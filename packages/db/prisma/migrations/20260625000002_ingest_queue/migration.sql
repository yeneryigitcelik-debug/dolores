-- Durable async ingest queue (EPIC J).
--
-- This migration covers the Prisma-ownable base table + index. The tenant RLS
-- policy, the SECURITY DEFINER claim/reclaim/purge functions, the dolores_app
-- grants, and the pg_cron purge job are applied as raw SQL by applyMigrations()
-- (packages/db/src/migration.ts) — keep the two in sync.
--
-- payload is a TRANSIENT work buffer: purged (set NULL) the instant a job reaches
-- a terminal state (done/failed), so dolores never becomes a chat-log store.

CREATE TABLE IF NOT EXISTS ingest_jobs (
  id           UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id UUID        NOT NULL,
  user_id      UUID,
  status       TEXT        NOT NULL DEFAULT 'pending',
  payload      TEXT,
  source       TEXT,
  attempts     INT         NOT NULL DEFAULT 0,
  last_error   TEXT,
  run_after    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ingest_jobs_claim
  ON ingest_jobs (run_after, created_at) WHERE status = 'pending';
