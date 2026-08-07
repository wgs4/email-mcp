/**
 * MCP tool: cross_account_copy
 *
 * Puts a COPY of a message into a *different* configured account, preserving
 * the raw RFC822 (headers, MIME, attachments), flags, and INTERNALDATE — so the
 * copy reads as natively delivered from the ORIGINAL sender on its ORIGINAL
 * date, which is exactly what forwarding destroys. Mechanism: FETCH source →
 * Message-ID pre-flight dedup → APPEND dest. That is steps 1-3 of the
 * cross_account_move saga, sharing its code (`stageAtDestination`); steps 6-9
 * (Trash resolution, UID MOVE, cleanup bookkeeping) are deleted, and the
 * $Routed keyword of step 4 is deliberately NOT set — a copy is not a routing
 * event.
 *
 * THE SOURCE IS NEVER TOUCHED. No Trash move, no \Deleted, no EXPUNGE, ever.
 *
 * Unlike cross_account_move, this tool does NOT require Postgres. The audit row
 * is written best-effort when [database].url is configured and downgraded to an
 * `audit_log_skipped` warning otherwise: "no audit log, no move" is the right
 * fail-closed rule for an operation that destroys the original, and the wrong
 * one for an operation that destroys nothing.
 *
 * Registered only when settings.read_only is false (D17 — the read-only gate is
 * registration, not a runtime error). For same-account copies use copy_email.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type ConnectionManager from '../connections/manager.js';
import type { CopyResult } from '../routing/cross-account-mover.js';
import { CrossAccountMover } from '../routing/cross-account-mover.js';
import { MoveLogRepository } from '../routing/log-repository.js';
import audit from '../safety/audit.js';
import { sanitizeMailboxName } from '../safety/validation.js';
import type { AppConfig } from '../types/index.js';

function summarize(results: CopyResult[]): string {
  const ok = results.filter((r) => r.success).length;
  const dup = results.filter((r) => r.success && r.status === 'duplicate_skipped').length;
  const failed = results.length - ok;
  const lines = results.map((r) => {
    if (r.success) {
      return `  ✅ uid ${r.source_uid} → ${r.dest_account}/${r.dest_mailbox} (${r.status}, dest_uid ${r.dest_uid ?? '?'}, source untouched${r.copy_log_id === null ? '' : `, log #${r.copy_log_id}`})${r.warnings.length ? ` ⚠️ ${r.warnings.map((w) => w.kind).join(',')}` : ''}`;
    }
    return `  ❌ uid ${r.source_uid ?? '?'} — ${r.error_kind}: ${r.error_message}`;
  });
  let header: string;
  if (results.length === 1) {
    const r = results[0];
    if (!r.success) {
      header = 'Copy failed.';
    } else if (r.status === 'duplicate_skipped') {
      header = 'Already present (deduped).';
    } else {
      header = 'Copied.';
    }
  } else {
    header = `Copied ${ok}/${results.length} (${dup} deduped, ${failed} failed).`;
  }
  return `${header}\n${lines.join('\n')}\n\n${JSON.stringify(results, null, 2)}`;
}

export default function registerCrossAccountCopyTool(
  server: McpServer,
  connections: ConnectionManager,
  config: AppConfig,
): void {
  // One repo (lazy Postgres pool) reused across calls. An unset URL is fine
  // here — the copy path treats the audit row as best-effort.
  const logRepo = new MoveLogRepository(config.database?.url);
  const copier = new CrossAccountMover(connections, logRepo);

  server.tool(
    'cross_account_copy',
    'Put a COPY of an email into a DIFFERENT configured account, preserving raw ' +
      'headers, MIME structure, attachments, flags, and the original date — the ' +
      'copy looks natively delivered from the ORIGINAL sender, unlike a forward. ' +
      'The source is NEVER touched (no Trash, no delete). Already-present ' +
      'messages are skipped by Message-ID. For copies within ONE account use ' +
      'copy_email instead. No database required.',
    {
      sourceAccount: z.string().describe('Source account name (from list_accounts)'),
      sourceMailbox: z.string().describe('Source mailbox, e.g. INBOX'),
      emailId: z
        .union([z.string(), z.array(z.string())])
        .describe('Source UID, or an array of UIDs for a bulk copy (sequential)'),
      destAccount: z.string().describe('Destination account name (must differ from source)'),
      destMailbox: z.string().default('INBOX').describe('Destination mailbox (default INBOX)'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async ({ sourceAccount, sourceMailbox, emailId, destAccount, destMailbox }) => {
      const cleanSource = sanitizeMailboxName(sourceMailbox);
      const cleanDest = sanitizeMailboxName(destMailbox);
      const ids = Array.isArray(emailId) ? emailId : [emailId];
      try {
        const results = await copier.copyMany(
          ids.map((id) => ({
            sourceAccount,
            sourceMailbox: cleanSource,
            emailId: id,
            destAccount,
            destMailbox: cleanDest,
          })),
        );
        const anyFailed = results.some((r) => !r.success);
        await audit.log(
          'cross_account_copy',
          sourceAccount,
          { sourceMailbox, emailId, destAccount, destMailbox },
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
          'cross_account_copy',
          sourceAccount,
          { sourceMailbox, emailId, destAccount, destMailbox },
          'error',
          msg,
        );
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `cross_account_copy failed: ${msg}` }],
        };
      }
    },
  );
}
