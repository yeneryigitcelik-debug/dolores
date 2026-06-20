/**
 * Embedded migration SQL — mirrors prisma/migrations/20240620000000_init/migration.sql.
 * All statements are idempotent; applyMigrations() can be called on every startup.
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

-- Indexes on facts
-- Single NULLS NOT DISTINCT unique index (PG15+). A predicate-less
-- ON CONFLICT (workspace_id, user_id, category, key) — which core's upsertFact
-- uses — cannot infer a PARTIAL unique index, so one combined index is required.
-- NULLS NOT DISTINCT makes workspace-level facts (user_id IS NULL) dedupe too.
CREATE UNIQUE INDEX IF NOT EXISTS facts_ws_user_cat_key
  ON facts (workspace_id, user_id, category, key)
  NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS idx_facts_workspace_scope
  ON facts (workspace_id, scope);

-- Indexes on memories
CREATE INDEX IF NOT EXISTS idx_memories_workspace_scope
  ON memories (workspace_id, scope);
CREATE INDEX IF NOT EXISTS idx_memories_embedding
  ON memories USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
CREATE INDEX IF NOT EXISTS idx_memories_content_tsv
  ON memories USING gin (content_tsv);

-- RLS: memories (FORCE ensures non-superuser table owners also comply)
-- CASE avoids ''::uuid cast error — PostgreSQL does not short-circuit AND in policies.
-- DROP + CREATE for idempotency (PostgreSQL has no CREATE OR REPLACE POLICY).
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories FORCE ROW LEVEL SECURITY;
-- After a transaction that used set_config('dolores.workspace_id', uuid, true) commits,
-- PostgreSQL reverts the GUC to '' (empty string), not NULL. Both UUID casts must use
-- CASE WHEN nullif(..., '') IS NOT NULL to guard against the ''::uuid cast error.
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
  );

-- Application role (non-superuser): daemon must connect as this user for RLS to apply.
-- Superusers (POSTGRES_USER=dolores) bypass RLS even with FORCE ROW LEVEL SECURITY.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dolores_app') THEN
    CREATE ROLE dolores_app WITH LOGIN PASSWORD 'dolores';
  END IF;
END;
$$;
GRANT CONNECT ON DATABASE dolores TO dolores_app;
GRANT USAGE ON SCHEMA public TO dolores_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE memories, facts TO dolores_app;

-- pg_cron: conservative decay (daily soft-decay, never deletes)
SELECT cron.schedule(
  'memory-soften',
  '0 3 * * *',
  $$
    UPDATE memories
       SET importance = GREATEST(1, importance - 1)
     WHERE last_accessed < now() - INTERVAL '30 days'
       AND importance > 1
  $$
);
`;

/** Opt-in aggressive decay — schedule only when DOLORES_DECAY_MODE=aggressive. */
export const AGGRESSIVE_DECAY_SQL = /* sql */ `
SELECT cron.schedule(
  'memory-decay',
  '0 4 * * *',
  $$
    DELETE FROM memories
     WHERE importance < 3
       AND last_accessed < now() - INTERVAL '90 days'
  $$
);
`;
