-- 003_email_move_log_ticket_tag.sql
-- Record the osTicket tag injected into the Subject by cross_account_move.
--
-- `subject_rewritten` says whether this call changed the Subject bytes on the
-- copy that landed at the destination; `ticket_tag` is the requested ticket
-- number (whether or not the rewrite was needed — an already-tagged subject is
-- left untouched, subject_rewritten stays FALSE, and ticket_tag still records
-- which ticket the move was aimed at).
--
-- Defaults keep every pre-existing row truthful: nothing before this feature
-- rewrote a subject, so FALSE/NULL is exactly right. `claim()` writes both
-- columns explicitly; copy rows and old rows take the defaults.
--
-- Forward-only (D5). Pure DDL — bin/migrate.ts supplies the transaction.

ALTER TABLE email_move_log
  ADD COLUMN IF NOT EXISTS subject_rewritten BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ticket_tag TEXT;
