import type { Pool, PoolClient } from "pg";
import type { MemoryContext } from "../types.js";

/**
 * GUC names that the db package's RLS policies read. These are a FIXED contract
 * shared across packages — do not rename without updating the SQL policies.
 */
export const WORKSPACE_GUC = "dolores.workspace_id";
export const USER_GUC = "dolores.user_id";

/**
 * Run `fn` inside a transaction with the tenant identity pinned for RLS.
 *
 * We use `set_config(name, value, is_local => true)` (the bindable equivalent of
 * `SET LOCAL`) so the workspace/user ids can be passed as parameters instead of
 * interpolated — no SQL injection surface. `is_local` ties the setting to the
 * surrounding transaction, so it is reset automatically on COMMIT/ROLLBACK.
 *
 * A null/absent `userId` is sent as '' (empty string); RLS policies map that
 * back to "no specific user" (workspace-level visibility) via
 * `nullif(current_setting('dolores.user_id', true), '')::uuid`.
 */
export async function withTenant<T>(
  pool: Pool,
  ctx: MemoryContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config($1, $2, true)", [WORKSPACE_GUC, ctx.workspaceId]);
    await client.query("SELECT set_config($1, $2, true)", [USER_GUC, ctx.userId ?? ""]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      /* connection already broken — surface the original error below */
    });
    throw err;
  } finally {
    client.release();
  }
}
