/**
 * CrossAccountMover (D15) — the cross-account move saga (D18).
 *
 * Transaction-script style. Source and destination are DIFFERENT accounts →
 * two independent imapflow clients → two independent mailbox locks (no
 * re-entrancy/deadlock: the D2 concern is sweep re-entering the SAME client;
 * not applicable to the standalone tool, which acquires its own locks like
 * every other tool in the codebase).
 *
 * Atomic sequence (D18):
 *   1. FETCH source: raw RFC822 + flags + INTERNALDATE + Message-ID + UIDVALIDITY
 *   2. Pre-flight dedup on destination by Message-ID
 *   3. APPEND to destination (preserve flags + INTERNALDATE), capture dest_uid
 *   4. STORE $Routed on dest if PERMANENTFLAGS allows (else warn)
 *   5. Synchronous audit INSERT (claim). 23505 → clean up our dup, duplicate_skipped.
 *      Other DB failure → audit_log_insert_failed, source untouched.
 *   6. Re-verify source UIDVALIDITY unchanged
 *   7. Resolve source \Trash (SPECIAL-USE)
 *   8. Source cleanup: UID MOVE source → source Trash (capability-gated).
 *      No MOVE capability → fail closed (source_cleanup_unsafe). The minimal
 *      tool never issues EXPUNGE — the spike proved Gmail mis-scopes it; the
 *      proven-safe-EXPUNGE fallback needs a per-account operator assertion that
 *      is out of scope here, so we fail closed instead of risking the footgun.
 *   9. recordSourceCleanup
 */

import type ConnectionManager from '../connections/manager.js';
import type { ErrorKind, MoveWarning, SourceCleanup } from './error-kinds.js';
import { ERROR_KIND, MoveError, WARNING_KIND } from './error-kinds.js';
import type { MoveLogRepository } from './log-repository.js';

export interface MoveArgs {
  sourceAccount: string;
  sourceMailbox: string;
  emailId: string;
  destAccount: string;
  destMailbox: string;
}

export type MoveResult =
  | {
      success: true;
      status: 'success' | 'duplicate_skipped';
      source_account: string;
      source_mailbox: string;
      source_uid: number;
      dest_account: string;
      dest_mailbox: string;
      dest_uid: number | null;
      message_id: string | null;
      subject: string | null;
      from: string | null;
      size_bytes: number | null;
      source_cleanup: SourceCleanup;
      move_log_id: number;
      warnings: MoveWarning[];
    }
  | {
      success: false;
      error_kind: string;
      error_message: string;
      source_account: string;
      source_mailbox: string;
      source_uid: number | null;
      move_log_id?: number;
    };

interface FetchedSource {
  raw: Buffer;
  flags: string[];
  internalDate: Date | undefined;
  messageId: string | null;
  subject: string | null;
  from: string | null;
  sizeBytes: number | null;
  uidValidity: bigint;
}

function toDate(v: unknown): Date | undefined {
  if (v instanceof Date) {
    return v;
  }
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

function formatFrom(addr?: { name?: string; address?: string }): string | null {
  if (!addr) {
    return null;
  }
  const name = addr.name ? `${addr.name} ` : '';
  return `${name}<${addr.address ?? ''}>`.trim();
}

/** Map a raw IMAP/imapflow error to a typed MoveError. */
function classifyImapError(err: unknown, fallback: ErrorKind): MoveError {
  if (err instanceof MoveError) {
    return err;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/quota|OVERQUOTA|LIMIT/i.test(msg)) {
    return new MoveError(ERROR_KIND.QUOTA_EXCEEDED, `destination over quota: ${msg}`);
  }
  if (/connection|ECONNRESET|ETIMEDOUT|socket/i.test(msg)) {
    return new MoveError(ERROR_KIND.CONNECTION_ERROR, msg);
  }
  return new MoveError(fallback, msg);
}

export class CrossAccountMover {
  constructor(
    private readonly connections: ConnectionManager,
    private readonly logRepo: MoveLogRepository,
  ) {}

  async moveMany(argsList: MoveArgs[]): Promise<MoveResult[]> {
    // Sequential (respect IMAP connection limits); one failure does not abort
    // the batch — each item gets its own result. Promise-chain reduce keeps it
    // sequential without a loop/await-in-loop.
    return argsList.reduce<Promise<MoveResult[]>>(async (accP, args) => {
      const acc = await accP;
      acc.push(await this.moveOne(args));
      return acc;
    }, Promise.resolve([]));
  }

  async moveOne(args: MoveArgs): Promise<MoveResult> {
    const { sourceAccount, sourceMailbox, emailId, destAccount, destMailbox } = args;
    const uid = Number.parseInt(emailId, 10);

    const fail = (kind: string, message: string, moveLogId?: number): MoveResult => ({
      success: false,
      error_kind: kind,
      error_message: message,
      source_account: sourceAccount,
      source_mailbox: sourceMailbox,
      source_uid: Number.isFinite(uid) ? uid : null,
      move_log_id: moveLogId,
    });

    if (!Number.isInteger(uid) || uid <= 0) {
      return fail(ERROR_KIND.INVALID_EMAIL_ID, `email_id "${emailId}" is not a positive integer`);
    }
    const accounts = new Set(this.connections.getAccountNames());
    if (!accounts.has(sourceAccount)) {
      return fail(ERROR_KIND.SOURCE_NOT_FOUND, `source account "${sourceAccount}" not configured`);
    }
    if (!accounts.has(destAccount)) {
      return fail(
        ERROR_KIND.DEST_ACCOUNT_INVALID,
        `destination account "${destAccount}" not configured`,
      );
    }
    if (sourceAccount === destAccount) {
      return fail(
        ERROR_KIND.SAME_ACCOUNT_MOVE,
        'source and destination are the same account — use move_email instead',
      );
    }

    const warnings: MoveWarning[] = [];

    try {
      // 1. FETCH source.
      const src = await this.fetchSource(sourceAccount, sourceMailbox, uid);

      // 2-4. Destination work: dedup, APPEND, $Routed.
      const destClient = await this.connections.getImapClient(destAccount);
      let destUid: number | null = null;
      let dedupHit = false;
      const destLock = await destClient.getMailboxLock(destMailbox);
      try {
        if (src.messageId) {
          const found = await destClient.search(
            { header: { 'message-id': src.messageId } },
            { uid: true },
          );
          if (found && found.length > 0) {
            dedupHit = true;
            [destUid] = found;
          }
        }
        if (!dedupHit) {
          const appended = await destClient.append(
            destMailbox,
            src.raw,
            src.flags,
            src.internalDate,
          );
          if (appended === false || typeof appended.uid !== 'number') {
            throw new MoveError(
              ERROR_KIND.APPEND_FAILED,
              'destination APPEND failed or returned no UID',
            );
          }
          destUid = appended.uid;
          // 4. $Routed keyword, capability-gated on PERMANENTFLAGS.
          const mb = destClient.mailbox;
          const permFlags = mb && mb.permanentFlags ? mb.permanentFlags : new Set<string>();
          if (permFlags.has('\\*') || permFlags.has('$Routed')) {
            await destClient
              .messageFlagsAdd(String(destUid), ['$Routed'], { uid: true })
              .catch(() => {
                warnings.push({
                  kind: WARNING_KIND.FLAG_NOT_SET,
                  message: '$Routed STORE failed on destination',
                });
              });
          } else {
            warnings.push({
              kind: WARNING_KIND.FLAG_NOT_SET,
              message: 'destination PERMANENTFLAGS does not accept custom keywords',
            });
          }
        }
      } catch (err) {
        throw classifyImapError(err, ERROR_KIND.APPEND_FAILED);
      } finally {
        destLock.release();
      }

      // 5. Synchronous audit INSERT (D-Premise-2 — part of the move contract).
      // claim() throws a typed MoveError on DB-down/misconfig (→ outer catch);
      // returns ok:false when a concurrent move won the unique-index race.
      const status: 'success' | 'duplicate_skipped' = dedupHit ? 'duplicate_skipped' : 'success';
      const claimed = await this.logRepo.claim({
        source_account: sourceAccount,
        source_mailbox: sourceMailbox,
        source_uid: uid,
        dest_account: destAccount,
        dest_mailbox: destMailbox,
        dest_uid: destUid,
        message_id: src.messageId,
        subject: src.subject,
        from_addr: src.from,
        email_date: null,
        size_bytes: src.sizeBytes,
        status,
        manual: true,
      });
      if (!claimed.ok) {
        // A concurrent move won the race after our pre-flight dedup passed.
        // Remove our just-appended duplicate; report duplicate_skipped.
        if (!dedupHit && destUid !== null) {
          await this.discardDestDuplicate(destAccount, destMailbox, destUid).catch(() => {});
        }
        if (!claimed.existing) {
          throw new MoveError(
            ERROR_KIND.AUDIT_LOG_INSERT_FAILED,
            'duplicate detected but winner row not found',
          );
        }
        return {
          success: true,
          status: 'duplicate_skipped',
          source_account: sourceAccount,
          source_mailbox: sourceMailbox,
          source_uid: uid,
          dest_account: destAccount,
          dest_mailbox: destMailbox,
          dest_uid: claimed.existing.dest_uid,
          message_id: src.messageId,
          subject: src.subject,
          from: src.from,
          size_bytes: src.sizeBytes,
          source_cleanup: 'skipped_unsafe',
          move_log_id: claimed.existing.id,
          warnings,
        };
      }
      const moveLogId = claimed.id;

      // 6-8. Source cleanup, capability-gated UID MOVE to source Trash.
      const cleanup = await this.cleanupSource(sourceAccount, sourceMailbox, uid, src.uidValidity);
      await this.logRepo.recordSourceCleanup(moveLogId, {
        source_deleted: cleanup.deleted,
        source_cleanup: cleanup.kind,
        error_kind: cleanup.errorKind ?? null,
        error_message: cleanup.errorMessage ?? null,
      });
      if (cleanup.warning) {
        warnings.push(cleanup.warning);
      }

      return {
        success: true,
        status,
        source_account: sourceAccount,
        source_mailbox: sourceMailbox,
        source_uid: uid,
        dest_account: destAccount,
        dest_mailbox: destMailbox,
        dest_uid: destUid,
        message_id: src.messageId,
        subject: src.subject,
        from: src.from,
        size_bytes: src.sizeBytes,
        source_cleanup: cleanup.kind,
        move_log_id: moveLogId,
        warnings,
      };
    } catch (err) {
      if (err instanceof MoveError) {
        return fail(err.kind, err.message);
      }
      return fail(
        ERROR_KIND.CONNECTION_ERROR,
        `cross-account move failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async fetchSource(account: string, mailbox: string, uid: number): Promise<FetchedSource> {
    const client = await this.connections.getImapClient(account);
    const lock = await client.getMailboxLock(mailbox);
    try {
      const uidValidity = client.mailbox && client.mailbox.uidValidity;
      const msg = await client.fetchOne(
        String(uid),
        { uid: true, source: true, flags: true, envelope: true, internalDate: true },
        { uid: true },
      );
      if (!msg || !msg.source) {
        throw new MoveError(
          ERROR_KIND.SOURCE_NOT_FOUND,
          `email ${uid} not found in ${account}/${mailbox}`,
        );
      }
      const env = msg.envelope;
      return {
        raw: msg.source,
        flags: msg.flags ? [...msg.flags] : [],
        internalDate: toDate(msg.internalDate),
        messageId: env?.messageId ?? null,
        subject: env?.subject ?? null,
        from: formatFrom(env?.from?.[0]),
        sizeBytes: msg.source.length,
        uidValidity: typeof uidValidity === 'bigint' ? uidValidity : 0n,
      };
    } finally {
      lock.release();
    }
  }

  /** UID MOVE the source message into the source account's \Trash (D18). */
  private async cleanupSource(
    account: string,
    mailbox: string,
    uid: number,
    expectedUidValidity: bigint,
  ): Promise<{
    deleted: boolean;
    kind: SourceCleanup;
    warning?: MoveWarning;
    errorKind?: string;
    errorMessage?: string;
  }> {
    const client = await this.connections.getImapClient(account);

    // 7. Resolve source \Trash via SPECIAL-USE.
    let trashPath: string | null = null;
    try {
      const mailboxes = await client.list();
      trashPath = mailboxes.find((mb) => mb.specialUse === '\\Trash')?.path ?? null;
    } catch {
      /* fall through to not-found */
    }
    if (!trashPath) {
      return {
        deleted: false,
        kind: 'skipped_no_trash',
        errorKind: ERROR_KIND.TRASH_MAILBOX_NOT_FOUND,
        errorMessage: `no \\Trash mailbox on "${account}"`,
      };
    }

    const lock = await client.getMailboxLock(mailbox);
    try {
      // 6. Re-verify UIDVALIDITY — the UID must still mean the same message.
      const nowUidValidity = client.mailbox && client.mailbox.uidValidity;
      if (
        expectedUidValidity !== 0n &&
        typeof nowUidValidity === 'bigint' &&
        nowUidValidity !== expectedUidValidity
      ) {
        return {
          deleted: false,
          kind: 'skipped_unsafe',
          errorKind: ERROR_KIND.SOURCE_NOT_FOUND,
          errorMessage: 'source UIDVALIDITY changed between fetch and cleanup',
        };
      }

      // 8. Capability-gated. UID MOVE only (proven safe on every current
      // account incl. Gmail). No MOVE → fail closed; never risk EXPUNGE.
      if (!client.capabilities.has('MOVE')) {
        return {
          deleted: false,
          kind: 'skipped_unsafe',
          errorKind: ERROR_KIND.SOURCE_CLEANUP_UNSAFE,
          errorMessage: `source "${account}" does not advertise MOVE; refusing unsafe EXPUNGE (fail closed)`,
        };
      }
      await client.messageMove(String(uid), trashPath, { uid: true });
      return { deleted: true, kind: 'moved_to_trash' };
    } catch (err) {
      return {
        deleted: false,
        kind: 'skipped_unsafe',
        errorKind: ERROR_KIND.SOURCE_CLEANUP_FAILED,
        errorMessage: `UID MOVE to Trash failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      lock.release();
    }
  }

  /** Remove a just-appended duplicate from the destination after a 23505 race. */
  private async discardDestDuplicate(
    destAccount: string,
    destMailbox: string,
    destUid: number,
  ): Promise<void> {
    const client = await this.connections.getImapClient(destAccount);
    const mailboxes = await client.list();
    const trashPath = mailboxes.find((mb) => mb.specialUse === '\\Trash')?.path;
    const lock = await client.getMailboxLock(destMailbox);
    try {
      if (trashPath && client.capabilities.has('MOVE')) {
        await client.messageMove(String(destUid), trashPath, { uid: true });
      }
      // No MOVE/Trash: leave the dup; the orphan is logged by the caller.
    } finally {
      lock.release();
    }
  }
}
