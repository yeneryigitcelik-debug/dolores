import type { Pool, PoolClient } from "pg";
import { NoOpEmbedder } from "../embedder/noop.js";
import type { Embedder, Fact, MemoryContext, Reranker } from "../types.js";
import { recall } from "./recall.js";
import { type FactRow, type MemoryRow, rowToFact } from "./sql.js";
import { withTenant } from "./tenant.js";
import { tokenEstimate } from "./tokens.js";

/** How many candidate memories to consider before token-budget trimming. */
const MEMORY_CANDIDATES = 50;

/** Characters per token, matching tokenEstimate = ceil(length / 4). */
const CHARS_PER_TOKEN = 4;

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
 * Convert a caller token budget into a hard character cap such that
 * ceil(chars / 4) <= budget. NaN / non-positive → 0; +Infinity → uncapped;
 * fractional budgets are floored.
 */
function budgetToMaxChars(maxTokens: number): number {
  if (Number.isNaN(maxTokens) || maxTokens <= 0) return 0;
  if (maxTokens === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  return Math.floor(maxTokens) * CHARS_PER_TOKEN;
}

/**
 * Pure renderer (DB-free, unit-testable). Greedily packs facts then memories
 * under the token budget. Accounting is exact on characters (including the
 * section headers and every newline separator), so the returned estimate
 * always equals tokenEstimate(text) and never exceeds a finite budget. Section
 * headers are only emitted when at least one item of that section fits.
 */
export function renderContext(
  facts: Fact[],
  memories: RenderMemory[],
  maxTokens: number,
): BuiltContext {
  const maxChars = budgetToMaxChars(maxTokens);
  const lines: string[] = [];
  let used = 0;

  const pack = <T>(header: string, items: readonly T[], render: (item: T) => string): void => {
    let headerAdded = false;
    for (const item of items) {
      const line = render(item);
      const sep = lines.length > 0 ? 1 : 0;
      const extra = headerAdded ? sep + line.length : sep + header.length + 1 + line.length;
      if (used + extra > maxChars) break;
      if (!headerAdded) {
        lines.push(header);
        headerAdded = true;
      }
      lines.push(line);
      used += extra;
    }
  };

  pack("# Facts", facts, (f) => `- [${f.category}] ${f.key}: ${f.value}`);
  pack("# Memories", memories, (m) => `- (${m.importance}) ${m.content}`);

  const text = lines.join("\n");
  return { text, tokenEstimate: tokenEstimate(text) };
}
