-- ============================================================
-- dolores :: initial migration
-- Extensions · Tables · Indexes · RLS · Decay functions · pg_cron
-- All statements are idempotent (safe to re-run).
--
-- NOTE: dolores_app password is NOT set here. When using applyMigrations()
-- (the TypeScript function), it is set from DOLORES_APP_PASSWORD env var via
-- a safely-escaped ALTER ROLE call. When running this file directly via
-- prisma migrate deploy, run afterwards:
--   ALTER ROLE dolores_app WITH PASSWORD '<your-password>';
-- ============================================================

-- 1. Extensions -----------------------------------------------

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 2. Tables ---------------------------------------------------

CREATE TABLE IF NOT EXISTS facts (
  id           UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id UUID        NOT NULL,
  user_id      UUID,                      -- NULL = workspace-level fact
  scope        TEXT        NOT NULL DEFAULT 'personal',
  category     TEXT        NOT NULL,
  key          TEXT        NOT NULL,
  value        TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memories (
  id            UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id  UUID        NOT NULL,
  user_id       UUID,                     -- NULL = workspace-level memory
  scope         TEXT        NOT NULL DEFAULT 'personal',
  content       TEXT        NOT NULL,
  importance    SMALLINT    NOT NULL DEFAULT 5,
  source        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_accessed TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- pgvector: 384 dims = bge-small-en-v1.5 (fastembed default)
  embedding     vector(384),
  -- generated tsvector for hybrid full-text search
  content_tsv   TSVECTOR    GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);

-- HOT update optimization: last_accessed/importance updated on every recall hit.
-- fillfactor=80 reserves 20% of each page so in-place HOT updates are possible.
ALTER TABLE memories SET (fillfactor=80);

-- 3. Indexes --------------------------------------------------

-- facts: a single NULLS NOT DISTINCT unique index (PG15+). Standard UNIQUE treats
-- NULLs as distinct, which would allow duplicate workspace-level facts (user_id IS
-- NULL). A PARTIAL index would dedupe but cannot back core.upsertFact's predicate-less
-- ON CONFLICT (workspace_id, user_id, category, key) inference — so one combined
-- NULLS NOT DISTINCT index is the correct choice here.
CREATE UNIQUE INDEX IF NOT EXISTS facts_ws_user_cat_key
  ON facts (workspace_id, user_id, category, key)
  NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS idx_facts_workspace_scope
  ON facts (workspace_id, scope);

-- memories: vector ANN (cosine), full-text GIN, tenant+scope filter
CREATE INDEX IF NOT EXISTS idx_memories_workspace_scope
  ON memories (workspace_id, scope);

-- IVFFlat with lists=100 is appropriate for up to ~1M rows.
-- If the table grows beyond that, rebuild with a higher lists value.
CREATE INDEX IF NOT EXISTS idx_memories_embedding
  ON memories USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_memories_content_tsv
  ON memories USING gin (content_tsv);

-- Composite index for ranking queries: buildContext/prune/decay all filter by
-- workspace_id and order by importance + recency — this index covers all three.
CREATE INDEX IF NOT EXISTS idx_memories_ranking
  ON memories (workspace_id, importance DESC, last_accessed DESC, created_at DESC);

-- 4. Row-Level Security ---------------------------------------

-- FORCE ROW LEVEL SECURITY ensures the table owner (non-superuser) also obeys
-- the policies. The daemon connects as `dolores_app` (non-superuser) so that
-- RLS is enforced on every query.
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories FORCE ROW LEVEL SECURITY;

-- memories_tenant_isolation:
--   Daemon sets dolores.workspace_id (always) and dolores.user_id (when available)
--   as transaction-local GUCs via SET LOCAL before every query.
--
--   Visibility rules:
--     • workspace_id must always match dolores.workspace_id.
--     • user_id IS NULL  → workspace-wide row, visible to any workspace member.
--     • user_id IS NOT NULL → visible only when dolores.user_id is set and matches.
--
--   WITH CHECK mirrors USING so INSERT/UPDATE also enforce tenant isolation.
--   When dolores.workspace_id is unset, current_setting returns '' → no rows pass.
--
--   DROP + CREATE is used for idempotency (PostgreSQL has no CREATE OR REPLACE POLICY).
-- After a transaction that used set_config('dolores.workspace_id', uuid, true) commits,
-- PostgreSQL reverts the GUC to its session default — '' (empty string) for undefined
-- custom GUCs. Both UUID casts use CASE/nullif to guard against ''::uuid cast error.
DROP POLICY IF EXISTS memories_tenant_isolation ON memories;
CREATE POLICY memories_tenant_isolation ON memories
  AS PERMISSIVE FOR ALL
  USING (
    workspace_id = CASE
      WHEN nullif(current_setting('dolores.workspace_id', true), '') IS NOT NULL
      THEN current_setting('dolores.workspace_id', true)::uuid
    END
    AND (
      user_id IS NULL
      OR user_id = CASE
        WHEN nullif(current_setting('dolores.user_id', true), '') IS NOT NULL
        THEN current_setting('dolores.user_id', true)::uuid
      END
    )
  )
  WITH CHECK (
    workspace_id = CASE
      WHEN nullif(current_setting('dolores.workspace_id', true), '') IS NOT NULL
      THEN current_setting('dolores.workspace_id', true)::uuid
    END
    AND (
      user_id IS NULL
      OR user_id = CASE
        WHEN nullif(current_setting('dolores.user_id', true), '') IS NOT NULL
        THEN current_setting('dolores.user_id', true)::uuid
      END
    )
  );

ALTER TABLE facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE facts FORCE ROW LEVEL SECURITY;

-- facts_tenant_isolation: identical isolation logic as memories
DROP POLICY IF EXISTS facts_tenant_isolation ON facts;
CREATE POLICY facts_tenant_isolation ON facts
  AS PERMISSIVE FOR ALL
  USING (
    workspace_id = CASE
      WHEN nullif(current_setting('dolores.workspace_id', true), '') IS NOT NULL
      THEN current_setting('dolores.workspace_id', true)::uuid
    END
    AND (
      user_id IS NULL
      OR user_id = CASE
        WHEN nullif(current_setting('dolores.user_id', true), '') IS NOT NULL
        THEN current_setting('dolores.user_id', true)::uuid
      END
    )
  )
  WITH CHECK (
    workspace_id = CASE
      WHEN nullif(current_setting('dolores.workspace_id', true), '') IS NOT NULL
      THEN current_setting('dolores.workspace_id', true)::uuid
    END
    AND (
      user_id IS NULL
      OR user_id = CASE
        WHEN nullif(current_setting('dolores.user_id', true), '') IS NOT NULL
        THEN current_setting('dolores.user_id', true)::uuid
      END
    )
  );

-- 5. Application role --------------------------------------------
--
-- Superusers (POSTGRES_USER) bypass RLS entirely; the daemon must connect
-- as a non-superuser so that the tenant isolation policies are enforced.
-- dolores_app gets only DML on the two tables — no schema changes.
-- Password is NOT set here — use applyMigrations() (reads DOLORES_APP_PASSWORD)
-- or run: ALTER ROLE dolores_app WITH PASSWORD '<password>';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dolores_app') THEN
    CREATE ROLE dolores_app WITH LOGIN;
  END IF;
END;
$$;

GRANT CONNECT ON DATABASE dolores TO dolores_app;
GRANT USAGE ON SCHEMA public TO dolores_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE memories, facts TO dolores_app;

-- 6. SECURITY DEFINER decay functions ---------------------------
--
-- pg_cron jobs run without dolores.workspace_id GUC set. With FORCE RLS enabled,
-- even the scheduler role sees 0 rows through the tenant isolation policy
-- (workspace_id = NULL → false). SECURITY DEFINER makes these functions run
-- as the creating superuser, bypassing RLS — the correct scope for maintenance.
-- SET search_path = public prevents search_path hijacking attacks.
CREATE OR REPLACE FUNCTION dolores_soften_memories()
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  UPDATE memories
     SET importance = GREATEST(1, importance - 1)
   WHERE last_accessed < now() - INTERVAL '30 days'
     AND importance > 1;
END;
$$;

CREATE OR REPLACE FUNCTION dolores_decay_memories()
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  DELETE FROM memories
   WHERE importance < 3
     AND last_accessed < now() - INTERVAL '90 days';
END;
$$;

-- 7. pg_cron: conservative decay (default, always scheduled) --
--
-- Reduces importance of stale memories once a day via SECURITY DEFINER function.
-- NEVER deletes — safe by default (DOLORES_DECAY_MODE=conservative).
-- For the opt-in aggressive DELETE policy see AGGRESSIVE_DECAY_SQL in migration.ts.
--
-- cron.schedule() upserts by jobname, so this is idempotent.
SELECT cron.schedule(
  'memory-soften',
  '0 3 * * *',
  'SELECT dolores_soften_memories()'
);
