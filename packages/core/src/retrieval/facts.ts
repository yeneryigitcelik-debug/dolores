import type { Pool } from "pg";
import type { Fact, FactInput, MemoryContext } from "../types.js";
import { type FactRow, requireRow, rowToFact } from "./sql.js";
import { withTenant } from "./tenant.js";

const FACT_COLUMNS =
  "id, workspace_id, user_id, scope, category, key, value, created_at, updated_at";

/**
 * Upsert a deterministic fact on (workspace_id, user_id, category, key). An
 * existing key is overwritten with the new value (last-writer-wins) — this is
 * how contradicting facts are resolved.
 *
 * NOTE: the unique index must be NULLS NOT DISTINCT for workspace-level facts
 * (user_id IS NULL) to dedupe correctly — see [CONTRACT] in the handoff.
 */
export async function upsertFact(pool: Pool, ctx: MemoryContext, input: FactInput): Promise<Fact> {
  const scope = input.scope ?? "personal";
  return withTenant(pool, ctx, async (client) => {
    const res = await client.query<FactRow>(
      `INSERT INTO facts (workspace_id, user_id, scope, category, key, value)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (workspace_id, user_id, category, key)
       DO UPDATE SET value = EXCLUDED.value,
                     scope = EXCLUDED.scope,
                     updated_at = now()
       RETURNING ${FACT_COLUMNS}`,
      [ctx.workspaceId, ctx.userId ?? null, scope, input.category, input.key, input.value],
    );
    return rowToFact(requireRow(res.rows, "upsertFact"));
  });
}

/** List facts (optionally filtered by category), deterministically ordered. */
export async function listFacts(
  pool: Pool,
  ctx: MemoryContext,
  category?: string,
): Promise<Fact[]> {
  return withTenant(pool, ctx, async (client) => {
    const res = await client.query<FactRow>(
      `SELECT ${FACT_COLUMNS}
         FROM facts
        WHERE ($1::text IS NULL OR category = $1)
        ORDER BY category, key`,
      [category ?? null],
    );
    return res.rows.map(rowToFact);
  });
}
