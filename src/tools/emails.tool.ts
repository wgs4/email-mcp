/**
 * MCP tools: list_emails, get_email, get_emails, get_email_status,
 * search_emails, search_all_accounts.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type ConnectionManager from '../connections/manager.js';
import type ImapService from '../services/imap.service.js';
import type { Email, EmailMeta, FacetResult, PaginatedResult } from '../types/index.js';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatEmailMeta(email: EmailMeta): string {
  const flags = [
    email.seen ? '' : '🔵',
    email.flagged ? '⭐' : '',
    email.answered ? '↩️' : '',
    email.hasAttachments ? '📎' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const from = email.from.name ? `${email.from.name} <${email.from.address}>` : email.from.address;
  const labelStr = email.labels.length > 0 ? `\n  🏷️ ${email.labels.join(', ')}` : '';

  let attachLine = '';
  if (email.attachments && email.attachments.length > 0) {
    const names = email.attachments.map((a) => a.filename);
    const shown = names.slice(0, 3).join(', ');
    const extra = names.length > 3 ? ` (+${names.length - 3} more)` : '';
    attachLine = `\n  📎 Attachments: ${shown}${extra}`;
  }

  const accountTag = email.account ? `[${email.account}] ` : '';
  return `${accountTag}[${email.id}] ${flags} ${email.subject}\n  From: ${from} | ${email.date}${labelStr}${attachLine}${email.preview ? `\n  ${email.preview}` : ''}`;
}

/**
 * Render a facet result block (sender/year/mailbox) — shared between
 * `search_emails`, `search_all_accounts`, and `run_preset`.
 */
export function formatFacetsBlock(facets: FacetResult | undefined): string {
  if (!facets) return '';
  const lines: string[] = ['', '📊 Facets'];
  if (facets.sender) {
    const top = Object.entries(facets.sender)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([k, v]) => `${k} (${v})`)
      .join(', ');
    lines.push(`  By sender: ${top || '(none)'}`);
  }
  if (facets.year) {
    const all = Object.entries(facets.year)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([k, v]) => `${k} (${v})`)
      .join(', ');
    lines.push(`  By year:   ${all || '(none)'}`);
  }
  if (facets.mailbox) {
    const all = Object.entries(facets.mailbox)
      .map(([k, v]) => `${k} (${v})`)
      .join(', ');
    lines.push(`  By mailbox: ${all || '(none)'}`);
  }
  return `\n${lines.join('\n')}`;
}

/**
 * Format a paginated search result (single- or cross-account) for MCP text
 * output. Used by `search_emails`, `search_all_accounts`, and `run_preset`.
 */
export function formatSearchResult(
  result: PaginatedResult<EmailMeta> & {
    warnings?: { account: string; error: string }[];
  },
  header: string,
  emptyMessage: string,
): string {
  const warningPrefix = result.warning ? `⚠️ ${result.warning}\n` : '';

  if (result.items.length === 0) {
    return `${warningPrefix}${emptyMessage}`;
  }

  const emails = result.items.map(formatEmailMeta).join('\n\n');
  const facetsBlock = formatFacetsBlock(result.facets);

  let accountWarningsBlock = '';
  if (result.warnings && result.warnings.length > 0) {
    const lines = ['', '⚠️ Warnings'];
    result.warnings.forEach((w) => {
      lines.push(`  - ${w.account}: ${w.error}`);
    });
    accountWarningsBlock = `\n${lines.join('\n')}`;
  }

  return `${warningPrefix}${header}\n${emails}${facetsBlock}${accountWarningsBlock}`;
}

/** Strips HTML markup and decodes common entities to produce readable plain text. */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Removes quoted reply chains and signatures from plain text. */
function stripReplyChain(text: string): string {
  const lines = text.split('\n');
  const stopIdx = lines.findIndex((l) => /^--\s*$/.test(l) || /^_{3,}\s*$/.test(l));
  const relevant = stopIdx === -1 ? lines : lines.slice(0, stopIdx);
  return relevant
    .filter((l) => !l.startsWith('>'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

type BodyFormat = 'full' | 'text' | 'stripped';

/**
 * Applies the requested body format and optional character cap.
 *
 * - full:     raw bodyText ?? bodyHtml (preserves original, default)
 * - text:     prefers bodyText; converts bodyHtml to plain text if needed
 * - stripped: like text, but also removes quoted reply chains and signatures
 */
function applyBodyFormat(
  bodyText: string | undefined,
  bodyHtml: string | undefined,
  format: BodyFormat,
  maxLength?: number,
): string {
  let body: string;

  if (format === 'full') {
    body = bodyText ?? bodyHtml ?? '(no content)';
  } else {
    const base = bodyText ?? (bodyHtml ? stripHtml(bodyHtml) : undefined) ?? '(no content)';
    body = format === 'stripped' ? stripReplyChain(base) : base;
  }

  if (maxLength !== undefined && maxLength > 0 && body.length > maxLength) {
    const remaining = body.length - maxLength;
    body = `${body.slice(0, maxLength)}\n\n… (${remaining} more characters — increase maxLength to read the full body)`;
  }

  return body;
}

/** Renders the current read/flag/label state as a concise status line. */
function formatEmailStatus(email: Pick<Email, 'seen' | 'flagged' | 'answered' | 'labels'>): string {
  const parts: string[] = [email.seen ? '✓ Read' : '🔵 Unread'];
  if (email.flagged) parts.push('⭐ Flagged');
  if (email.answered) parts.push('↩️ Replied');
  const labelStr = email.labels.length > 0 ? ` · 🏷️ ${email.labels.join(', ')}` : '';
  return `${parts.join(' · ')}${labelStr}`;
}

// ---------------------------------------------------------------------------

export default function registerEmailsTools(
  server: McpServer,
  imapService: ImapService,
  connections: ConnectionManager,
): void {
  // ---------------------------------------------------------------------------
  // list_emails
  // ---------------------------------------------------------------------------
  server.tool(
    'list_emails',
    'List emails with optional server-side filters. Supports date ranges (since/before/on, ' +
      'including relative tokens like "7d", "yesterday"), subject/from/to/cc/bcc/body/text search, ' +
      'read/flag/answered state, keywords/labels, header matches, and UID ranges. ' +
      'On Gmail accounts, pass gmail_raw for native Gmail search syntax (dramatically faster). ' +
      'Returns paginated metadata (read/unread 🔵, flagged ⭐, replied ↩️, attachments 📎, labels 🏷️). ' +
      'Use get_email to fetch full body content. ' +
      'ProtonMail note: labels are represented as IMAP folders — use list_labels to discover them, ' +
      'then list_emails with mailbox="Labels/X" to find labeled emails.',
    {
      account: z.string().describe('Account name from list_accounts'),
      mailbox: z.string().default('INBOX').describe('Mailbox path (default: INBOX)'),
      page: z.number().int().min(1).default(1).describe('Page number'),
      pageSize: z.number().int().min(1).max(100).default(20).describe('Results per page'),
      since: z
        .string()
        .optional()
        .describe(
          'Date filter: received on/after. Accepts ISO 8601, YYYY-MM-DD, or relative like "7d" / "yesterday"',
        ),
      before: z.string().optional().describe('Date filter: received strictly before'),
      on: z.string().optional().describe('Date filter: received on specific date'),
      sent_since: z
        .string()
        .optional()
        .describe(
          'Date header: sent on/after (differs from since which uses internal delivery date)',
        ),
      sent_before: z.string().optional().describe('Date header: sent before'),
      from: z.string().optional().describe('Filter by sender address or name'),
      subject: z.string().optional().describe('Substring in Subject'),
      to: z.string().optional().describe('Substring in To'),
      cc: z.string().optional().describe('Substring in Cc'),
      bcc: z.string().optional().describe('Substring in Bcc'),
      text: z.string().optional().describe('Any text field (headers + body)'),
      body: z.string().optional().describe('Body only'),
      seen: z.boolean().optional().describe('true = read only; false = unread only'),
      flagged: z.boolean().optional().describe('true = flagged; false = unflagged'),
      has_attachment: z
        .boolean()
        .optional()
        .describe('Filter: true=has attachments, false=no attachments'),
      answered: z.boolean().optional().describe('Filter: true=replied, false=not yet replied'),
      draft: z.boolean().optional(),
      deleted: z.boolean().optional(),
      keyword: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe('IMAP keyword/label (AND when array)'),
      not_keyword: z.union([z.string(), z.array(z.string())]).optional(),
      header: z
        .record(z.string(), z.string())
        .optional()
        .describe('Arbitrary header name/value match, e.g. {"X-Custom": "value"}'),
      uids: z
        .union([z.array(z.number()), z.string()])
        .optional()
        .describe('Specific UID ranges (array of numbers or IMAP sequence string like "1:100")'),
      larger_than: z.number().optional().describe('Minimum email size in KB'),
      smaller_than: z.number().optional().describe('Maximum email size in KB'),
      attachment_filename: z
        .string()
        .optional()
        .describe(
          'Filter by attachment filename substring (case-insensitive). Example: "lease" matches "signed_lease_v7.pdf".',
        ),
      attachment_mimetype: z
        .string()
        .optional()
        .describe(
          'Filter by MIME type regex (case-insensitive). Examples: "application/pdf", "image/.*".',
        ),
      gmail_raw: z
        .string()
        .optional()
        .describe(
          "Gmail accounts ONLY: pass Gmail search syntax (e.g. 'from:foo has:attachment') for dramatically faster server-side search. Other filters ignored when set.",
        ),
    },
    { readOnlyHint: true, destructiveHint: false },
    async (params) => {
      try {
        const result = await imapService.listEmails(params.account, {
          mailbox: params.mailbox,
          page: params.page,
          pageSize: params.pageSize,
          since: params.since,
          before: params.before,
          on: params.on,
          sentSince: params.sent_since,
          sentBefore: params.sent_before,
          from: params.from,
          subject: params.subject,
          to: params.to,
          cc: params.cc,
          bcc: params.bcc,
          text: params.text,
          body: params.body,
          seen: params.seen,
          flagged: params.flagged,
          hasAttachment: params.has_attachment,
          answered: params.answered,
          draft: params.draft,
          deleted: params.deleted,
          keyword: params.keyword,
          notKeyword: params.not_keyword,
          header: params.header,
          uids: params.uids,
          largerThan: params.larger_than,
          smallerThan: params.smaller_than,
          attachmentFilename: params.attachment_filename,
          attachmentMimetype: params.attachment_mimetype,
          gmailRaw: params.gmail_raw,
        });

        const warningPrefix = result.warning ? `⚠️ ${result.warning}\n` : '';

        if (result.items.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `${warningPrefix}No emails found matching the criteria.`,
              },
            ],
          };
        }

        const totalDisplay = result.totalApprox ? `~${result.total}` : `${result.total}`;
        const header =
          `📬 [${params.mailbox}] ${totalDisplay} emails ` +
          `(page ${result.page}/${Math.ceil(result.total / result.pageSize)})` +
          `${result.hasMore ? ' — more pages available' : ''}\n`;
        const emails = result.items.map(formatEmailMeta).join('\n\n');

        return {
          content: [
            {
              type: 'text' as const,
              text: `${warningPrefix}${header}\n${emails}`,
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to list emails: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // get_email
  // ---------------------------------------------------------------------------
  server.tool(
    'get_email',
    'Get the full content of a specific email by ID. ' +
      'Does NOT mark the email as seen (uses IMAP BODY.PEEK — non-destructive). ' +
      'Use format="text" to strip HTML, or format="stripped" to also remove quoted replies and signatures. ' +
      'Use maxLength to cap the body size for large emails. ' +
      'Set markRead=true only when you want to explicitly mark the email as read.',
    {
      account: z.string().describe('Account name from list_accounts'),
      emailId: z.string().describe('Email ID from list_emails or search_emails'),
      mailbox: z.string().default('INBOX').describe('Mailbox path (default: INBOX)'),
      format: z
        .enum(['full', 'text', 'stripped'])
        .default('full')
        .describe(
          'Body format: full=raw (default), text=plain text (strips HTML), stripped=plain text without quoted replies or signatures',
        ),
      maxLength: z
        .number()
        .int()
        .min(100)
        .optional()
        .describe(
          'Truncate body at this many characters. A hint shows how many characters remain.',
        ),
      markRead: z
        .boolean()
        .default(false)
        .describe(
          'Explicitly mark the email as read after fetching (default: false — reading is non-destructive by default)',
        ),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ account, emailId, mailbox, format, maxLength, markRead }) => {
      try {
        const email = await imapService.getEmail(account, emailId, mailbox);

        const parts: string[] = [
          `📧 ${email.subject}`,
          `Status: ${formatEmailStatus(email)}`,
          `From:   ${email.from.name ? `${email.from.name} <${email.from.address}>` : email.from.address}`,
          `To:     ${email.to.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ')}`,
        ];

        if (email.cc?.length) {
          parts.push(`CC:     ${email.cc.map((a) => a.address).join(', ')}`);
        }

        parts.push(`Date:   ${email.date}`);
        parts.push(`ID:     ${email.messageId}`);

        if (email.inReplyTo) {
          parts.push(`Reply:  ${email.inReplyTo}`);
        }

        if (email.attachments.length > 0) {
          parts.push(
            `📎 Attachments: ${email.attachments.map((a) => `${a.filename} (${a.mimeType}, ${formatSize(a.size)})`).join(', ')}`,
          );
        }

        parts.push('', '--- Body ---', '');
        parts.push(
          applyBodyFormat(email.bodyText, email.bodyHtml, format as BodyFormat, maxLength),
        );

        if (markRead) {
          await imapService.setFlags(account, emailId, mailbox, 'read');
        }

        return {
          content: [{ type: 'text' as const, text: parts.join('\n') }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to get email: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // get_emails  (batch content fetch)
  // ---------------------------------------------------------------------------
  server.tool(
    'get_emails',
    'Fetch the full content of multiple emails in a single call (max 20). ' +
      'More efficient than calling get_email repeatedly when triaging or summarising several emails. ' +
      'Does NOT mark emails as seen. ' +
      'Defaults to format="text" (HTML stripped) for compact, AI-friendly output.',
    {
      account: z.string().describe('Account name from list_accounts'),
      ids: z
        .array(z.string())
        .min(1)
        .max(20)
        .describe('Email IDs to fetch (max 20). Obtain IDs from list_emails or search_emails.'),
      mailbox: z.string().default('INBOX').describe('Mailbox path (default: INBOX)'),
      format: z
        .enum(['full', 'text', 'stripped'])
        .default('text')
        .describe(
          'Body format (default: text — strips HTML for efficient AI reading). Use stripped to also remove quoted replies.',
        ),
      maxLength: z
        .number()
        .int()
        .min(100)
        .optional()
        .describe('Truncate each email body at this many characters.'),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ account, ids, mailbox, format, maxLength }) => {
      const results: string[] = [];
      const errors: string[] = [];

      const settled = await Promise.allSettled(
        ids.map(async (emailId) => imapService.getEmail(account, emailId, mailbox)),
      );

      settled.forEach((outcome, i) => {
        const emailId = ids[i];
        if (outcome.status === 'fulfilled') {
          const email = outcome.value;
          const from = email.from.name
            ? `${email.from.name} <${email.from.address}>`
            : email.from.address;
          const body = applyBodyFormat(
            email.bodyText,
            email.bodyHtml,
            format as BodyFormat,
            maxLength,
          );
          const attachLine =
            email.attachments.length > 0
              ? `📎 ${email.attachments.map((a) => a.filename).join(', ')}`
              : '';

          results.push(
            [
              `━━━ [${emailId}] ${email.subject}`,
              `Status: ${formatEmailStatus(email)}`,
              `From:   ${from}`,
              `Date:   ${email.date}`,
              attachLine,
              '',
              body,
            ]
              .filter((l) => l !== '')
              .join('\n'),
          );
        } else {
          const err = outcome.reason as unknown;
          errors.push(`[${emailId}] Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      });

      const errSuffix = errors.length > 0 ? `, ${errors.length} error(s)` : '';
      const summary = `📬 [${mailbox}] ${results.length} email(s) fetched${errSuffix}`;

      const parts: string[] = [summary, '', ...results];
      if (errors.length > 0) {
        parts.push('', '--- Errors ---', ...errors);
      }

      return {
        content: [{ type: 'text' as const, text: parts.join('\n') }],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // get_email_status  (lightweight flag/label check — no body fetch)
  // ---------------------------------------------------------------------------
  server.tool(
    'get_email_status',
    'Get the current read/flag/label state of an email without fetching its body. ' +
      'Much cheaper than get_email when you only need to check whether an email is unread, ' +
      'flagged, or which labels it has. ' +
      'Also useful to confirm the result of a mark_email call. ' +
      'Does NOT mark the email as seen.',
    {
      account: z.string().describe('Account name from list_accounts'),
      emailId: z.string().describe('Email ID from list_emails or search_emails'),
      mailbox: z.string().default('INBOX').describe('Mailbox path (default: INBOX)'),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ account, emailId, mailbox }) => {
      try {
        const flags = await imapService.getEmailFlags(account, emailId, mailbox);

        const statusParts: string[] = [flags.seen ? '✓ Read' : '🔵 Unread'];
        if (flags.flagged) statusParts.push('⭐ Flagged');
        if (flags.answered) statusParts.push('↩️ Replied');

        const lines = [
          `📊 Email Status`,
          `ID:      ${emailId} | Mailbox: ${mailbox}`,
          `Subject: ${flags.subject}`,
          `From:    ${flags.from}`,
          `Date:    ${flags.date}`,
          `Status:  ${statusParts.join(' · ')}`,
          `Labels:  ${flags.labels.length > 0 ? flags.labels.join(', ') : '(none)'}`,
        ];

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to get email status: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // search_emails
  // ---------------------------------------------------------------------------
  server.tool(
    'search_emails',
    'Search emails with server-side filters. Omit query (or pass an empty string) to use pure filters. ' +
      'Supports date ranges (since/before/on, including "7d" / "yesterday"), subject/from/to/cc/bcc/body/text ' +
      'filters, read/flag/answered state, keywords/labels, header matches, UID ranges, size limits, and attachments. ' +
      "On Gmail accounts, pass gmail_raw (e.g. 'from:foo has:attachment older_than:30d') for a dramatically " +
      'faster native Gmail search. Results are paginated; large result sets are capped at 5000 UIDs with a warning.',
    {
      account: z.string().describe('Account name from list_accounts'),
      query: z
        .string()
        .optional()
        .default('')
        .describe('Search keyword across subject/from/body (omit to use filters only)'),
      mailbox: z.string().default('INBOX').describe('Mailbox path (default: INBOX)'),
      page: z.number().int().min(1).default(1).describe('Page number'),
      pageSize: z.number().int().min(1).max(100).default(20).describe('Results per page'),
      to: z.string().optional().describe('Filter by recipient address'),
      from: z.string().optional().describe('Filter by sender address or name'),
      subject: z.string().optional().describe('Substring in Subject'),
      cc: z.string().optional().describe('Substring in Cc'),
      bcc: z.string().optional().describe('Substring in Bcc'),
      text: z.string().optional().describe('Any text field (headers + body)'),
      body: z.string().optional().describe('Body only'),
      since: z
        .string()
        .optional()
        .describe(
          'Date filter: received on/after. Accepts ISO 8601, YYYY-MM-DD, or relative like "7d" / "yesterday"',
        ),
      before: z.string().optional().describe('Date filter: received strictly before'),
      on: z.string().optional().describe('Date filter: received on specific date'),
      sent_since: z
        .string()
        .optional()
        .describe(
          'Date header: sent on/after (differs from since which uses internal delivery date)',
        ),
      sent_before: z.string().optional().describe('Date header: sent before'),
      seen: z.boolean().optional().describe('true = read only; false = unread only'),
      flagged: z.boolean().optional().describe('true = flagged; false = unflagged'),
      has_attachment: z
        .boolean()
        .optional()
        .describe('Filter: true=has attachments, false=no attachments'),
      larger_than: z.number().optional().describe('Minimum email size in KB'),
      smaller_than: z.number().optional().describe('Maximum email size in KB'),
      answered: z.boolean().optional().describe('Filter: true=replied, false=not replied'),
      draft: z.boolean().optional(),
      deleted: z.boolean().optional(),
      keyword: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe('IMAP keyword/label (AND when array)'),
      not_keyword: z.union([z.string(), z.array(z.string())]).optional(),
      header: z
        .record(z.string(), z.string())
        .optional()
        .describe('Arbitrary header name/value match, e.g. {"X-Custom": "value"}'),
      uids: z
        .union([z.array(z.number()), z.string()])
        .optional()
        .describe('Specific UID ranges (array of numbers or IMAP sequence string like "1:100")'),
      attachment_filename: z
        .string()
        .optional()
        .describe(
          'Filter by attachment filename substring (case-insensitive). Example: "lease" matches "signed_lease_v7.pdf".',
        ),
      attachment_mimetype: z
        .string()
        .optional()
        .describe(
          'Filter by MIME type regex (case-insensitive). Examples: "application/pdf", "image/.*".',
        ),
      facets: z
        .array(z.enum(['sender', 'year', 'mailbox']))
        .optional()
        .describe(
          'Return bucketed counts by sender/year/mailbox alongside the paginated results. ' +
            'Useful for understanding large result sets. Skipped if match set exceeds 10000 UIDs.',
        ),
      gmail_raw: z
        .string()
        .optional()
        .describe(
          "Gmail accounts ONLY: pass Gmail search syntax (e.g. 'from:foo has:attachment') for dramatically faster server-side search. Other filters ignored when set.",
        ),
    },
    { readOnlyHint: true, destructiveHint: false },
    async (params) => {
      try {
        const result = await imapService.searchEmails(params.account, params.query ?? '', {
          mailbox: params.mailbox,
          page: params.page,
          pageSize: params.pageSize,
          to: params.to,
          from: params.from,
          subject: params.subject,
          cc: params.cc,
          bcc: params.bcc,
          text: params.text,
          body: params.body,
          since: params.since,
          before: params.before,
          on: params.on,
          sentSince: params.sent_since,
          sentBefore: params.sent_before,
          seen: params.seen,
          flagged: params.flagged,
          hasAttachment: params.has_attachment,
          largerThan: params.larger_than,
          smallerThan: params.smaller_than,
          answered: params.answered,
          draft: params.draft,
          deleted: params.deleted,
          keyword: params.keyword,
          notKeyword: params.not_keyword,
          header: params.header,
          uids: params.uids,
          attachmentFilename: params.attachment_filename,
          attachmentMimetype: params.attachment_mimetype,
          facets: params.facets,
          gmailRaw: params.gmail_raw,
        });

        const totalDisplay = result.totalApprox ? `~${result.total}` : `${result.total}`;
        const queryLabel = params.query ? `"${params.query}"` : 'filters';
        const totalPages = result.total > 0 ? Math.ceil(result.total / result.pageSize) : 1;
        const header =
          `🔍 [${params.mailbox}] ${totalDisplay} result(s) for ${queryLabel} ` +
          `(page ${result.page}/${totalPages})\n`;
        const emptyMsg = params.query
          ? `No emails found matching "${params.query}".`
          : 'No emails found matching the specified filters.';

        return {
          content: [
            {
              type: 'text' as const,
              text: formatSearchResult(result, header, emptyMsg),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to search emails: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // search_all_accounts
  // ---------------------------------------------------------------------------
  server.tool(
    'search_all_accounts',
    'Search emails across multiple accounts in parallel. Same filter set as search_emails ' +
      'but fans out across N accounts and merges results sorted by date. Each result is tagged ' +
      'with the account it came from. Partial failures are surfaced as warnings without failing ' +
      'the whole call. Useful for "find X anywhere in my inboxes" queries across your email ecosystem.',
    {
      query: z
        .string()
        .optional()
        .default('')
        .describe('Search keyword across subject/from/body (omit to use filters only)'),
      accounts: z
        .array(z.string())
        .optional()
        .describe('Specific accounts to search (default: all accounts from list_accounts)'),
      mailbox: z.string().default('INBOX').describe('Mailbox path (default: INBOX)'),
      page: z.number().int().min(1).default(1).describe('Page number of the merged result set'),
      pageSize: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe('Results per page (merged across accounts)'),
      to: z.string().optional(),
      from: z.string().optional(),
      subject: z.string().optional(),
      cc: z.string().optional(),
      bcc: z.string().optional(),
      text: z.string().optional(),
      body: z.string().optional(),
      since: z.string().optional(),
      before: z.string().optional(),
      on: z.string().optional(),
      sent_since: z.string().optional(),
      sent_before: z.string().optional(),
      seen: z.boolean().optional(),
      flagged: z.boolean().optional(),
      has_attachment: z.boolean().optional(),
      larger_than: z.number().optional(),
      smaller_than: z.number().optional(),
      answered: z.boolean().optional(),
      draft: z.boolean().optional(),
      deleted: z.boolean().optional(),
      keyword: z.union([z.string(), z.array(z.string())]).optional(),
      not_keyword: z.union([z.string(), z.array(z.string())]).optional(),
      header: z.record(z.string(), z.string()).optional(),
      attachment_filename: z.string().optional(),
      attachment_mimetype: z.string().optional(),
      facets: z.array(z.enum(['sender', 'year', 'mailbox'])).optional(),
      gmail_raw: z
        .string()
        .optional()
        .describe(
          'Gmail accounts ONLY (when targeted accounts include Gmail). Non-Gmail accounts in the ' +
            'fan-out will error individually and appear in warnings.',
        ),
    },
    { readOnlyHint: true, destructiveHint: false },
    async (params) => {
      try {
        const accountNames =
          params.accounts && params.accounts.length > 0
            ? params.accounts
            : connections.getAccountNames();

        if (accountNames.length === 0) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: 'No accounts configured — add at least one account to config.toml.',
              },
            ],
          };
        }

        const result = await imapService.searchAcrossAccounts(accountNames, params.query ?? '', {
          mailbox: params.mailbox,
          page: params.page,
          pageSize: params.pageSize,
          to: params.to,
          from: params.from,
          subject: params.subject,
          cc: params.cc,
          bcc: params.bcc,
          text: params.text,
          body: params.body,
          since: params.since,
          before: params.before,
          on: params.on,
          sentSince: params.sent_since,
          sentBefore: params.sent_before,
          seen: params.seen,
          flagged: params.flagged,
          hasAttachment: params.has_attachment,
          largerThan: params.larger_than,
          smallerThan: params.smaller_than,
          answered: params.answered,
          draft: params.draft,
          deleted: params.deleted,
          keyword: params.keyword,
          notKeyword: params.not_keyword,
          header: params.header,
          attachmentFilename: params.attachment_filename,
          attachmentMimetype: params.attachment_mimetype,
          facets: params.facets,
          gmailRaw: params.gmail_raw,
        });

        const totalDisplay = result.totalApprox ? `~${result.total}` : `${result.total}`;
        const queryLabel = params.query ? `"${params.query}"` : 'filters';
        const totalPages = result.total > 0 ? Math.ceil(result.total / result.pageSize) : 1;
        const header =
          `🔍 [${accountNames.length} account(s) · ${params.mailbox}] ` +
          `${totalDisplay} result(s) for ${queryLabel} ` +
          `(page ${result.page}/${totalPages})\n`;
        const emptyMsg = params.query
          ? `No emails found matching "${params.query}" across ${accountNames.length} account(s).`
          : `No emails found matching the specified filters across ${accountNames.length} account(s).`;

        return {
          content: [
            {
              type: 'text' as const,
              text: formatSearchResult(result, header, emptyMsg),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to search accounts: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
