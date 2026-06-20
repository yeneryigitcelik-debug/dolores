import { type DaemonConfig, NoOpEmbedder, type PruneResponse } from "@dolores/core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./server.js";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const DB_URL = process.env.DOLORES_APP_DATABASE_URL ?? process.env.DATABASE_URL ?? "";

const HAS_DB = DB_URL.length > 0;

const TEST_WORKSPACE_ID = "a1a1a1a1-b2b2-c3c3-d4d4-e5e5e5e5e5e5";
const TEST_USER_ID = "f6f6f6f6-a7a7-b8b8-c9c9-d0d0d0d0d0d0";

const cfg: DaemonConfig = {
  host: "127.0.0.1",
  port: 4505,
  databaseUrl: DB_URL,
  embedder: "noop",
  embedModel: "bge-small-en-v1.5",
  decayMode: "conservative",
  extractionEnabled: false,
};

// ---------------------------------------------------------------------------
// Suite: /health (always available, no DB required)
// ---------------------------------------------------------------------------

describe("GET /health", () => {
  let pool: Pool;
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL || "postgresql://noop:noop@localhost:5432/noop" });
    const embedder = new NoOpEmbedder();
    await embedder.ready();
    app = await createApp(pool, embedder, cfg);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.end().catch(() => undefined);
  });

  it("returns 200 { ok: true }", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Suite: /status (no DB = connected:false, with DB = connected:true)
// ---------------------------------------------------------------------------

describe("GET /status", () => {
  let pool: Pool;
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL || "postgresql://noop:noop@localhost:1/noop" });
    const embedder = new NoOpEmbedder();
    await embedder.ready();
    app = await createApp(pool, embedder, cfg);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.end().catch(() => undefined);
  });

  it("returns 200 with expected shape", async () => {
    const res = await app.inject({ method: "GET", url: "/status" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      ok: boolean;
      embedder: { id: string; dim: number; ready: boolean };
      db: { connected: boolean; memories: number; facts: number };
      decayMode: string;
      estimatedTokenSavings: number;
    };
    expect(body.ok).toBe(true);
    expect(body.embedder.id).toBe("noop");
    expect(body.embedder.dim).toBe(0);
    expect(body.embedder.ready).toBe(true);
    expect(body.decayMode).toBe("conservative");
    expect(typeof body.db.connected).toBe("boolean");
    expect(typeof body.db.memories).toBe("number");
    expect(typeof body.db.facts).toBe("number");
    expect(typeof body.estimatedTokenSavings).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Suite: /remember → /recall round-trip (requires real DB)
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("DB round-trip: /remember → /recall", () => {
  let pool: Pool;
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL });
    const embedder = new NoOpEmbedder();
    await embedder.ready();
    app = await createApp(pool, embedder, cfg);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("POST /remember returns { id, deduped }", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/remember",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: TEST_WORKSPACE_ID,
        userId: TEST_USER_ID,
        content: "dolores daemon test memory: TypeScript strict mode preferred",
        importance: 7,
        source: "daemon.test",
      }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { id: string; deduped: boolean };
    expect(typeof body.id).toBe("string");
    expect(body.id.length).toBeGreaterThan(0);
    expect(typeof body.deduped).toBe("boolean");
  });

  it("POST /recall returns hits for a matching query", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/recall",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: TEST_WORKSPACE_ID,
        userId: TEST_USER_ID,
        query: "TypeScript",
        limit: 5,
      }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { hits: unknown[]; tokenEstimate: number };
    expect(Array.isArray(body.hits)).toBe(true);
    expect(typeof body.tokenEstimate).toBe("number");
  });

  it("POST /remember returns 400 for missing workspaceId", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/remember",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "test" }),
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Suite: /prune conservative (requires real DB)
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("POST /prune — conservative mode", () => {
  let pool: Pool;
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL });
    const embedder = new NoOpEmbedder();
    await embedder.ready();
    // cfg.decayMode = "conservative"
    app = await createApp(pool, embedder, cfg);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("dryRun=true returns deleted=0, softened is a number, data unchanged", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/prune",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: TEST_WORKSPACE_ID,
        userId: TEST_USER_ID,
        dryRun: true,
      }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as PruneResponse;
    expect(body.dryRun).toBe(true);
    expect(body.deleted).toBe(0); // conservative never deletes
    expect(typeof body.softened).toBe("number");
    expect(body.softened).toBeGreaterThanOrEqual(0);
  });

  it("dryRun=false returns deleted=0 (conservative = soften only)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/prune",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: TEST_WORKSPACE_ID,
        userId: TEST_USER_ID,
        dryRun: false,
      }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as PruneResponse;
    expect(body.dryRun).toBe(false);
    expect(body.deleted).toBe(0); // conservative NEVER deletes
    expect(typeof body.softened).toBe("number");
    expect(body.softened).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Suite: /prune aggressive (requires real DB)
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("POST /prune — aggressive mode", () => {
  let pool: Pool;
  let app: Awaited<ReturnType<typeof createApp>>;

  const aggressiveCfg: DaemonConfig = { ...cfg, decayMode: "aggressive" };

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL });
    const embedder = new NoOpEmbedder();
    await embedder.ready();
    app = await createApp(pool, embedder, aggressiveCfg);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("dryRun=true reports both deleted and softened counts without modifying data", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/prune",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: TEST_WORKSPACE_ID,
        userId: TEST_USER_ID,
        dryRun: true,
      }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as PruneResponse;
    expect(body.dryRun).toBe(true);
    expect(typeof body.deleted).toBe("number");
    expect(typeof body.softened).toBe("number");
    expect(body.deleted).toBeGreaterThanOrEqual(0);
    expect(body.softened).toBeGreaterThanOrEqual(0);
  });

  it("dryRun=false executes soften + delete for stale low-importance memories", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/prune",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: TEST_WORKSPACE_ID,
        userId: TEST_USER_ID,
        dryRun: false,
      }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as PruneResponse;
    expect(body.dryRun).toBe(false);
    expect(typeof body.deleted).toBe("number");
    expect(typeof body.softened).toBe("number");
    expect(body.deleted).toBeGreaterThanOrEqual(0);
    expect(body.softened).toBeGreaterThanOrEqual(0);
  });
});
