/**
 * MCP tools: maildir_search, maildir_get_email, maildir_save_attachment.
 *
 * Read-only search of the raw Dovecot Maildir store on the mail server over
 * SSH. Reaches EVERY mailbox on the server, including ones that are not
 * configured as IMAP accounts here. Registered only when `[maildir] enabled =
 * true` (off by default). See docs/maildir-search.md.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type MaildirService from '../services/maildir/maildir.service.js';
import { HEADER_FIELDS } from '../services/maildir/patterns.js';

function errorResult(prefix: string, err: unknown) {
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: `${prefix}: ${err instanceof Error ? err.message : String(err)}`,
      },
    ],
  };
}

const NOTICE =
  'Reads the raw mail store of EVERY mailbox on the mail server (all employees), read-only.';

export default function registerMaildirTools(server: McpServer, maildir: MaildirService): void {
  // ---------------------------------------------------------------------------
  // maildir_search
  // ---------------------------------------------------------------------------
  server.tool(
    'maildir_search',
    `${NOTICE} Search all mailboxes, all folders and all years on the mail server directly ` +
      '(including mailboxes that are not IMAP accounts here). Default: header search ' +
      '(From/To/Cc/Subject), fixed string, case-insensitive. Use mode="full_text" for bodies, ' +
      'attachment_name for file names, since/before for dates, domains/users/folders to narrow. ' +
      'Results are newest first and paged (offset/limit); later pages come from a 10-minute cache. ' +
      'ALWAYS check "complete": false means the search was cut short (time limit, cap or error) ' +
      'and missing results are NOT proof that a message does not exist.',
    {
      query: z
        .string()
        .optional()
        .describe('Term to find. Header search by default; see mode and fields.'),
      mode: z
        .enum(['headers', 'full_text'])
        .default('headers')
        .describe(
          'headers = only the header block of each message (fast). full_text = whole message incl. body (slower).',
        ),
      fields: z
        .array(z.enum(HEADER_FIELDS))
        .optional()
        .describe('Header fields for mode=headers. Default: from, to, cc, subject.'),
      regex: z
        .boolean()
        .default(false)
        .describe(
          'Treat every term as a regular expression (PCRE on the server; must also compile in JavaScript). Default: fixed string.',
        ),
      from: z.string().optional().describe('From header contains this (AND).'),
      to: z.string().optional().describe('To header contains this (AND).'),
      subject: z.string().optional().describe('Subject header contains this (AND).'),
      attachment_name: z
        .string()
        .optional()
        .describe(
          'An attachment file name contains this (AND). Matches name=/filename= MIME parameters.',
        ),
      domains: z
        .array(z.string())
        .optional()
        .describe('Only these mail domains, e.g. ["wgsusa.com"]. Default: all allowed.'),
      users: z
        .array(z.string())
        .optional()
        .describe('Only these mailboxes: "justin" (any domain) or "justin@wgsusa.com".'),
      folders: z
        .array(z.string())
        .optional()
        .describe(
          'Only folders whose name matches one of these globs (* and ?), case-insensitive. ' +
            'INBOX is "INBOX"; others as on the server, e.g. "Archive", "Sent*", "Archives.2020".',
        ),
      exclude_folders: z
        .array(z.string())
        .optional()
        .describe('Skip folders matching these globs, e.g. ["Junk", "spam", "Trash"].'),
      since: z
        .string()
        .optional()
        .describe(
          'Delivered after this time (YYYY-MM-DD = the start of that day; mail-server local time).',
        ),
      before: z
        .string()
        .optional()
        .describe(
          'Delivered before this time (YYYY-MM-DD = the start of that day; YYYY-MM-DD HH:MM; mail-server local time). since=2025-03-01, before=2025-04-01 = all of March.',
        ),
      offset: z.number().int().min(0).default(0).describe('Paging offset.'),
      limit: z.number().int().min(1).max(200).default(50).describe('Page size (max 200).'),
      max_results: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Stop after this many hits (capped by config max_results).'),
      timeout_seconds: z
        .number()
        .int()
        .min(5)
        .optional()
        .describe('Time budget for the whole search (capped by config max_timeout_seconds).'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async (params) => {
      try {
        const result = await maildir.search(params);
        const head = result.complete
          ? `Search complete: ${String(result.total_hits)} hit(s).`
          : `PARTIAL RESULT — the search did not finish: ${result.partial_reasons.join(' ')} ` +
            `Found ${String(result.total_hits)} hit(s) so far. Missing results do NOT mean the ` +
            'message does not exist.';
        const body = {
          content: [
            { type: 'text' as const, text: head },
            { type: 'text' as const, text: JSON.stringify(result, null, 2) },
          ],
        };
        // A cut-short search with no hits must never read as "not found".
        if (!result.complete && result.total_hits === 0) return { isError: true, ...body };
        return body;
      } catch (err) {
        return errorResult('maildir_search failed (nothing was found or ruled out)', err);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // maildir_get_email
  // ---------------------------------------------------------------------------
  server.tool(
    'maildir_get_email',
    `${NOTICE} Read one message by id from maildir_search: headers, text body (size-capped), ` +
      'the attachment list (index, filename, type, size), and optionally the original HTML body ' +
      '(include_html) for callers that must store or parse raw HTML.',
    {
      id: z
        .string()
        .min(1)
        .describe('Message id from maildir_search (path under the Maildir root).'),
      max_body_chars: z
        .number()
        .int()
        .min(100)
        .optional()
        .describe('Cap on returned text body characters (capped by config max_body_chars).'),
      include_headers: z
        .boolean()
        .default(false)
        .describe('Also return the raw header block (max 64 KiB).'),
      include_html: z
        .boolean()
        .default(false)
        .describe(
          'Also return the original HTML body part in html (for callers that must store or parse raw HTML, e.g. UPS billing notices).',
        ),
      max_html_chars: z
        .number()
        .int()
        .min(100)
        .max(2_000_000)
        .optional()
        .describe(
          'Cap on returned HTML body characters when include_html is true (default 500,000, max 2,000,000).',
        ),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ id, max_body_chars, include_headers, include_html, max_html_chars }) => {
      try {
        const result = await maildir.getEmail(id, {
          maxBodyChars: max_body_chars,
          includeHeaders: include_headers,
          includeHtml: include_html,
          maxHtmlChars: max_html_chars,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorResult('maildir_get_email failed', err);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // maildir_save_attachment
  // ---------------------------------------------------------------------------
  server.tool(
    'maildir_save_attachment',
    `${NOTICE} Save one attachment of a message (id from maildir_search) to a local file. ` +
      'Destination must be under your home directory or the tmp dir; default ~/Downloads/. ' +
      'Nothing on the mail server is changed.',
    {
      id: z.string().min(1).describe('Message id from maildir_search.'),
      filename: z
        .string()
        .optional()
        .describe('Exact decoded attachment filename from maildir_get_email.'),
      index: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Attachment index from maildir_get_email (use when names repeat).'),
      destination: z
        .string()
        .optional()
        .describe('Absolute file path or directory. Default: ~/Downloads/'),
      overwrite: z
        .boolean()
        .default(false)
        .describe('Overwrite an existing file; otherwise add -1, -2, ... to the name.'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async (params) => {
      try {
        const result = await maildir.saveAttachment(params);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorResult('maildir_save_attachment failed', err);
      }
    },
  );
}
