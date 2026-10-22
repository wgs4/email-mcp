/**
 * CrossAccountMover (D15) — the cross-account move saga (D18) and the
 * non-destructive cross-account copy that shares its first steps.
 *
 * Transaction-script style. Source and destination are DIFFERENT accounts →
 * two independent imapflow clients → two independent mailbox locks (no
 * re-entrancy/deadlock: the D2 concern is sweep re-entering the SAME client;
 * not applicable to the standalone tool, which acquires its own locks like
 * every other tool in the codebase).
 *
 * MOVE — atomic sequence (D18):
 *   1. FETCH source: raw RFC822 + flags + INTERNALDATE + Message-ID + UIDVALIDITY
 *   1a. Optional: prepend the caller's osTicket ticket tag (`[#N]`) to the
 *      top-level Subject — pure rewrite, see subject-tag.ts. A subject already
 *      belonging to a different ticket aborts the move before anything lands.
 *   2. Pre-flight dedup on destination by Message-ID (a tagged re-move also
 *      verifies the destination copy's first osTicket token)
 *   3. APPEND to destination (preserve flags + INTERNALDATE), capture dest_uid
 *   4. STORE $Routed on dest if PERMANENTFLAGS allows (else warn)
 *   5. Synchronous audit INSERT (claim). 23505 → clean up our dup, duplicate_skipped.
 *      For a tagged move the winner's destination Subject is verified first.
 *      Other DB failure → audit_log_insert_failed, source untouched.
 *   6. Re-verify source UIDVALIDITY unchanged
 *   7. Resolve source \Trash (SPECIAL-USE)
 *   8. Source cleanup: UID MOVE source → source Trash (capability-gated).
 *      No MOVE capability → fail closed (source_cleanup_unsafe). The minimal
 *      tool never issues EXPUNGE — the spike proved Gmail mis-scopes it; the
 *      proven-safe-EXPUNGE fallback needs a per-account operator assertion that
 *      is out of scope here, so we fail closed instead of risking the footgun.
 *   9. recordSourceCleanup
 *
 * COPY — steps 1-3 of that same sequence and nothing else:
 *   1-3. Identical, and literally the same code (`stageAtDestination`) so the
 *      two paths cannot drift apart: the copy lands with the original sender,
 *      Date, MIME structure, attachments, flags and INTERNALDATE — natively
 *      delivered, not forwarded.
 *   4. SKIPPED. $Routed is move/routing semantics; a copy must not look routed.
 *   5. Best-effort audit INSERT (logCopy) — see below.
 *   6-9. DELETED. The source is never re-opened for write: no Trash move, no
 *      \Deleted, no EXPUNGE, ever.
 *
 * Why the audit log is a hard requirement for a move but best-effort for a copy:
 * the move's claim() is the only durable record that the source was destroyed,
 * so "no audit log, no move" (D-Premise-2) is the right fail-closed posture. A
 * copy destroys nothing, and the common configuration has no [database] section
 * at all — refusing a non-destructive operation because Postgres is absent
 * fails closed on something that has nothing to fail closed about. So a missing
 * URL, an unreachable host, or a rejected INSERT produces an
 * `audit_log_skipped` warning and the copy still reports success.
 */

import type { ImapFlow } from 'imapflow';

import type ConnectionManager from '../connections/manager.js';
import type { ErrorKind, MoveWarning, SourceCleanup } from './error-kinds.js';
import { ERROR_KIND, MoveError, WARNING_KIND } from './error-kinds.js';
import type { MoveLogEntry, MoveLogRepository } from './log-repository.js';
import type { SubjectTicketCheck } from './subject-tag.js';
import { checkSubjectTicket, tagSubject } from './subject-tag.js';

export interface MoveArgs {
  sourceAccount: string;
  sourceMailbox: string;
  emailId: string;
  destAccount: string;
  destMailbox: string;
  /**
   * Optional osTicket ticket number. When set, the top-level Subject is tagged
   * with `[#N]` before APPEND so osTicket threads the message onto that ticket
   * instead of opening a new one.
   */
  ticketNumber?: string;
}

/** Copy takes exactly the same inputs as a move; the alias reads better at call sites. */
export type CopyArgs = MoveArgs;

/** Which saga a shared step is running under. */
export type TransferMode = 'move' | 'copy';

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
      /** TRUE when this move changed the Subject before APPEND. */
      subject_rewritten: boolean;
      /** osTicket ticket number requested for this move, if any. */
      ticket_tag: string | null;
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

/**
 * Same discriminated-union shape as MoveResult, minus the semantics a copy does
 * not have. `source_cleanup` is pinned to null (there is no cleanup to report —
 * the source is untouched by construction) and the audit-log id is nullable
 * because the copy completes with or without it.
 */
export type CopyResult =
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
      /** Always null: a copy never touches the source. */
      source_cleanup: null;
      /** email_move_log id when the best-effort audit row landed; null when it did not. */
      copy_log_id: number | null;
      warnings: MoveWarning[];
    }
  | {
      success: false;
      error_kind: string;
      error_message: string;
      source_account: string;
      source_mailbox: string;
      source_uid: number | null;
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

/** What steps 1-3 produce, for either mode's tail to finish with. */
interface StagedMessage {
  src: FetchedSource;
  destUid: number | null;
  dedupHit: boolean;
  subjectRewritten: boolean;
  ticketTag: string | null;
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

/** Human-readable reason a destination Subject failed the shared ticket check. */
function describeTagMismatch(check: SubjectTicketCheck): string {
  switch (check.status) {
    case 'conflict':
      return `also carries [#${check.existingTicket}]`;
    case 'different':
      return `first osTicket token is ${check.firstToken === null ? 'none' : `#${check.firstToken}`}, not the requested ticket`;
    case 'undecodable_subject':
      return 'contains an encoded-word this server cannot decode';
    case 'duplicate_subject':
      return 'has multiple Subject headers';
    case 'malformed_subject':
      return 'has a malformed Subject header';
    case 'no_subject':
      return 'has no Subject header';
    case 'match':
      return 'already matches the requested ticket';
    default:
      return 'failed the ticket check';
  }
}

/**
 * Verify that the destination copy osTicket is going to keep already resolves
 * to the requested ticket. Reads the destination's raw Subject header and
 * applies osTicket's own "first hash token" rule. A mismatch must never be
 * reported as a successful dedup, because the source would then be trashed
 * while the surviving copy still threads elsewhere (or opens a new ticket).
 */
async function assertDestinationTagWithClient(
  client: ImapFlow,
  uid: number,
  ticketNumber: string,
): Promise<string | null> {
  const msg = await client.fetchOne(
    String(uid),
    { uid: true, headers: ['subject'] },
    { uid: true },
  );
  const bytes = msg ? (msg.headers ?? msg.source) : undefined;
  if (!bytes) {
    throw new MoveError(
      ERROR_KIND.DEDUP_TAG_MISMATCH,
      `destination copy (uid ${uid}) could not be read to verify its osTicket tag`,
    );
  }
  // Same check as the source path (first token == n AND no conflicting
  // bracketed tag). Sharing checkSubjectTicket keeps the two from drifting.
  const check = checkSubjectTicket(
    Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes),
    ticketNumber,
  );
  if (check.status !== 'match') {
    throw new MoveError(
      ERROR_KIND.DEDUP_TAG_MISMATCH,
      `destination copy (uid ${uid}) ${describeTagMismatch(check)} (requested [#${ticketNumber}]); refusing to remove the source`,
    );
  }
  return check.subject;
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

    const invalid = this.validateArgs(args, uid, 'move');
    if (invalid) {
      return fail(invalid.kind, invalid.message);
    }

    const warnings: MoveWarning[] = [];

    try {
      // 0. A tagged move must be able to write its audit columns. Fail BEFORE
      // any destination APPEND, so schema 002 never leaves an unlogged copy.
      if (args.ticketNumber !== undefined) {
        await this.logRepo.ensureTicketTagColumns();
      }

      // 1-4. FETCH source, dedup, APPEND, $Routed.
      const { src, destUid, dedupHit, subjectRewritten, ticketTag } = await this.stageAtDestination(
        args,
        uid,
        'move',
        warnings,
      );

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
        subject_rewritten: !dedupHit && subjectRewritten,
        ticket_tag: ticketTag,
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
        if (ticketTag !== null) {
          // The winner's copy is the one that stays. Verify ITS subject before
          // reporting success and leaving the source for cleanup.
          const winnerUid = await this.resolveWinnerUid(
            destAccount,
            destMailbox,
            claimed.existing.dest_uid,
            src.messageId,
          );
          if (winnerUid === null) {
            throw new MoveError(
              ERROR_KIND.DEDUP_TAG_MISMATCH,
              'duplicate detected but the winning destination copy could not be located to verify its ticket tag',
            );
          }
          const winnerSubject = await this.assertDestinationTag(
            destAccount,
            destMailbox,
            winnerUid,
            ticketTag,
          );
          // Report the copy that actually survives, not the source's subject.
          if (winnerSubject !== null) {
            src.subject = winnerSubject;
          }
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
          subject_rewritten: false,
          ticket_tag: ticketTag,
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
        subject_rewritten: !dedupHit && subjectRewritten,
        ticket_tag: ticketTag,
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

  async copyMany(argsList: CopyArgs[]): Promise<CopyResult[]> {
    // Sequential, per-item results — same posture as moveMany.
    return argsList.reduce<Promise<CopyResult[]>>(async (accP, args) => {
      const acc = await accP;
      acc.push(await this.copyOne(args));
      return acc;
    }, Promise.resolve([]));
  }

  /**
   * Steps 1-3 of the saga and nothing else. The source is opened READ-ONLY (a
   * FETCH under a mailbox lock) and never written to: no $Routed, no Trash
   * move, no \Deleted, no EXPUNGE. There is no post-append duplicate-discard
   * path either — that exists only to unwind a lost DB claim race, and a copy
   * makes no claim, so nothing at the destination is ever deleted.
   */
  async copyOne(args: CopyArgs): Promise<CopyResult> {
    const { sourceAccount, sourceMailbox, emailId, destAccount, destMailbox } = args;
    const uid = Number.parseInt(emailId, 10);

    const fail = (kind: string, message: string): CopyResult => ({
      success: false,
      error_kind: kind,
      error_message: message,
      source_account: sourceAccount,
      source_mailbox: sourceMailbox,
      source_uid: Number.isFinite(uid) ? uid : null,
    });

    const invalid = this.validateArgs(args, uid, 'copy');
    if (invalid) {
      return fail(invalid.kind, invalid.message);
    }

    const warnings: MoveWarning[] = [];

    try {
      // 1-3. FETCH source, dedup, APPEND. (4. $Routed is move-only.)
      const { src, destUid, dedupHit } = await this.stageAtDestination(args, uid, 'copy', warnings);

      // 5. Best-effort audit row — never fails or blocks the copy.
      const status: 'success' | 'duplicate_skipped' = dedupHit ? 'duplicate_skipped' : 'success';
      const copyLogId = await this.recordCopy(
        {
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
        },
        warnings,
      );

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
        source_cleanup: null,
        copy_log_id: copyLogId,
        warnings,
      };
    } catch (err) {
      if (err instanceof MoveError) {
        return fail(err.kind, err.message);
      }
      return fail(
        ERROR_KIND.CONNECTION_ERROR,
        `cross-account copy failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Shared input guards. Pure — never touches IMAP or Postgres. Only the
   * same-account refusal differs between modes, and only in which sibling tool
   * it names.
   */
  private validateArgs(
    args: MoveArgs,
    uid: number,
    mode: TransferMode,
  ): { kind: ErrorKind; message: string } | null {
    const { sourceAccount, emailId, destAccount } = args;
    if (!Number.isInteger(uid) || uid <= 0) {
      return {
        kind: ERROR_KIND.INVALID_EMAIL_ID,
        message: `email_id "${emailId}" is not a positive integer`,
      };
    }
    if (args.ticketNumber !== undefined && !/^\d{3,10}$/.test(args.ticketNumber)) {
      return {
        kind: ERROR_KIND.INVALID_TICKET_NUMBER,
        message: `ticketNumber "${args.ticketNumber}" must be 3-10 digits`,
      };
    }
    const accounts = new Set(this.connections.getAccountNames());
    if (!accounts.has(sourceAccount)) {
      return {
        kind: ERROR_KIND.SOURCE_NOT_FOUND,
        message: `source account "${sourceAccount}" not configured`,
      };
    }
    if (!accounts.has(destAccount)) {
      return {
        kind: ERROR_KIND.DEST_ACCOUNT_INVALID,
        message: `destination account "${destAccount}" not configured`,
      };
    }
    if (sourceAccount === destAccount) {
      return mode === 'move'
        ? {
            kind: ERROR_KIND.SAME_ACCOUNT_MOVE,
            message: 'source and destination are the same account — use move_email instead',
          }
        : {
            kind: ERROR_KIND.SAME_ACCOUNT_COPY,
            message: 'source and destination are the same account — use copy_email instead',
          };
    }
    return null;
  }

  /**
   * Steps 1-4, shared by both sagas: FETCH the source (read-only), pre-flight
   * dedup the destination by Message-ID, APPEND preserving flags +
   * INTERNALDATE, and — for a MOVE only — STORE the $Routed keyword.
   *
   * Throws a typed MoveError; the caller's outer catch maps it to a result.
   */
  private async stageAtDestination(
    args: MoveArgs,
    uid: number,
    mode: TransferMode,
    warnings: MoveWarning[],
  ): Promise<StagedMessage> {
    const { sourceAccount, sourceMailbox, destAccount, destMailbox } = args;

    // 1. FETCH source.
    const src = await this.fetchSource(sourceAccount, sourceMailbox, uid);

    // 1a. osTicket threading: prepend the tag to the top-level Subject before
    // dedup and APPEND. A subject already belonging to a different ticket, or
    // one osTicket could not unambiguously read, aborts before anything lands.
    let subjectRewritten = false;
    let ticketTag: string | null = null;
    if (mode === 'move' && args.ticketNumber) {
      const tagged = tagSubject(src.raw, args.ticketNumber);
      if (tagged.status === 'conflict') {
        throw new MoveError(
          ERROR_KIND.TICKET_TAG_CONFLICT,
          `subject already carries osTicket tag [#${tagged.existingTicket}]; refusing to add [#${args.ticketNumber}]`,
        );
      }
      if (tagged.status === 'duplicate_subject') {
        throw new MoveError(
          ERROR_KIND.DUPLICATE_SUBJECT_HEADER,
          'message has multiple top-level Subject headers; osTicket could pick either one, so refusing to tag it',
        );
      }
      if (tagged.status === 'malformed_subject') {
        throw new MoveError(
          ERROR_KIND.MALFORMED_SUBJECT_HEADER,
          'Subject header contains a bare CR/LF that is not a valid fold; refusing to rewrite it',
        );
      }
      if (tagged.status === 'undecodable_subject') {
        throw new MoveError(
          ERROR_KIND.UNDECODABLE_SUBJECT,
          'Subject contains an encoded-word this server cannot decode; refusing to tag it without a trustworthy conflict check',
        );
      }
      src.raw = tagged.raw;
      if (tagged.subject !== null) {
        src.subject = tagged.subject;
      }
      subjectRewritten = tagged.rewritten;
      ticketTag = args.ticketNumber;
    }

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
          // A dedup hit is only acceptable when the destination copy already
          // carries the requested ticket as its FIRST osTicket token. Otherwise
          // the tag would silently be lost and the source cleaned up anyway.
          if (mode === 'move' && ticketTag !== null) {
            const destSubject = await assertDestinationTagWithClient(
              destClient,
              destUid,
              ticketTag,
            );
            // Report the copy that actually survives, not the source's subject.
            if (destSubject !== null) {
              src.subject = destSubject;
            }
          }
        }
      }
      if (!dedupHit) {
        const appended = await destClient.append(destMailbox, src.raw, src.flags, src.internalDate);
        if (appended === false || typeof appended.uid !== 'number') {
          throw new MoveError(
            ERROR_KIND.APPEND_FAILED,
            'destination APPEND failed or returned no UID',
          );
        }
        destUid = appended.uid;
        // 4. $Routed keyword, capability-gated on PERMANENTFLAGS. Move only —
        // a copy must look natively delivered, not routed.
        if (mode === 'move') {
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
      }
    } catch (err) {
      throw classifyImapError(err, ERROR_KIND.APPEND_FAILED);
    } finally {
      destLock.release();
    }

    return { src, destUid, dedupHit, subjectRewritten, ticketTag };
  }

  /** Same check, acquiring its own mailbox lock (used after the audit race). */
  private async assertDestinationTag(
    account: string,
    mailbox: string,
    uid: number,
    ticketNumber: string,
  ): Promise<string | null> {
    const client = await this.connections.getImapClient(account);
    const lock = await client.getMailboxLock(mailbox);
    try {
      return await assertDestinationTagWithClient(client, uid, ticketNumber);
    } finally {
      lock.release();
    }
  }

  /** Locate the audit-race winner's destination UID when the row lacks it. */
  private async resolveWinnerUid(
    account: string,
    mailbox: string,
    destUid: number | null,
    messageId: string | null,
  ): Promise<number | null> {
    if (destUid !== null) {
      return destUid;
    }
    if (!messageId) {
      return null;
    }
    const client = await this.connections.getImapClient(account);
    const lock = await client.getMailboxLock(mailbox);
    try {
      const found = await client.search({ header: { 'message-id': messageId } }, { uid: true });
      return found && found.length > 0 ? found[0] : null;
    } finally {
      lock.release();
    }
  }

  /**
   * Step 5 for a COPY: best-effort audit row. Every failure mode — no
   * [database].url (the default install), unreachable host, un-migrated schema,
   * rejected INSERT — becomes an audit_log_skipped warning on an otherwise
   * successful copy. Contrast claim() in moveOne, where a move that cannot be
   * logged must not happen at all.
   */
  private async recordCopy(entry: MoveLogEntry, warnings: MoveWarning[]): Promise<number | null> {
    try {
      return await this.logRepo.logCopy(entry);
    } catch (err) {
      warnings.push({
        kind: WARNING_KIND.AUDIT_LOG_SKIPPED,
        message: `copy completed but was not audit-logged: ${err instanceof Error ? err.message : String(err)}`,
      });
      return null;
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
