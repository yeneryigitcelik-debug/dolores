import {
  type ClaimedIngestJob,
  type Embedder,
  claimIngestJob,
  completeIngestJob,
  failIngestJob,
  ingestText,
  reclaimRunningIngestJobs,
} from "@dolores/core";
import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

/**
 * Durable ingest worker (EPIC J). Polls the Postgres-native queue, claims jobs
 * atomically (FOR UPDATE SKIP LOCKED via a SECURITY DEFINER fn), distils each
 * with ingestText under its own tenant, and marks it done (payload purged) or
 * retried/failed. Off the critical path — recall/context never touch this.
 */

interface WorkerDeps {
  pool: Pool;
  embedder: Embedder;
  extractionEnabled: boolean;
  log: FastifyBaseLogger;
}

interface WorkerTuning {
  count: number;
  pollMs: number;
  maxAttempts: number;
  baseBackoffMs: number;
}

function resolveWorkerTuning(): WorkerTuning {
  const num = (name: string, def: number, min: number): number => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v >= min ? Math.floor(v) : def;
  };
  return {
    count: num("DOLORES_INGEST_WORKERS", 1, 1),
    pollMs: num("DOLORES_INGEST_POLL_MS", 1000, 50),
    maxAttempts: num("DOLORES_INGEST_MAX_ATTEMPTS", 3, 1),
    baseBackoffMs: 2000,
  };
}

export interface IngestWorkerHandle {
  /** Stop claiming and let in-flight jobs finish, then resolve. */
  stop(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Start `count` worker loops. Reclaims jobs stuck in 'running' from a crashed run
 * first. Returns a handle whose stop() flips the flag and awaits the loops, so a
 * job mid-distillation finishes before shutdown tears down the pool/embedder.
 */
export async function startIngestWorkers(deps: WorkerDeps): Promise<IngestWorkerHandle> {
  const tuning = resolveWorkerTuning();

  try {
    const reclaimed = await reclaimRunningIngestJobs(deps.pool);
    if (reclaimed > 0) deps.log.info({ reclaimed }, "ingest worker: reclaimed stuck jobs");
  } catch (err) {
    deps.log.error({ err }, "ingest worker: reclaim failed");
  }

  let stopped = false;

  async function loop(): Promise<void> {
    while (!stopped) {
      let job: ClaimedIngestJob | null;
      try {
        job = await claimIngestJob(deps.pool);
      } catch (err) {
        deps.log.error({ err }, "ingest worker: claim failed");
        await sleep(tuning.pollMs);
        continue;
      }
      if (!job) {
        await sleep(tuning.pollMs);
        continue;
      }
      await processJob(deps, tuning, job);
    }
  }

  const loops = Array.from({ length: tuning.count }, () => loop());
  deps.log.info({ workers: tuning.count, pollMs: tuning.pollMs }, "ingest workers started");

  return {
    stop: async () => {
      stopped = true;
      await Promise.all(loops);
    },
  };
}

async function processJob(
  deps: WorkerDeps,
  tuning: WorkerTuning,
  job: ClaimedIngestJob,
): Promise<void> {
  const ctx = { workspaceId: job.workspaceId, userId: job.userId };
  try {
    await ingestText(deps.pool, ctx, deps.embedder, job.payload, {
      enabled: deps.extractionEnabled,
      source: job.source ?? undefined,
    });
    await completeIngestJob(deps.pool, ctx, job.id);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // `attempts` already includes this run; retry until it reaches maxAttempts.
    const retry = job.attempts < tuning.maxAttempts;
    const backoffMs = retry ? tuning.baseBackoffMs * 2 ** (job.attempts - 1) : 0;
    deps.log.warn({ jobId: job.id, attempts: job.attempts, retry }, "ingest job failed");
    await failIngestJob(deps.pool, ctx, job.id, { error, retry, backoffMs }).catch((e) => {
      deps.log.error({ err: e, jobId: job.id }, "ingest worker: could not record failure");
    });
  }
}
