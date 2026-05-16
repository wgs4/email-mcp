-- 001_init_email_mcp.sql
-- Cross-account email move + routing engine — initial schema.
--
-- Target database: email_mcp (dedicated DB on the WGS Postgres cluster,
-- owned by the dedicated `email_mcp` role — see design doc D20).
--
-- Forward-only migration (D5). No down(). Dev reset is
--   DROP DATABASE email_mcp; CREATE DATABASE email_mcp OWNER email_mcp;
-- then re-run `pnpm db:migrate`. Production rollback is from a Postgres
-- backup + a forward fix.
--
-- This file is pure DDL. bin/migrate.ts wraps it in a single transaction;
-- do NOT add BEGIN/COMMIT here. Every statement below is transaction-safe
-- on PostgreSQL 14.

-- ---------------------------------------------------------------------------
-- routing_rules — the policy layer
-- ---------------------------------------------------------------------------
CREATE TABLE routing_rules (
    id                SERIAL PRIMARY KEY,
    name              TEXT NOT NULL,
    source_account    TEXT NOT NULL,
    dest_account      TEXT NOT NULL,
    dest_mailbox      TEXT NOT NULL DEFAULT 'INBOX',

    -- Match conditions: AND across all non-null fields.
    -- match_subject / match_from / match_to are implemented in v1.
    -- match_header / match_body are accepted at the schema level but their
    -- evaluation is deferred to v2 (D13): routing_rules_manage rejects a rule
    -- whose ONLY non-null predicates are match_header/match_body, so a
    -- v1 rule can never silently match-all.
    match_subject     TEXT,
    match_from        TEXT,
    match_to          TEXT,
    match_header      JSONB,
    match_body        TEXT,
    exclude_from      TEXT,        -- per-rule regex, checked AFTER global trusted_domains

    -- Behavior
    priority          INT NOT NULL DEFAULT 100,
    enabled           BOOLEAN NOT NULL DEFAULT TRUE,
    mark_read         BOOLEAN NOT NULL DEFAULT FALSE,   -- support wants routed mail unread
    add_flag          TEXT,
    -- D14: bad-rule blast-radius cap. apply_routing_rules counts moves for
    -- this rule in the last 24h; at/over the cap it auto-sets enabled=FALSE.
    max_moves_per_day INT NOT NULL DEFAULT 20,

    -- Metadata
    notes             TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by        TEXT
);

CREATE INDEX idx_routing_rules_source ON routing_rules (source_account) WHERE enabled;

-- Keep updated_at honest on every UPDATE.
CREATE OR REPLACE FUNCTION routing_rules_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_routing_rules_updated_at
  BEFORE UPDATE ON routing_rules
  FOR EACH ROW
  EXECUTE FUNCTION routing_rules_touch_updated_at();

-- ---------------------------------------------------------------------------
-- email_move_log — the audit trail (source of truth for "what got routed")
-- ---------------------------------------------------------------------------
CREATE TABLE email_move_log (
    id              BIGSERIAL PRIMARY KEY,
    moved_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    source_account  TEXT NOT NULL,
    source_mailbox  TEXT NOT NULL,
    source_uid      BIGINT NOT NULL,

    dest_account    TEXT NOT NULL,
    dest_mailbox    TEXT NOT NULL,
    dest_uid        BIGINT,

    message_id      TEXT,
    subject         TEXT,
    from_addr       TEXT,
    email_date      TIMESTAMPTZ,                       -- NULL when Date header unparseable
    size_bytes      BIGINT,                            -- BIGINT: large MIME can exceed INT max

    rule_id         INT REFERENCES routing_rules(id),
    sweep_session   TEXT,
    manual          BOOLEAN NOT NULL DEFAULT FALSE,

    status          TEXT NOT NULL DEFAULT 'success'
                        CHECK (status IN ('success','failed','duplicate_skipped','not_found')),
    -- TRUE only after source cleanup actually removed the source (UID MOVE to
    -- Trash, or proven-safe EXPUNGE). FALSE when cleanup was skipped/failed.
    source_deleted  BOOLEAN NOT NULL DEFAULT FALSE,
    -- D18: which source-cleanup path was taken.
    source_cleanup  TEXT
                        CHECK (source_cleanup IS NULL OR source_cleanup IN
                          ('moved_to_trash','expunged','skipped_unsafe','skipped_no_trash')),
    error_kind      TEXT,                              -- precise code from the error matrix
    error_message   TEXT
);

-- Race safety (concurrent sweeps): the second concurrent move of the same
-- message fails this UNIQUE with SQLSTATE 23505; the move tool catches it,
-- moves its just-appended duplicate to the dest Trash, and reports
-- duplicate_skipped. Message-ID-less rows are exempt (partial index);
-- the fallback (from+date+size+sha256) dedup handles those.
CREATE UNIQUE INDEX uniq_move_log_msgid
  ON email_move_log (dest_account, dest_mailbox, message_id)
  WHERE message_id IS NOT NULL;

CREATE INDEX idx_move_log_message_id ON email_move_log (message_id);
CREATE INDEX idx_move_log_moved_at   ON email_move_log (moved_at);
CREATE INDEX idx_move_log_rule       ON email_move_log (rule_id) WHERE rule_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- trusted_domains — global cross-cutting exclusion (P4)
-- ---------------------------------------------------------------------------
-- Matching is SUFFIX-based in the engine: 'ups.com' excludes 'ups.com' and
-- any subdomain ('notifications.ups.com'), but NOT 'upsource.com'. Store
-- registrable apex domains only, lowercase, no leading dot. The UNIQUE
-- constraint already provides the lookup index — no extra CREATE INDEX.
CREATE TABLE trusted_domains (
    id          SERIAL PRIMARY KEY,
    domain      TEXT NOT NULL UNIQUE,
    notes       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
