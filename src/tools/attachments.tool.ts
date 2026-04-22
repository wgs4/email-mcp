/**
 * MCP tools: download_attachment, save_attachment, save_all_attachments_from_search.
 *
 * `download_attachment` returns base64 through the MCP response (legacy — 5 MB
 * ceiling, ~25k token cap). The two new tools bypass that and write directly
 * to disk under `$HOME` or `/tmp`.
 */

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type ConnectionManager from '../connections/manager.js';
import type ImapService from '../services/imap.service.js';

export default function registerAttachmentTools(
  server: McpServer,
  imapService: ImapService,
  connections: ConnectionManager,
): void {
  // ---------------------------------------------------------------------------
  // download_attachment (legacy — base64 through MCP response)
  // ---------------------------------------------------------------------------
  server.tool(
    'download_attachment',
    'Download an email attachment by filename. First use get_email to see available attachments and their filenames. Returns base64-encoded content for files ≤5MB.',
    {
      account: z.string().describe('Account name from list_accounts'),
      id: z.string().describe('Email ID (UID) from list_emails or get_email'),
      mailbox: z.string().default('INBOX').describe('Mailbox containing the email'),
      filename: z.string().describe('Exact attachment filename (from get_email metadata)'),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ account, id, mailbox, filename }) => {
      try {
        const result = await imapService.downloadAttachment(account, id, mailbox, filename);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  filename: result.filename,
                  mimeType: result.mimeType,
                  size: result.size,
                  sizeHuman: `${Math.round(result.size / 1024)}KB`,
                },
                null,
                2,
              ),
            },
            {
              type: 'text' as const,
              text: `\n--- Base64 Content ---\n${result.contentBase64}`,
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to download attachment: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // save_attachment — direct-to-disk, no base64 hop
  // ---------------------------------------------------------------------------
  server.tool(
    'save_attachment',
    'Save an email attachment directly to disk. Unlike download_attachment (which returns base64), ' +
      'this writes the file to your filesystem without size limits and without streaming bytes through ' +
      'the MCP response. Default destination is ~/Downloads/<filename>.',
    {
      account: z.string().describe('Account name from list_accounts'),
      emailId: z.string().describe('Email ID (UID) from list_emails or get_email'),
      mailbox: z.string().default('INBOX').describe('Mailbox containing the email'),
      filename: z.string().describe('Exact attachment filename from get_email metadata'),
      destination: z
        .string()
        .optional()
        .describe(
          'Absolute path OR directory. If directory, the attachment keeps its original filename. ' +
            'Default: ~/Downloads/',
        ),
      open: z
        .boolean()
        .default(false)
        .describe('Open the file in the default macOS application after save'),
      overwrite: z
        .boolean()
        .default(false)
        .describe(
          'Allow overwriting an existing file; otherwise auto-suffix (file-1.pdf, file-2.pdf)',
        ),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ account, emailId, mailbox, filename, destination, open, overwrite }) => {
      try {
        const target = destination ?? join(homedir(), 'Downloads');
        const result = await imapService.saveAttachmentToDisk(
          account,
          emailId,
          mailbox,
          filename,
          target,
          overwrite,
        );

        if (open && process.platform === 'darwin') {
          try {
            const child = spawn('open', [result.path], {
              detached: true,
              stdio: 'ignore',
            });
            child.unref();
          } catch {
            // Non-fatal — file was saved, we just couldn't open it.
          }
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  path: result.path,
                  size: result.size,
                  sizeHuman: `${Math.round(result.size / 1024)}KB`,
                  mimeType: result.mimeType,
                  opened: open && process.platform === 'darwin',
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
              text: `Failed to save attachment: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // save_all_attachments_from_search — batch sweep
  // ---------------------------------------------------------------------------
  server.tool(
    'save_all_attachments_from_search',
    'Run a search and download every attachment (optionally filtered by filename/mimetype) into a ' +
      'dated folder under ~/Downloads/. Useful for audit exports, year-end lease PDF sweeps, vendor ' +
      'invoice collections.',
    {
      account: z
        .string()
        .optional()
        .describe('Single-account mode; mutually exclusive with accounts'),
      accounts: z
        .array(z.string())
        .optional()
        .describe(
          'Cross-account fan-out; defaults to all accounts when neither account nor accounts is set',
        ),
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
      gmail_raw: z.string().optional(),
      attachment_filename: z
        .string()
        .optional()
        .describe('Only save attachments whose filename matches this substring (case-insensitive)'),
      attachment_mimetype: z
        .string()
        .optional()
        .describe('Only save attachments whose MIME type matches this regex'),
      max_emails: z.number().int().min(1).max(10000).default(1000),
      destination: z
        .string()
        .optional()
        .describe('Destination folder. Default: ~/Downloads/email-attachments-<ts>/'),
      organize_by: z
        .enum(['flat', 'date', 'sender', 'account'])
        .default('flat')
        .describe('Subfolder structure under destination'),
    },
    { readOnlyHint: true, destructiveHint: false },
    async (params) => {
      try {
        // Default destination — dated subfolder under ~/Downloads.
        const tsSlug = new Date().toISOString().replace(/[:.]/g, '-');
        const folder =
          params.destination ?? join(homedir(), 'Downloads', `email-attachments-${tsSlug}`);

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

        const searchOptions = {
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
          answered: params.answered,
          draft: params.draft,
          deleted: params.deleted,
          keyword: params.keyword,
          notKeyword: params.not_keyword,
          header: params.header,
          hasAttachment: params.has_attachment,
          largerThan: params.larger_than,
          smallerThan: params.smaller_than,
          gmailRaw: params.gmail_raw,
        };

        const result = await imapService.saveAllAttachmentsFromSearch({
          accountNames,
          accountName,
          query: params.query ?? '',
          searchOptions,
          maxEmails: params.max_emails,
          destinationFolder: folder,
          organizeBy: params.organize_by,
          attachmentFilename: params.attachment_filename,
          attachmentMimetype: params.attachment_mimetype,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  folder: result.folder,
                  files_saved: result.files_saved,
                  total_size: result.total_size,
                  total_size_human: `${(result.total_size / 1024 / 1024).toFixed(2)}MB`,
                  skipped: result.skipped,
                  errors: result.errors,
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
              text: `Failed to save attachments: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
