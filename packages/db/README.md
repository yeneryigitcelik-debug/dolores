# @dolores/db

PostgreSQL database layer for dolores — schema bootstrap, tenant isolation, and pg_cron decay.

## Quick start

```bash
# 1. Start Postgres (from repo root)
pnpm db:up

# 2. Apply schema (idempotent — safe to run any time)
DATABASE_URL=postgresql://dolores:dolores@localhost:5433/dolores \
  node -e "import('@dolores/db').then(m => m.applyMigrations(m.getPool()))"

# 3. Alternatively, use prisma migrate
pnpm --filter @dolores/db migrate:dev   # dev: generates + applies
pnpm --filter @dolores/db migrate       # prod: applies pending
```

## How migrations work

Migrations live in `prisma/migrations/20240620000000_init/migration.sql`.

- `prisma migrate deploy` — applies pending migration files (tracked in `_prisma_migrations`).
- `applyMigrations(pool)` — runs the same SQL directly, idempotent. Called by `dolores init`.

Both paths reach the same schema state. The SQL file is idempotent (IF NOT EXISTS + DO blocks for policies).

### What the migration creates

| Object | Notes |
|--------|-------|
| `vector` extension | pgvector for VECTOR(384) similarity search |
| `pg_cron` extension | background decay jobs |
| `facts` table | structured key-value memory |
| `memories` table | semantic memory with `embedding vector(384)` + generated `content_tsv tsvector` |
| `idx_memories_embedding` | IVFFlat cosine-distance index (`lists=100`) |
| `idx_memories_content_tsv` | GIN index for full-text hybrid search |
| `memories_tenant_isolation` policy | RLS — workspace + user isolation |
| `facts_tenant_isolation` policy | RLS — same isolation logic |
| `memory-soften` cron job | daily 03:00 UTC conservative decay |

## RLS isolation

Every query must run inside `withTenant()`. The daemon sets two transaction-local GUCs:

```
dolores.workspace_id = '<workspace-uuid>'
dolores.user_id      = '<user-uuid>'  -- or '' for workspace-level access
```

**Policy logic (same for `memories` and `facts`):**

```sql
workspace_id = current_setting('dolores.workspace_id', true)::uuid
AND (
  user_id IS NULL                              -- workspace-level row: always visible
  OR (
    nullif(current_setting('dolores.user_id', true), '') IS NOT NULL
    AND user_id = current_setting('dolores.user_id', true)::uuid
  )                                            -- personal row: visible to owner only
)
```

| Scenario | Visible rows |
|----------|-------------|
| `withTenant({ workspaceId })` | workspace-level rows (`user_id IS NULL`) |
| `withTenant({ workspaceId, userId })` | workspace-level rows **+** matching personal rows |
| Direct query (no GUC set) | **zero rows** — safe default |
| Different workspace | **zero rows** — cross-tenant isolation |

## `withTenant` API

```typescript
import { getPool, withTenant } from '@dolores/db';

const pool = getPool(); // reads DATABASE_URL; singleton

const result = await withTenant(
  pool,
  { workspaceId: 'uuid', userId: 'uuid-or-null' },
  async (client) => {
    return client.query('SELECT * FROM memories WHERE scope = $1', ['personal']);
  }
);
```

- Acquires a `PoolClient`, opens `BEGIN`, sets GUCs via `set_config(..., true)` (transaction-local), runs `fn`, commits.
- On error: automatic `ROLLBACK` + release.
- `userId: null | undefined` → workspace-only access (personal rows hidden).

## pg_cron jobs

### Conservative decay (default — always scheduled)

| Job | Schedule | Action |
|-----|----------|--------|
| `memory-soften` | daily 03:00 UTC | `importance = GREATEST(1, importance-1)` where `last_accessed < 30 days AND importance > 1` |

This job **never deletes** rows. It is safe by default.

### Aggressive decay (opt-in)

Activated only when `DOLORES_DECAY_MODE=aggressive`. The daemon calls `enableAggressiveDecay(pool)`:

```typescript
import { enableAggressiveDecay, getPool } from '@dolores/db';
await enableAggressiveDecay(getPool());
```

| Job | Schedule | Action |
|-----|----------|--------|
| `memory-decay` | daily 04:00 UTC | `DELETE` where `importance < 3 AND last_accessed < 90 days` |

SQL is in `src/sql/aggressive_decay.sql`.

To disable: `SELECT cron.unschedule('memory-decay');`

## Tests

```bash
# Requires docker DB to be running
pnpm db:up
pnpm --filter @dolores/db test
```

Tests verify:
- Migration creates tables with expected columns
- RLS is enabled
- Cross-workspace isolation (workspace A cannot see workspace B rows)
- Workspace-only context hides personal rows
- User context sees workspace + personal rows
- Direct query (no GUC) returns zero rows

## Build

```bash
pnpm --filter @dolores/db build   # compiles src/ → dist/
pnpm --filter @dolores/db generate # regenerates Prisma Client
```
