/**
 * SMTP service — pure business logic for email send operations.
 *
 * No MCP dependency — fully unit-testable.
 */

import { randomUUID } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { IConnectionManager } from '../connections/types.js';
import type RateLimiter from '../safety/rate-limiter.js';
import type { AccountConfig, SendResult } from '../types/index.js';
import type ImapService from './imap.service.js';

// ---------------------------------------------------------------------------
// Helpers (must be defined before SmtpService)
// ---------------------------------------------------------------------------

function isGmailAccount(account: AccountConfig): boolean {
  return account.imap.host.includes('gmail.com') || account.smtp.host.includes('gmail.com');
}

function encodeRfc2047(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf-8').toString('base64')}?=`;
}

function buildRawMessage(options: {
  from: string;
  to: string;
  subject: string;
  body: string;
  cc?: string;
  messageId: string;
  inReplyTo?: string;
  references?: string;
  html?: boolean;
}): string {
  const lines: string[] = [];
  lines.push(`From: ${options.from}`);
  lines.push(`To: ${options.to}`);
  if (options.cc) lines.push(`Cc: ${options.cc}`);
  lines.push(`Subject: ${encodeRfc2047(options.subject)}`);
  lines.push(`Date: ${new Date().toUTCString()}`);
  const mid = options.messageId || `<${randomUUID()}@email-mcp.local>`;
  lines.push(`Message-ID: ${mid}`);
  lines.push('MIME-Version: 1.0');
  if (options.inReplyTo) lines.push(`In-Reply-To: ${options.inReplyTo}`);
  if (options.references) lines.push(`References: ${options.references}`);
  const contentType = options.html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
  lines.push(`Content-Type: ${contentType}`);
  lines.push('Content-Transfer-Encoding: 8bit');
  lines.push('');
  const normalizedBody = options.body.replace(/\r?\n/g, '\r\n');
  lines.push(normalizedBody);
  return lines.join('\r\n');
}

/**
 * Remove any `Bcc:` header (and its folded continuation lines) from a raw RFC822
 * message, operating ONLY on the header block (everything before the first
 * blank line). Bcc addresses belong in the SMTP envelope, never in the
 * transmitted/stored message — a leaked `Bcc:` header would disclose the blind
 * recipients to everyone who receives the mail.
 *
 * No-op when there is no Bcc header. Original line endings and body bytes are
 * preserved exactly. Exported for unit testing.
 */
export function stripBccHeader(raw: Buffer): Buffer {
  const text = raw.toString('binary');

  // Locate the header/body boundary (first blank line), supporting CRLF and LF.
  const crlfIdx = text.indexOf('\r\n\r\n');
  const lfIdx = text.indexOf('\n\n');
  let boundary: number;
  let eol: string;
  if (crlfIdx >= 0 && (lfIdx < 0 || crlfIdx <= lfIdx)) {
    boundary = crlfIdx;
    eol = '\r\n';
  } else if (lfIdx >= 0) {
    boundary = lfIdx;
    eol = '\n';
  } else {
    // No header/body separator (malformed/degenerate message). We cannot tell
    // headers from body, so treating everything as headers risks deleting body
    // lines that merely start with `Bcc:`. Return the original bytes untouched.
    return raw;
  }

  const headerBlock = text.slice(0, boundary);
  const rest = text.slice(boundary); // blank-line separator + body, untouched

  const headerLines = headerBlock.split(eol);
  // Walk the header lines, dropping any `Bcc:` header and the folded
  // continuation lines (leading space/tab) that belong to it. `dropping`
  // tracks whether we are mid-drop so continuation lines are removed too.
  const { kept } = headerLines.reduce<{ kept: string[]; dropping: boolean }>(
    (acc, line) => {
      const isContinuation = line.startsWith(' ') || line.startsWith('\t');
      if (acc.dropping && isContinuation) {
        return acc; // folded continuation of the Bcc header — drop it
      }
      if (/^(resent-)?bcc:/i.test(line)) {
        // Drop both `Bcc:` and the RFC 5322 `Resent-Bcc:` header — each carries
        // blind recipients that must never be transmitted. `X-Original-Bcc:`
        // and similar prefixed headers are deliberately NOT matched.
        return { kept: acc.kept, dropping: true };
      }
      return { kept: [...acc.kept, line], dropping: false };
    },
    { kept: [], dropping: false },
  );

  // Nothing changed — return the original buffer untouched.
  if (kept.length === headerLines.length) return raw;

  const rebuilt = kept.join(eol) + rest;
  return Buffer.from(rebuilt, 'binary');
}

export default class SmtpService {
  constructor(
    private connections: IConnectionManager,
    private rateLimiter: RateLimiter,
    private imapService: ImapService,
  ) {}

  // -------------------------------------------------------------------------
  // Send email
  // -------------------------------------------------------------------------

  async sendEmail(
    accountName: string,
    options: {
      to: string[];
      subject: string;
      body: string;
      cc?: string[];
      bcc?: string[];
      html?: boolean;
    },
  ): Promise<SendResult> {
    this.checkRateLimit(accountName);

    const account = this.connections.getAccount(accountName);
    const transport = await this.connections.getSmtpTransport(accountName);

    const mailOptions = {
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to: options.to.join(', '),
      cc: options.cc?.join(', '),
      bcc: options.bcc?.join(', '),
      subject: options.subject,
      ...(options.html ? { html: options.body } : { text: options.body }),
    };

    const result = await transport.sendMail(mailOptions);

    await this.appendToSentFolder(
      accountName,
      buildRawMessage({
        from: mailOptions.from,
        to: mailOptions.to,
        subject: mailOptions.subject,
        body: options.body,
        cc: mailOptions.cc,
        messageId: result.messageId ?? '',
        html: options.html,
      }),
    );

    return {
      messageId: result.messageId ?? '',
      status: 'sent',
    };
  }

  // -------------------------------------------------------------------------
  // Reply
  // -------------------------------------------------------------------------

  async replyToEmail(
    accountName: string,
    options: {
      emailId: string;
      mailbox?: string;
      body: string;
      replyAll?: boolean;
      html?: boolean;
      includeAttachments?: boolean;
    },
  ): Promise<SendResult> {
    this.checkRateLimit(accountName);

    const account = this.connections.getAccount(accountName);
    const original = await this.imapService.getEmail(accountName, options.emailId, options.mailbox);

    // Build recipient list
    const to = [original.from.address];
    const cc: string[] = [];

    if (options.replyAll) {
      // Add all original To recipients except ourselves
      original.to
        .filter((addr) => addr.address !== account.email)
        .forEach((addr) => {
          to.push(addr.address);
        });
      // Add CC recipients except ourselves
      (original.cc ?? [])
        .filter((addr) => addr.address !== account.email)
        .forEach((addr) => {
          cc.push(addr.address);
        });
    }

    // Build threading headers
    const references = [...(original.references ?? []), original.messageId].filter(Boolean);

    const subject = original.subject.startsWith('Re:')
      ? original.subject
      : `Re: ${original.subject}`;

    const transport = await this.connections.getSmtpTransport(accountName);

    const fromAddr = account.fullName ? `"${account.fullName}" <${account.email}>` : account.email;

    // Fetch attachment binaries from IMAP when requested (parallel downloads)
    /* eslint-disable @stylistic/implicit-arrow-linebreak */
    const fetchAttachment = async (filename: string) =>
      this.imapService.downloadAttachment(
        accountName,
        options.emailId,
        options.mailbox ?? 'INBOX',
        filename,
      );
    /* eslint-enable @stylistic/implicit-arrow-linebreak */

    const attachments: { filename: string; content: Buffer; contentType: string }[] = [];
    if (options.includeAttachments && original.attachments.length > 0) {
      const results = await Promise.allSettled(
        original.attachments.map(async (meta) => fetchAttachment(meta.filename)),
      );
      results.forEach((result, i) => {
        if (result.status === 'rejected') {
          // eslint-disable-next-line no-console
          console.warn(
            `[reply_email] Skipping attachment "${original.attachments[i].filename}":`,
            result.reason,
          );
        } else {
          attachments.push({
            filename: result.value.filename,
            content: Buffer.from(result.value.contentBase64, 'base64'),
            contentType: result.value.mimeType,
          });
        }
      });
    }

    // Build the raw message once — same bytes sent via SMTP and stored in Sent folder
    const mailOptions = {
      from: fromAddr,
      to: to.join(', '),
      cc: cc.length > 0 ? cc.join(', ') : undefined,
      subject,
      inReplyTo: original.messageId,
      references: references.join(' '),
      ...(options.html ? { html: options.body } : { text: options.body }),
      ...(attachments.length > 0 ? { attachments } : {}),
    };

    const rawMessage = await new Promise<Buffer>((resolve, reject) => {
      new MailComposer(mailOptions).compile().build((err: Error | null, buf: Buffer) => {
        if (err) reject(err);
        else resolve(buf);
      });
    });

    // When sending a pre-composed raw message, nodemailer cannot derive the SMTP
    // envelope from the (opaque) raw bytes — it would compute an empty recipient
    // list and throw "No recipients defined". Pass the envelope explicitly so the
    // RCPT TO list covers every To + Cc recipient.
    const result = await transport.sendMail({
      envelope: { from: account.email, to: [...to, ...cc] },
      raw: rawMessage,
    });

    await this.appendToSentFolder(accountName, rawMessage);

    return {
      messageId: result.messageId ?? '',
      status: 'sent',
    };
  }

  // -------------------------------------------------------------------------
  // Forward
  // -------------------------------------------------------------------------

  async forwardEmail(
    accountName: string,
    options: {
      emailId: string;
      mailbox?: string;
      to: string[];
      body?: string;
      cc?: string[];
    },
  ): Promise<SendResult> {
    this.checkRateLimit(accountName);

    const account = this.connections.getAccount(accountName);
    const original = await this.imapService.getEmail(accountName, options.emailId, options.mailbox);

    const subject = original.subject.startsWith('Fwd:')
      ? original.subject
      : `Fwd: ${original.subject}`;

    // Build forwarded message body
    const forwardHeader = [
      '',
      '---------- Forwarded message ----------',
      `From: ${original.from.name ? `${original.from.name} <${original.from.address}>` : original.from.address}`,
      `Date: ${original.date}`,
      `Subject: ${original.subject}`,
      `To: ${original.to.map((a) => a.address).join(', ')}`,
      '',
    ].join('\n');

    const originalBody = original.bodyText ?? original.bodyHtml ?? '';
    const fullBody = (options.body ?? '') + forwardHeader + originalBody;

    const transport = await this.connections.getSmtpTransport(accountName);

    const fromAddr = account.fullName ? `"${account.fullName}" <${account.email}>` : account.email;

    const result = await transport.sendMail({
      from: fromAddr,
      to: options.to.join(', '),
      cc: options.cc?.join(', '),
      subject,
      text: fullBody,
    });

    await this.appendToSentFolder(
      accountName,
      buildRawMessage({
        from: fromAddr,
        to: options.to.join(', '),
        subject,
        body: fullBody,
        cc: options.cc?.join(', '),
        messageId: result.messageId ?? '',
      }),
    );

    return {
      messageId: result.messageId ?? '',
      status: 'sent',
    };
  }

  // -------------------------------------------------------------------------
  // Rate limit check
  // -------------------------------------------------------------------------

  private checkRateLimit(accountName: string): void {
    if (!this.rateLimiter.tryConsume(accountName)) {
      throw new Error(
        `Rate limit exceeded for account "${accountName}". ` +
          `Please wait before sending more emails.`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Sent folder helpers
  // -------------------------------------------------------------------------

  private async appendToSentFolder(
    accountName: string,
    rawMessage: string | Buffer,
  ): Promise<void> {
    const account = this.connections.getAccount(accountName);

    // Skip if disabled in config
    if (account.saveToSent === false) return;

    // Skip Gmail (auto-saves via SMTP)
    if (isGmailAccount(account) && account.gmailAutoSave !== false) return;

    try {
      await this.imapService.appendToSent(accountName, rawMessage);
    } catch (error) {
      // Log warning but do not throw — SMTP send already succeeded
      // eslint-disable-next-line no-console
      console.warn(`Failed to save to Sent folder for ${accountName}:`, error);
    }
  }

  // -------------------------------------------------------------------------
  // Send draft
  // -------------------------------------------------------------------------

  async sendDraft(accountName: string, draftId: number, mailbox?: string): Promise<SendResult> {
    this.checkRateLimit(accountName);

    // Fetch the parsed draft for its recipient addresses (and the resolved
    // Drafts mailbox path)…
    const { email: draft, mailbox: draftsPath } = await this.imapService.fetchDraft(
      accountName,
      draftId,
      mailbox,
    );

    // …and the FULL raw bytes so attachments are sent as-is (recomposing from
    // the parsed Email loses attachment binaries — that was the bug).
    const rawBuffer = await this.imapService.fetchDraftRaw(accountName, draftId, draftsPath);

    const account = this.connections.getAccount(accountName);
    const transport = await this.connections.getSmtpTransport(accountName);

    // Build the SMTP envelope from the parsed draft. Bcc lives only in the
    // envelope; it is stripped from the transmitted/stored message below.
    const toAddrs = draft.to.map((a) => a.address);
    const ccAddrs = (draft.cc ?? []).map((a) => a.address);
    const bccAddrs = (draft.bcc ?? []).map((a) => a.address);

    // Normalize the RCPT TO list: drop empty/whitespace-only addresses (a
    // parsed `{address:''}` is not a recipient) and de-dupe case-insensitively
    // (an address in both To and Cc, or differing only in case, yields ONE
    // RCPT). First-seen order and the first occurrence's casing are preserved.
    const recipients = [...toAddrs, ...ccAddrs, ...bccAddrs].reduce<{
      seen: Set<string>;
      list: string[];
    }>(
      (acc, addr) => {
        const trimmed = addr.trim();
        const key = trimmed.toLowerCase();
        if (trimmed.length === 0 || acc.seen.has(key)) return acc;
        acc.seen.add(key);
        acc.list.push(addr);
        return acc;
      },
      { seen: new Set<string>(), list: [] },
    ).list;
    const envelope = { from: account.email, to: recipients };

    if (envelope.to.length === 0) {
      throw new Error('Draft has no recipients (To/Cc/Bcc all empty)');
    }

    // Strip the Bcc header so blind recipients never leak into the delivered
    // message or the Sent copy. Threading headers (In-Reply-To/References) and
    // Message-ID/Date are already embedded in the raw bytes — leave them as-is.
    const sanitizedRaw = stripBccHeader(rawBuffer);

    // When sending pre-composed raw bytes, nodemailer cannot derive the SMTP
    // envelope from the opaque message — pass it explicitly (mirrors
    // replyToEmail) so the RCPT TO list covers every To + Cc + Bcc recipient.
    const result = await transport.sendMail({ envelope, raw: sanitizedRaw });

    // Append the SAME sanitized bytes to Sent BEFORE deleting the draft —
    // "one raw message, sent and stored".
    await this.appendToSentFolder(accountName, sanitizedRaw);

    // Delete the draft after successful send
    await this.imapService.deleteDraft(accountName, draftId, draftsPath);

    return {
      messageId: result.messageId ?? '',
      status: 'sent',
    };
  }
}
