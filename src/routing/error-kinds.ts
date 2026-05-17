/**
 * Typed error/warning codes for the cross-account routing engine (D8/D9).
 *
 * const-object-derived unions: one source of truth, IDE refactor + autocomplete,
 * switch-statement exhaustiveness. Emitted in MoveResult and written to
 * email_move_log.error_kind.
 */

export const ERROR_KIND = {
  /** Source UID not in the source mailbox (already moved, or UIDVALIDITY changed). No-op. */
  SOURCE_NOT_FOUND: 'source_not_found',
  /** email_id is not a positive integer. */
  INVALID_EMAIL_ID: 'invalid_email_id',
  /** Destination account is not configured in email-mcp. */
  DEST_ACCOUNT_INVALID: 'dest_account_invalid',
  /** Source and destination are the same account — use move_email instead (D2). */
  SAME_ACCOUNT_MOVE: 'same_account_move',
  /** IMAP APPEND to the destination was rejected (permissions, missing mailbox). */
  APPEND_FAILED: 'append_failed',
  /** Destination mailbox is over quota. */
  QUOTA_EXCEEDED: 'quota_exceeded',
  /** IMAP connection dropped mid-operation. */
  CONNECTION_ERROR: 'connection_error',
  /** Postgres host unreachable — lazy connect failed. */
  DATABASE_UNAVAILABLE: 'database_unavailable',
  /** Postgres reachable but auth/schema wrong (operator setup error). */
  DATABASE_MISCONFIGURED: 'database_misconfigured',
  /** [routing].enabled = false kill switch. */
  ROUTING_DISABLED: 'routing_disabled',
  /** APPEND succeeded but the audit-log INSERT failed — source NOT removed. */
  AUDIT_LOG_INSERT_FAILED: 'audit_log_insert_failed',
  /** APPEND + audit OK but the source UID MOVE to Trash (or EXPUNGE) failed. */
  SOURCE_CLEANUP_FAILED: 'source_cleanup_failed',
  /** Source advertises no MOVE and has no proven-safe UID EXPUNGE — fail closed (D18). */
  SOURCE_CLEANUP_UNSAFE: 'source_cleanup_unsafe',
  /** Source account has no SPECIAL-USE \Trash mailbox to MOVE into (D18). */
  TRASH_MAILBOX_NOT_FOUND: 'trash_mailbox_not_found',
} as const;

export type ErrorKind = (typeof ERROR_KIND)[keyof typeof ERROR_KIND];

export const WARNING_KIND = {
  /** $Routed keyword not settable — destination PERMANENTFLAGS rejects custom keywords. */
  FLAG_NOT_SET: 'flag_not_set',
  /** Source cleanup used STORE \Deleted + UID EXPUNGE (non-MOVE, proven-safe server). */
  EXPUNGE_FALLBACK: 'expunge_fallback',
  /** dest_mailbox was remapped via SPECIAL-USE (e.g. "INBOX" → "[Gmail]/All Mail"). */
  DEST_MAILBOX_REMAPPED: 'dest_mailbox_remapped',
} as const;

export type WarningKind = (typeof WARNING_KIND)[keyof typeof WARNING_KIND];

export interface MoveWarning {
  kind: WarningKind;
  message: string;
}

/** D18: which source-cleanup path the move actually took. Mirrors email_move_log.source_cleanup. */
export type SourceCleanup = 'moved_to_trash' | 'expunged' | 'skipped_unsafe' | 'skipped_no_trash';

/** A move-engine error carrying a typed kind, thrown by the saga and mapped to MoveResult. */
export class MoveError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'MoveError';
  }
}
