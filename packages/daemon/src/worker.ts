import {
  type ClaimedIngestJob,
  type Embedder,
  ExtractionError,
  type LlmProvider,
  MIN_INGEST_LEASE_MS,
  claimIngestJob,
  clampIngestLeaseMs,
  completeIngestJob,
  createLlmProviderFromEnv,
  failIngestJob,
  ingestText,
  reclaimExpiredIngestJobs,
  renewIngestJobLease,
} from "@dolores/core";
import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

/**
 * Durable ingest worker (EPIC J). Polls the Postgres-native queue, claims jobs
 * atomically (FOR UPDATE SKIP LOCKED via a SECURITY DEFINER fn), distils each
 * with ingestText (strict mode) under its own tenant, heartbeats the lease while
 * working, and acks done/retry/failed fenced on the claimed attempt.
 * At-least-once: a crash mid-job means the provider may be called again.
 */

interface WorkerDeps {
  pool: Pool;
  embedder: Embedder;
  extractionEnabled: boolean;
  log: FastifyBaseLogger;
  /** undefined = resolve from env once; null = explicitly unavailable. */
  provider?: LlmProvider | null;
}

export interface WorkerTuning {
  count: number;
  pollMs: number;
  maxAttempts: number;
  baseBackoffMs: number;
  leaseMs: number;
  heartbeatMs: number;
  reclaimMs: number;
}

/**
 * Pure tuning resolver (exported for tests). The heartbeat is capped at
 * min(ownLease/2, MIN_INGEST_LEASE_MS/2) = at most 30s, so even a peer worker
 * running with the minimum lease can never reclaim a job we still heartbeat.
 */
export function resolveWorkerTuning(env: NodeJS.ProcessEnv = process.env): WorkerTuning {
  const num = (name: string, def: number, min: number): number => {
    const v = Number(env[name]);
    return Number.isFinite(v) && v >= min ? Math.floor(v) : def;
  };
  // Same clamp as the SQL reclaimer ([60s, int32]) so worker and DB agree and
  // timers cannot overflow. Unset/blank -> default.
  const rawLease = env.DOLORES_INGEST_LEASE_MS;
  const leaseMs = clampIngestLeaseMs(
    rawLease === undefined || rawLease.trim() === "" ? undefined : Number(rawLease),
  );
  const heartbeatMs = Math.min(
    num("DOLORES_INGEST_HEARTBEAT_MS", 30_000, 50),
    Math.floor(leaseMs / 2),
    Math.floor(MIN_INGEST_LEASE_MS / 2),
  );
  return {
    count: num("DOLORES_INGEST_WORKERS", 1, 1),
    pollMs: num("DOLORES_INGEST_POLL_MS", 1000, 50),
    maxAttempts: num("DOLORES_INGEST_MAX_ATTEMPTS", 3, 1),
    baseBackoffMs: num("DOLORES_INGEST_BASE_BACKOFF_MS", 2000, 0),
    leaseMs,
    heartbeatMs,
    reclaimMs: num("DOLORES_INGEST_RECLAIM_MS", 60_000, 1000),
  };
}

export interface IngestWorkerHandle {
  /** Stop claiming, cancel timers, let in-flight jobs finish, then resolve. */
  stop(): Promise<void>;
}

type Timer = ReturnType<typeof setTimeout>;

/** Cancellable sleeps so stop() never waits out a poll/reclaim interval. */
function createSleeper(): { sleep(ms: number): Promise<void>; close(): void } {
  const pending = new Set<{ timer: Timer; resolve: () => void }>();
  let closed = false;
  return {
    sleep(ms: number): Promise<void> {
      if (closed) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const entry = {
          timer: setTimeout(() => {
            pending.delete(entry);
            resolve();
          }, ms),
          resolve,
        };
        pending.add(entry);
      });
    },
    close(): void {
      closed = true;
      for (const e of pending) {
        clearTimeout(e.timer);
        e.resolve();
      }
      pending.clear();
    },
  };
}

/** Non-leaking error descriptor for logs (code/name only, never the message). */
function errCode(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return "unknown";
}

/** Text persisted to last_error (visible via /ingest/status): generic only. */
function safeErrorText(err: unknown): string {
  if (err instanceof ExtractionError) return err.message;
  return "ingest processing failed";
}

/**
 * Start `count` worker loops plus a periodic expired-lease reclaimer. If
 * extraction is disabled or no provider is available the worker PAUSES: it never
 * claims or reclaims, so queued jobs stay pending (not falsely marked done).
 */
export async function startIngestWorkers(deps: WorkerDeps): Promise<IngestWorkerHandle> {
  const tuning = resolveWorkerTuning();
  const provider =
    deps.provider !== undefined
      ? deps.provider
      : deps.extractionEnabled
        ? createLlmProviderFromEnv()
        : null;

  if (!deps.extractionEnabled || !provider) {
    deps.log.warn(
      "ingest worker paused: extraction disabled or no LLM provider configured; jobs stay pending",
    );
    return { stop: async () => undefined };
  }

  const sleeper = createSleeper();
  let stopped = false;

  const reclaim = async (): Promise<void> => {
    try {
      const reclaimed = await reclaimExpiredIngestJobs(deps.pool, tuning.leaseMs);
      if (reclaimed > 0) deps.log.info({ reclaimed }, "ingest worker: reclaimed expired jobs");
    } catch (err) {
      if (err instanceof Error && err.name === "IngestQueueUpgradeRequiredError") {
        deps.log.error(
          "ingest worker: expired-lease reclaim unavailable; run `dolores init --no-docker` to upgrade database functions",
        );
      } else {
        deps.log.error({ code: errCode(err) }, "ingest worker: reclaim failed");
      }
    }
  };

  await reclaim();

  async function loop(): Promise<void> {
    while (!stopped) {
      let job: ClaimedIngestJob | null;
      try {
        job = await claimIngestJob(deps.pool);
      } catch (err) {
        deps.log.error({ code: errCode(err) }, "ingest worker: claim failed");
        await sleeper.sleep(tuning.pollMs);
        continue;
      }
      if (!job) {
        await sleeper.sleep(tuning.pollMs);
        continue;
      }
      await processJob(deps, tuning, provider as LlmProvider, job);
    }
  }

  async function reclaimLoop(): Promise<void> {
    while (!stopped) {
      await sleeper.sleep(tuning.reclaimMs);
      if (stopped) break;
      await reclaim();
    }
  }

  const loops = Array.from({ length: tuning.count }, () => loop());
  loops.push(reclaimLoop());
  deps.log.info(
    { workers: tuning.count, pollMs: tuning.pollMs, leaseMs: tuning.leaseMs },
    "ingest workers started",
  );

  return {
    stop: async () => {
      stopped = true;
      sleeper.close();
      await Promise.all(loops);
    },
  };
}

async function processJob(
  deps: WorkerDeps,
  tuning: WorkerTuning,
  provider: LlmProvider,
  job: ClaimedIngestJob,
): Promise<void> {
  const ctx = { workspaceId: job.workspaceId, userId: job.userId };
  const fence = job.attempts;

  let inflight: Promise<void> | null = null;
  const heartbeat = setInterval(() => {
    if (inflight) return;
    inflight = renewIngestJobLease(deps.pool, ctx, job.id, fence)
      .then((ok) => {
        if (!ok) {
          deps.log.warn({ jobId: job.id, attempt: fence }, "ingest worker: lease lost");
        }
      })
      .catch((err: unknown) => {
        deps.log.warn({ jobId: job.id, code: errCode(err) }, "ingest worker: lease renewal failed");
      })
      .finally(() => {
        inflight = null;
      });
  }, tuning.heartbeatMs);

  let failure: { err: unknown } | null = null;
  try {
    await ingestText(deps.pool, ctx, deps.embedder, job.payload, {
      enabled: true,
      strict: true,
      provider,
      source: job.source ?? undefined,
    });
  } catch (err) {
    failure = { err };
  } finally {
    clearInterval(heartbeat);
    const pendingRenewal: Promise<void> | null = inflight;
    if (pendingRenewal) await pendingRenewal;
  }

  if (!failure) {
    try {
      const acked = await completeIngestJob(deps.pool, ctx, job.id, fence);
      if (!acked) {
        deps.log.warn({ jobId: job.id, attempt: fence }, "ingest worker: stale completion ignored");
      }
    } catch (err) {
      // Row stays 'running'; the expired-lease reclaimer will retry it later.
      deps.log.error(
        { jobId: job.id, code: errCode(err) },
        "ingest worker: could not complete job",
      );
    }
    return;
  }

  // `attempts` already includes this run; retry until it reaches maxAttempts.
  const retry = job.attempts < tuning.maxAttempts;
  const backoffMs = retry ? tuning.baseBackoffMs * 2 ** (job.attempts - 1) : 0;
  deps.log.warn(
    { jobId: job.id, attempts: job.attempts, retry, code: errCode(failure.err) },
    "ingest job failed",
  );
  try {
    const acked = await failIngestJob(deps.pool, ctx, job.id, {
      error: safeErrorText(failure.err),
      retry,
      backoffMs,
      attempt: fence,
    });
    if (!acked) {
      deps.log.warn({ jobId: job.id, attempt: fence }, "ingest worker: stale failure ack ignored");
    }
  } catch (err) {
    deps.log.error(
      { jobId: job.id, code: errCode(err) },
      "ingest worker: could not record failure",
    );
  }
}
