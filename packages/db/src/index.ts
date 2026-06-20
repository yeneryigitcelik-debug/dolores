/**
 * @dolores/db — database primitives for dolores
 *
 * Public API:
 *   getPool()                              → singleton pg.Pool (DATABASE_URL required)
 *   applyMigrations(pool)                  → idempotent schema bootstrap
 *   withTenant(pool, ctx, fn)              → RLS-scoped transaction helper
 *   enableAggressiveDecay(pool)            → opt-in: schedule DELETE cron job
 */

import { Pool } from "pg";
import type { PoolClient } from "pg";
import { AGGRESSIVE_DECAY_SQL, INIT_SQL } from "./migration.js";

export type { Pool, PoolClient };

// ---------------------------------------------------------------------------
// Singleton pool
// ---------------------------------------------------------------------------

let _pool: Pool | null = null;

/**
 * Returns the process-wide singleton pg.Pool.
 * Reads DATABASE_URL from the environment on first call and throws if missing.
 */
export function getPool(): Pool {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL environment variable is not set");
  _pool = new Pool({ connectionString: url });
  return _pool;
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/**
 * Applies the dolores schema to the connected database.
 * Idempotent — safe to call on every startup (`dolores init` calls this).
 *
 * Creates:
 *  - pgvector + pg_cron extensions
 *  - facts and memories tables
 *  - All indexes (IVFFlat, GIN, composite)
 *  - RLS policies using dolores.workspace_id / dolores.user_id GUCs
 *  - Conservative pg_cron job ("memory-soften")
 */
export async function applyMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(INIT_SQL);
  } finally {
    client.release();
  }
}

/**
 * Schedules the aggressive decay cron job (DELETE low-importance old memories).
 * Only call when DOLORES_DECAY_MODE=aggressive.
 */
export async function enableAggressiveDecay(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(AGGRESSIVE_DECAY_SQL);
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Tenant context helper
// ---------------------------------------------------------------------------

export interface TenantContext {
  workspaceId: string;
  /**
   * When undefined or null, the transaction sees only workspace-level rows
   * (memories/facts with user_id IS NULL). Personal rows are hidden.
   */
  userId?: string | null;
}

/**
 * Acquires a client from pool, sets transaction-local GUCs for RLS isolation,
 * runs fn(client) inside a transaction, then commits and releases.
 *
 * GUCs set inside the transaction:
 *   dolores.workspace_id = ctx.workspaceId   (always, must be a valid UUID)
 *   dolores.user_id      = ctx.userId ?? ''  ('' → workspace-only access)
 *
 * RLS policy behaviour:
 *   • workspace_id must equal dolores.workspace_id (cross-tenant rows hidden).
 *   • user_id IS NULL rows are always visible within the workspace.
 *   • user_id IS NOT NULL rows are visible only when dolores.user_id matches.
 *   • If dolores.workspace_id is not set (outside withTenant), NO rows pass.
 *
 * Usage:
 *   const hits = await withTenant(pool, { workspaceId, userId }, (c) =>
 *     c.query('SELECT * FROM memories WHERE scope = $1', ['personal'])
 *   );
 *
 * @param pool       - pg.Pool (from getPool())
 * @param ctx        - workspace + optional user identity
 * @param fn         - callback receiving the tenant-scoped PoolClient
 * @returns          - whatever fn returns
 */
export async function withTenant<T>(
  pool: Pool,
  ctx: TenantContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // SET LOCAL is transaction-scoped — only visible within this transaction.
    await client.query("SELECT set_config('dolores.workspace_id', $1, true)", [ctx.workspaceId]);
    // Empty string signals "workspace-only" mode; policy uses NULLIF to detect it.
    await client.query("SELECT set_config('dolores.user_id', $1, true)", [ctx.userId ?? ""]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
