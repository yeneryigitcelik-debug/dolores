import type { Pool } from "pg";
import type { Fact, MemoryContext } from "../types.js";
import { type FactRow, type MemoryRow, rowToFact } from "./sql.js";
import { withTenant } from "./tenant.js";
import { tokenEstimate } from "./tokens.js";

/** How many candidate memories to consider before token-budget trimming. */
const MEMORY_CANDIDATES = 50;

export interface BuiltContext {
  text: string;
  tokenEstimate: number;
}

type RenderMemory = Pick<MemoryRow, "content" | "importance">;

/**
 * Deterministically render facts + the most important/fresh memories into a
 * compact system-prompt blob, capped at `maxTokens`. Pure SQL — no LLM, no
 * embedder. Facts are rendered first (deterministic, cheap, high-signal), then
 * the remaining budget is filled with memories.
 */
export async function buildContext(
  pool: Pool,
  ctx: MemoryContext,
  maxTokens = 600,
): Promise<BuiltContext> {
  return withTenant(pool, ctx, async (client) => {
    const facts = await client.query<FactRow>(
      `SELECT id, workspace_id, user_id, scope, category, key, value, created_at, updated_at
         FROM facts
        ORDER BY category, key`,
    );
    const memories = await client.query<MemoryRow>(
      `SELECT id, workspace_id, user_id, scope, content, importance, source, created_at, last_accessed
         FROM memories
        ORDER BY importance DESC, last_accessed DESC, created_at DESC
        LIMIT $1`,
      [MEMORY_CANDIDATES],
    );
    return renderContext(facts.rows.map(rowToFact), memories.rows, maxTokens);
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
