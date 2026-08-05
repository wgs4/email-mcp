/**
 * SMTP service — pure business logic for email send operations.
 *
 * No MCP dependency — fully unit-testable.
 */

import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { IConnectionManager } from '../connections/types.js';
import type RateLimiter from '../safety/rate-limiter.js';
import type { AccountConfig, SendResult } from '../types/index.js';
import type { ResolvedAttachment } from './attachment-resolver.js';
import type ImapService from './imap.service.js';

// ---------------------------------------------------------------------------
// Helpers (must be defined before SmtpService)
// ---------------------------------------------------------------------------

/**
 * Per-attachment ceiling when carrying attachments across a forward. Higher
 * than `downloadAttachment`'s 5 MB default, which exists to keep large files
 * from being base64-streamed through an MCP tool RESPONSE — here the bytes go
 * straight into the composed message and never reach the model.
 */
const FORWARD_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

function isGmailAccount(account: AccountConfig): boolean {
  return account.imap.host.includes('gmail.com') || account.smtp.host.includes('gmail.com');
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

/**
 * Normalize an SMTP envelope recipient list (the RCPT TO set). Drops
 * empty/whitespace-only addresses (a parsed `{address:''}` is not a recipient)
 * and de-dupes case-insensitively (an address appearing in both To and Cc, or
 * differing only in case, yields ONE RCPT). First-seen order and the first
 * occurrence's original casing are preserved. Exported for unit testing.
 */
export function normalizeEnvelopeRecipients(addrs: string[]): string[] {
  return addrs.reduce<{ seen: Set<string>; list: string[] }>(
    (acc, addr) => {
      const trimmed = addr.trim();
      const key = trimmed.toLowerCase();
      if (trimmed.length === 0 || acc.seen.has(key)) return acc;
      acc.seen.add(key);
      acc.list.push(trimmed);
      return acc;
    },
    { seen: new Set<string>(), list: [] },
  ).list;
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
      attachments?: ResolvedAttachment[];
    },
  ): Promise<SendResult> {
    this.checkRateLimit(accountName);

    const account = this.connections.getAccount(accountName);
    const transport = await this.connections.getSmtpTransport(accountName);

    const toAddrs = options.to;
    const ccAddrs = options.cc ?? [];
    const bccAddrs = options.bcc ?? [];

    // Compose ONCE → raw bytes (same approach as replyToEmail / sendDraft): the
    // identical bytes are transmitted via SMTP and stored in Sent. Bcc is
    // deliberately NOT placed in mailOptions — we send the raw message, so
    // nodemailer would not strip a Bcc header for us; the blind recipients ride
    // only in the SMTP envelope below.
    const mailOptions = {
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to: toAddrs.join(', '),
      cc: ccAddrs.length > 0 ? ccAddrs.join(', ') : undefined,
      subject: options.subject,
      ...(options.html ? { html: options.body } : { text: options.body }),
      ...(options.attachments?.length ? { attachments: options.attachments } : {}),
    };

    const rawMessage = await new Promise<Buffer>((resolve, reject) => {
      new MailComposer(mailOptions).compile().build((err: Error | null, buf: Buffer) => {
        if (err) reject(err);
        else resolve(buf);
      });
    });

    // Build the SMTP envelope explicitly — nodemailer cannot derive it from the
    // opaque raw bytes. The RCPT TO list covers every To + Cc + Bcc recipient,
    // de-duped case-insensitively.
    const envelope = {
      from: account.email,
      to: normalizeEnvelopeRecipients([...toAddrs, ...ccAddrs, ...bccAddrs]),
    };

    if (envelope.to.length === 0) {
      // The tool schema requires `to` (minItems 1); guard anyway so we never
      // hand SMTP an empty RCPT TO list.
      throw new Error('Cannot send email: no recipients (To/Cc/Bcc all empty)');
    }

    const result = await transport.sendMail({ envelope, raw: rawMessage });

    // Append the SAME raw bytes to Sent — "one raw message, sent and stored".
    // This also fixes the previously lossy Sent copy (attachment-blind
    // buildRawMessage path).
    await this.appendToSentFolder(accountName, rawMessage);

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
    const fetchAttachment = async (filename: string) =>
      this.imapService.downloadAttachment(
        accountName,
        options.emailId,
        options.mailbox ?? 'INBOX',
        filename,
      );

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

  /**
   * Forward a message, carrying its attachments across by default.
   *
   * Attachment handling is deliberately STRICTER than `replyToEmail`'s opt-in,
   * best-effort re-attach: a forward's attachments are usually the whole point
   * of forwarding, so a fetch failure throws instead of quietly transmitting a
   * gutted message. Pass `includeAttachments: false` for a body-only forward.
   */
  async forwardEmail(
    accountName: string,
    options: {
      emailId: string;
      mailbox?: string;
      to: string[];
      body?: string;
      cc?: string[];
      includeAttachments?: boolean;
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

    const attachments = await this.fetchAttachmentsForForward(accountName, original, options);

    // Compose ONCE → raw bytes: the identical bytes are transmitted via SMTP and
    // stored in Sent. (The previous implementation sent `text` only — dropping
    // every attachment — and stored a second, separately-built copy from an
    // attachment-blind raw builder, so the Sent copy was lossy too.)
    const mailOptions = {
      from: fromAddr,
      to: options.to.join(', '),
      cc: options.cc?.length ? options.cc.join(', ') : undefined,
      subject,
      text: fullBody,
      ...(attachments.length > 0 ? { attachments } : {}),
    };

    const rawMessage = await new Promise<Buffer>((resolve, reject) => {
      new MailComposer(mailOptions).compile().build((err: Error | null, buf: Buffer) => {
        if (err) reject(err);
        else resolve(buf);
      });
    });

    // nodemailer cannot derive an envelope from opaque raw bytes — pass it
    // explicitly so the RCPT TO list covers every To + Cc recipient.
    const envelope = {
      from: account.email,
      to: normalizeEnvelopeRecipients([...options.to, ...(options.cc ?? [])]),
    };

    if (envelope.to.length === 0) {
      throw new Error('Cannot forward email: no recipients (To/Cc both empty)');
    }

    const result = await transport.sendMail({ envelope, raw: rawMessage });

    await this.appendToSentFolder(accountName, rawMessage);

    return {
      messageId: result.messageId ?? '',
      status: 'sent',
    };
  }

  /**
   * Download the original's attachments for a forward.
   *
   * De-dupes by filename: `downloadAttachment` resolves a MIME part BY filename
   * and returns the first match, so a message carrying the same filename twice
   * would otherwise cost two fetches and attach the first part's bytes twice —
   * possibly the wrong bytes if the same-named parts differ. One part per
   * distinct filename, first-seen order.
   *
   * Throws on the first failure, naming the attachment (see `forwardEmail`).
   */
  private async fetchAttachmentsForForward(
    accountName: string,
    original: { attachments: { filename: string }[] },
    options: { emailId: string; mailbox?: string; includeAttachments?: boolean },
  ): Promise<{ filename: string; content: Buffer; contentType: string }[]> {
    // Default ON — a forward that silently loses its attachments is broken.
    if (options.includeAttachments === false) return [];

    const filenames = [...new Set(original.attachments.map((meta) => meta.filename))];
    if (filenames.length === 0) return [];

    const results = await Promise.allSettled(
      filenames.map(async (filename) =>
        this.imapService.downloadAttachment(
          accountName,
          options.emailId,
          options.mailbox ?? 'INBOX',
          filename,
          FORWARD_ATTACHMENT_MAX_BYTES,
        ),
      ),
    );

    const failures = results.flatMap((result, i) =>
      result.status === 'rejected'
        ? [
            `"${filenames[i]}" (${result.reason instanceof Error ? result.reason.message : String(result.reason)})`,
          ]
        : [],
    );
    if (failures.length > 0) {
      throw new Error(
        `Cannot forward: ${failures.length} of ${filenames.length} attachment(s) could not be fetched — ${failures.join('; ')}. ` +
          'Nothing was sent. Retry, or pass includeAttachments=false to forward the body without them.',
      );
    }

    return results.flatMap((result) =>
      result.status === 'fulfilled'
        ? [
            {
              filename: result.value.filename,
              content: Buffer.from(result.value.contentBase64, 'base64'),
              contentType: result.value.mimeType,
            },
          ]
        : [],
    );
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

    // Normalize the RCPT TO list (drop blanks, de-dupe case-insensitively,
    // preserve first-seen order). See {@link normalizeEnvelopeRecipients}.
    const recipients = normalizeEnvelopeRecipients([...toAddrs, ...ccAddrs, ...bccAddrs]);
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
