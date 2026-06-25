import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Embedder, MemoryContext } from "../types.js";
import { recall } from "./recall.js";
import { remember } from "./remember.js";

// ---------------------------------------------------------------------------
// Unit: temporal filters in the recall SQL (recording mock pool, no real DB).
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

const ctx: MemoryContext = { workspaceId: "00000000-0000-0000-0000-0000000000ee", userId: null };

/** SQL emitted by the two retrieval arms (the SELECTs against `memories`). */
function armSql(calls: RecordedCall[]): string[] {
  return calls.filter((c) => c.sql.includes("FROM memories")).map((c) => c.sql);
}

describe("recall temporal filters (EPIC F)", () => {
  it("default recall restricts to the ACTIVE set (superseded_by IS NULL)", async () => {
    const calls: RecordedCall[] = [];
    await recall(recordingPool(calls), ctx, fixedEmbedder(384), { query: "hosting provider" });
    const arms = armSql(calls);
    expect(arms.length).toBeGreaterThan(0);
    for (const sql of arms) {
      expect(sql).toContain("superseded_by IS NULL");
      expect(sql).not.toContain("valid_from <="); // no asOf predicate
    }
  });

  it("includeSuperseded drops the active-only filter", async () => {
    const calls: RecordedCall[] = [];
    await recall(recordingPool(calls), ctx, fixedEmbedder(384), {
      query: "hosting provider",
      includeSuperseded: true,
    });
    for (const sql of armSql(calls)) {
      expect(sql).not.toContain("superseded_by IS NULL");
      expect(sql).not.toContain("valid_from <=");
    }
  });

  it("asOf selects by validity window and spans superseded rows", async () => {
    const calls: RecordedCall[] = [];
    await recall(recordingPool(calls), ctx, fixedEmbedder(384), {
      query: "hosting provider",
      asOf: "2026-01-01T00:00:00.000Z",
    });
    for (const sql of armSql(calls)) {
      expect(sql).toContain("valid_from <=");
      expect(sql).toContain("valid_to IS NULL OR valid_to >");
      // asOf already selects historical versions — must NOT also exclude them.
      expect(sql).not.toContain("superseded_by IS NULL");
    }
    // asOf value is bound as a parameter (no interpolation).
    const arm = calls.find((c) => c.sql.includes("valid_from <="));
    expect(arm?.params).toContain("2026-01-01T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Live DB. Requires DOLORES_APP_DATABASE_URL (app user + RLS) + DATABASE_URL
// (superuser cleanup), Postgres reachable with the EPIC F migration applied.
// ---------------------------------------------------------------------------

const APP_URL = process.env.DOLORES_APP_DATABASE_URL ?? "";
const ADMIN_URL = process.env.DATABASE_URL ?? "";
const liveDescribe = APP_URL && ADMIN_URL ? describe : describe.skip;

const EVOLVE_WS = "00000000-0000-0000-0000-00000000ee01";
const OTHER_WS = "00000000-0000-0000-0000-00000000ee02";

// Computed key so env writes use member access (matches the accepted pattern in
// recall.quality.test.ts; biome's noDelete only flags static-member deletes).
const ENV_MODE = "DOLORES_EVOLUTION_MODE";

interface MemRow {
  id: string;
  content: string;
  importance: number;
  superseded_by: string | null;
  valid_from: Date;
  valid_to: Date | null;
}

/** Same fixed vector for every text → cosine similarity 1.0 → always supersedes. */
function fixedVectorEmbedder(): Embedder {
  const v = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
  return {
    id: "fake-fixed-vec",
    dim: 384,
    ready: async () => {},
    embed: async (texts: string[]) => texts.map(() => v),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

liveDescribe("memory evolution (live DB)", () => {
  let pool: pg.Pool;
  let admin: pg.Pool;
  const savedMode = process.env[ENV_MODE];

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: APP_URL, max: 5 });
    admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
  });

  afterEach(async () => {
    if (savedMode === undefined) delete process.env[ENV_MODE];
    else process.env[ENV_MODE] = savedMode;
    for (const ws of [EVOLVE_WS, OTHER_WS]) {
      // superseded_by self-FK: null it before delete so row order can't block.
      await admin.query("UPDATE memories SET superseded_by = NULL WHERE workspace_id = $1", [ws]);
      await admin.query("DELETE FROM memories WHERE workspace_id = $1", [ws]);
    }
  });

  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  it("versioned mode supersedes the old memory and keeps it for point-in-time recall", async () => {
    process.env[ENV_MODE] = "versioned";
    const tenant: MemoryContext = { workspaceId: EVOLVE_WS, userId: null };
    const embedder = fixedVectorEmbedder();

    const first = await remember(pool, tenant, embedder, {
      content: "hosting provider is hetzner",
      importance: 7,
    });
    await sleep(25); // guarantee now() advances so valid_to > valid_from
    const second = await remember(pool, tenant, embedder, {
      content: "hosting provider is vultr",
      importance: 5,
    });

    // Superseding inserts a NEW active row (not an in-place overwrite).
    expect(second.deduped).toBe(true);
    expect(second.id).not.toBe(first.id);

    const rows = (
      await admin.query<MemRow>(
        `SELECT id, content, importance, superseded_by, valid_from, valid_to
           FROM memories WHERE workspace_id = $1 ORDER BY valid_from`,
        [EVOLVE_WS],
      )
    ).rows;
    expect(rows).toHaveLength(2);
    const hetzner = rows.find((r) => r.content.includes("hetzner"));
    const vultr = rows.find((r) => r.content.includes("vultr"));
    // Old row: chained forward + validity window closed.
    expect(hetzner?.superseded_by).toBe(second.id);
    expect(hetzner?.valid_to).not.toBeNull();
    // New row: active, importance carried over (GREATEST 7 vs 5 = 7).
    expect(vultr?.superseded_by).toBeNull();
    expect(vultr?.valid_to).toBeNull();
    expect(vultr?.importance).toBe(7);

    // Default recall surfaces only the ACTIVE (current) value.
    const now = await recall(pool, tenant, embedder, { query: "hosting provider" });
    expect(now.hits).toHaveLength(1);
    expect(now.hits[0]?.content).toContain("vultr");

    // Point-in-time recall: as of a moment while hetzner was valid → hetzner.
    if (!hetzner) throw new Error("hetzner row missing");
    const t1 = new Date(hetzner.valid_from).getTime();
    const t2 = new Date(hetzner.valid_to as unknown as string).getTime();
    const asOf = new Date(Math.floor((t1 + t2) / 2)).toISOString();
    const past = await recall(pool, tenant, embedder, { query: "hosting provider", asOf });
    expect(past.hits.some((h) => h.content.includes("hetzner"))).toBe(true);
    expect(past.hits.some((h) => h.content.includes("vultr"))).toBe(false);

    // includeSuperseded exposes history with the chain pointer populated.
    const all = await recall(pool, tenant, embedder, {
      query: "hosting provider",
      includeSuperseded: true,
    });
    expect(all.hits).toHaveLength(2);
    const histHit = all.hits.find((h) => h.content.includes("hetzner"));
    expect(histHit?.supersededBy).toBe(second.id);
  });

  it("inplace (default) overwrites in place — no history row", async () => {
    delete process.env[ENV_MODE]; // default = inplace
    const tenant: MemoryContext = { workspaceId: EVOLVE_WS, userId: null };
    const embedder = fixedVectorEmbedder();

    const first = await remember(pool, tenant, embedder, {
      content: "deploy target is staging",
      importance: 4,
    });
    const second = await remember(pool, tenant, embedder, {
      content: "deploy target is production",
      importance: 6,
    });

    expect(second.deduped).toBe(true);
    expect(second.id).toBe(first.id); // same row, overwritten

    const rows = (
      await admin.query<MemRow>(
        "SELECT content, superseded_by FROM memories WHERE workspace_id = $1",
        [EVOLVE_WS],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toContain("production");
    expect(rows[0]?.superseded_by).toBeNull();
  });

  it("RLS isolates superseded history across workspaces", async () => {
    process.env[ENV_MODE] = "versioned";
    const embedder = fixedVectorEmbedder();
    const owner: MemoryContext = { workspaceId: EVOLVE_WS, userId: null };
    const intruder: MemoryContext = { workspaceId: OTHER_WS, userId: null };

    await remember(pool, owner, embedder, {
      content: "secret region is eu-central",
      importance: 8,
    });
    await sleep(25);
    await remember(pool, owner, embedder, { content: "secret region is us-east", importance: 8 });

    // Another workspace sees nothing — not even the superseded historical row.
    const leaked = await recall(pool, intruder, embedder, {
      query: "secret region",
      includeSuperseded: true,
    });
    expect(leaked.hits).toHaveLength(0);
  });
});
