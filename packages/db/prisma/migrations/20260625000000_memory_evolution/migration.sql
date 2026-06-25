-- Temporal memory evolution (EPIC F).
--
-- VECTOR/TSVECTOR-style raw-SQL migration: these columns are not expressed in
-- schema.prisma (like `embedding` / `content_tsv`). Mirrors the additions in the
-- db helper's INIT_SQL (packages/db/src/migration.ts) — keep the two in sync.
--
-- All statements are idempotent so applyMigrations() can re-run them on startup.

--   superseded_by : self-FK to the memory that replaced this one (NULL = active).
--                   ON DELETE SET NULL keeps the chain from blocking hard deletes.
--   valid_from    : when this statement became true (backfilled from created_at).
--   valid_to      : when it stopped being true (set when superseded; NULL = still true).
ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS superseded_by UUID REFERENCES memories(id) ON DELETE SET NULL;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS valid_to   TIMESTAMPTZ;

-- Backfill existing rows from created_at (NOT migration time), then lock down.
UPDATE memories SET valid_from = created_at WHERE valid_from IS NULL;
ALTER TABLE memories ALTER COLUMN valid_from SET DEFAULT now();
ALTER TABLE memories ALTER COLUMN valid_from SET NOT NULL;

-- Partial index for the hot path: recall/context default to the ACTIVE set only.
CREATE INDEX IF NOT EXISTS idx_memories_active_ranking
  ON memories (workspace_id, importance DESC, last_accessed DESC)
  WHERE superseded_by IS NULL;
