import type { Pool } from "pg";
import { toIso } from "../retrieval/sql.js";
import { withTenant } from "../retrieval/tenant.js";
import type { IngestJobStatus, IngestStatusResponse, MemoryContext } from "../types.js";

/**
 * Durable ingest queue data-access (EPIC J). The daemon worker orchestrates these;
 * extraction itself (ingestText) lives in ../extraction. Cross-tenant claim/reclaim
 * go through SECURITY DEFINER functions (RLS-bypassing, like the decay jobs);
 * everything else is tenant-scoped via withTenant.
 *
 * Leases: no extra columns. A 'running' row's updated_at is its lease timestamp;
 * the worker heartbeats it (renewIngestJobLease) and reclamation only resets rows
 * whose lease expired. Acks/renewals are FENCED on (status='running', attempts =
 * claimed attempt) so a stale worker can never ack a newer re-claimed attempt.
 * Delivery is at-least-once: after a crash the provider may be called again.
 */

/** Default lease: a running job with no heartbeat for this long is reclaimable. */
export const DEFAULT_INGEST_LEASE_MS = 300_000;
/** Lower clamp for any lease passed to reclamation (also enforced in SQL). */
export const MIN_INGEST_LEASE_MS = 60_000;
const MAX_INT32 = 2_147_483_647;

/** Thrown when the database lacks the safe reclaim function (pre-upgrade schema). */
export class IngestQueueUpgradeRequiredError extends Error {
  constructor() {
    super(
      "ingest queue: SQL function dolores_reclaim_expired_ingest_jobs(int) is missing; " +
        "run `dolores init --no-docker` to upgrade database functions",
    );
    this.name = "IngestQueueUpgradeRequiredError";
  }
}

/** Clamp a lease to [MIN_INGEST_LEASE_MS, int32]; non-finite -> default. */
export function clampIngestLeaseMs(ms?: number): number {
  const v =
    typeof ms === "number" && Number.isFinite(ms) ? Math.floor(ms) : DEFAULT_INGEST_LEASE_MS;
  return Math.min(Math.max(v, MIN_INGEST_LEASE_MS), MAX_INT32);
}

/** A job claimed by the worker — carries its own tenant identity + payload. */
export interface ClaimedIngestJob {
  id: string;
  workspaceId: string;
  userId: string | null;
  payload: string;
  source: string | null;
  /** attempt number (already incremented by the claim) — the ack fence. */
  attempts: number;
}

/** Enqueue raw text for async distillation. Returns the new job id. RLS-scoped. */
export async function enqueueIngestJob(
  pool: Pool,
  ctx: MemoryContext,
  input: { text: string; source?: string },
): Promise<string> {
  return withTenant(pool, ctx, async (client) => {
    const res = await client.query<{ id: string }>(
      `INSERT INTO ingest_jobs (workspace_id, user_id, payload, source)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [ctx.workspaceId, ctx.userId ?? null, input.text, input.source ?? null],
    );
    const id = res.rows[0]?.id;
    if (!id) throw new Error("enqueueIngestJob: insert returned no id");
    return id;
  });
}

interface ClaimRow {
  id: string;
  workspace_id: string;
  user_id: string | null;
  payload: string | null;
  source: string | null;
  attempts: number;
}

/**
 * Claim the next runnable job ACROSS tenants via the SECURITY DEFINER function
 * (FOR UPDATE SKIP LOCKED -> many workers pull distinct jobs). Returns null when
 * nothing is runnable.
 */
export async function claimIngestJob(pool: Pool): Promise<ClaimedIngestJob | null> {
  const res = await pool.query<ClaimRow>("SELECT * FROM dolores_claim_ingest_job()");
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    payload: row.payload ?? "",
    source: row.source,
    attempts: row.attempts,
  };
}

/**
 * Mark a job done and PURGE its payload (rule 1). Runs under the job's tenant.
 * With `attempt`, the update is fenced to the still-running claimed attempt;
 * without it (legacy callers) it is unconditional by id and returns void.
 * A fenced call returns true when updated, false when stale/fenced-out.
 */
export function completeIngestJob(pool: Pool, ctx: MemoryContext, jobId: string): Promise<void>;
export function completeIngestJob(
  pool: Pool,
  ctx: MemoryContext,
  jobId: string,
  attempt: number,
): Promise<boolean>;
export function completeIngestJob(
  pool: Pool,
  ctx: MemoryContext,
  jobId: string,
  attempt?: number,
  // biome-ignore lint/suspicious/noConfusingVoidType: legacy void overload compatibility
): Promise<boolean | void>;
export async function completeIngestJob(
  pool: Pool,
  ctx: MemoryContext,
  jobId: string,
  attempt?: number,
  // biome-ignore lint/suspicious/noConfusingVoidType: legacy void overload compatibility
): Promise<boolean | void> {
  const ok = await withTenant(pool, ctx, async (client) => {
    const res =
      attempt === undefined
        ? await client.query(
            "UPDATE ingest_jobs SET status = 'done', payload = NULL, updated_at = now() WHERE id = $1",
            [jobId],
          )
        : await client.query(
            `UPDATE ingest_jobs SET status = 'done', payload = NULL, updated_at = now()
              WHERE id = $1 AND status = 'running' AND attempts = $2`,
            [jobId, attempt],
          );
    return (res.rowCount ?? 0) > 0;
  });
  return attempt === undefined ? undefined : ok;
}

/** Options for failIngestJob; `attempt` present = fenced ack returning boolean. */
export interface FailIngestJobOptions {
  error: string;
  retry: boolean;
  backoffMs?: number;
  attempt?: number;
}

/**
 * Record a failure. `retry` -> back to 'pending' with a backoff (payload kept for
 * the next attempt); terminal -> 'failed' and payload PURGED. Tenant-scoped.
 * `attempt` fences like completeIngestJob and returns whether a row was updated.
 * Legacy calls without an attempt retain their void return value.
 */
export function failIngestJob(
  pool: Pool,
  ctx: MemoryContext,
  jobId: string,
  opts: { error: string; retry: boolean; backoffMs?: number; attempt?: undefined },
): Promise<void>;
export function failIngestJob(
  pool: Pool,
  ctx: MemoryContext,
  jobId: string,
  opts: { error: string; retry: boolean; backoffMs?: number; attempt: number },
): Promise<boolean>;
export function failIngestJob(
  pool: Pool,
  ctx: MemoryContext,
  jobId: string,
  opts: FailIngestJobOptions,
  // biome-ignore lint/suspicious/noConfusingVoidType: legacy void overload compatibility
): Promise<boolean | void>;
export async function failIngestJob(
  pool: Pool,
  ctx: MemoryContext,
  jobId: string,
  opts: FailIngestJobOptions,
  // biome-ignore lint/suspicious/noConfusingVoidType: legacy void overload compatibility
): Promise<boolean | void> {
  const ok = await withTenant(pool, ctx, async (client) => {
    const fenced = opts.attempt !== undefined;
    if (opts.retry) {
      const backoff = String(Math.max(0, Math.floor(opts.backoffMs ?? 0)));
      const params: unknown[] = [jobId, opts.error, backoff];
      if (fenced) params.push(opts.attempt);
      const res = await client.query(
        `UPDATE ingest_jobs
            SET status = 'pending', last_error = $2, updated_at = now(),
                run_after = now() + ($3 || ' milliseconds')::interval
          WHERE id = $1${fenced ? " AND status = 'running' AND attempts = $4" : ""}`,
        params,
      );
      return (res.rowCount ?? 0) > 0;
    }
    const params: unknown[] = [jobId, opts.error];
    if (fenced) params.push(opts.attempt);
    const res = await client.query(
      `UPDATE ingest_jobs
          SET status = 'failed', last_error = $2, payload = NULL, updated_at = now()
        WHERE id = $1${fenced ? " AND status = 'running' AND attempts = $3" : ""}`,
      params,
    );
    return (res.rowCount ?? 0) > 0;
  });
  return opts.attempt === undefined ? undefined : ok;
}

/**
 * Heartbeat: extend the lease of a job this worker still owns. Tenant-scoped and
 * fenced on (status='running', attempts=attempt). Returns false when the lease
 * was lost (reclaimed and/or re-claimed by another worker, or finished).
 */
export async function renewIngestJobLease(
  pool: Pool,
  ctx: MemoryContext,
  jobId: string,
  attempt: number,
): Promise<boolean> {
  return withTenant(pool, ctx, async (client) => {
    const res = await client.query(
      `UPDATE ingest_jobs SET updated_at = now()
        WHERE id = $1 AND status = 'running' AND attempts = $2`,
      [jobId, attempt],
    );
    return (res.rowCount ?? 0) > 0;
  });
}

interface StatusRow {
  id: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Fetch a job's status (tenant-scoped). null = not visible to this tenant / gone. */
export async function getIngestJobStatus(
  pool: Pool,
  ctx: MemoryContext,
  jobId: string,
): Promise<IngestStatusResponse | null> {
  return withTenant(pool, ctx, async (client) => {
    const res = await client.query<StatusRow>(
      "SELECT id, status, attempts, last_error, created_at, updated_at FROM ingest_jobs WHERE id = $1",
      [jobId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      status: row.status as IngestJobStatus,
      attempts: row.attempts,
      lastError: row.last_error,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  });
}

function isUndefinedFunction(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "42883";
}

/**
 * Reclaim EXPIRED running jobs (lease older than leaseMs, clamped >= 60s) back to
 * 'pending'. Live heartbeating jobs are never touched. Calls ONLY the safe
 * dolores_reclaim_expired_ingest_jobs(int); if it is missing (database not
 * re-initialised) this fails closed with IngestQueueUpgradeRequiredError and
 * NEVER falls back to the legacy zero-arg function. Returns count reclaimed.
 */
export async function reclaimExpiredIngestJobs(pool: Pool, leaseMs?: number): Promise<number> {
  try {
    const res = await pool.query<{ n: number | null }>(
      "SELECT dolores_reclaim_expired_ingest_jobs($1::int) AS n",
      [clampIngestLeaseMs(leaseMs)],
    );
    return Number(res.rows[0]?.n ?? 0);
  } catch (err) {
    if (isUndefinedFunction(err)) throw new IngestQueueUpgradeRequiredError();
    throw err;
  }
}

/**
 * @deprecated Use reclaimExpiredIngestJobs. Kept for compatibility; now uses the
 * safe expired-lease semantics (default 5 min lease), never the legacy SQL.
 */
export async function reclaimRunningIngestJobs(pool: Pool): Promise<number> {
  return reclaimExpiredIngestJobs(pool);
}
