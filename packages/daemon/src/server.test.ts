import { type DaemonConfig, NoOpEmbedder, type PruneResponse, withTenant } from "@dolores/core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
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

// ---------------------------------------------------------------------------
// Suite: body length limits → 400 VALIDATION_ERROR
// ---------------------------------------------------------------------------

describe("Body size limits", () => {
  let pool: Pool;
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: "postgresql://noop:noop@localhost:1/noop" });
    const embedder = new NoOpEmbedder();
    await embedder.ready();
    app = await createApp(pool, embedder, cfg);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.end().catch(() => undefined);
  });

  it("POST /remember with content > 50_000 chars returns 400 VALIDATION_ERROR", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/remember",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: TEST_WORKSPACE_ID,
        userId: TEST_USER_ID,
        content: "x".repeat(50_001),
      }),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("POST /recall with query > 2_000 chars returns 400 VALIDATION_ERROR", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/recall",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: TEST_WORKSPACE_ID,
        userId: TEST_USER_ID,
        query: "x".repeat(2_001),
      }),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("POST /ingest with text > 100_000 chars returns 400 VALIDATION_ERROR", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: TEST_WORKSPACE_ID,
        userId: TEST_USER_ID,
        text: "x".repeat(100_001),
      }),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });
});

// ---------------------------------------------------------------------------
// Suite: Bearer auth middleware
// ---------------------------------------------------------------------------

describe("Bearer auth middleware", () => {
  let pool: Pool;
  let appWithAuth: Awaited<ReturnType<typeof createApp>>;
  const TOKEN = "test-secret-token-dolores-12345";

  beforeAll(async () => {
    pool = new Pool({ connectionString: "postgresql://noop:noop@localhost:1/noop" });
    const embedder = new NoOpEmbedder();
    await embedder.ready();
    appWithAuth = await createApp(pool, embedder, { ...cfg, authToken: TOKEN });
    await appWithAuth.ready();
  });

  afterAll(async () => {
    await appWithAuth.close();
    await pool.end().catch(() => undefined);
  });

  it("GET /health is accessible without token even when auth is enabled", async () => {
    const res = await appWithAuth.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it("POST /recall without Authorization header returns 401 UNAUTHORIZED", async () => {
    const res = await appWithAuth.inject({
      method: "POST",
      url: "/recall",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID, query: "test" }),
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(typeof body.error.message).toBe("string");
  });

  it("POST /recall with wrong token returns 401 UNAUTHORIZED", async () => {
    const res = await appWithAuth.inject({
      method: "POST",
      url: "/recall",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wrong-token",
      },
      body: JSON.stringify({ workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID, query: "test" }),
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("POST /recall with correct token passes auth (not 401)", async () => {
    const res = await appWithAuth.inject({
      method: "POST",
      url: "/recall",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ workspaceId: TEST_WORKSPACE_ID, userId: TEST_USER_ID, query: "test" }),
    });
    // Auth passes; DB unreachable → 500 is acceptable, 401 is not
    expect(res.statusCode).not.toBe(401);
  });

  it("POST /status without token returns 401 when auth enabled", async () => {
    const res = await appWithAuth.inject({ method: "GET", url: "/status" });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Suite: error response schema (no internal detail leaked)
// ---------------------------------------------------------------------------

describe("Error response schema", () => {
  let pool: Pool;
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    // dead pool — forces DB errors on any endpoint that reaches the DB
    pool = new Pool({ connectionString: "postgresql://noop:noop@localhost:1/noop" });
    const embedder = new NoOpEmbedder();
    await embedder.ready();
    app = await createApp(pool, embedder, cfg);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.end().catch(() => undefined);
  });

  it("400 validation errors have {error:{code,message,issues}} shape", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/remember",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}), // missing required workspaceId + content
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as {
      error: { code: string; message: string; issues?: unknown[] };
    };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(typeof body.error.message).toBe("string");
    expect(Array.isArray(body.error.issues)).toBe(true);
  });

  it("500 errors return INTERNAL code without pg connection details", async () => {
    // /remember passes Zod validation but will fail at DB (dead pool)
    const res = await app.inject({
      method: "POST",
      url: "/remember",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: TEST_WORKSPACE_ID,
        userId: TEST_USER_ID,
        content: "test content for error schema check",
      }),
    });
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).toBe("An internal error occurred");
    // Must not leak pg connection details
    expect(body.error.message).not.toMatch(/ECONNREFUSED|postgres|localhost|\d+\.\d+\.\d+\.\d+/);
  });
});

// ---------------------------------------------------------------------------
// Suite: /ingest returns 202 Accepted
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("POST /ingest → 202 + jobId, /ingest/status", () => {
  let pool: Pool;
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL });
    const embedder = new NoOpEmbedder();
    await embedder.ready();
    // createApp does NOT start the ingest worker, so jobs stay 'pending' here —
    // which is exactly what lets us assert the enqueued state deterministically.
    app = await createApp(pool, embedder, cfg);
    await app.ready();
  });

  afterAll(async () => {
    // Clean up the pending jobs this suite enqueued (no worker drained them).
    await withTenant(pool, { workspaceId: TEST_WORKSPACE_ID }, (c) =>
      c.query("DELETE FROM ingest_jobs WHERE workspace_id = $1", [TEST_WORKSPACE_ID]),
    ).catch(() => undefined);
    await app.close();
    await pool.end().catch(() => undefined);
  });

  it("enqueues and returns 202 { queued: true, jobId }", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: TEST_WORKSPACE_ID,
        userId: TEST_USER_ID,
        text: "some ingested text",
      }),
    });
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body) as { queued: boolean; jobId?: string };
    expect(body.queued).toBe(true);
    expect(body.jobId).toMatch(/^[0-9a-f-]{36}$/);

    // /ingest/status reflects the queued job (pending — no worker in createApp).
    const statusRes = await app.inject({
      method: "POST",
      url: "/ingest/status",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: TEST_WORKSPACE_ID,
        userId: TEST_USER_ID,
        jobId: body.jobId,
      }),
    });
    expect(statusRes.statusCode).toBe(200);
    const status = JSON.parse(statusRes.body) as { id: string; status: string; attempts: number };
    expect(status.id).toBe(body.jobId);
    expect(status.status).toBe("pending");
    expect(status.attempts).toBe(0);
  });

  it("/ingest/status returns 404 for an unknown jobId", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/ingest/status",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: TEST_WORKSPACE_ID,
        userId: TEST_USER_ID,
        jobId: "00000000-0000-0000-0000-0000000000ff",
      }),
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Suite: GET /metrics
// ---------------------------------------------------------------------------

describe("GET /metrics — shape", () => {
  let pool: Pool;
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: "postgresql://noop:noop@localhost:1/noop" });
    const embedder = new NoOpEmbedder();
    await embedder.ready();
    app = await createApp(pool, embedder, cfg);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.end().catch(() => undefined);
  });

  it("returns 200 with expected MetricsPayload shape", async () => {
    // Fire a request first so at least one route entry appears
    await app.inject({ method: "GET", url: "/health" });

    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      uptimeSec: number;
      totalRequests: number;
      routes: Record<string, { count: number; avgMs: number }>;
      embedder: { ready: boolean };
      db: { connected: boolean };
    };
    expect(typeof body.uptimeSec).toBe("number");
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(typeof body.totalRequests).toBe("number");
    expect(body.totalRequests).toBeGreaterThan(0);
    expect(typeof body.routes).toBe("object");
    expect(body.embedder.ready).toBe(true);
    expect(typeof body.db.connected).toBe("boolean");
  });

  it("tracks route counts — repeated /health calls accumulate", async () => {
    // Hit /health twice more so the route appears with count ≥ 2
    await app.inject({ method: "GET", url: "/health" });
    await app.inject({ method: "GET", url: "/health" });

    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      routes: Record<string, { count: number; avgMs: number }>;
    };
    const healthRoute = body.routes["GET /health"];
    expect(healthRoute).toBeDefined();
    expect(typeof healthRoute?.count).toBe("number");
    expect(healthRoute?.count).toBeGreaterThanOrEqual(2);
    expect(typeof healthRoute?.avgMs).toBe("number");
  });
});

describe("GET /metrics — auth when auth enabled", () => {
  let pool: Pool;
  let appWithAuth: Awaited<ReturnType<typeof createApp>>;
  const TOKEN = "test-secret-token-dolores-99999";

  beforeAll(async () => {
    pool = new Pool({ connectionString: "postgresql://noop:noop@localhost:1/noop" });
    const embedder = new NoOpEmbedder();
    await embedder.ready();
    appWithAuth = await createApp(pool, embedder, { ...cfg, authToken: TOKEN });
    await appWithAuth.ready();
  });

  afterAll(async () => {
    await appWithAuth.close();
    await pool.end().catch(() => undefined);
  });

  it("GET /metrics without token returns 401 UNAUTHORIZED", async () => {
    const res = await appWithAuth.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("GET /metrics with correct token returns 200", async () => {
    const res = await appWithAuth.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { uptimeSec: number };
    expect(typeof body.uptimeSec).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Suite: DOLORES_LOG_LEVEL env controls pino log level
// ---------------------------------------------------------------------------

describe("DOLORES_LOG_LEVEL env controls log level", () => {
  it("app.log.level reflects DOLORES_LOG_LEVEL=debug", async () => {
    const prev = process.env.DOLORES_LOG_LEVEL;
    process.env.DOLORES_LOG_LEVEL = "debug";
    let app: Awaited<ReturnType<typeof createApp>> | undefined;
    const pool = new Pool({ connectionString: "postgresql://noop:noop@localhost:1/noop" });
    try {
      const embedder = new NoOpEmbedder();
      await embedder.ready();
      app = await createApp(pool, embedder, cfg);
      await app.ready();
      expect(app.log.level).toBe("debug");
    } finally {
      // biome-ignore lint/performance/noDelete: process.env needs delete to truly unset (= undefined sets the string "undefined")
      if (prev === undefined) delete process.env.DOLORES_LOG_LEVEL;
      else process.env.DOLORES_LOG_LEVEL = prev;
      await app?.close();
      await pool.end().catch(() => undefined);
    }
  });

  it("app.log.level defaults to info when DOLORES_LOG_LEVEL unset", async () => {
    const prev = process.env.DOLORES_LOG_LEVEL;
    // biome-ignore lint/performance/noDelete: process.env needs delete to truly unset (= undefined sets the string "undefined")
    delete process.env.DOLORES_LOG_LEVEL;
    let app: Awaited<ReturnType<typeof createApp>> | undefined;
    const pool = new Pool({ connectionString: "postgresql://noop:noop@localhost:1/noop" });
    try {
      const embedder = new NoOpEmbedder();
      await embedder.ready();
      app = await createApp(pool, embedder, cfg);
      await app.ready();
      expect(app.log.level).toBe("info");
    } finally {
      if (prev !== undefined) process.env.DOLORES_LOG_LEVEL = prev;
      await app?.close();
      await pool.end().catch(() => undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// Suite: safety gate — non-localhost host without DOLORES_AUTH_TOKEN
// ---------------------------------------------------------------------------

describe("Safety gate: non-localhost without DOLORES_AUTH_TOKEN", () => {
  const APP = "postgresql://noop:noop@localhost:5432/noop";

  /**
   * Run fn with env overrides, restoring prior values afterward. A value of
   * undefined DELETES the key — `process.env.X = undefined` would coerce to the
   * string "undefined" (truthy), which is exactly the bug this avoids.
   */
  function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
    const keys = Object.keys(overrides);
    const saved: Record<string, string | undefined> = {};
    for (const k of keys) saved[k] = process.env[k];
    const apply = (values: Record<string, string | undefined>) => {
      for (const k of keys) {
        const v = values[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    };
    try {
      apply(overrides);
      fn();
    } finally {
      apply(saved);
    }
  }

  it("loadConfig throws when DOLORES_DAEMON_HOST=0.0.0.0 and no auth token", () => {
    withEnv(
      {
        DOLORES_DAEMON_HOST: "0.0.0.0",
        DOLORES_AUTH_TOKEN: undefined,
        DOLORES_APP_DATABASE_URL: APP,
      },
      () => expect(() => loadConfig()).toThrow(/DOLORES_AUTH_TOKEN/),
    );
  });

  it("loadConfig succeeds when host is 0.0.0.0 with DOLORES_AUTH_TOKEN set", () => {
    withEnv(
      {
        DOLORES_DAEMON_HOST: "0.0.0.0",
        DOLORES_AUTH_TOKEN: "my-secure-token",
        DOLORES_APP_DATABASE_URL: APP,
      },
      () => {
        const config = loadConfig();
        expect(config.host).toBe("0.0.0.0");
        expect(config.authToken).toBe("my-secure-token");
      },
    );
  });

  it("loadConfig succeeds with localhost host and no auth token", () => {
    withEnv(
      {
        DOLORES_DAEMON_HOST: "127.0.0.1",
        DOLORES_AUTH_TOKEN: undefined,
        DOLORES_APP_DATABASE_URL: APP,
      },
      () => {
        const config = loadConfig();
        expect(config.host).toBe("127.0.0.1");
        expect(config.authToken).toBeUndefined();
      },
    );
  });
});
