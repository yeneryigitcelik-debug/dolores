import type { Pool, PoolClient } from "pg";
import type {
  Embedder,
  MemoryContext,
  RecallHit,
  RecallQuery,
  RecallResult,
  Scope,
} from "../types.js";
import { fuseRrf } from "./rrf.js";
import { type MemoryRow, toIso, toVectorLiteral } from "./sql.js";
import { withTenant } from "./tenant.js";
import { tokenEstimate } from "./tokens.js";

const DEFAULT_LIMIT = 5;
/** Postgres `regconfig` used for full-text. Matches the db migration's index. */
const FT_CONFIG = "english";

/**
 * Hybrid recall: pgvector cosine + Postgres full-text, fused with RRF.
 *
 * SAF SQL + vector — no LLM on this path. With the noop embedder (dim 0) only
 * the full-text arm runs. Rows returned to the caller have their `last_accessed`
 * bumped to now() (recency signal for decay/context ranking).
 */
export async function recall(
  pool: Pool,
  ctx: MemoryContext,
  embedder: Embedder,
  q: RecallQuery,
): Promise<RecallResult> {
  const query = q.query.trim();
  const limit = q.limit && q.limit > 0 ? q.limit : DEFAULT_LIMIT;
  if (!query) return { hits: [], tokenEstimate: 0 };

  // Pull a wider candidate pool per arm so RRF has room to fuse.
  const candidates = Math.min(Math.max(limit * 4, 20), 100);

  let vector: number[] | null = null;
  if (embedder.dim > 0) {
    try {
      const [vec] = await embedder.embed([query]);
      vector = vec ?? null;
    } catch (err) {
      console.warn(`[dolores] recall: embedding failed, full-text only: ${asMessage(err)}`);
    }
  }

  return withTenant(pool, ctx, async (client) => {
    const byId = new Map<string, MemoryRow>();

    const vectorArm = vector ? await runVectorArm(client, vector, q, candidates, byId) : [];
    const fullTextArm = await runFullTextArm(client, query, q, candidates, byId);

    const fused = fuseRrf([vectorArm, fullTextArm], { limit });
    if (fused.length === 0) return { hits: [], tokenEstimate: 0 };

    // Recency bump for the rows we actually surface.
    await client.query("UPDATE memories SET last_accessed = now() WHERE id = ANY($1::uuid[])", [
      fused.map((f) => f.id),
    ]);

    const hits: RecallHit[] = [];
    for (const f of fused) {
      const row = byId.get(f.id);
      if (!row) continue;
      hits.push({
        id: row.id,
        content: row.content,
        importance: row.importance,
        scope: row.scope as Scope,
        score: f.score,
        source: row.source,
        createdAt: toIso(row.created_at),
      });
    }

    const rendered = hits.map((h) => h.content).join("\n");
    return { hits, tokenEstimate: tokenEstimate(rendered) };
  });
}

/** Build the optional `scope` / `minImportance` filter shared by both arms. */
function buildFilters(q: RecallQuery, params: unknown[]): string {
  let sql = "";
  if (q.scope) {
    params.push(q.scope);
    sql += ` AND scope = $${params.length}`;
  }
  if (q.minImportance !== undefined) {
    params.push(q.minImportance);
    sql += ` AND importance >= $${params.length}`;
  }
  return sql;
}

async function runVectorArm(
  client: PoolClient,
  vector: number[],
  q: RecallQuery,
  candidates: number,
  byId: Map<string, MemoryRow>,
): Promise<string[]> {
  const params: unknown[] = [toVectorLiteral(vector)];
  const filters = buildFilters(q, params);
  params.push(candidates);
  const res = await client.query<MemoryRow>(
    `SELECT id, workspace_id, user_id, scope, content, importance, source, created_at, last_accessed
       FROM memories
      WHERE embedding IS NOT NULL${filters}
      ORDER BY embedding <=> $1::vector
      LIMIT $${params.length}`,
    params,
  );
  for (const row of res.rows) byId.set(row.id, row);
  return res.rows.map((r) => r.id);
}

async function runFullTextArm(
  client: PoolClient,
  query: string,
  q: RecallQuery,
  candidates: number,
  byId: Map<string, MemoryRow>,
): Promise<string[]> {
  const params: unknown[] = [FT_CONFIG, query];
  const filters = buildFilters(q, params);
  params.push(candidates);
  const res = await client.query<MemoryRow>(
    `SELECT id, workspace_id, user_id, scope, content, importance, source, created_at, last_accessed
       FROM memories
      WHERE content_tsv @@ plainto_tsquery($1, $2)${filters}
      ORDER BY ts_rank(content_tsv, plainto_tsquery($1, $2)) DESC
      LIMIT $${params.length}`,
    params,
  );
  for (const row of res.rows) byId.set(row.id, row);
  return res.rows.map((r) => r.id);
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
