/**
 * MCP tool: cross_account_move
 *
 * Moves a message between two *different* configured accounts, preserving the
 * raw RFC822 (headers, MIME, attachments), flags, and INTERNALDATE. Mechanism
 * (D18): FETCH source → APPEND dest → audit-log → UID MOVE source into the
 * source account's Trash (capability-gated, fail-closed). The audit log is part
 * of the move contract — no Postgres, no move (D-Premise-2 / D20).
 *
 * Optional `ticketNumber`: osTicket threads a message onto an existing ticket
 * only when the FIRST hash token in its Subject resolves to that ticket.
 * Supplying it prepends the literal `[#N]` to the top-level Subject (and
 * changes nothing else) before APPEND; a subject already tagged for a
 * different ticket fails the move instead.
 *
 * Registered only when settings.read_only is false (D17 — the read-only gate is
 * registration, not a runtime error). For same-account moves use move_email.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type ConnectionManager from '../connections/manager.js';
import type { MoveResult } from '../routing/cross-account-mover.js';
import { CrossAccountMover } from '../routing/cross-account-mover.js';
import { MoveLogRepository } from '../routing/log-repository.js';
import audit from '../safety/audit.js';
import { sanitizeMailboxName } from '../safety/validation.js';
import type { AppConfig } from '../types/index.js';

function summarize(results: MoveResult[]): string {
  const ok = results.filter((r) => r.success).length;
  const dup = results.filter((r) => r.success && r.status === 'duplicate_skipped').length;
  const failed = results.length - ok;
  const lines = results.map((r) => {
    if (r.success) {
      const tag = r.ticket_tag
        ? `, ticket [#${r.ticket_tag}]${r.subject_rewritten ? ' subject rewritten' : ''}`
        : '';
      return `  ✅ uid ${r.source_uid} → ${r.dest_account}/${r.dest_mailbox} (${r.status}, dest_uid ${r.dest_uid ?? '?'}, source ${r.source_cleanup}, log #${r.move_log_id}${tag})${r.warnings.length ? ` ⚠️ ${r.warnings.map((w) => w.kind).join(',')}` : ''}`;
    }
    return `  ❌ uid ${r.source_uid ?? '?'} — ${r.error_kind}: ${r.error_message}`;
  });
  let header: string;
  if (results.length === 1) {
    const r = results[0];
    if (!r.success) {
      header = 'Move failed.';
    } else if (r.status === 'duplicate_skipped') {
      header = 'Already present (deduped).';
    } else {
      header = 'Moved.';
    }
  } else {
    header = `Moved ${ok}/${results.length} (${dup} deduped, ${failed} failed).`;
  }
  return `${header}\n${lines.join('\n')}\n\n${JSON.stringify(results, null, 2)}`;
}

export default function registerCrossAccountMoveTool(
  server: McpServer,
  connections: ConnectionManager,
  config: AppConfig,
): void {
  // One repo (lazy Postgres pool) reused across calls.
  const logRepo = new MoveLogRepository(config.database?.url);
  const mover = new CrossAccountMover(connections, logRepo);

  server.tool(
    'cross_account_move',
    'Move an email between two DIFFERENT configured accounts, preserving raw ' +
      'headers, flags, and original date (the message looks natively delivered ' +
      "at the destination). The source copy is moved to the source account's " +
      'Trash. For moves within ONE account use move_email instead. Requires the ' +
      'routing Postgres database to be configured (the move is audit-logged). ' +
      'Pass ticketNumber to attach this email to an existing osTicket ticket ' +
      'instead of opening a new one. Find the ticket first (osTicket MCP ' +
      'findMergeCandidates). The message must be UNREAD for osTicket to fetch it.',
    {
      sourceAccount: z.string().describe('Source account name (from list_accounts)'),
      sourceMailbox: z.string().describe('Source mailbox, e.g. INBOX'),
      emailId: z
        .union([z.string(), z.array(z.string())])
        .describe('Source UID, or an array of UIDs for a bulk move (sequential)'),
      destAccount: z.string().describe('Destination account name (must differ from source)'),
      destMailbox: z.string().default('INBOX').describe('Destination mailbox (default INBOX)'),
      ticketNumber: z
        .string()
        .regex(/^\d{3,10}$/, 'ticketNumber must be 3-10 digits')
        .optional()
        .describe(
          'Existing osTicket ticket number (3-10 digits). The literal [#N] is ' +
            'prepended to the top-level Subject so osTicket threads this email ' +
            'onto that ticket. The message must be UNREAD.',
        ),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    async ({ sourceAccount, sourceMailbox, emailId, destAccount, destMailbox, ticketNumber }) => {
      const cleanSource = sanitizeMailboxName(sourceMailbox);
      const cleanDest = sanitizeMailboxName(destMailbox);
      const ids = Array.isArray(emailId) ? emailId : [emailId];
      try {
        const results = await mover.moveMany(
          ids.map((id) => ({
            sourceAccount,
            sourceMailbox: cleanSource,
            emailId: id,
            destAccount,
            destMailbox: cleanDest,
            ticketNumber,
          })),
        );
        const anyFailed = results.some((r) => !r.success);
        await audit.log(
          'cross_account_move',
          sourceAccount,
          { sourceMailbox, emailId, destAccount, destMailbox, ticketNumber },
          anyFailed ? 'error' : 'ok',
          anyFailed ? results.find((r) => !r.success)?.error_message : undefined,
        );
        const text = summarize(results);
        // Single-string input → single result object; array → array (the JSON
        // block in `text` carries the full structured result either way).
        return {
          ...(anyFailed ? { isError: true } : {}),
          content: [{ type: 'text' as const, text }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await audit.log(
          'cross_account_move',
          sourceAccount,
          { sourceMailbox, emailId, destAccount, destMailbox, ticketNumber },
          'error',
          msg,
        );
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `cross_account_move failed: ${msg}` }],
        };
      }
    },
  );
}
