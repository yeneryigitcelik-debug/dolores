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
    // Aday havuzu salt-okunur çekilir (touch:false): bütçe kırpması adayların
    // çoğunu atar; yalnızca bağlama gerçekten giren satırlar aşağıda güncellenir.
    const { hits } = await recall(
      pool,
      ctx,
      embedder ?? new NoOpEmbedder(),
      { query: trimmedQuery, limit: MEMORY_CANDIDATES },
      reranker,
      { touch: false },
    );
    const { built, memoryCount } = packContext(facts, hits, maxTokens);
    const selectedIds = hits.slice(0, memoryCount).map((h) => h.id);
    if (selectedIds.length > 0) {
      await withTenant(pool, ctx, (client) => touchMemories(client, ctx.workspaceId, selectedIds));
    }
    return built;
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
    const { built, memoryCount } = packContext(facts, memories.rows, maxTokens);
    // Aynı tenant transaction'ı içinde: yalnızca render edilen satırlar güncellenir.
    const selectedIds = memories.rows.slice(0, memoryCount).map((m) => m.id);
    if (selectedIds.length > 0) {
      await touchMemories(client, ctx.workspaceId, selectedIds);
    }
    return built;
  });
}

/**
 * Bağlama gerçekten giren memory'lerin `last_accessed` değerini günceller.
 * Parametreler bağlı; RLS'e ek olarak açık workspace filtresi ve yalnızca aktif
 * (süperseded olmamış) satırlar.
 */
async function touchMemories(
  client: PoolClient,
  workspaceId: string,
  ids: readonly string[],
): Promise<void> {
  await client.query(
    `UPDATE memories SET last_accessed = now()
      WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND superseded_by IS NULL`,
    [workspaceId, [...ids]],
  );
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
  return packContext(facts, memories, maxTokens).built;
}

/**
 * Özel defter tutma: renderContext ile birebir aynı çıktıyı üretir ve ek olarak
 * kaç memory'nin (önek olarak) bağlama girdiğini döndürür. Paketleme önek-açgözlü
 * olduğu için seçilen memory'ler tam olarak ilk `memoryCount` öğedir.
 */
function packContext(
  facts: Fact[],
  memories: readonly RenderMemory[],
  maxTokens: number,
): { built: BuiltContext; memoryCount: number } {
  const maxChars = budgetToMaxChars(maxTokens);
  const lines: string[] = [];
  let used = 0;

  const pack = <T>(header: string, items: readonly T[], render: (item: T) => string): number => {
    let headerAdded = false;
    let count = 0;
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
      count++;
    }
    return count;
  };

  pack("# Facts", facts, (f) => `- [${f.category}] ${f.key}: ${f.value}`);
  const memoryCount = pack("# Memories", memories, (m) => `- (${m.importance}) ${m.content}`);

  const text = lines.join("\n");
  return { built: { text, tokenEstimate: tokenEstimate(text) }, memoryCount };
}
