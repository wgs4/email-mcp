/**
 * Connection manager for lazy-persistent IMAP and SMTP connections.
 *
 * - Creates connections on first use per account
 * - Reuses open connections across tool calls
 * - Auto-reconnects on failure
 * - Graceful shutdown closes all connections
 */

import { ImapFlow } from 'imapflow';
import type { Transporter } from 'nodemailer';
import nodemailer from 'nodemailer';
import { mcpLog } from '../logging.js';

import type OAuthService from '../services/oauth.service.js';
import type { AccountConfig } from '../types/index.js';
import type { IConnectionManager } from './types.js';

type SmtpAuth =
  | { user: string; pass?: string }
  | { type: string; user: string; accessToken: string };

/**
 * Redact known + common credential substrings before logging an error
 * ([P2] codex). imapflow errors rarely echo the password, but auth/OAuth/TLS
 * failures can carry server text or diagnostic context — defense in depth so
 * a process-stderr log line can never leak a credential.
 */
export function redactSecrets(message: string, secrets: (string | undefined)[]): string {
  let out = message;
  secrets.forEach((s) => {
    if (s && s.length >= 4) {
      out = out.split(s).join('***');
    }
  });
  // Mask `Bearer <token>` / `Basic <blob>` auth schemes.
  out = out.replace(/\b(bearer|basic)\s+[^\s"',;]+/gi, '$1 ***');
  // Mask `key: value` / `key=value` for credential-bearing keys.
  out = out.replace(
    /\b(password|passwd|pwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization)\b(\s*[:=]\s*)[^\s"',;]+/gi,
    '$1$2***',
  );
  return out;
}

export default class ConnectionManager implements IConnectionManager {
  private imapClients = new Map<string, ImapFlow>();

  private smtpTransports = new Map<string, Transporter>();

  private accounts = new Map<string, AccountConfig>();

  private oauthService?: OAuthService;

  constructor(accounts: AccountConfig[], oauthService?: OAuthService) {
    accounts.forEach((account) => {
      this.accounts.set(account.name, account);
    });
    this.oauthService = oauthService;
  }

  // -------------------------------------------------------------------------
  // Account lookup
  // -------------------------------------------------------------------------

  getAccount(name: string): AccountConfig {
    const account = this.accounts.get(name);
    if (!account) {
      throw new Error(
        `Account "${name}" not found. Available: ${[...this.accounts.keys()].join(', ')}`,
      );
    }
    return account;
  }

  getAccountNames(): string[] {
    return [...this.accounts.keys()];
  }

  // -------------------------------------------------------------------------
  // IMAP
  // -------------------------------------------------------------------------

  /**
   * Build an UNCONNECTED ImapFlow for an account (auth/OAuth + transport
   * options). Single source of truth for client construction — shared by the
   * cached `getImapClient` and the throwaway `createEphemeralImapClient` (D3
   * infra: do NOT reimplement auth elsewhere).
   */
  private async buildImapClient(accountName: string): Promise<ImapFlow> {
    const account = this.getAccount(accountName);

    // Build auth config based on auth type
    let auth: { user: string; pass?: string; accessToken?: string };
    if (account.oauth2 && this.oauthService) {
      const accessToken = await this.oauthService.getAccessToken(account.oauth2);
      auth = { user: account.username, accessToken };
    } else {
      auth = { user: account.username, pass: account.password };
    }

    return new ImapFlow({
      host: account.imap.host,
      port: account.imap.port,
      secure: account.imap.tls,
      tls: {
        rejectUnauthorized: account.imap.verifySsl,
      },
      auth,
      logger: false,
    });
  }

  async getImapClient(accountName: string): Promise<ImapFlow> {
    const existing = this.imapClients.get(accountName);
    if (existing?.usable) {
      return existing;
    }

    // Clean up stale connection
    if (existing) {
      this.imapClients.delete(accountName);
      try {
        existing.close();
      } catch {
        /* ignore */
      }
    }

    const account = this.getAccount(accountName);
    const client = await this.buildImapClient(accountName);

    // R1c/D6/F2: a socket-timeout emitError() on a client with NO 'error'
    // listener crashes the whole process. Attach a default handler at creation
    // — before connect(), so connection-phase errors are caught too. Log it and
    // drop the client so the next getImapClient reconnects. The watcher attaches
    // its own additional 'error' listener; EventEmitter listeners are additive.
    client.on('error', (err: Error) => {
      const detail = redactSecrets(err instanceof Error ? err.message : String(err), [
        account.password,
      ]);
      mcpLog('error', 'imap', `IMAP client error for "${accountName}": ${detail}`).catch(() => {});
      this.imapClients.delete(accountName);
    });

    await client.connect();
    await mcpLog(
      'info',
      'imap',
      `Connected to ${account.imap.host}:${account.imap.port} for "${accountName}"`,
    );
    this.imapClients.set(accountName, client);
    return client;
  }

  /**
   * Create a throwaway, UNCACHED IMAP connection for a bounded deep search
   * (D3/R3). The caller owns its lifecycle and MUST `close()` it (e.g. on a
   * bounded-wait timeout). It is never stored in `imapClients`, so its
   * failure can never poison the account's shared client. It still gets a
   * log-and-swallow `'error'` listener so a socket-timeout emitError on the
   * ephemeral socket cannot crash the process (F2), but — unlike the cached
   * client's handler — it does NOT touch the shared-client map.
   */
  async createEphemeralImapClient(accountName: string): Promise<ImapFlow> {
    const account = this.getAccount(accountName);
    const client = await this.buildImapClient(accountName);

    client.on('error', (err: Error) => {
      const detail = redactSecrets(err instanceof Error ? err.message : String(err), [
        account.password,
      ]);
      mcpLog('error', 'imap', `Ephemeral IMAP client error for "${accountName}": ${detail}`).catch(
        () => {},
      );
      // Intentionally NOT touching this.imapClients — the ephemeral client is
      // not cached; the caller closes it. D3: never poison the shared client.
    });

    await client.connect();
    await mcpLog(
      'info',
      'imap',
      `Ephemeral connection to ${account.imap.host}:${account.imap.port} for "${accountName}"`,
    );
    return client;
  }

  // -------------------------------------------------------------------------
  // SMTP
  // -------------------------------------------------------------------------

  private static buildSmtpTransportOptions(
    account: AccountConfig,
    auth: SmtpAuth,
  ): nodemailer.TransportOptions {
    const pool = account.smtp.pool ?? {
      enabled: true,
      maxConnections: 1,
      maxMessages: 100,
    };

    return {
      host: account.smtp.host,
      port: account.smtp.port,
      secure: account.smtp.tls,
      requireTLS: account.smtp.starttls,
      ignoreTLS: !account.smtp.tls && !account.smtp.starttls,
      tls: {
        rejectUnauthorized: account.smtp.verifySsl,
      },
      auth,
      pool: pool.enabled,
      ...(pool.enabled
        ? {
            maxConnections: pool.maxConnections,
            maxMessages: pool.maxMessages,
          }
        : {}),
    } as nodemailer.TransportOptions;
  }

  async getSmtpTransport(
    accountName: string,
    options?: { verify?: boolean },
  ): Promise<Transporter> {
    const verify = options?.verify ?? false;
    const existing = this.smtpTransports.get(accountName);
    if (existing) {
      if (!verify) {
        return existing;
      }
      try {
        await existing.verify();
        return existing;
      } catch {
        this.smtpTransports.delete(accountName);
        try {
          existing.close();
        } catch {
          /* ignore */
        }
      }
    }

    const account = this.getAccount(accountName);

    // Build auth config based on auth type
    let auth: SmtpAuth;
    if (account.oauth2 && this.oauthService) {
      const accessToken = await this.oauthService.getAccessToken(account.oauth2);
      auth = { type: 'OAuth2', user: account.username, accessToken };
    } else {
      auth = { user: account.username, pass: account.password };
    }

    const transport = nodemailer.createTransport(
      ConnectionManager.buildSmtpTransportOptions(account, auth),
    );

    await transport.verify();
    await mcpLog(
      'info',
      'smtp',
      `Connected to ${account.smtp.host}:${account.smtp.port} for "${accountName}"`,
    );
    this.smtpTransports.set(accountName, transport);
    return transport;
  }

  async verifySmtpTransport(accountName: string): Promise<void> {
    await this.getSmtpTransport(accountName, { verify: true });
  }

  // -------------------------------------------------------------------------
  // Test connections (for setup wizard / test command)
  // -------------------------------------------------------------------------

  static async testImap(
    account: AccountConfig,
    oauthService?: OAuthService,
  ): Promise<{
    success: boolean;
    error?: string;
    details?: { messages: number; folders: number };
  }> {
    let client: ImapFlow | undefined;
    try {
      let auth: { user: string; pass?: string; accessToken?: string };
      if (account.oauth2 && oauthService) {
        const accessToken = await oauthService.getAccessToken(account.oauth2);
        auth = { user: account.username, accessToken };
      } else {
        auth = { user: account.username, pass: account.password };
      }

      client = new ImapFlow({
        host: account.imap.host,
        port: account.imap.port,
        secure: account.imap.tls,
        tls: {
          rejectUnauthorized: account.imap.verifySsl,
        },
        auth,
        logger: false,
      });
      await client.connect();

      const mailboxes = await client.list();
      let messageCount = 0;
      try {
        const inbox = await client.status('INBOX', {
          messages: true,
          unseen: true,
        });
        messageCount = inbox.messages ?? 0;
      } catch {
        // INBOX may not exist (e.g. Google Workspace uses "All Mail")
        if (mailboxes.length > 0) {
          try {
            const first = await client.status(mailboxes[0].path, {
              messages: true,
            });
            messageCount = first.messages ?? 0;
          } catch {
            /* ignore — connection still works */
          }
        }
      }

      return {
        success: true,
        details: {
          messages: messageCount,
          folders: mailboxes.length,
        },
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (client) {
        try {
          await client.logout();
        } catch {
          /* ignore */
        }
      }
    }
  }

  static async testSmtp(
    account: AccountConfig,
    oauthService?: OAuthService,
  ): Promise<{ success: boolean; error?: string }> {
    let transport: Transporter | undefined;
    try {
      let auth: SmtpAuth;
      if (account.oauth2 && oauthService) {
        const accessToken = await oauthService.getAccessToken(account.oauth2);
        auth = { type: 'OAuth2', user: account.username, accessToken };
      } else {
        auth = { user: account.username, pass: account.password };
      }

      transport = nodemailer.createTransport(
        ConnectionManager.buildSmtpTransportOptions(account, auth),
      );
      await transport.verify();
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      transport?.close();
    }
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  async closeAll(): Promise<void> {
    await mcpLog('info', 'connections', 'Closing all connections');
    const closeOps: Promise<void>[] = [];

    Array.from(this.imapClients.entries()).forEach(([name, client]) => {
      closeOps.push(
        client
          .logout()
          .catch(() => {})
          .then(() => {
            this.imapClients.delete(name);
          }),
      );
    });

    Array.from(this.smtpTransports.entries()).forEach(([name, transport]) => {
      transport.close();
      this.smtpTransports.delete(name);
    });

    await Promise.allSettled(closeOps);
  }
}
