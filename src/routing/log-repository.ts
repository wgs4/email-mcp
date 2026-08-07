/**
 * MoveLogRepository (D15) — all Postgres access for the routing engine.
 *
 * Lazy connection (D-Premise-2 / D20): the client is built on first use. If
 * `[database].url` is unset → MoveError(database_misconfigured). If the host is
 * unreachable → database_unavailable. If auth/schema is wrong →
 * database_misconfigured. The rest of email-mcp never touches this.
 *
 * The audit log is part of the move contract (D-Premise-2): a move that cannot
 * be logged is a move that does not happen. `claim()` is called AFTER the
 * destination APPEND and BEFORE source cleanup, so a failed insert leaves the
 * source intact and the next run's pre-flight dedup reconciles.
 *
 * `logCopy()` is the deliberate exception: a copy destroys nothing, so its
 * audit row is best-effort and every throw here is downgraded to a warning by
 * the caller (see cross-account-mover.ts's header for the reasoning).
 */

import postgres from 'postgres';
import type { SourceCleanup } from './error-kinds.js';
import { ERROR_KIND, MoveError } from './error-kinds.js';

export interface MoveLogEntry {
  source_account: string;
  source_mailbox: string;
  source_uid: number;
  dest_account: string;
  dest_mailbox: string;
  dest_uid: number | null;
  message_id: string | null;
  subject: string | null;
  from_addr: string | null;
  email_date: Date | null;
  size_bytes: number | null;
  status: 'success' | 'failed' | 'duplicate_skipped' | 'not_found';
  manual: boolean;
}

export interface ExistingMove {
  id: number;
  dest_uid: number | null;
  status: string;
}

/**
 * Result of claim(). `ok:false` means the uniq_move_log_msgid unique index
 * fired — a concurrent move won the race; `existing` is the winner's row so
 * the caller can clean up its just-appended duplicate and report
 * duplicate_skipped.
 */
export type ClaimResult = { ok: true; id: number } | { ok: false; existing: ExistingMove | null };

type Sql = ReturnType<typeof postgres>;

/** Map a postgres/network error to a typed MoveError (returned, not thrown). */
function classifyConnectError(err: unknown): MoveError {
  const code = (err as { code?: string })?.code ?? '';
  if (
    /^(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|CONNECT_TIMEOUT|CONNECTION_DESTROYED|CONNECTION_CLOSED)$/.test(
      code,
    )
  ) {
    return new MoveError(
      ERROR_KIND.DATABASE_UNAVAILABLE,
      `Postgres unreachable (${code || 'connection error'})`,
    );
  }
  // SQLSTATE: bad auth (28*), missing database (3D000), un-migrated schema
  // (42P01), feature-not-supported (0A000).
  if (/^(28|3D000|42P01|0A000)/.test(code)) {
    return new MoveError(
      ERROR_KIND.DATABASE_MISCONFIGURED,
      `Postgres misconfigured (SQLSTATE ${code}) — check credentials/schema/migrations`,
    );
  }
  return new MoveError(
    ERROR_KIND.DATABASE_UNAVAILABLE,
    `Postgres error: ${err instanceof Error ? err.message : String(err)}`,
  );
}

export class MoveLogRepository {
  private sql: Sql | null = null;

  constructor(private readonly url: string | undefined) {}

  private client(): Sql {
    if (this.sql) {
      return this.sql;
    }
    if (!this.url?.trim()) {
      throw new MoveError(
        ERROR_KIND.DATABASE_MISCONFIGURED,
        'No [database].url configured (set it in config.toml or EMAIL_MCP_DATABASE_URL)',
      );
    }
    this.sql = postgres(this.url, { max: 1, onnotice: () => {}, connect_timeout: 10 });
    return this.sql;
  }

  /**
   * Insert the audit row post-APPEND. `{ ok:true, id }` on success;
   * `{ ok:false, existing }` when the unique index fires (concurrent winner).
   * Any other DB failure throws a typed MoveError.
   */
  async claim(entry: MoveLogEntry): Promise<ClaimResult> {
    const sql = this.client();
    try {
      const rows = await sql<{ id: number }[]>`
        INSERT INTO email_move_log (
          source_account, source_mailbox, source_uid,
          dest_account, dest_mailbox, dest_uid,
          message_id, subject, from_addr, email_date, size_bytes,
          manual, status, source_deleted
        ) VALUES (
          ${entry.source_account}, ${entry.source_mailbox}, ${entry.source_uid},
          ${entry.dest_account}, ${entry.dest_mailbox}, ${entry.dest_uid},
          ${entry.message_id}, ${entry.subject}, ${entry.from_addr},
          ${entry.email_date}, ${entry.size_bytes},
          ${entry.manual}, ${entry.status}, FALSE
        )
        RETURNING id`;
      return { ok: true, id: rows[0].id };
    } catch (err) {
      if ((err as { code?: string })?.code === '23505') {
        const existing = entry.message_id
          ? await this.findByMessageId(
              entry.dest_account,
              entry.dest_mailbox,
              entry.message_id,
            ).catch(() => null)
          : null;
        return { ok: false, existing };
      }
      throw classifyConnectError(err);
    }
  }

  /**
   * Insert the audit row for a COPY (`operation='copy'`, migration 002).
   *
   * Unlike claim() this is NOT part of the operation's contract — the caller
   * treats any throw as a warning and completes the copy regardless — so there
   * is no 23505 branch: `uniq_move_log_msgid` is scoped to `operation='move'`
   * precisely so copy rows can neither lose a race against, nor poison, the
   * move dedup guard. `source_deleted` is FALSE and `source_cleanup` stays NULL
   * because a copy never touches the source.
   */
  async logCopy(entry: MoveLogEntry): Promise<number> {
    const sql = this.client();
    try {
      const rows = await sql<{ id: number }[]>`
        INSERT INTO email_move_log (
          source_account, source_mailbox, source_uid,
          dest_account, dest_mailbox, dest_uid,
          message_id, subject, from_addr, email_date, size_bytes,
          manual, status, source_deleted, operation
        ) VALUES (
          ${entry.source_account}, ${entry.source_mailbox}, ${entry.source_uid},
          ${entry.dest_account}, ${entry.dest_mailbox}, ${entry.dest_uid},
          ${entry.message_id}, ${entry.subject}, ${entry.from_addr},
          ${entry.email_date}, ${entry.size_bytes},
          ${entry.manual}, ${entry.status}, FALSE, 'copy'
        )
        RETURNING id`;
      return rows[0].id;
    } catch (err) {
      throw classifyConnectError(err);
    }
  }

  /** Post-cleanup update: did the source actually get removed, and how (D18). */
  async recordSourceCleanup(
    id: number,
    fields: {
      source_deleted: boolean;
      source_cleanup: SourceCleanup;
      error_kind?: string | null;
      error_message?: string | null;
    },
  ): Promise<void> {
    const sql = this.client();
    try {
      await sql`
        UPDATE email_move_log
           SET source_deleted = ${fields.source_deleted},
               source_cleanup = ${fields.source_cleanup},
               error_kind     = ${fields.error_kind ?? null},
               error_message  = ${fields.error_message ?? null}
         WHERE id = ${id}`;
    } catch (err) {
      throw classifyConnectError(err);
    }
  }

  async findByMessageId(
    destAccount: string,
    destMailbox: string,
    messageId: string,
  ): Promise<ExistingMove | null> {
    const sql = this.client();
    try {
      const rows = await sql<ExistingMove[]>`
        SELECT id, dest_uid, status
          FROM email_move_log
         WHERE dest_account = ${destAccount}
           AND dest_mailbox = ${destMailbox}
           AND message_id   = ${messageId}
         ORDER BY id
         LIMIT 1`;
      return rows[0] ?? null;
    } catch (err) {
      throw classifyConnectError(err);
    }
  }

  async close(): Promise<void> {
    if (this.sql) {
      await this.sql.end({ timeout: 5 }).catch(() => {});
      this.sql = null;
    }
  }
}
