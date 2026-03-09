/**
 * SMTP service — pure business logic for email send operations.
 *
 * No MCP dependency — fully unit-testable.
 */

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
  lines.push(`Subject: ${options.subject}`);
  lines.push(`Date: ${new Date().toUTCString()}`);
  lines.push(`Message-ID: ${options.messageId}`);
  lines.push('MIME-Version: 1.0');
  if (options.inReplyTo) lines.push(`In-Reply-To: ${options.inReplyTo}`);
  if (options.references) lines.push(`References: ${options.references}`);
  const contentType = options.html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
  lines.push(`Content-Type: ${contentType}`);
  lines.push('');
  lines.push(options.body);
  return lines.join('\r\n');
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

    const result = await transport.sendMail({
      from: fromAddr,
      to: to.join(', '),
      cc: cc.length > 0 ? cc.join(', ') : undefined,
      subject,
      inReplyTo: original.messageId,
      references: references.join(' '),
      ...(options.html ? { html: options.body } : { text: options.body }),
    });

    await this.appendToSentFolder(
      accountName,
      buildRawMessage({
        from: fromAddr,
        to: to.join(', '),
        subject,
        body: options.body,
        cc: cc.length > 0 ? cc.join(', ') : undefined,
        messageId: result.messageId ?? '',
        inReplyTo: original.messageId,
        references: references.join(' '),
        html: options.html,
      }),
    );

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

    // Fetch the draft via IMAP
    const { email: draft, mailbox: draftsPath } = await this.imapService.fetchDraft(
      accountName,
      draftId,
      mailbox,
    );

    const account = this.connections.getAccount(accountName);
    const transport = await this.connections.getSmtpTransport(accountName);

    const to = draft.to.map((a) => a.address).join(', ');
    const cc = draft.cc?.map((a) => a.address).join(', ');
    const fromAddr = account.fullName ? `"${account.fullName}" <${account.email}>` : account.email;

    const result = await transport.sendMail({
      from: fromAddr,
      to,
      cc,
      subject: draft.subject,
      inReplyTo: draft.inReplyTo,
      references: draft.references?.join(' '),
      ...(draft.bodyHtml ? { html: draft.bodyHtml } : { text: draft.bodyText ?? '' }),
    });

    // Append to Sent BEFORE deleting the draft
    await this.appendToSentFolder(
      accountName,
      buildRawMessage({
        from: fromAddr,
        to,
        subject: draft.subject,
        body: draft.bodyHtml ?? draft.bodyText ?? '',
        cc,
        messageId: result.messageId ?? '',
        inReplyTo: draft.inReplyTo,
        references: draft.references?.join(' '),
        html: !!draft.bodyHtml,
      }),
    );

    // Delete the draft after successful send
    await this.imapService.deleteDraft(accountName, draftId, draftsPath);

    return {
      messageId: result.messageId ?? '',
      status: 'sent',
    };
  }
}
