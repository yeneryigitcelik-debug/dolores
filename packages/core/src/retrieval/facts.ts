import type { Pool } from "pg";
import type { Fact, FactInput, MemoryContext } from "../types.js";
import { resolveWriteOwner } from "./scope.js";
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
  const owner = resolveWriteOwner(ctx, input.scope);
  return withTenant(pool, ctx, async (client) => {
    const res = await client.query<FactRow>(
      `INSERT INTO facts (workspace_id, user_id, scope, category, key, value)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (workspace_id, user_id, category, key)
       DO UPDATE SET value = EXCLUDED.value,
                     scope = EXCLUDED.scope,
                     updated_at = now()
       RETURNING ${FACT_COLUMNS}`,
      [ctx.workspaceId, owner.userId, owner.scope, input.category, input.key, input.value],
    );
    return rowToFact(requireRow(res.rows, "upsertFact"));
  });
}

/**
 * Batch upsert multiple facts in a single transaction. Functionally equivalent
 * to N sequential upsertFact() calls but uses unnest() to do it in one round-trip.
 */
export async function batchUpsertFacts(
  pool: Pool,
  ctx: MemoryContext,
  inputs: FactInput[],
): Promise<void> {
  if (inputs.length === 0) return;
  // Validate every input before any write; then collapse duplicate conflict keys
  // (last input wins, like sequential upserts) so ON CONFLICT never sees the
  // same target twice in one statement.
  const resolved = inputs.map((f) => ({ f, owner: resolveWriteOwner(ctx, f.scope) }));
  const byKey = new Map<string, (typeof resolved)[number]>();
  for (const r of resolved) {
    const k = JSON.stringify([r.owner.userId, r.f.category, r.f.key]);
    byKey.delete(k);
    byKey.set(k, r);
  }
  const rows = [...byKey.values()];
  return withTenant(pool, ctx, async (client) => {
    const workspaceIds = rows.map(() => ctx.workspaceId);
    const userIds = rows.map((r) => r.owner.userId);
    const scopes = rows.map((r) => r.owner.scope);
    const categories = rows.map((r) => r.f.category);
    const keys = rows.map((r) => r.f.key);
    const values = rows.map((r) => r.f.value);
    await client.query(
      `INSERT INTO facts (workspace_id, user_id, scope, category, key, value)
       SELECT unnest($1::uuid[]), unnest($2::uuid[]), unnest($3::text[]),
              unnest($4::text[]), unnest($5::text[]), unnest($6::text[])
       ON CONFLICT (workspace_id, user_id, category, key)
       DO UPDATE SET value = EXCLUDED.value, scope = EXCLUDED.scope, updated_at = now()`,
      [workspaceIds, userIds, scopes, categories, keys, values],
    );
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
