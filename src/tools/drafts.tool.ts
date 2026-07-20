/**
 * MCP tools: save_draft, send_draft, update_draft
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import audit from '../safety/audit.js';

import { SupersededDraftError } from '../services/draft-errors.js';
import type ImapService from '../services/imap.service.js';
import type SmtpService from '../services/smtp.service.js';
import { adaptAttachmentInput, attachmentInputSchema } from './attachment-input.js';

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

        const warn = result.warning ? `\n⚠️ ${result.warning}` : '';
        return {
          content: [
            {
              type: 'text' as const,
              text: `✅ Draft sent (Message-ID: ${result.messageId}). Draft removed from folder.${warn}`,
            },
          ],
        };
      } catch (err) {
        if (err instanceof SupersededDraftError) {
          await audit.log('send_draft', account, { id, mailbox }, 'error', 'draft_superseded');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `⚠️ draft_superseded: ${err.message} (newest UID ${err.hint.newestUid}).`,
              },
            ],
          };
        }
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
        if (/not found in/i.test(err instanceof Error ? err.message : '')) {
          const hint = await imapService
            .findSupersession(account, draftId, mailbox)
            .catch(() => null);
          if (hint) {
            await audit.log(
              'update_draft',
              account,
              { draftId, mailbox },
              'error',
              'draft_superseded',
            );
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text:
                    `⚠️ draft_superseded: UID ${draftId} is gone; newest is UID ${hint.newestUid} (${hint.newestDate}). ` +
                    `Retry update_draft against ${hint.newestUid}, or run resync_draft_attachments(draft_id=${hint.newestUid}, apply=true) to restore attachments.`,
                },
              ],
            };
          }
        }
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

  // ---------------------------------------------------------------------------
  // resync_draft_attachments
  // ---------------------------------------------------------------------------
  server.tool(
    'resync_draft_attachments',
    'Detect and restore attachments that Apple Mail silently dropped when it re-saved an MCP ' +
      'draft. Resolves the draft lineage (same From + subject, or a shared Apple UUID), diffs ' +
      'attachments against ancestors and the session cache, and (with apply=true) APPENDs a new ' +
      "draft that carries the user's body BYTE-FOR-BYTE plus the recovered files. apply=false " +
      '(default) reports only. Pass draft_id (any UID in the lineage) OR subject.',
    {
      account: z.string().describe('Account name from list_accounts'),
      draft_id: z
        .number()
        .int()
        .optional()
        .describe('UID of any draft in the lineage (ancestor or current)'),
      subject: z.string().optional().describe('Exact draft subject — use when the UID is unknown'),
      apply: z.boolean().default(false).describe('false = report only (no write); true = re-apply'),
      attachments: z
        .array(z.string())
        .optional()
        .describe(
          'Explicit filename allowlist to restore (overrides intentional-removal exclusion)',
        ),
      strip_dangling_cids: z
        .boolean()
        .default(true)
        .describe('When applying, strip <img>/<object> whose cid: has no matching part'),
      mailbox: z.string().optional().describe('Drafts folder path (auto-detected if omitted)'),
    },
    { readOnlyHint: false, destructiveHint: true },
    async ({
      account,
      draft_id: draftId,
      subject,
      apply,
      attachments,
      strip_dangling_cids: strip,
      mailbox,
    }) => {
      if ((draftId === undefined) === (subject === undefined)) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: 'Provide exactly one of draft_id or subject.' }],
        };
      }
      try {
        const res = await imapService.resyncDraftAttachments(account, {
          draftId,
          subject,
          apply,
          attachments,
          stripDanglingCids: strip,
          mailbox,
        });
        await audit.log('resync_draft_attachments', account, { draftId, subject, apply }, 'ok');
        const r = res.report;
        if (!apply) {
          const lines = [
            `🔎 Resync report — current draft UID ${r.currentUid} (folder: ${r.mailbox}), lineage UIDs: ${r.lineageUids.join(', ')}.`,
            r.missing.length > 0
              ? `Missing: ${r.missing.map((m) => `${m.filename} [${m.recoverable ? m.source : 'UNRECOVERABLE'}]`).join(', ')}`
              : 'No missing attachments.',
            r.intentionallyRemovedExcluded.length > 0
              ? `Excluded (intentionally removed): ${r.intentionallyRemovedExcluded.join(', ')}`
              : '',
            r.danglingCids.length > 0 ? `Dangling cids: ${r.danglingCids.join(', ')}` : '',
            'Run again with apply=true to restore.',
          ].filter(Boolean);
          return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        }
        const a = res.applied;
        const nothingToRestore = {
          content: [
            {
              type: 'text' as const,
              text: `✅ Nothing to restore for draft UID ${r.currentUid}.`,
            },
          ],
        };
        if (a === undefined) return nothingToRestore;
        if (a.newUid === null) return nothingToRestore;
        const warnBlock =
          a.warnings.length > 0 ? `\n\nWarnings:\n  - ${a.warnings.join('\n  - ')}` : '';
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `♻️ Resynced. New draft UID: ${a.newUid} (folder: ${a.mailbox}); restored: ${a.restored.join(', ') || 'none'}; ` +
                `old UID ${a.oldUidReplaced} replaced${a.strippedCids.length ? `; stripped cids: ${a.strippedCids.join(', ')}` : ''}` +
                `${a.skippedUnrecoverable.length ? `; UNRECOVERABLE: ${a.skippedUnrecoverable.join(', ')}` : ''}.${warnBlock}`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log(
          'resync_draft_attachments',
          account,
          { draftId, subject, apply },
          'error',
          errMsg,
        );
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Failed to resync draft: ${errMsg}` }],
        };
      }
    },
  );
}
