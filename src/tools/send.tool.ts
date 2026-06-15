/**
 * MCP tools: send_email, reply_email, forward_email
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import audit from '../safety/audit.js';
import { validateInputLength } from '../safety/validation.js';

import type ImapService from '../services/imap.service.js';
import type SmtpService from '../services/smtp.service.js';
import { adaptAttachmentInput, attachmentInputSchema } from './attachment-input.js';

export default function registerSendTools(
  server: McpServer,
  smtpService: SmtpService,
  imapService: ImapService,
): void {
  // ---------------------------------------------------------------------------
  // send_email
  // ---------------------------------------------------------------------------
  server.tool(
    'send_email',
    'Send a new email. Supports plain text or HTML body, CC, BCC, and attachments ' +
      '(from a local path, inline base64 bytes, or a reference to an attachment on an existing message).',
    {
      account: z.string().describe('Account name from list_accounts'),
      to: z.array(z.string().email()).min(1).describe('Recipient email addresses'),
      subject: z.string().describe('Email subject'),
      body: z.string().describe('Email body content'),
      cc: z.array(z.string().email()).optional().describe('CC recipients'),
      bcc: z.array(z.string().email()).optional().describe('BCC recipients'),
      html: z.boolean().default(false).describe('Send as HTML (default: plain text)'),
      attachments: z
        .array(attachmentInputSchema)
        .optional()
        .describe(
          'Attachments to include. Each entry is one of: ' +
            '{ path }: read bytes from a local file (use absolute path); ' +
            '{ content_base64, filename }: provide bytes inline; ' +
            '{ source_email_id, source_mailbox, filename }: carry an attachment from another message ' +
            'without round-tripping bytes through this MCP. Strict failure: if any attachment cannot ' +
            'be resolved, the email is NOT sent.',
        ),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (params) => {
      try {
        validateInputLength(params.subject, 998, 'Subject');
        validateInputLength(params.body, 5_000_000, 'Body');

        // Resolve attachments BEFORE sending — strict failure means a bad
        // attachment aborts the whole send rather than mailing a partial.
        const resolvedAttachments =
          params.attachments && params.attachments.length > 0
            ? await imapService.resolveAttachmentsForSend(
                params.account,
                params.attachments.map(adaptAttachmentInput),
              )
            : undefined;

        const result = await smtpService.sendEmail(params.account, {
          ...params,
          attachments: resolvedAttachments,
        });
        await audit.log(
          'send_email',
          params.account,
          {
            to: params.to,
            subject: params.subject,
            attachmentCount: params.attachments?.length ?? 0,
          },
          'ok',
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: `✅ Email sent successfully!\nTo: ${params.to.join(', ')}\nSubject: ${params.subject}\nMessage-ID: ${result.messageId}`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log(
          'send_email',
          params.account,
          { to: params.to, subject: params.subject },
          'error',
          errMsg,
        );
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to send email: ${errMsg}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // reply_email
  // ---------------------------------------------------------------------------
  server.tool(
    'reply_email',
    'Reply to an email with proper threading (In-Reply-To & References headers). Use get_email first to read the original.',
    {
      account: z.string().describe('Account name from list_accounts'),
      emailId: z.string().describe('Email ID to reply to (from list_emails or get_email)'),
      mailbox: z.string().default('INBOX').describe('Mailbox where the original email is'),
      body: z.string().describe('Reply body content'),
      replyAll: z.boolean().default(false).describe('Reply to all recipients'),
      html: z.boolean().default(false).describe('Send as HTML'),
      includeAttachments: z
        .boolean()
        .default(false)
        .describe('Re-attach attachments from the original email to this reply'),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (params) => {
      try {
        const result = await smtpService.replyToEmail(params.account, params);
        await audit.log(
          'reply_email',
          params.account,
          { emailId: params.emailId, mailbox: params.mailbox },
          'ok',
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: `✅ Reply sent successfully!\nMessage-ID: ${result.messageId}`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log(
          'reply_email',
          params.account,
          { emailId: params.emailId, mailbox: params.mailbox },
          'error',
          errMsg,
        );
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to reply: ${errMsg}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // forward_email
  // ---------------------------------------------------------------------------
  server.tool(
    'forward_email',
    'Forward an email to new recipients with optional additional message. Original email is quoted below.',
    {
      account: z.string().describe('Account name from list_accounts'),
      emailId: z.string().describe('Email ID to forward (from list_emails or get_email)'),
      mailbox: z.string().default('INBOX').describe('Mailbox where the original email is'),
      to: z.array(z.string().email()).min(1).describe('Forward to these recipients'),
      body: z.string().optional().describe('Additional message above the forwarded content'),
      cc: z.array(z.string().email()).optional().describe('CC recipients'),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (params) => {
      try {
        const result = await smtpService.forwardEmail(params.account, params);
        await audit.log(
          'forward_email',
          params.account,
          { to: params.to, emailId: params.emailId },
          'ok',
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: `✅ Email forwarded successfully!\nTo: ${params.to.join(', ')}\nMessage-ID: ${result.messageId}`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log(
          'forward_email',
          params.account,
          { to: params.to, emailId: params.emailId },
          'error',
          errMsg,
        );
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to forward: ${errMsg}`,
            },
          ],
        };
      }
    },
  );
}
