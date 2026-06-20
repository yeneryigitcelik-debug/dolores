import {
  type ContextResponse,
  type DaemonConfig,
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
  ingestText,
  listFacts,
  recall,
  remember,
  upsertFact,
  withTenant,
} from "@dolores/core";
import Fastify, { type FastifyInstance, type FastifyError } from "fastify";
import { Pool } from "pg";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod schemas for request bodies
// ---------------------------------------------------------------------------

const scopeSchema = z.enum(["personal", "workspace"]);

const ctxSchema = z.object({
  workspaceId: z.string().uuid("workspaceId must be a UUID"),
  userId: z.string().uuid().nullable().optional(),
});

const rememberBodySchema = ctxSchema.extend({
  content: z.string().min(1, "content must be non-empty"),
  scope: scopeSchema.optional(),
  importance: z.number().int().min(1).max(10).optional(),
  source: z.string().optional(),
});

const recallBodySchema = ctxSchema.extend({
  query: z.string().min(1, "query must be non-empty"),
  limit: z.number().int().min(1).max(100).optional(),
  scope: scopeSchema.optional(),
  minImportance: z.number().int().min(1).max(10).optional(),
});

const contextBodySchema = ctxSchema.extend({
  maxTokens: z.number().int().min(1).optional(),
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
  text: z.string().min(1, "text must be non-empty"),
  source: z.string().optional(),
});

const pruneBodySchema = ctxSchema.extend({
  dryRun: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Prune helper (not in @dolores/core — daemon-only logic)
// ---------------------------------------------------------------------------

async function runConservativePrune(
  pool: Pool,
  ctx: MemoryContext,
  dryRun: boolean,
): Promise<{ softened: number; deleted: number }> {
  let softened = 0;
  let deleted = 0;

  await withTenant(pool, ctx, async (client) => {
    if (dryRun) {
      const [softenRes, deleteRes] = await Promise.all([
        client.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM memories
           WHERE last_accessed < NOW() - INTERVAL '30 days' AND importance > 1`,
        ),
        client.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM memories
           WHERE last_accessed < NOW() - INTERVAL '90 days' AND importance < 3`,
        ),
      ]);
      softened = Number.parseInt(softenRes.rows[0]?.count ?? "0", 10);
      deleted = Number.parseInt(deleteRes.rows[0]?.count ?? "0", 10);
    } else {
      const softenRes = await client.query(
        `UPDATE memories
           SET importance = GREATEST(1, importance - 1)
         WHERE last_accessed < NOW() - INTERVAL '30 days' AND importance > 1`,
      );
      const deleteRes = await client.query(
        `DELETE FROM memories
         WHERE last_accessed < NOW() - INTERVAL '90 days' AND importance < 3`,
      );
      softened = softenRes.rowCount ?? 0;
      deleted = deleteRes.rowCount ?? 0;
    }
  });

  return { softened, deleted };
}

// ---------------------------------------------------------------------------
// App factory (testable without binding to a port)
// ---------------------------------------------------------------------------

export async function createApp(
  pool: Pool,
  embedder: Embedder,
  config: DaemonConfig,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // ---------- Global error handler ----------
  app.setErrorHandler(async (error: FastifyError, _req, reply) => {
    // JSON parse errors from malformed request bodies
    if ((error.statusCode ?? 500) < 500) {
      return reply
        .status(error.statusCode ?? 400)
        .send({ error: { code: "PARSE_ERROR", message: error.message } });
    }
    console.error("[dolores-daemon] unhandled error:", error.message);
    return reply
      .status(500)
      .send({ error: { code: "INTERNAL_ERROR", message: "An internal error occurred" } });
  });

  // ---------- GET /health ----------
  app.get("/health", async (): Promise<HealthResponse> => {
    return { ok: true };
  });

  // ---------- GET /status ----------
  app.get("/status", async (): Promise<StatusResponse> => {
    let connected = false;
    let memories = 0;
    let facts = 0;

    try {
      const client = await pool.connect();
      try {
        await client.query("SELECT 1");
        connected = true;
        // Counts via raw client (no GUC → RLS returns 0, but confirms tables exist)
        const [mr, fr] = await Promise.all([
          client.query<{ count: string }>("SELECT COUNT(*) AS count FROM memories"),
          client.query<{ count: string }>("SELECT COUNT(*) AS count FROM facts"),
        ]);
        memories = Number.parseInt(mr.rows[0]?.count ?? "0", 10);
        facts = Number.parseInt(fr.rows[0]?.count ?? "0", 10);
      } finally {
        client.release();
      }
    } catch {
      connected = false;
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
      return reply
        .status(400)
        .send({ error: { code: "VALIDATION_ERROR", issues: parsed.error.issues } });
    }
    const { workspaceId, userId, content, scope, importance, source } = parsed.data;
    const ctx: MemoryContext = { workspaceId, userId };
    try {
      return await remember(pool, ctx, embedder, { content, scope, importance, source });
    } catch (err) {
      return reply.status(500).send({
        error: { code: "INTERNAL_ERROR", message: errMsg(err) },
      });
    }
  });

  // ---------- POST /recall ----------
  app.post("/recall", async (request, reply): Promise<RecallResponse | undefined> => {
    const parsed = recallBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: { code: "VALIDATION_ERROR", issues: parsed.error.issues } });
    }
    const { workspaceId, userId, query, limit, scope, minImportance } = parsed.data;
    const ctx: MemoryContext = { workspaceId, userId };
    try {
      return await recall(pool, ctx, embedder, { query, limit, scope, minImportance });
    } catch (err) {
      return reply.status(500).send({
        error: { code: "INTERNAL_ERROR", message: errMsg(err) },
      });
    }
  });

  // ---------- POST /context ----------
  app.post("/context", async (request, reply): Promise<ContextResponse | undefined> => {
    const parsed = contextBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: { code: "VALIDATION_ERROR", issues: parsed.error.issues } });
    }
    const { workspaceId, userId, maxTokens } = parsed.data;
    const ctx: MemoryContext = { workspaceId, userId };
    try {
      const result = await buildContext(pool, ctx, maxTokens);
      return { text: result.text, tokenEstimate: result.tokenEstimate };
    } catch (err) {
      return reply.status(500).send({
        error: { code: "INTERNAL_ERROR", message: errMsg(err) },
      });
    }
  });

  // ---------- POST /facts/list ----------
  app.post("/facts/list", async (request, reply): Promise<FactsListResponse | undefined> => {
    const parsed = factsListBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: { code: "VALIDATION_ERROR", issues: parsed.error.issues } });
    }
    const { workspaceId, userId, category } = parsed.data;
    const ctx: MemoryContext = { workspaceId, userId };
    try {
      const facts = await listFacts(pool, ctx, category);
      return { facts };
    } catch (err) {
      return reply.status(500).send({
        error: { code: "INTERNAL_ERROR", message: errMsg(err) },
      });
    }
  });

  // ---------- POST /facts/upsert ----------
  app.post("/facts/upsert", async (request, reply): Promise<FactsUpsertResponse | undefined> => {
    const parsed = factsUpsertBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: { code: "VALIDATION_ERROR", issues: parsed.error.issues } });
    }
    const { workspaceId, userId, category, key, value, scope } = parsed.data;
    const ctx: MemoryContext = { workspaceId, userId };
    try {
      const fact = await upsertFact(pool, ctx, { category, key, value, scope });
      return { fact };
    } catch (err) {
      return reply.status(500).send({
        error: { code: "INTERNAL_ERROR", message: errMsg(err) },
      });
    }
  });

  // ---------- POST /ingest ----------
  // Fire-and-forget: respond immediately, extraction runs async.
  // Gracefully handles: extraction disabled, no provider, LLM errors.
  app.post("/ingest", async (request, reply): Promise<IngestResponse | undefined> => {
    const parsed = ingestBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: { code: "VALIDATION_ERROR", issues: parsed.error.issues } });
    }
    const { workspaceId, userId, text, source } = parsed.data;
    const ctx: MemoryContext = { workspaceId, userId };

    void ingestText(pool, ctx, embedder, text, {
      enabled: config.extractionEnabled,
      source,
    }).catch((err: unknown) => {
      console.error("[dolores-daemon] ingest background error:", errMsg(err));
    });

    return { queued: true };
  });

  // ---------- POST /prune ----------
  app.post("/prune", async (request, reply): Promise<PruneResponse | undefined> => {
    const parsed = pruneBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: { code: "VALIDATION_ERROR", issues: parsed.error.issues } });
    }
    const { workspaceId, userId, dryRun = false } = parsed.data;
    const ctx: MemoryContext = { workspaceId, userId };
    try {
      const { softened, deleted } = await runConservativePrune(pool, ctx, dryRun);
      return { deleted, softened, dryRun };
    } catch (err) {
      return reply.status(500).send({
        error: { code: "INTERNAL_ERROR", message: errMsg(err) },
      });
    }
  });

  return app;
}

// ---------------------------------------------------------------------------
// Start: load embedder once, create pool, bind and listen
// ---------------------------------------------------------------------------

export async function startDaemon(config: DaemonConfig): Promise<void> {
  const embedder = createEmbedder(config.embedder, config.embedModel);

  console.log(`[dolores-daemon] loading embedder ${embedder.id}...`);
  await embedder.ready();
  console.log(`[dolores-daemon] embedder ready (dim=${embedder.dim})`);

  const pool = new Pool({ connectionString: config.databaseUrl });

  const app = await createApp(pool, embedder, config);

  setupGracefulShutdown(app, pool, embedder);

  await app.listen({ port: config.port, host: config.host });
  console.log(`[dolores-daemon] listening on ${config.host}:${config.port}`);
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

function setupGracefulShutdown(app: FastifyInstance, pool: Pool, embedder: Embedder): void {
  let stopping = false;

  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;

    console.log(`[dolores-daemon] ${signal} → graceful shutdown…`);

    // Safety valve: if drain genuinely hangs (>30 s), force-exit as a last
    // resort. unref() so it never keeps the loop alive on the happy path.
    const timer = setTimeout(() => {
      console.error("[dolores-daemon] shutdown timed out, forcing exit");
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
        // 3. Close the DB pool.
        await pool.end();

        clearTimeout(timer);
        console.log("[dolores-daemon] shutdown complete");

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
        console.error("[dolores-daemon] shutdown error:", errMsg(err));
        process.exitCode = 1;
        // Abnormal path: force exit so a wedged shutdown can't hang forever.
        process.exit(1);
      }
    })();
  };

  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

// ---------------------------------------------------------------------------
// Util
// ---------------------------------------------------------------------------

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
