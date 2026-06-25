import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { LlmProvider } from "../extraction/provider.js";
import { recall } from "../retrieval/recall.js";
import { remember } from "../retrieval/remember.js";
import type { Embedder, MemoryContext } from "../types.js";
import { consolidateMemories } from "./consolidate.js";

const APP_URL = process.env.DOLORES_APP_DATABASE_URL ?? "";
const ADMIN_URL = process.env.DATABASE_URL ?? "";
const liveDescribe = APP_URL && ADMIN_URL ? describe : describe.skip;

const CONSOL_WS = "00000000-0000-0000-0000-0000000c0001";

// Controlled vectors: v1/v2/v3 are pairwise-similar to the SEED v1 at cosine 0.85
// — above the 0.82 cluster floor but BELOW the 0.9 dedup line, so remember() keeps
// them as three distinct rows that consolidation then groups. vUn is orthogonal.
const e0 = (() => {
  const v = new Array(384).fill(0);
  v[0] = 1;
  return v;
})();
const s = Math.sqrt(1 - 0.85 * 0.85);
const v2vec = (() => {
  const v = new Array(384).fill(0);
  v[0] = 0.85;
  v[1] = s;
  return v;
})();
const v3vec = (() => {
  const v = new Array(384).fill(0);
  v[0] = 0.85;
  v[2] = s;
  return v;
})();
const vUn = (() => {
  const v = new Array(384).fill(0);
  v[50] = 1;
  return v;
})();

const VEC: Record<string, number[]> = {
  "alpha note one": e0,
  "alpha note two": v2vec,
  "alpha note three": v3vec,
  "unrelated beta topic": vUn,
  "merged alpha memory": e0, // the synthesized note → recallable via the v1 query
  alpha: e0, // recall query
};

function controlledEmbedder(): Embedder {
  return {
    id: "fake-consolidation",
    dim: 384,
    ready: async () => {},
    embed: async (texts: string[]) => texts.map((t) => VEC[t.trim()] ?? new Array(384).fill(0)),
  };
}

const stubProvider = (reply: string): LlmProvider => ({ id: "stub", complete: async () => reply });

interface MemRow {
  id: string;
  content: string;
  superseded_by: string | null;
}

liveDescribe("memory consolidation (live DB)", () => {
  let pool: pg.Pool;
  let admin: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: APP_URL, max: 5 });
    admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
  });

  afterEach(async () => {
    await admin.query("UPDATE memories SET superseded_by = NULL WHERE workspace_id = $1", [
      CONSOL_WS,
    ]);
    await admin.query("DELETE FROM memories WHERE workspace_id = $1", [CONSOL_WS]);
  });

  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  it("clusters related memories into one note and supersedes the members", async () => {
    const ctx: MemoryContext = { workspaceId: CONSOL_WS, userId: null };
    const embedder = controlledEmbedder();

    // 3 related (cosine 0.85 — distinct rows, no dedup) + 1 unrelated.
    await remember(pool, ctx, embedder, { content: "alpha note one", importance: 4 });
    await remember(pool, ctx, embedder, { content: "alpha note two", importance: 6 });
    await remember(pool, ctx, embedder, { content: "alpha note three", importance: 5 });
    await remember(pool, ctx, embedder, { content: "unrelated beta topic", importance: 5 });

    const summary = await consolidateMemories(pool, ctx, embedder, {
      provider: stubProvider("merged alpha memory"),
      minClusterSize: 3,
      similarityThreshold: 0.82,
    });

    expect(summary.consolidated).toBe(1);
    expect(summary.superseded).toBe(3);

    const rows = (
      await admin.query<MemRow>(
        "SELECT id, content, superseded_by FROM memories WHERE workspace_id = $1",
        [CONSOL_WS],
      )
    ).rows;
    const consolidated = rows.find((r) => r.content === "merged alpha memory");
    expect(consolidated).toBeDefined();
    expect(consolidated?.superseded_by).toBeNull(); // the consolidation is active
    // Importance carried over: GREATEST(4,6,5) = 6.
    const members = rows.filter((r) => r.content.startsWith("alpha note"));
    expect(members).toHaveLength(3);
    for (const m of members) expect(m.superseded_by).toBe(consolidated?.id);
    // The unrelated memory is untouched.
    expect(rows.find((r) => r.content.includes("unrelated"))?.superseded_by).toBeNull();

    // Default recall surfaces the consolidation, not the superseded members.
    const { hits } = await recall(pool, ctx, embedder, { query: "alpha" });
    expect(hits.some((h) => h.content === "merged alpha memory")).toBe(true);
    expect(hits.some((h) => h.content.startsWith("alpha note"))).toBe(false);
  });

  it("is a graceful no-op without a provider", async () => {
    const ctx: MemoryContext = { workspaceId: CONSOL_WS, userId: null };
    const embedder = controlledEmbedder();
    await remember(pool, ctx, embedder, { content: "alpha note one", importance: 5 });
    await remember(pool, ctx, embedder, { content: "alpha note two", importance: 5 });
    await remember(pool, ctx, embedder, { content: "alpha note three", importance: 5 });

    const summary = await consolidateMemories(pool, ctx, embedder, {
      provider: null,
      minClusterSize: 3,
    });
    expect(summary.consolidated).toBe(0);
    expect(summary.superseded).toBe(0);
  });
});
