import type { Pool, PoolClient } from "pg";
import type {
  Embedder,
  MemoryContext,
  RecallHit,
  RecallQuery,
  RecallResult,
  Scope,
} from "../types.js";
import { mmrSelect } from "./mmr.js";
import { type BoostableHit, applyBoost, fuseRrf } from "./rrf.js";
import { type MemoryRow, parseVectorLiteral, toIso, toVectorLiteral } from "./sql.js";
import { withTenant } from "./tenant.js";
import { tokenEstimate } from "./tokens.js";

const DEFAULT_LIMIT = 5;
/** Postgres `regconfig` used for full-text. Matches the db migration's index. */
const FT_CONFIG = "english";
/** Columns both arms project (shared so the two SELECTs can't drift). */
const MEMORY_COLS =
  "id, workspace_id, user_id, scope, content, importance, source, created_at, last_accessed, superseded_by, valid_from, valid_to";
/**
 * ivfflat.probes default. The db migration builds the index with lists=100, where
 * the engine default of 1 probe scans a single cell → poor recall at this scale.
 * 10 probes trade a little latency for materially better recall. Tunable via
 * DOLORES_IVFFLAT_PROBES.
 */
const DEFAULT_IVFFLAT_PROBES = 10;

function resolveIvfflatProbes(): number {
  const raw = Number(process.env.DOLORES_IVFFLAT_PROBES);
  if (Number.isFinite(raw) && raw >= 1) return Math.floor(raw);
  return DEFAULT_IVFFLAT_PROBES;
}

/**
 * MMR diversity λ (EPIC H). 1 (default) = OFF (pure relevance, current behaviour).
 * <1 trades relevance for diversity so the top-N isn't near-duplicates.
 */
function resolveMmrLambda(): number {
  const raw = Number(process.env.DOLORES_MMR_LAMBDA);
  if (!Number.isFinite(raw) || raw >= 1) return 1;
  return Math.max(0, raw);
}

interface FusionWeights {
  vector: number;
  fullText: number;
}

/** Per-arm RRF weights (EPIC H). Default 1 each = classic equal-weight RRF. */
function resolveFusionWeights(): FusionWeights {
  const w = (name: string): number => {
    const raw = Number(process.env[name]);
    return Number.isFinite(raw) && raw >= 0 ? raw : 1;
  };
  return {
    vector: w("DOLORES_FUSION_VECTOR_WEIGHT"),
    fullText: w("DOLORES_FUSION_FT_WEIGHT"),
  };
}

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

  const lambda = resolveMmrLambda();
  const weights = resolveFusionWeights();

  let vector: number[] | null = null;
  if (embedder.dim > 0) {
    try {
      const [vec] = await embedder.embed([query]);
      vector = vec ?? null;
    } catch (err) {
      console.warn(`[dolores] recall: embedding failed, full-text only: ${asMessage(err)}`);
    }
  }

  // MMR needs candidate vectors AND an embedding space to compare in; with the
  // noop/full-text-only path there is nothing to diversify against, so skip it.
  const useMmr = lambda < 1 && vector !== null;

  return withTenant(pool, ctx, async (client) => {
    const byId = new Map<string, MemoryRow>();
    const embById = useMmr ? new Map<string, number[]>() : null;

    let vectorArm: string[] = [];
    if (vector) {
      // Raise ivfflat probes for THIS transaction only (SET LOCAL via set_config)
      // so the index scans more cells → better recall (lists=100, engine default 1).
      await client.query("SELECT set_config('ivfflat.probes', $1, true)", [
        String(resolveIvfflatProbes()),
      ]);
      vectorArm = await runVectorArm(client, ctx.workspaceId, vector, q, candidates, byId, embById);
    }
    const fullTextArm = await runFullTextArm(
      client,
      ctx.workspaceId,
      query,
      q,
      candidates,
      byId,
      embById,
    );

    // Fuse ALL candidates (no limit yet) so the importance/recency boost can
    // participate in the final top-N selection, not just reorder a pre-cut slice.
    const fused = fuseRrf([vectorArm, fullTextArm], {
      weights: [weights.vector, weights.fullText],
    });
    if (fused.length === 0) return { hits: [], tokenEstimate: 0 };

    const now = Date.now();
    const boostable: BoostableHit[] = fused.map((f) => {
      const row = byId.get(f.id);
      return {
        id: f.id,
        score: f.score,
        importance: row?.importance ?? 5,
        ageMs: row ? now - new Date(row.last_accessed).getTime() : 0,
      };
    });
    const boosted = applyBoost(boostable);

    // MMR diversity (EPIC H) when enabled; otherwise a pure-relevance slice
    // (identical to the pre-MMR behaviour).
    const ranked: { id: string; score: number }[] = embById
      ? mmrSelect(
          boosted.map((b) => ({ id: b.id, score: b.score, embedding: embById.get(b.id) ?? null })),
          lambda,
          limit,
        )
      : boosted.slice(0, limit);

    // Recency bump for the rows we actually surface — but ONLY on the default
    // active recall. A point-in-time (asOf) or includeSuperseded query is
    // read-only introspection; bumping last_accessed there would pollute the
    // live recency signal that decay/ranking rely on.
    if (!q.asOf && !q.includeSuperseded) {
      await client.query("UPDATE memories SET last_accessed = now() WHERE id = ANY($1::uuid[])", [
        ranked.map((f) => f.id),
      ]);
    }

    const hits: RecallHit[] = [];
    for (const f of ranked) {
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
        supersededBy: row.superseded_by ?? null,
      });
    }

    const rendered = hits.map((h) => h.content).join("\n");
    return { hits, tokenEstimate: tokenEstimate(rendered) };
  });
}

/**
 * Build the filter shared by both arms. An explicit `workspace_id = $N` is added
 * on top of RLS: defence-in-depth, and — crucially — it lets Postgres use the
 * (workspace_id, ...) indexes instead of relying on the RLS predicate alone.
 * Mirrors the explicit filter already used in remember.ts.
 */
function buildFilters(workspaceId: string, q: RecallQuery, params: unknown[]): string {
  params.push(workspaceId);
  let sql = ` AND workspace_id = $${params.length}`;
  if (q.scope) {
    params.push(q.scope);
    sql += ` AND scope = $${params.length}`;
  }
  if (q.minImportance !== undefined) {
    params.push(q.minImportance);
    sql += ` AND importance >= $${params.length}`;
  }
  // Temporal evolution (EPIC F).
  if (q.asOf) {
    // Point-in-time: the version whose validity window contains asOf. This spans
    // superseded rows on purpose (historical versions carry a closed valid_to).
    params.push(q.asOf);
    sql += ` AND valid_from <= $${params.length}::timestamptz`;
    params.push(q.asOf);
    sql += ` AND (valid_to IS NULL OR valid_to > $${params.length}::timestamptz)`;
  } else if (!q.includeSuperseded) {
    // Default: active set only — hide memories that have been superseded.
    sql += " AND superseded_by IS NULL";
  }
  return sql;
}

/** Column list, plus `embedding::text` when MMR needs candidate vectors. */
type ArmRow = MemoryRow & { emb?: string | null };
function armCols(embById: Map<string, number[]> | null): string {
  return embById ? `${MEMORY_COLS}, embedding::text AS emb` : MEMORY_COLS;
}
function collect(
  rows: ArmRow[],
  byId: Map<string, MemoryRow>,
  embById: Map<string, number[]> | null,
) {
  for (const row of rows) {
    byId.set(row.id, row);
    if (embById && row.emb) embById.set(row.id, parseVectorLiteral(row.emb));
  }
}

async function runVectorArm(
  client: PoolClient,
  workspaceId: string,
  vector: number[],
  q: RecallQuery,
  candidates: number,
  byId: Map<string, MemoryRow>,
  embById: Map<string, number[]> | null,
): Promise<string[]> {
  const params: unknown[] = [toVectorLiteral(vector)];
  const filters = buildFilters(workspaceId, q, params);
  params.push(candidates);
  const res = await client.query<ArmRow>(
    `SELECT ${armCols(embById)}
       FROM memories
      WHERE embedding IS NOT NULL${filters}
      ORDER BY embedding <=> $1::vector
      LIMIT $${params.length}`,
    params,
  );
  collect(res.rows, byId, embById);
  return res.rows.map((r) => r.id);
}

async function runFullTextArm(
  client: PoolClient,
  workspaceId: string,
  query: string,
  q: RecallQuery,
  candidates: number,
  byId: Map<string, MemoryRow>,
  embById: Map<string, number[]> | null,
): Promise<string[]> {
  const params: unknown[] = [FT_CONFIG, query];
  const filters = buildFilters(workspaceId, q, params);
  params.push(candidates);
  const res = await client.query<ArmRow>(
    `SELECT ${armCols(embById)}
       FROM memories
      WHERE content_tsv @@ plainto_tsquery($1, $2)${filters}
      ORDER BY ts_rank(content_tsv, plainto_tsquery($1, $2)) DESC
      LIMIT $${params.length}`,
    params,
  );
  collect(res.rows, byId, embById);
  return res.rows.map((r) => r.id);
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
