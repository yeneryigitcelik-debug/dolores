import type { Pool } from "pg";
import { toIso } from "../retrieval/sql.js";
import { withTenant } from "../retrieval/tenant.js";
import type { IngestJobStatus, IngestStatusResponse, MemoryContext } from "../types.js";

/**
 * Durable ingest queue data-access (EPIC J). The daemon worker orchestrates these;
 * extraction itself (ingestText) lives in ../extraction. Cross-tenant claim/reclaim
 * go through SECURITY DEFINER functions (RLS-bypassing, like the decay jobs);
 * everything else is tenant-scoped via withTenant.
 */

/** A job claimed by the worker — carries its own tenant identity + payload. */
export interface ClaimedIngestJob {
  id: string;
  workspaceId: string;
  userId: string | null;
  payload: string;
  source: string | null;
  /** attempt number (already incremented by the claim). */
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
 * (FOR UPDATE SKIP LOCKED → many workers pull distinct jobs). Plain pool query,
 * no tenant GUC; the function bypasses RLS. Returns null when nothing is runnable.
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

/** Mark a job done and PURGE its payload (rule 1). Runs under the job's tenant. */
export async function completeIngestJob(
  pool: Pool,
  ctx: MemoryContext,
  jobId: string,
): Promise<void> {
  await withTenant(pool, ctx, async (client) => {
    await client.query(
      "UPDATE ingest_jobs SET status = 'done', payload = NULL, updated_at = now() WHERE id = $1",
      [jobId],
    );
  });
}

/**
 * Record a failure. `retry` → back to 'pending' with a backoff (payload kept for
 * the next attempt); terminal → 'failed' and payload PURGED. Tenant-scoped.
 */
export async function failIngestJob(
  pool: Pool,
  ctx: MemoryContext,
  jobId: string,
  opts: { error: string; retry: boolean; backoffMs?: number },
): Promise<void> {
  await withTenant(pool, ctx, async (client) => {
    if (opts.retry) {
      const backoff = String(Math.max(0, Math.floor(opts.backoffMs ?? 0)));
      await client.query(
        `UPDATE ingest_jobs
            SET status = 'pending', last_error = $2, updated_at = now(),
                run_after = now() + ($3 || ' milliseconds')::interval
          WHERE id = $1`,
        [jobId, opts.error, backoff],
      );
    } else {
      await client.query(
        `UPDATE ingest_jobs
            SET status = 'failed', last_error = $2, payload = NULL, updated_at = now()
          WHERE id = $1`,
        [jobId, opts.error],
      );
    }
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

/** Reclaim jobs stuck in 'running' from a crashed run → 'pending'. Returns count. */
export async function reclaimRunningIngestJobs(pool: Pool): Promise<number> {
  const res = await pool.query<{ dolores_reclaim_ingest_jobs: number }>(
    "SELECT dolores_reclaim_ingest_jobs()",
  );
  return res.rows[0]?.dolores_reclaim_ingest_jobs ?? 0;
}
