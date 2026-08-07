/**
 * MCP tools: move_email, copy_email, delete_email, mark_email
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import audit from '../safety/audit.js';
import { sanitizeMailboxName } from '../safety/validation.js';

import type ImapService from '../services/imap.service.js';

/**
 * copy_email is the SAME-account tool (server-side IMAP COPY). It accepts an
 * optional destinationAccount purely so a cross-account request is refused with
 * a pointer at the right tool — the mirror image of how cross_account_copy
 * refuses a same-account request. Returns the refusal text, or null when the
 * request really is single-account.
 */
export function crossAccountCopyRefusal(
  account: string,
  destinationAccount?: string,
): string | null {
  if (destinationAccount && destinationAccount !== account) {
    return (
      `source and destination are different accounts ("${account}" → ` +
      `"${destinationAccount}") — use cross_account_copy instead`
    );
  }
  return null;
}

export default function registerManageTools(server: McpServer, imapService: ImapService): void {
  // ---------------------------------------------------------------------------
  // move_email
  // ---------------------------------------------------------------------------
  server.tool(
    'move_email',
    'Move an email to a different mailbox folder. ' +
      'The sourceMailbox must be a real folder, not a virtual one like "All Mail". ' +
      'Use find_email_folder first if the email was discovered in a virtual folder.',
    {
      account: z.string().describe('Account name from list_accounts'),
      emailId: z.string().describe('Email ID to move (from list_emails)'),
      sourceMailbox: z.string().describe('Current mailbox (e.g., INBOX)'),
      destinationMailbox: z
        .string()
        .describe('Target mailbox (e.g., Archive). Use list_mailboxes to see options.'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async ({ account, emailId, sourceMailbox, destinationMailbox }) => {
      try {
        const cleanSource = sanitizeMailboxName(sourceMailbox);
        const cleanDest = sanitizeMailboxName(destinationMailbox);
        await imapService.moveEmail(account, emailId, cleanSource, cleanDest);
        await audit.log(
          'move_email',
          account,
          { emailId, sourceMailbox, destinationMailbox },
          'ok',
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: `✅ Email moved from "${sourceMailbox}" to "${destinationMailbox}".`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log(
          'move_email',
          account,
          { emailId, sourceMailbox, destinationMailbox },
          'error',
          errMsg,
        );
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to move email: ${errMsg}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // copy_email
  // ---------------------------------------------------------------------------
  server.tool(
    'copy_email',
    'Copy an email into another mailbox folder WITHIN the same account, leaving ' +
      'the original exactly where it is. Uses the server-side IMAP COPY, so the ' +
      'copy keeps the original sender, date, MIME structure and attachments. ' +
      'The sourceMailbox must be a real folder, not a virtual one like "All Mail". ' +
      'To copy into a DIFFERENT account use cross_account_copy instead.',
    {
      account: z.string().describe('Account name from list_accounts'),
      emailId: z.string().describe('Email ID to copy (from list_emails)'),
      sourceMailbox: z.string().describe('Current mailbox (e.g., INBOX)'),
      destinationMailbox: z
        .string()
        .describe('Target mailbox (e.g., Archive). Use list_mailboxes to see options.'),
      destinationAccount: z
        .string()
        .optional()
        .describe(
          'Optional. Only accepted when it equals `account`; a different value is ' +
            'refused with a pointer to cross_account_copy.',
        ),
    },
    // Not idempotent: a second call appends a second copy.
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async ({ account, emailId, sourceMailbox, destinationMailbox, destinationAccount }) => {
      const params = { emailId, sourceMailbox, destinationMailbox, destinationAccount };
      const refusal = crossAccountCopyRefusal(account, destinationAccount);
      if (refusal) {
        await audit.log('copy_email', account, params, 'error', refusal);
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Failed to copy email: ${refusal}` }],
        };
      }
      try {
        const cleanSource = sanitizeMailboxName(sourceMailbox);
        const cleanDest = sanitizeMailboxName(destinationMailbox);
        await imapService.copyEmail(account, emailId, cleanSource, cleanDest);
        await audit.log('copy_email', account, params, 'ok');
        return {
          content: [
            {
              type: 'text' as const,
              text: `✅ Email copied from "${sourceMailbox}" to "${destinationMailbox}" (original left in place).`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log('copy_email', account, params, 'error', errMsg);
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to copy email: ${errMsg}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // delete_email
  // ---------------------------------------------------------------------------
  server.tool(
    'delete_email',
    'Delete an email. By default moves to Trash. Set permanent=true for permanent deletion (⚠️ irreversible). ' +
      'The mailbox must be a real folder. Use find_email_folder first if the email was found in a virtual folder.',
    {
      account: z.string().describe('Account name from list_accounts'),
      emailId: z.string().describe('Email ID to delete (from list_emails)'),
      mailbox: z.string().default('INBOX').describe('Mailbox containing the email'),
      permanent: z.boolean().default(false).describe('⚠️ Permanently delete (skip Trash)'),
    },
    { readOnlyHint: false, destructiveHint: true },
    async ({ account, emailId, mailbox, permanent }) => {
      try {
        const cleanMailbox = sanitizeMailboxName(mailbox);
        await imapService.deleteEmail(account, emailId, cleanMailbox, permanent);
        await audit.log('delete_email', account, { emailId, mailbox, permanent }, 'ok');
        return {
          content: [
            {
              type: 'text' as const,
              text: permanent ? `⚠️ Email permanently deleted.` : `🗑️ Email moved to Trash.`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log('delete_email', account, { emailId, mailbox, permanent }, 'error', errMsg);
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to delete email: ${errMsg}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // mark_email
  // ---------------------------------------------------------------------------
  server.tool(
    'mark_email',
    'Change email flags — mark as read/unread, flag/unflag. Idempotent: marking an already-read email as read is a no-op.',
    {
      account: z.string().describe('Account name from list_accounts'),
      id: z.string().describe('Email ID (UID) from list_emails or search_emails'),
      mailbox: z.string().default('INBOX').describe('Mailbox containing the email'),
      action: z
        .enum(['read', 'unread', 'flag', 'unflag'])
        .describe('Action: read, unread, flag (star), or unflag (unstar)'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async ({ account, id, mailbox, action }) => {
      try {
        await imapService.setFlags(account, id, mailbox, action);
        await audit.log('mark_email', account, { id, mailbox, action }, 'ok');
        const labels: Record<string, string> = {
          read: '📖 Marked as read',
          unread: '📩 Marked as unread',
          flag: '⭐ Flagged',
          unflag: '☆ Unflagged',
        };
        return {
          content: [{ type: 'text' as const, text: `${labels[action]}.` }],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log('mark_email', account, { id, mailbox, action }, 'error', errMsg);
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to mark email: ${errMsg}`,
            },
          ],
        };
      }
    },
  );
}
