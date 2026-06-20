import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { NoOpEmbedder } from "../embedder/noop.js";
import type { Embedder, MemoryContext } from "../types.js";
import { buildContext } from "./context.js";
import { recall } from "./recall.js";
import { remember } from "./remember.js";

// ---------------------------------------------------------------------------
// ivfflat.probes — pure unit test with a recording mock pool (no real DB).
// ---------------------------------------------------------------------------

interface RecordedCall {
  sql: string;
  params?: unknown[];
}

function recordingPool(calls: RecordedCall[]): pg.Pool {
  return {
    connect: async () => ({
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return { rows: [] };
      },
      release: () => {},
    }),
  } as unknown as pg.Pool;
}

function fixedEmbedder(dim: number): Embedder {
  return {
    id: `fixed-${dim}`,
    dim,
    ready: async () => {},
    embed: async (texts: string[]) => texts.map(() => Array.from({ length: dim }, () => 0.1)),
  };
}

describe("recall sets ivfflat.probes", () => {
  const ctx: MemoryContext = { workspaceId: "00000000-0000-0000-0000-0000000000aa", userId: null };

  it("issues SET LOCAL ivfflat.probes when the vector arm runs", async () => {
    const calls: RecordedCall[] = [];
    await recall(recordingPool(calls), ctx, fixedEmbedder(384), { query: "hello world" });
    const probeCall = calls.find((c) => c.sql.includes("ivfflat.probes"));
    expect(probeCall).toBeDefined();
    expect(probeCall?.params?.[0]).toBe("10"); // default
  });

  it("honours DOLORES_IVFFLAT_PROBES", async () => {
    const key = "DOLORES_IVFFLAT_PROBES";
    const saved = process.env[key];
    process.env[key] = "25";
    try {
      const calls: RecordedCall[] = [];
      await recall(recordingPool(calls), ctx, fixedEmbedder(384), { query: "hi" });
      const probeCall = calls.find((c) => c.sql.includes("ivfflat.probes"));
      expect(probeCall?.params?.[0]).toBe("25");
    } finally {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  });

  it("does NOT set ivfflat.probes in noop (full-text only) mode", async () => {
    const calls: RecordedCall[] = [];
    await recall(recordingPool(calls), ctx, new NoOpEmbedder(), { query: "hello" });
    expect(calls.some((c) => c.sql.includes("ivfflat.probes"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Live DB integration. Requires DOLORES_APP_DATABASE_URL + DATABASE_URL on 5544.
// Uses isolated workspaces + admin (superuser) cleanup, like the concurrency test.
// ---------------------------------------------------------------------------

const APP_URL = process.env.DOLORES_APP_DATABASE_URL ?? "";
const ADMIN_URL = process.env.DATABASE_URL ?? "";
const liveDescribe = APP_URL && ADMIN_URL ? describe : describe.skip;

const BOOST_WS = "00000000-0000-0000-0000-00000000cc02";
const CTX_WS = "00000000-0000-0000-0000-00000000cc03";

liveDescribe("retrieval quality (live DB)", () => {
  let pool: pg.Pool;
  let admin: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: APP_URL, max: 5 });
    admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
  });

  afterEach(async () => {
    for (const ws of [BOOST_WS, CTX_WS]) {
      await admin.query("DELETE FROM memories WHERE workspace_id = $1", [ws]);
      await admin.query("DELETE FROM facts WHERE workspace_id = $1", [ws]);
    }
  });

  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  it("importance boost flips ordering: a more important memory beats the closer vector match", async () => {
    const ctx: MemoryContext = { workspaceId: BOOST_WS, userId: null };

    // Controlled 384-dim vectors. The query embeds to vA (= LOW's exact match).
    // HIGH (vB) has cosine similarity 0.85 to the query — close enough to rank #2
    // in the vector arm, but BELOW the 0.9 supersede threshold so it inserts as a
    // distinct row rather than deduping into LOW.
    const vA = (() => {
      const v = Array.from({ length: 384 }, () => 0);
      v[0] = 1;
      return v;
    })();
    const vB = (() => {
      const v = Array.from({ length: 384 }, () => 0);
      v[0] = 0.85;
      v[1] = Math.sqrt(1 - 0.85 * 0.85);
      return v;
    })();
    const VEC: Record<string, number[]> = {
      "alpha topic note one": vA, // LOW importance, EXACT match to the query vector
      "beta topic note two": vB, // HIGH importance, slightly farther
      "zeta probe lookup token": vA, // the query (no full-text overlap with contents)
    };
    const embedder: Embedder = {
      id: "fake-controlled",
      dim: 384,
      ready: async () => {},
      embed: async (texts: string[]) =>
        texts.map((t) => VEC[t.trim()] ?? Array.from({ length: 384 }, () => 0)),
    };

    await remember(pool, ctx, embedder, {
      content: "alpha topic note one",
      importance: 1,
    });
    await remember(pool, ctx, embedder, {
      content: "beta topic note two",
      importance: 10,
    });

    // Equalize recency (both rows get the same last_accessed/created_at) so this
    // test isolates the IMPORTANCE boost — without this, HIGH being inserted last
    // gives it a recency edge too, making the assertion non-deterministic.
    await admin.query(
      "UPDATE memories SET last_accessed = now(), created_at = now() WHERE workspace_id = $1",
      [BOOST_WS],
    );

    const { hits } = await recall(pool, ctx, embedder, { query: "zeta probe lookup token" });

    expect(hits).toHaveLength(2);
    // Despite LOW being the EXACT vector match, the importance boost ranks HIGH first.
    expect(hits[0]?.content).toBe("beta topic note two");
    expect(hits[0]?.importance).toBe(10);
    expect(hits[1]?.importance).toBe(1);
    // Scores stay normalised 0..1.
    for (const h of hits) {
      expect(h.score).toBeGreaterThan(0);
      expect(h.score).toBeLessThanOrEqual(1);
    }
  });

  it("query-aware buildContext returns only RELEVANT memories (full-text fallback)", async () => {
    const ctx: MemoryContext = { workspaceId: CTX_WS, userId: null };
    const noop = new NoOpEmbedder();

    await remember(pool, ctx, noop, {
      content: "deployment schedule is every friday afternoon",
      importance: 5,
    });
    await remember(pool, ctx, noop, { content: "favorite color is teal", importance: 5 });
    await remember(pool, ctx, noop, { content: "lunch meeting was rescheduled", importance: 5 });

    // Query-aware: no embedder passed → NoOpEmbedder → full-text relevance only.
    // plainto_tsquery ANDs lexemes, so both "deploy" + "schedul" must be present.
    const ctxText = await buildContext(pool, ctx, 600, "deployment schedule");
    expect(ctxText.text).toContain("deployment schedule is every friday afternoon");
    expect(ctxText.text).not.toContain("favorite color is teal");
    expect(ctxText.text).not.toContain("lunch meeting was rescheduled");

    // Default (no query) is the static blob — surfaces ALL of them by importance.
    const staticText = await buildContext(pool, ctx, 600);
    expect(staticText.text).toContain("favorite color is teal");
    expect(staticText.text).toContain("lunch meeting was rescheduled");
  });
});
