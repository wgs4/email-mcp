/**
 * MCP tools: save_draft, send_draft, update_draft
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import audit from '../safety/audit.js';

import type { AttachmentInput } from '../services/attachment-resolver.js';
import type ImapService from '../services/imap.service.js';
import type SmtpService from '../services/smtp.service.js';

// ---------------------------------------------------------------------------
// Attachment input schema (snake_case at the MCP boundary)
// ---------------------------------------------------------------------------

const attachmentFromPath = z.object({
  path: z.string().describe('Absolute local filesystem path to the file'),
  filename: z.string().optional().describe('Override filename (defaults to basename of path)'),
  mime_type: z.string().optional().describe('MIME type override (auto-detected if omitted)'),
});

const attachmentFromBase64 = z.object({
  content_base64: z.string().describe('Base64-encoded file content'),
  filename: z.string().describe('Filename to use on the message'),
  mime_type: z.string().optional().describe('MIME type override (auto-detected if omitted)'),
});

const attachmentFromMessage = z.object({
  source_email_id: z.string().describe('UID of an existing message holding this attachment'),
  source_mailbox: z
    .string()
    .describe('Mailbox path containing the source message (e.g. "INBOX" or "Drafts")'),
  filename: z.string().describe('Attachment filename on the source message — exact match'),
});

const attachmentInputSchema = z.union([
  attachmentFromPath,
  attachmentFromBase64,
  attachmentFromMessage,
]);

type AttachmentInputRaw = z.infer<typeof attachmentInputSchema>;

function adaptAttachmentInput(raw: AttachmentInputRaw): AttachmentInput {
  if ('path' in raw) {
    return {
      path: raw.path,
      filename: raw.filename,
      mimeType: raw.mime_type,
    };
  }
  if ('content_base64' in raw) {
    return {
      contentBase64: raw.content_base64,
      filename: raw.filename,
      mimeType: raw.mime_type,
    };
  }
  return {
    sourceEmailId: raw.source_email_id,
    sourceMailbox: raw.source_mailbox,
    filename: raw.filename,
  };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export default function registerDraftTools(
  server: McpServer,
  imapService: ImapService,
  smtpService: SmtpService,
): void {
  // ---------------------------------------------------------------------------
  // save_draft
  // ---------------------------------------------------------------------------
  server.tool(
    'save_draft',
    'Save an email draft to the Drafts folder. Compose over time, then use send_draft to send it. ' +
      'Supports attachments from a local path, inline base64 bytes, or references to attachments on ' +
      'an existing message (server-side carry — bytes do not traverse the MCP wire). ' +
      'Use list_emails with the Drafts mailbox to see saved drafts.',
    {
      account: z.string().describe('Account name from list_accounts'),
      to: z
        .array(z.string().email())
        .default([])
        .describe('Recipient email addresses (can be empty for drafts)'),
      subject: z.string().describe('Email subject'),
      body: z.string().describe('Email body content'),
      cc: z.array(z.string().email()).optional().describe('CC recipients'),
      bcc: z.array(z.string().email()).optional().describe('BCC recipients'),
      html: z.boolean().default(false).describe('Send as HTML (default: plain text)'),
      in_reply_to: z.string().optional().describe('Message-ID for threading (from get_email)'),
      attachments: z
        .array(attachmentInputSchema)
        .optional()
        .describe(
          'Attachments to include. Each entry is one of: ' +
            '{ path }: read bytes from a local file (use absolute path); ' +
            '{ content_base64, filename }: provide bytes inline; ' +
            '{ source_email_id, source_mailbox, filename }: carry an attachment from another message ' +
            'without round-tripping bytes through this MCP. Strict failure: if any attachment cannot ' +
            'be resolved, no draft is saved.',
        ),
    },
    { readOnlyHint: false, destructiveHint: false },
    async ({ account, to, subject, body, cc, bcc, html, in_reply_to: inReplyTo, attachments }) => {
      try {
        const result = await imapService.saveDraftWithAttachments(account, {
          to,
          subject,
          body,
          cc,
          bcc,
          html,
          inReplyTo,
          attachments: attachments?.map(adaptAttachmentInput),
        });

        await audit.log(
          'save_draft',
          account,
          { to, subject, attachmentCount: attachments?.length ?? 0 },
          'ok',
        );

        const attachSummary =
          attachments && attachments.length > 0 ? `, ${attachments.length} attachment(s)` : '';

        return {
          content: [
            {
              type: 'text' as const,
              text: `📝 Draft saved (ID: ${result.id}, folder: ${result.mailbox}${attachSummary}).`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log('save_draft', account, { to, subject }, 'error', errMsg);
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to save draft: ${errMsg}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // send_draft
  // ---------------------------------------------------------------------------
  server.tool(
    'send_draft',
    'Send an existing draft email and remove it from Drafts. The draft is fetched, sent via SMTP, then deleted. Use list_emails with the Drafts mailbox to find draft IDs.',
    {
      account: z.string().describe('Account name from list_accounts'),
      id: z.number().int().describe('Draft email UID (from list_emails on Drafts mailbox)'),
      mailbox: z.string().optional().describe('Drafts folder path (auto-detected if omitted)'),
    },
    { readOnlyHint: false, destructiveHint: true },
    async ({ account, id, mailbox }) => {
      try {
        const result = await smtpService.sendDraft(account, id, mailbox);

        await audit.log('send_draft', account, { id, mailbox }, 'ok');

        return {
          content: [
            {
              type: 'text' as const,
              text: `✅ Draft sent (Message-ID: ${result.messageId}). Draft removed from folder.`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log('send_draft', account, { id, mailbox }, 'error', errMsg);
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to send draft: ${errMsg}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // update_draft
  // ---------------------------------------------------------------------------
  server.tool(
    'update_draft',
    'Replace an existing draft with new content while preserving (or modifying) its attachments. ' +
      'Use this to rewrite a draft body without losing attached files, or to carry attachments from ' +
      'another message into a draft. IMAP has no in-place edit, so the implementation APPENDs a new ' +
      'copy first, then deletes the old UID only after the APPEND succeeds. If anything fails before ' +
      'APPEND, the old draft is left intact. Returns the NEW draft UID. ' +
      'Omitted fields (subject, body, recipients) keep the existing draft values. ' +
      'attachments_keep defaults to ALL existing attachments; pass [] to drop them all.',
    {
      account: z.string().describe('Account name from list_accounts'),
      draft_id: z.number().int().describe('UID of the existing draft to replace'),
      mailbox: z.string().optional().describe('Drafts folder path (auto-detected if omitted)'),
      subject: z.string().optional().describe('New subject (omit to keep existing)'),
      body: z.string().optional().describe('New body content (omit to keep existing)'),
      html: z.boolean().optional().describe('Body is HTML (omit to inherit from existing draft)'),
      to: z
        .array(z.string().email())
        .optional()
        .describe('New recipient list (omit to keep existing). Pass [] for none.'),
      cc: z.array(z.string().email()).optional().describe('New CC list (omit to keep existing)'),
      bcc: z.array(z.string().email()).optional().describe('New BCC list (omit to keep existing)'),
      in_reply_to: z.string().optional().describe('New In-Reply-To (omit to keep existing)'),
      attachments_keep: z
        .array(z.string())
        .optional()
        .describe(
          'Filenames of existing attachments to keep. Omit = keep ALL. Pass [] to drop all. ' +
            'Filenames not present on the draft are ignored (with a warning in the response).',
        ),
      attachments_add: z
        .array(attachmentInputSchema)
        .optional()
        .describe(
          'New attachments to add — same input shape as save_draft.attachments (path / base64 / ' +
            'message-reference). Use the message-reference form to carry attachments from another ' +
            'draft or any message without round-tripping bytes through this MCP.',
        ),
      attachments_remove: z
        .array(z.string())
        .optional()
        .describe(
          'Filenames to drop from the existing draft (subtracted from attachments_keep set)',
        ),
    },
    { readOnlyHint: false, destructiveHint: true },
    async ({
      account,
      draft_id: draftId,
      mailbox,
      subject,
      body,
      html,
      to,
      cc,
      bcc,
      in_reply_to: inReplyTo,
      attachments_keep: attachmentsKeep,
      attachments_add: attachmentsAdd,
      attachments_remove: attachmentsRemove,
    }) => {
      try {
        const result = await imapService.updateDraft(account, draftId, {
          mailbox,
          subject,
          body,
          html,
          to,
          cc,
          bcc,
          inReplyTo,
          attachmentsKeep,
          attachmentsAdd: attachmentsAdd?.map(adaptAttachmentInput),
          attachmentsRemove,
        });

        await audit.log(
          'update_draft',
          account,
          {
            draftId,
            mailbox,
            subject,
            attachmentsKeepCount: attachmentsKeep?.length,
            attachmentsAddCount: attachmentsAdd?.length ?? 0,
            attachmentsRemoveCount: attachmentsRemove?.length ?? 0,
          },
          'ok',
        );

        const warningBlock =
          result.warnings.length > 0 ? `\n\nWarnings:\n  - ${result.warnings.join('\n  - ')}` : '';
        const deletedNote = result.oldDraftDeleted
          ? `old draft UID ${result.oldId} removed`
          : `old draft UID ${result.oldId} NOT deleted (see warnings)`;

        return {
          content: [
            {
              type: 'text' as const,
              text: `✏️ Draft updated. New UID: ${result.id} (folder: ${result.mailbox}); ${deletedNote}.${warningBlock}`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log('update_draft', account, { draftId, mailbox }, 'error', errMsg);
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to update draft: ${errMsg}`,
            },
          ],
        };
      }
    },
  );
}
