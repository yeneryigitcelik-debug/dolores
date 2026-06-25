import type { Pool, PoolClient } from "pg";
import { NoOpEmbedder } from "../embedder/noop.js";
import type { Embedder, Fact, MemoryContext, Reranker } from "../types.js";
import { recall } from "./recall.js";
import { type FactRow, type MemoryRow, rowToFact } from "./sql.js";
import { withTenant } from "./tenant.js";
import { tokenEstimate } from "./tokens.js";

/** How many candidate memories to consider before token-budget trimming. */
const MEMORY_CANDIDATES = 50;

const FACT_SELECT =
  "SELECT id, workspace_id, user_id, scope, category, key, value, created_at, updated_at FROM facts ORDER BY category, key";

export interface BuiltContext {
  text: string;
  tokenEstimate: number;
}

type RenderMemory = Pick<MemoryRow, "content" | "importance">;

async function fetchFacts(client: PoolClient): Promise<Fact[]> {
  const res = await client.query<FactRow>(FACT_SELECT);
  return res.rows.map(rowToFact);
}

/**
 * Render facts + memories into a compact system-prompt blob, capped at
 * `maxTokens`. Pure SQL — no LLM. Facts are rendered first (deterministic, cheap,
 * high-signal), then the remaining budget is filled with memories.
 *
 * Two modes:
 *  - `query` omitted → static identity blob: the most important / freshest
 *    memories (importance DESC, last_accessed DESC).
 *  - `query` given → task-aware: the most RELEVANT memories for that query via
 *    hybrid recall (pgvector + full-text). Pass `embedder` to enable the vector
 *    arm; without one a NoOpEmbedder is used (full-text-only relevance). recall
 *    is pure SQL+vector — still no LLM on this path.
 */
export async function buildContext(
  pool: Pool,
  ctx: MemoryContext,
  maxTokens = 600,
  query?: string,
  embedder?: Embedder,
  reranker?: Reranker,
): Promise<BuiltContext> {
  const trimmedQuery = query?.trim();

  if (trimmedQuery) {
    const facts = await withTenant(pool, ctx, fetchFacts);
    const { hits } = await recall(
      pool,
      ctx,
      embedder ?? new NoOpEmbedder(),
      { query: trimmedQuery, limit: MEMORY_CANDIDATES },
      reranker,
    );
    const memories: RenderMemory[] = hits.map((h) => ({
      content: h.content,
      importance: h.importance,
    }));
    return renderContext(facts, memories, maxTokens);
  }

  return withTenant(pool, ctx, async (client) => {
    const facts = await fetchFacts(client);
    const memories = await client.query<MemoryRow>(
      `SELECT id, workspace_id, user_id, scope, content, importance, source, created_at, last_accessed
         FROM memories
        WHERE superseded_by IS NULL
        ORDER BY importance DESC, last_accessed DESC, created_at DESC
        LIMIT $1`,
      [MEMORY_CANDIDATES],
    );
    return renderContext(facts, memories.rows, maxTokens);
  });
}

/**
 * Pure renderer (DB-free, unit-testable). Greedily packs facts then memories
 * under the token budget. Section headers are only emitted when at least one
 * item of that section fits, so there are never dangling headers.
 */
export function renderContext(
  facts: Fact[],
  memories: RenderMemory[],
  maxTokens: number,
): BuiltContext {
  const lines: string[] = [];
  let budget = maxTokens;

  const factHeader = "# Facts";
  let factHeaderAdded = false;
  for (const f of facts) {
    const line = `- [${f.category}] ${f.key}: ${f.value}`;
    const cost = tokenEstimate(line) + (factHeaderAdded ? 0 : tokenEstimate(factHeader));
    if (cost > budget) break;
    if (!factHeaderAdded) {
      lines.push(factHeader);
      budget -= tokenEstimate(factHeader);
      factHeaderAdded = true;
    }
    lines.push(line);
    budget -= tokenEstimate(line);
  }

  const memHeader = "# Memories";
  let memHeaderAdded = false;
  for (const m of memories) {
    const line = `- (${m.importance}) ${m.content}`;
    const cost = tokenEstimate(line) + (memHeaderAdded ? 0 : tokenEstimate(memHeader));
    if (cost > budget) break;
    if (!memHeaderAdded) {
      lines.push(memHeader);
      budget -= tokenEstimate(memHeader);
      memHeaderAdded = true;
    }
    lines.push(line);
    budget -= tokenEstimate(line);
  }

  const text = lines.join("\n");
  return { text, tokenEstimate: tokenEstimate(text) };
}
