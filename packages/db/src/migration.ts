/**
 * Embedded migration SQL — mirrors prisma/migrations/20240620000000_init/migration.sql.
 * All statements are idempotent; applyMigrations() can be called on every startup.
 *
 * Password for dolores_app is NOT embedded here — applyMigrations() sets it via
 * a parameterized ALTER ROLE call using DOLORES_APP_PASSWORD env var.
 */
export const INIT_SQL = /* sql */ `
-- Extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- facts table
CREATE TABLE IF NOT EXISTS facts (
  id           UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id UUID        NOT NULL,
  user_id      UUID,
  scope        TEXT        NOT NULL DEFAULT 'personal',
  category     TEXT        NOT NULL,
  key          TEXT        NOT NULL,
  value        TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- memories table (embedding + generated tsvector added as raw SQL)
CREATE TABLE IF NOT EXISTS memories (
  id            UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id  UUID        NOT NULL,
  user_id       UUID,
  scope         TEXT        NOT NULL DEFAULT 'personal',
  content       TEXT        NOT NULL,
  importance    SMALLINT    NOT NULL DEFAULT 5,
  source        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_accessed TIMESTAMPTZ NOT NULL DEFAULT now(),
  embedding     vector(384),
  content_tsv   TSVECTOR    GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);

-- HOT update optimization: last_accessed/importance update on every recall hit.
-- fillfactor=80 reserves 20% of each page so updates stay on the same page (HOT).
ALTER TABLE memories SET (fillfactor=80);

-- Indexes on facts
-- Single NULLS NOT DISTINCT unique index (PG15+). A predicate-less
-- ON CONFLICT (workspace_id, user_id, category, key) cannot infer a PARTIAL
-- unique index, so one combined index is required.
-- NULLS NOT DISTINCT makes workspace-level facts (user_id IS NULL) dedupe too.
CREATE UNIQUE INDEX IF NOT EXISTS facts_ws_user_cat_key
  ON facts (workspace_id, user_id, category, key)
  NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS idx_facts_workspace_scope
  ON facts (workspace_id, scope);

-- Indexes on memories
CREATE INDEX IF NOT EXISTS idx_memories_workspace_scope
  ON memories (workspace_id, scope);
-- The VECTOR index (ivfflat default | hnsw opt-in) is created separately by
-- applyMigrations() from DOLORES_VECTOR_INDEX — see vectorIndexSql() below. It is
-- NOT in INIT_SQL so re-running with hnsw selected never rebuilds the ivfflat one.
CREATE INDEX IF NOT EXISTS idx_memories_content_tsv
  ON memories USING gin (content_tsv);
-- Composite index covers buildContext/prune/decay ranking queries to avoid seq-scan.
CREATE INDEX IF NOT EXISTS idx_memories_ranking
  ON memories (workspace_id, importance DESC, last_accessed DESC, created_at DESC);

-- Temporal memory evolution (EPIC F). Columns are added via ALTER (not the
-- CREATE TABLE above) so existing databases converge too — CREATE TABLE IF NOT
-- EXISTS never adds columns to a pre-existing table. All statements idempotent.
--   superseded_by : self-FK to the memory that replaced this one (NULL = active).
--                   ON DELETE SET NULL keeps the chain from blocking hard deletes.
--   valid_from    : when this statement became true (backfilled from created_at).
--   valid_to      : when it stopped being true (set when superseded; NULL = still true).
ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS superseded_by UUID REFERENCES memories(id) ON DELETE SET NULL;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS valid_to   TIMESTAMPTZ;
-- Backfill existing rows from created_at (NOT migration time), then lock the
-- column down. SET DEFAULT / SET NOT NULL are idempotent on re-run.
UPDATE memories SET valid_from = created_at WHERE valid_from IS NULL;
ALTER TABLE memories ALTER COLUMN valid_from SET DEFAULT now();
ALTER TABLE memories ALTER COLUMN valid_from SET NOT NULL;

-- Partial index for the hot path: recall/context default to the ACTIVE set only.
CREATE INDEX IF NOT EXISTS idx_memories_active_ranking
  ON memories (workspace_id, importance DESC, last_accessed DESC)
  WHERE superseded_by IS NULL;

-- RLS: memories (FORCE ensures table owner also complies, not just non-owners)
-- CASE avoids ''::uuid cast error — PostgreSQL does not short-circuit AND in policies.
-- DROP + CREATE for idempotency (PostgreSQL has no CREATE OR REPLACE POLICY).
-- After a transaction that used set_config('dolores.workspace_id', uuid, true) commits,
-- PostgreSQL reverts the GUC to '' (empty string), not NULL. Both UUID casts must use
-- CASE WHEN nullif(..., '') IS NOT NULL to guard against the ''::uuid cast error.
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories FORCE ROW LEVEL SECURITY;
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

-- RLS: facts
ALTER TABLE facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE facts FORCE ROW LEVEL SECURITY;
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

-- Application role (non-superuser): daemon must connect as this user for RLS to apply.
-- Superusers (POSTGRES_USER=dolores) bypass RLS even with FORCE ROW LEVEL SECURITY.
-- Password is NOT set here — applyMigrations() sets it via DOLORES_APP_PASSWORD env var.
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

-- SECURITY DEFINER decay functions: pg_cron jobs run without dolores.workspace_id GUC.
-- FORCE ROW LEVEL SECURITY means even the scheduler role sees 0 rows via the policy
-- (workspace_id = NULL → false). SECURITY DEFINER runs the function as the creating
-- superuser, which bypasses RLS entirely — the correct scope for maintenance jobs.
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

-- pg_cron: conservative decay via SECURITY DEFINER function (daily, never deletes).
-- cron.schedule() upserts by jobname — idempotent.
SELECT cron.schedule(
  'memory-soften',
  '0 3 * * *',
  'SELECT dolores_soften_memories()'
);
`;

/** Opt-in aggressive decay — schedule only when DOLORES_DECAY_MODE=aggressive. */
export const AGGRESSIVE_DECAY_SQL = /* sql */ `
SELECT cron.schedule(
  'memory-decay',
  '0 4 * * *',
  'SELECT dolores_decay_memories()'
);
`;

/** Vector index access method (EPIC I). ivfflat = default; hnsw = pgvector ≥0.5. */
export type VectorIndexKind = "ivfflat" | "hnsw";

/** Resolve the vector index kind from DOLORES_VECTOR_INDEX (default ivfflat). */
export function resolveVectorIndexKind(): VectorIndexKind {
  return process.env.DOLORES_VECTOR_INDEX === "hnsw" ? "hnsw" : "ivfflat";
}

/**
 * SQL that ensures the selected vector index exists and the OTHER one is dropped.
 * Idempotent: CREATE ... IF NOT EXISTS never rebuilds on re-run with the same
 * kind, and DROP ... IF EXISTS cleans up after a switch. Applied by
 * applyMigrations() inside the migration transaction.
 *
 *  - ivfflat (lists=100): fast to build, good at small/medium scale.
 *  - hnsw (m=16, ef_construction=64): higher recall + lower query latency at
 *    scale, slower to build, more memory. Query-time recall is tuned via
 *    hnsw.ef_search (see recall.ts / DOLORES_HNSW_EF_SEARCH).
 *
 * NOTE: switching kinds rebuilds the index. For large tables prefer
 * `CREATE INDEX CONCURRENTLY` out-of-band (it cannot run in this transaction) —
 * see docs/OPERATIONS.md.
 */
export function vectorIndexSql(kind: VectorIndexKind): string {
  if (kind === "hnsw") {
    return /* sql */ `
CREATE INDEX IF NOT EXISTS idx_memories_embedding_hnsw
  ON memories USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
DROP INDEX IF EXISTS idx_memories_embedding;
`;
  }
  return /* sql */ `
CREATE INDEX IF NOT EXISTS idx_memories_embedding
  ON memories USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
DROP INDEX IF EXISTS idx_memories_embedding_hnsw;
`;
}
