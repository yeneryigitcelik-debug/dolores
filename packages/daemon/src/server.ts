import {
  type ContextResponse,
  type DecayMode,
  type Embedder,
  type FactsListResponse,
  type FactsUpsertResponse,
  type HealthResponse,
  type IngestResponse,
  type MemoryContext,
  type PruneResponse,
  type RecallResponse,
  type RememberResponse,
  type StatusResponse,
  buildContext,
  createEmbedder,
  createReranker,
  ingestText,
  listFacts,
  recall,
  remember,
  upsertFact,
  withTenant,
} from "@dolores/core";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { Pool } from "pg";
import { z } from "zod";
import type { DaemonRuntimeConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Zod schemas for request bodies
// ---------------------------------------------------------------------------

const scopeSchema = z.enum(["personal", "workspace"]);

const ctxSchema = z.object({
  workspaceId: z.string().uuid("workspaceId must be a UUID"),
  userId: z.string().uuid().nullable().optional(),
});

const rememberBodySchema = ctxSchema.extend({
  content: z.string().min(1, "content must be non-empty").max(50_000),
  scope: scopeSchema.optional(),
  importance: z.number().int().min(1).max(10).optional(),
  source: z.string().optional(),
});

const recallBodySchema = ctxSchema.extend({
  query: z.string().min(1, "query must be non-empty").max(2_000),
  limit: z.number().int().min(1).max(100).optional(),
  scope: scopeSchema.optional(),
  minImportance: z.number().int().min(1).max(10).optional(),
  // Temporal evolution (EPIC F). asOf accepts a date ('YYYY-MM-DD') or full ISO
  // timestamp — anything Date.parse understands, cast to timestamptz downstream.
  asOf: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), "asOf must be an ISO date or datetime")
    .optional(),
  includeSuperseded: z.boolean().optional(),
});

const contextBodySchema = ctxSchema.extend({
  maxTokens: z.number().int().min(1).optional(),
  query: z.string().max(2_000).optional(),
});

const factsListBodySchema = ctxSchema.extend({
  category: z.string().optional(),
});

const factsUpsertBodySchema = ctxSchema.extend({
  category: z.string().min(1),
  key: z.string().min(1),
  value: z.string().min(1),
  scope: scopeSchema.optional(),
});

const ingestBodySchema = ctxSchema.extend({
  text: z.string().min(1, "text must be non-empty").max(100_000),
  source: z.string().optional(),
});

const pruneBodySchema = ctxSchema.extend({
  dryRun: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Prune helper (not in @dolores/core — daemon-only logic)
// ---------------------------------------------------------------------------

// conservative = soften only (importance GREATEST(1,importance-1)); NEVER delete.
// aggressive   = soften + delete (importance<3 AND last_accessed 90d+).
// dryRun reports REAL candidate counts without modifying any rows.
async function runPrune(
  pool: Pool,
  ctx: MemoryContext,
  mode: DecayMode,
  dryRun: boolean,
): Promise<{ softened: number; deleted: number }> {
  let softened = 0;
  let deleted = 0;

  await withTenant(pool, ctx, async (client) => {
    if (dryRun) {
      const softenRes = await client.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM memories
         WHERE last_accessed < NOW() - INTERVAL '30 days' AND importance > 1`,
      );
      softened = Number.parseInt(softenRes.rows[0]?.count ?? "0", 10);

      if (mode === "aggressive") {
        const deleteRes = await client.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM memories
           WHERE last_accessed < NOW() - INTERVAL '90 days' AND importance < 3`,
        );
        deleted = Number.parseInt(deleteRes.rows[0]?.count ?? "0", 10);
      }
    } else {
      const softenRes = await client.query(
        `UPDATE memories
           SET importance = GREATEST(1, importance - 1)
         WHERE last_accessed < NOW() - INTERVAL '30 days' AND importance > 1`,
      );
      softened = softenRes.rowCount ?? 0;

      if (mode === "aggressive") {
        const deleteRes = await client.query(
          `DELETE FROM memories
           WHERE last_accessed < NOW() - INTERVAL '90 days' AND importance < 3`,
        );
        deleted = deleteRes.rowCount ?? 0;
      }
    }
  });

  return { softened, deleted };
}

// ---------------------------------------------------------------------------
// In-memory metrics
// ---------------------------------------------------------------------------

interface RouteMetric {
  count: number;
  totalMs: number;
}

// Local-only type — NOT added to @dolores/core/types.ts.
// [CONTRACT] If a client-facing MetricsResponse is ever needed across packages,
// add it to @dolores/core DAEMON_ROUTES and types.ts then import here.
interface MetricsPayload {
  uptimeSec: number;
  totalRequests: number;
  routes: Record<string, { count: number; avgMs: number }>;
  embedder: { ready: boolean };
  db: { connected: boolean };
}

// ---------------------------------------------------------------------------
// App factory (testable without binding to a port)
// ---------------------------------------------------------------------------

export async function createApp(
  pool: Pool,
  embedder: Embedder,
  config: DaemonRuntimeConfig,
  // Optional superuser pool for /status global counts — bypasses RLS.
  // Retrieval/recall/remember still use `pool` (app user + RLS).
  adminPool?: Pool,
): Promise<FastifyInstance> {
  const logLevel = process.env.DOLORES_LOG_LEVEL ?? "info";
  const app = Fastify({ logger: { level: logLevel } });

  // Optional final-stage reranker (EPIC H). Created once; NoOp unless
  // DOLORES_RERANKER selects a concrete local reranker. Stays off the LLM path.
  const reranker = createReranker(process.env.DOLORES_RERANKER);

  // ---------- Metrics state ----------
  const metricsStartedAt = Date.now();
  let metricsTotal = 0;
  const metricsRoutes = new Map<string, RouteMetric>();

  // Collect request count + latency for /metrics.
  // Fastify's own pino logger already handles access logs automatically;
  // this hook is for in-memory aggregation only.
  app.addHook("onResponse", (request, reply, done) => {
    metricsTotal++;
    const routeKey = `${request.method} ${request.routeOptions.url}`;
    const ms = reply.elapsedTime;
    const slot = metricsRoutes.get(routeKey) ?? { count: 0, totalMs: 0 };
    slot.count++;
    slot.totalMs += ms;
    metricsRoutes.set(routeKey, slot);
    done();
  });

  // ---------- Global error handler ----------
  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    // JSON parse errors and other client-side errors (4xx)
    if ((error.statusCode ?? 500) < 500) {
      return reply
        .status(error.statusCode ?? 400)
        .send({ error: { code: "VALIDATION_ERROR", message: error.message } });
    }
    request.log.error({ err: error }, "daemon unhandled error");
    return reply
      .status(500)
      .send({ error: { code: "INTERNAL", message: "An internal error occurred" } });
  });

  // ---------- Bearer auth hook (skip /health) ----------
  if (config.authToken) {
    const expectedHeader = `Bearer ${config.authToken}`;
    app.addHook("onRequest", async (request, reply) => {
      if (request.url.split("?")[0] === "/health") return;
      if (request.headers.authorization !== expectedHeader) {
        return reply.status(401).send({
          error: { code: "UNAUTHORIZED", message: "Invalid or missing authorization token" },
        });
      }
    });
  }

  // ---------- GET /health ----------
  app.get("/health", async (): Promise<HealthResponse> => {
    return { ok: true };
  });

  // ---------- GET /status ----------
  app.get("/status", async (): Promise<StatusResponse> => {
    let connected = false;
    let memories = 0;
    let facts = 0;

    // Connectivity check uses the app pool (dolores_app + RLS).
    try {
      const client = await pool.connect();
      try {
        await client.query("SELECT 1");
        connected = true;
      } finally {
        client.release();
      }
    } catch {
      connected = false;
    }

    // Global counts need the superuser adminPool to bypass RLS FORCE.
    // dolores_app without a workspace GUC always sees 0 rows due to RLS.
    // If adminPool is absent, counts stay at 0 (graceful degradation).
    if (connected && adminPool) {
      try {
        const adminClient = await adminPool.connect();
        try {
          const [mr, fr] = await Promise.all([
            adminClient.query<{ count: string }>("SELECT COUNT(*) AS count FROM memories"),
            adminClient.query<{ count: string }>("SELECT COUNT(*) AS count FROM facts"),
          ]);
          memories = Number.parseInt(mr.rows[0]?.count ?? "0", 10);
          facts = Number.parseInt(fr.rows[0]?.count ?? "0", 10);
        } finally {
          adminClient.release();
        }
      } catch {
        // Admin pool query failed — counts stay at 0.
      }
    }

    // rough token savings: avg ~50 tokens/memory vs 600-token context window
    const estimatedTokenSavings = Math.max(0, memories * 50 - 600);

    return {
      ok: true,
      embedder: { id: embedder.id, dim: embedder.dim, ready: true },
      db: { connected, memories, facts },
      decayMode: config.decayMode,
      estimatedTokenSavings,
    };
  });

  // ---------- POST /remember ----------
  app.post("/remember", async (request, reply): Promise<RememberResponse | undefined> => {
    const parsed = rememberBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          issues: parsed.error.issues,
        },
      });
    }
    const { workspaceId, userId, content, scope, importance, source } = parsed.data;
    const ctx: MemoryContext = { workspaceId, userId };
    try {
      return await remember(pool, ctx, embedder, { content, scope, importance, source });
    } catch (err) {
      request.log.error({ err }, "/remember error");
      return reply.status(500).send({
        error: { code: "INTERNAL", message: "An internal error occurred" },
      });
    }
  });

  // ---------- POST /recall ----------
  app.post("/recall", async (request, reply): Promise<RecallResponse | undefined> => {
    const parsed = recallBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          issues: parsed.error.issues,
        },
      });
    }
    const { workspaceId, userId, query, limit, scope, minImportance, asOf, includeSuperseded } =
      parsed.data;
    const ctx: MemoryContext = { workspaceId, userId };
    try {
      return await recall(
        pool,
        ctx,
        embedder,
        { query, limit, scope, minImportance, asOf, includeSuperseded },
        reranker,
      );
    } catch (err) {
      request.log.error({ err }, "/recall error");
      return reply.status(500).send({
        error: { code: "INTERNAL", message: "An internal error occurred" },
      });
    }
  });

  // ---------- POST /context ----------
  app.post("/context", async (request, reply): Promise<ContextResponse | undefined> => {
    const parsed = contextBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          issues: parsed.error.issues,
        },
      });
    }
    const { workspaceId, userId, maxTokens, query } = parsed.data;
    const ctx: MemoryContext = { workspaceId, userId };
    try {
      // query present → relevant-memory context (hybrid recall, uses the embedder);
      // absent → static importance/recency blob.
      const result = await buildContext(pool, ctx, maxTokens, query, embedder, reranker);
      return { text: result.text, tokenEstimate: result.tokenEstimate };
    } catch (err) {
      request.log.error({ err }, "/context error");
      return reply.status(500).send({
        error: { code: "INTERNAL", message: "An internal error occurred" },
      });
    }
  });

  // ---------- POST /facts/list ----------
  app.post("/facts/list", async (request, reply): Promise<FactsListResponse | undefined> => {
    const parsed = factsListBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          issues: parsed.error.issues,
        },
      });
    }
    const { workspaceId, userId, category } = parsed.data;
    const ctx: MemoryContext = { workspaceId, userId };
    try {
      const facts = await listFacts(pool, ctx, category);
      return { facts };
    } catch (err) {
      request.log.error({ err }, "/facts/list error");
      return reply.status(500).send({
        error: { code: "INTERNAL", message: "An internal error occurred" },
      });
    }
  });

  // ---------- POST /facts/upsert ----------
  app.post("/facts/upsert", async (request, reply): Promise<FactsUpsertResponse | undefined> => {
    const parsed = factsUpsertBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          issues: parsed.error.issues,
        },
      });
    }
    const { workspaceId, userId, category, key, value, scope } = parsed.data;
    const ctx: MemoryContext = { workspaceId, userId };
    try {
      const fact = await upsertFact(pool, ctx, { category, key, value, scope });
      return { fact };
    } catch (err) {
      request.log.error({ err }, "/facts/upsert error");
      return reply.status(500).send({
        error: { code: "INTERNAL", message: "An internal error occurred" },
      });
    }
  });

  // ---------- POST /ingest ----------
  // Fire-and-forget: respond 202 immediately, extraction runs async.
  // Gracefully handles: extraction disabled, no provider, LLM errors.
  app.post("/ingest", async (request, reply): Promise<IngestResponse | undefined> => {
    const parsed = ingestBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          issues: parsed.error.issues,
        },
      });
    }
    const { workspaceId, userId, text, source } = parsed.data;
    const ctx: MemoryContext = { workspaceId, userId };

    void ingestText(pool, ctx, embedder, text, {
      enabled: config.extractionEnabled,
      source,
    }).catch((err: unknown) => {
      app.log.error({ err }, "ingest background error");
    });

    return reply.status(202).send({ queued: true });
  });

  // ---------- POST /prune ----------
  app.post("/prune", async (request, reply): Promise<PruneResponse | undefined> => {
    const parsed = pruneBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          issues: parsed.error.issues,
        },
      });
    }
    const { workspaceId, userId, dryRun = false } = parsed.data;
    const ctx: MemoryContext = { workspaceId, userId };
    try {
      const { softened, deleted } = await runPrune(pool, ctx, config.decayMode, dryRun);
      return { deleted, softened, dryRun };
    } catch (err) {
      request.log.error({ err }, "/prune error");
      return reply.status(500).send({
        error: { code: "INTERNAL", message: "An internal error occurred" },
      });
    }
  });

  // ---------- GET /metrics ----------
  // Auth-protected when auth is enabled (onRequest hook covers all non-/health routes).
  app.get("/metrics", async (): Promise<MetricsPayload> => {
    const uptimeSec = Math.floor((Date.now() - metricsStartedAt) / 1000);

    // Quick connectivity probe — same pattern as /status.
    let dbConnected = false;
    try {
      const client = await pool.connect();
      try {
        await client.query("SELECT 1");
        dbConnected = true;
      } finally {
        client.release();
      }
    } catch {
      // pool unreachable — report false, don't throw
    }

    const routes: MetricsPayload["routes"] = {};
    for (const [route, m] of metricsRoutes) {
      routes[route] = {
        count: m.count,
        avgMs: m.count > 0 ? Math.round(m.totalMs / m.count) : 0,
      };
    }

    return {
      uptimeSec,
      totalRequests: metricsTotal,
      routes,
      embedder: { ready: true },
      db: { connected: dbConnected },
    };
  });

  return app;
}

// ---------------------------------------------------------------------------
// Start: load embedder once, create pool, bind and listen
// ---------------------------------------------------------------------------

export async function startDaemon(config: DaemonRuntimeConfig): Promise<void> {
  const embedder = createEmbedder(config.embedder, config.embedModel);

  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
  });

  // Superuser pool for /status global counts — reads DATABASE_URL which has
  // BYPASSRLS / superuser privileges, unlike the app pool (dolores_app + RLS).
  const adminUrl = process.env.DATABASE_URL;
  const adminPool = adminUrl
    ? new Pool({ connectionString: adminUrl, max: 3, idleTimeoutMillis: 30_000 })
    : undefined;

  // Create app before embedder.ready() so app.log is available for startup
  // messages. Route handlers only execute after app.listen() returns, by which
  // time embedder.ready() has completed.
  const app = await createApp(pool, embedder, config, adminPool);

  app.log.info({ embedderId: embedder.id }, "loading embedder");
  await embedder.ready();
  app.log.info({ dim: embedder.dim }, "embedder ready");

  setupGracefulShutdown(app, pool, embedder, adminPool);

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    { host: config.host, port: config.port },
    `listening on ${config.host}:${config.port}`,
  );
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

/**
 * Optional capability an Embedder may expose to release native resources (e.g.
 * the onnxruntime InferenceSession behind fastembed) before the process exits.
 * Declared locally so the daemon compiles whether or not `@dolores/core` has
 * added `dispose()` yet; `dispose?.()` is a no-op until core implements it.
 * NOTE: this is a capability mixin, NOT a redefinition of the `Embedder` type.
 */
type MaybeDisposable = { dispose?: () => void | Promise<void> };

function setupGracefulShutdown(
  app: FastifyInstance,
  pool: Pool,
  embedder: Embedder,
  adminPool?: Pool,
): void {
  let stopping = false;

  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;

    app.log.info({ signal }, `${signal} → graceful shutdown…`);

    // Safety valve: if drain genuinely hangs (>30 s), force-exit as a last
    // resort. unref() so it never keeps the loop alive on the happy path.
    const timer = setTimeout(() => {
      app.log.error("shutdown timed out, forcing exit");
      process.exit(1);
    }, 30_000);
    timer.unref();

    void (async () => {
      try {
        // 1. Stop accepting new connections and drain in-flight handlers so any
        //    ongoing embedder/ONNX ops finish before we tear anything down.
        await app.close();
        // 2. Release native embedder resources (onnxruntime session) if the
        //    embedder supports it. No-op until @dolores/core adds dispose().
        await (embedder as Embedder & MaybeDisposable).dispose?.();
        // 3. Close DB pools (app pool first, then admin pool).
        await pool.end();
        if (adminPool) await adminPool.end();

        clearTimeout(timer);
        app.log.info("shutdown complete");

        // Do NOT call process.exit() here. process.exit() force-runs
        // onnxruntime-node's native static destructors while its global thread
        // pool is in an invalid state, aborting with
        // "libc++abi: terminating … mutex lock failed: Invalid argument"
        // (SIGABRT / exit 134). Instead we let the event loop drain on its own:
        // once fastify + pg are closed nothing keeps it alive, so Node exits
        // cleanly with code 0 WITHOUT triggering the native abort.
        process.exitCode = 0;
      } catch (err) {
        clearTimeout(timer);
        app.log.error({ err }, "shutdown error");
        process.exitCode = 1;
        // Abnormal path: force exit so a wedged shutdown can't hang forever.
        process.exit(1);
      }
    })();
  };

  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}
