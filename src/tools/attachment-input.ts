/**
 * Shared attachment-input schema for MCP tools (snake_case at the MCP boundary).
 *
 * The polymorphic `attachmentInputSchema` (a z.union of three shapes) and the
 * `adaptAttachmentInput` adapter are shared by every tool that accepts
 * attachments — save_draft / update_draft (drafts.tool.ts) and send_email
 * (send.tool.ts) — so the wire shape and the adaptation to the internal
 * {@link AttachmentInput} type stay identical across them.
 */

import { z } from 'zod';
import type { AttachmentInput } from '../services/attachment-resolver.js';

const contentIdField = z
  .string()
  .optional()
  .describe(
    'Makes the attachment an inline part; reference it from the HTML body as <img src="cid:VALUE">. VALUE must be printable ASCII with no space, double quote, or angle brackets (one surrounding <> pair is stripped).',
  );

const attachmentFromPath = z.object({
  path: z.string().describe('Absolute local filesystem path to the file'),
  filename: z.string().optional().describe('Override filename (defaults to basename of path)'),
  mime_type: z.string().optional().describe('MIME type override (auto-detected if omitted)'),
  content_id: contentIdField,
});

const attachmentFromBase64 = z.object({
  content_base64: z.string().describe('Base64-encoded file content'),
  filename: z.string().describe('Filename to use on the message'),
  mime_type: z.string().optional().describe('MIME type override (auto-detected if omitted)'),
  content_id: contentIdField,
});

const attachmentFromMessage = z.object({
  source_email_id: z.string().describe('UID of an existing message holding this attachment'),
  source_mailbox: z
    .string()
    .describe('Mailbox path containing the source message (e.g. "INBOX" or "Drafts")'),
  filename: z.string().describe('Attachment filename on the source message — exact match'),
  content_id: contentIdField,
});

export const attachmentInputSchema = z.union([
  attachmentFromPath,
  attachmentFromBase64,
  attachmentFromMessage,
]);

export type AttachmentInputRaw = z.infer<typeof attachmentInputSchema>;

function adaptedContentId(raw: { content_id?: string }): { contentId?: string } {
  return raw.content_id !== undefined ? { contentId: raw.content_id } : {};
}

export function adaptAttachmentInput(raw: AttachmentInputRaw): AttachmentInput {
  if ('path' in raw) {
    return {
      path: raw.path,
      filename: raw.filename,
      mimeType: raw.mime_type,
      ...adaptedContentId(raw),
    };
  }
  if ('content_base64' in raw) {
    return {
      contentBase64: raw.content_base64,
      filename: raw.filename,
      mimeType: raw.mime_type,
      ...adaptedContentId(raw),
    };
  }
  return {
    sourceEmailId: raw.source_email_id,
    sourceMailbox: raw.source_mailbox,
    filename: raw.filename,
    ...adaptedContentId(raw),
  };
}
