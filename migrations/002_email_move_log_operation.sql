-- 002_email_move_log_operation.sql
-- cross_account_copy — tell copy rows apart from move rows in email_move_log.
--
-- A copy writes the same audit shape as a move but leaves the source in place,
-- so without a discriminator a copy row is indistinguishable from a move whose
-- source cleanup never got recorded (source_deleted FALSE + source_cleanup
-- NULL — the crashed-move signature). `operation` makes that explicit.
--
-- Every pre-existing row is a move, which is exactly what the DEFAULT gives.
-- `claim()` (the move path) still INSERTs without naming the column, so move
-- behavior is untouched; only `logCopy()` writes 'copy'.
--
-- uniq_move_log_msgid is re-created scoped to operation='move'. The index is
-- the move saga's concurrent-race guard: the loser catches 23505, discards its
-- just-appended duplicate and reports duplicate_skipped. A copy makes no such
-- claim and must never delete anything, so copy rows are kept out of the index
-- entirely — a copy can neither lose that race nor cause a later move to
-- unwind itself. Move-vs-move semantics are byte-for-byte unchanged.
--
-- Forward-only (D5). Pure DDL — bin/migrate.ts supplies the transaction.

ALTER TABLE email_move_log
  ADD COLUMN IF NOT EXISTS operation TEXT NOT NULL DEFAULT 'move'
    CHECK (operation IN ('move','copy'));

DROP INDEX IF EXISTS uniq_move_log_msgid;

CREATE UNIQUE INDEX uniq_move_log_msgid
  ON email_move_log (dest_account, dest_mailbox, message_id)
  WHERE message_id IS NOT NULL AND operation = 'move';

-- Copies are the rarer row; a partial index keeps "show me the copies" cheap
-- without adding write cost to the move path.
CREATE INDEX idx_move_log_copies
  ON email_move_log (moved_at)
  WHERE operation = 'copy';
