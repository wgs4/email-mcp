/**
 * MCP tool: export_search — run a search across one or many accounts and
 * stream the result set to a CSV or NDJSON file under `~/Downloads/` (or an
 * explicit destination).
 *
 * Bypasses the MCP response byte budget: the tool returns a tiny summary
 * (path, rows_written, truncated) and the bulk of the data lives on disk.
 */

import { createWriteStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type ConnectionManager from '../connections/manager.js';
import { toCsvRow } from '../services/csv.js';
import { assertSafeDestination } from '../services/file-paths.js';
import type ImapService from '../services/imap.service.js';
import type { EmailMeta } from '../types/index.js';

/** Column names understood for CSV output. */
type CsvColumn =
  | 'id'
  | 'account'
  | 'date'
  | 'from'
  | 'to'
  | 'subject'
  | 'flags'
  | 'labels'
  | 'attachments'
  | 'preview'
  | 'size';

/** Default column ordering when `columns` is omitted. */
const DEFAULT_CSV_COLUMNS = [
  'id',
  'account',
  'date',
  'from',
  'subject',
  'labels',
  'attachments',
  'has_attachments',
  'seen',
  'flagged',
] as const;
// Default set includes a few derived columns not in CSV_COLUMNS (has_attachments,
// seen, flagged) — we widen the type below so they render correctly.
type DefaultColumn = (typeof DEFAULT_CSV_COLUMNS)[number];

function fromString(meta: EmailMeta): string {
  const { from } = meta;
  if (from.name && from.address) return `${from.name} <${from.address}>`;
  return from.address;
}

function toFieldString(meta: EmailMeta): string {
  return meta.to.map((t) => (t.name ? `${t.name} <${t.address}>` : t.address)).join(', ');
}

function flagsString(meta: EmailMeta): string {
  const flags: string[] = [];
  if (meta.seen) flags.push('seen');
  if (meta.flagged) flags.push('flagged');
  if (meta.answered) flags.push('answered');
  return flags.join('|');
}

function attachmentsString(meta: EmailMeta): string {
  return (meta.attachments ?? []).map((a) => a.filename).join('|');
}

function columnValue(meta: EmailMeta, col: CsvColumn | DefaultColumn): string {
  switch (col) {
    case 'id':
      return meta.id;
    case 'account':
      return meta.account ?? '';
    case 'date':
      return meta.date;
    case 'from':
      return fromString(meta);
    case 'to':
      return toFieldString(meta);
    case 'subject':
      return meta.subject;
    case 'flags':
      return flagsString(meta);
    case 'labels':
      return meta.labels.join('|');
    case 'attachments':
      return attachmentsString(meta);
    case 'preview':
      return meta.preview ?? '';
    case 'size':
      // EmailMeta doesn't track size directly — fall back to summed attachment size
      return String((meta.attachments ?? []).reduce((s, a) => s + a.size, 0));
    case 'has_attachments':
      return meta.hasAttachments ? 'true' : 'false';
    case 'seen':
      return meta.seen ? 'true' : 'false';
    case 'flagged':
      return meta.flagged ? 'true' : 'false';
    default:
      return '';
  }
}

/**
 * Write the export to disk. Exported for unit tests that want to exercise
 * the writer without going through the full tool handler.
 *
 * Builds the serialized payload in-memory then streams it to disk. Memory
 * pressure is bounded by `max_rows` (hard ceiling 50_000) × per-row size,
 * well below any reasonable budget.
 */
export async function writeExport(params: {
  format: 'csv' | 'ndjson';
  items: EmailMeta[];
  columns: (CsvColumn | DefaultColumn)[];
  destination: string;
}): Promise<number> {
  let body: string;
  let rowsWritten: number;

  if (params.format === 'csv') {
    const header = toCsvRow([...params.columns]);
    const dataRows = params.items.map((item) => {
      const row = params.columns.map((c) => columnValue(item, c));
      return toCsvRow(row);
    });
    body = `${[header, ...dataRows].join('\n')}\n`;
    rowsWritten = dataRows.length;
  } else {
    const lines = params.items.map((item) => JSON.stringify(item));
    body = lines.length > 0 ? `${lines.join('\n')}\n` : '';
    rowsWritten = lines.length;
  }

  const ws = createWriteStream(params.destination);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    ws.on('error', rejectPromise);
    ws.on('finish', resolvePromise);
    ws.end(body);
  });

  return rowsWritten;
}

export default function registerExportTools(
  server: McpServer,
  imapService: ImapService,
  connections: ConnectionManager,
): void {
  server.tool(
    'export_search',
    'Run any search_emails / search_all_accounts query and stream the result set to a CSV or ' +
      'NDJSON file under ~/Downloads/ (or a caller-supplied destination). Bypasses the MCP response ' +
      'byte budget — returns only a summary (path, rows_written, truncated). Default CSV columns: ' +
      'id, account, date, from, subject, labels, attachments, has_attachments, seen, flagged.',
    {
      account: z.string().optional().describe('Single-account mode'),
      accounts: z
        .array(z.string())
        .optional()
        .describe('Cross-account fan-out; defaults to every configured account'),
      mailbox: z.string().default('INBOX'),
      query: z.string().optional().default(''),
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
      gmail_raw: z.string().optional(),
      format: z.enum(['csv', 'ndjson']).default('csv'),
      max_rows: z.number().int().min(1).max(50000).default(5000),
      columns: z
        .array(
          z.enum([
            'id',
            'account',
            'date',
            'from',
            'to',
            'subject',
            'flags',
            'labels',
            'attachments',
            'preview',
            'size',
          ]),
        )
        .optional()
        .describe('CSV only; ignored for NDJSON (NDJSON always writes full EmailMeta JSON)'),
      destination: z
        .string()
        .optional()
        .describe('Absolute path. Default: ~/Downloads/email-export-<ISO-ts>.{csv|ndjson}'),
    },
    { readOnlyHint: true, destructiveHint: false },
    async (params) => {
      try {
        const tsSlug = new Date().toISOString().replace(/[:.]/g, '-');
        const defaultPath = join(homedir(), 'Downloads', `email-export-${tsSlug}.${params.format}`);
        const destination = params.destination ?? defaultPath;

        // Path safety — reject anything outside $HOME or /tmp.
        assertSafeDestination(destination);

        // Resolve account mode
        let accountNames: string[] | null = null;
        let accountName: string | null = null;
        if (params.account) {
          accountName = params.account;
        } else if (params.accounts && params.accounts.length > 0) {
          accountNames = params.accounts;
        } else {
          accountNames = connections.getAccountNames();
        }

        const { items, truncated } = await imapService.searchForExport(
          accountNames,
          accountName,
          params.query ?? '',
          {
            mailbox: params.mailbox,
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
            gmailRaw: params.gmail_raw,
            maxRows: params.max_rows,
          },
        );

        // Column list — CSV only. For NDJSON we always dump the full EmailMeta.
        const columns: (CsvColumn | DefaultColumn)[] =
          params.format === 'csv' ? (params.columns ?? [...DEFAULT_CSV_COLUMNS]) : [];

        const rowsWritten = await writeExport({
          format: params.format,
          items,
          columns,
          destination,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  path: destination,
                  rows_written: rowsWritten,
                  truncated,
                  format: params.format,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to export search: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
