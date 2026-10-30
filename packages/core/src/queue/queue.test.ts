import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MemoryContext } from "../types.js";
import {
  DEFAULT_INGEST_LEASE_MS,
  IngestQueueUpgradeRequiredError,
  MIN_INGEST_LEASE_MS,
  claimIngestJob,
  clampIngestLeaseMs,
  completeIngestJob,
  enqueueIngestJob,
  failIngestJob,
  getIngestJobStatus,
  reclaimExpiredIngestJobs,
  reclaimRunningIngestJobs,
  renewIngestJobLease,
} from "./jobs.js";

// NOTE: these tests DELETE THE WHOLE ingest_jobs TABLE — run only against an
// isolated test database with no live daemon/worker attached.
const APP_URL = process.env.DOLORES_APP_DATABASE_URL ?? "";
const ADMIN_URL = process.env.DATABASE_URL ?? "";
const liveDescribe = APP_URL && ADMIN_URL ? describe : describe.skip;

const QUEUE_WS = "00000000-0000-0000-0000-0000000a0001";
const QUEUE_WS2 = "00000000-0000-0000-0000-0000000a0002";

interface RecordedQuery {
  text: string;
  values: unknown[] | undefined;
}

/** Minimal no-DB fake: every query rejects with `err` and is recorded. */
function failingPool(err: unknown): { pool: pg.Pool; calls: RecordedQuery[] } {
  const calls: RecordedQuery[] = [];
  const fake = {
    query: async (text: string, values?: unknown[]): Promise<never> => {
      calls.push({ text, values });
      throw err;
    },
  };
  return { pool: fake as unknown as pg.Pool, calls };
}

describe("ingest queue helpers (no DB)", () => {
  const undefinedFunction = Object.assign(new Error("function does not exist"), {
    code: "42883",
  });

  it("fails closed with IngestQueueUpgradeRequiredError on a pre-upgrade schema", async () => {
    const { pool, calls } = failingPool(undefinedFunction);
    await expect(reclaimExpiredIngestJobs(pool, 120_000)).rejects.toBeInstanceOf(
      IngestQueueUpgradeRequiredError,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("dolores_reclaim_expired_ingest_jobs($1::int)");
    expect(calls[0]?.text).not.toMatch(/dolores_reclaim_ingest_jobs\s*\(/);
    expect(calls[0]?.values).toEqual([120_000]);
  });

  it("the deprecated helper never falls back to the legacy zero-arg function", async () => {
    const { pool, calls } = failingPool(undefinedFunction);
    await expect(reclaimRunningIngestJobs(pool)).rejects.toBeInstanceOf(
      IngestQueueUpgradeRequiredError,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("dolores_reclaim_expired_ingest_jobs($1::int)");
    expect(calls[0]?.text).not.toMatch(/dolores_reclaim_ingest_jobs\s*\(/);
    expect(calls[0]?.values).toEqual([DEFAULT_INGEST_LEASE_MS]);
  });

  it("rethrows other database errors unchanged", async () => {
    const other = Object.assign(new Error("connection reset"), { code: "08006" });
    const { pool, calls } = failingPool(other);
    await expect(reclaimExpiredIngestJobs(pool)).rejects.toBe(other);
    expect(calls).toHaveLength(1);
  });

  it("clampIngestLeaseMs clamps to [60s, int32] and defaults non-finite input", () => {
    expect(clampIngestLeaseMs()).toBe(DEFAULT_INGEST_LEASE_MS);
    expect(clampIngestLeaseMs(Number.NaN)).toBe(DEFAULT_INGEST_LEASE_MS);
    expect(clampIngestLeaseMs(Number.POSITIVE_INFINITY)).toBe(DEFAULT_INGEST_LEASE_MS);
    expect(clampIngestLeaseMs(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_INGEST_LEASE_MS);
    expect(clampIngestLeaseMs(1)).toBe(MIN_INGEST_LEASE_MS);
    expect(clampIngestLeaseMs(-5)).toBe(MIN_INGEST_LEASE_MS);
    expect(clampIngestLeaseMs(90_000.7)).toBe(90_000);
    expect(clampIngestLeaseMs(1e12)).toBe(2_147_483_647);
  });
});

interface JobRow {
  status: string;
  payload: string | null;
  attempts: number;
  last_error: string | null;
}

liveDescribe("ingest queue (live DB)", () => {
  let pool: pg.Pool;
  let admin: pg.Pool;
  const ctx: MemoryContext = { workspaceId: QUEUE_WS, userId: null };

  const jobRow = async (id: string): Promise<JobRow | undefined> => {
    const res = await admin.query<JobRow>(
      "SELECT status, payload, attempts, last_error FROM ingest_jobs WHERE id = $1",
      [id],
    );
    return res.rows[0];
  };

  /** Age a job's lease without waiting (admin bypasses RLS). */
  const backdate = async (id: string, interval: string): Promise<void> => {
    await admin.query("UPDATE ingest_jobs SET updated_at = now() - $2::interval WHERE id = $1", [
      id,
      interval,
    ]);
  };

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: APP_URL, max: 5 });
    admin = new pg.Pool({ connectionString: ADMIN_URL, max: 3 });
  });

  beforeEach(async () => {
    await admin.query("DELETE FROM ingest_jobs");
  });

  afterEach(async () => {
    await admin.query("DELETE FROM ingest_jobs");
  });

  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  it("enqueue creates a pending job with the payload", async () => {
    const id = await enqueueIngestJob(pool, ctx, { text: "distil me", source: "conv-1" });
    const status = await getIngestJobStatus(pool, ctx, id);
    expect(status?.status).toBe("pending");
    expect(status?.attempts).toBe(0);
    expect((await jobRow(id))?.payload).toBe("distil me");
  });

  it("claim marks the job running, bumps attempts, and is exhausted after", async () => {
    const id = await enqueueIngestJob(pool, ctx, { text: "claim me" });
    const claimed = await claimIngestJob(pool);
    expect(claimed?.id).toBe(id);
    expect(claimed?.payload).toBe("claim me");
    expect(claimed?.attempts).toBe(1);
    expect((await jobRow(id))?.status).toBe("running");
    expect(await claimIngestJob(pool)).toBeNull();
  });

  it("complete (fenced) marks done and PURGES the payload (rule 1)", async () => {
    const id = await enqueueIngestJob(pool, ctx, { text: "secret transcript" });
    const claimed = await claimIngestJob(pool);
    expect(await completeIngestJob(pool, ctx, id, claimed?.attempts)).toBe(true);
    const row = await jobRow(id);
    expect(row?.status).toBe("done");
    expect(row?.payload).toBeNull();
  });

  it("legacy unfenced complete still works", async () => {
    const id = await enqueueIngestJob(pool, ctx, { text: "legacy" });
    await claimIngestJob(pool);
    await completeIngestJob(pool, ctx, id);
    expect((await jobRow(id))?.status).toBe("done");
  });

  it("fail with retry -> pending, keeps payload, sets a future run_after", async () => {
    const id = await enqueueIngestJob(pool, ctx, { text: "retry me" });
    const claimed = await claimIngestJob(pool);
    const ok = await failIngestJob(pool, ctx, id, {
      error: "boom",
      retry: true,
      backoffMs: 60_000,
      attempt: claimed?.attempts,
    });
    expect(ok).toBe(true);
    const row = await jobRow(id);
    expect(row?.status).toBe("pending");
    expect(row?.payload).toBe("retry me");
    expect(row?.last_error).toBe("boom");
    expect(await claimIngestJob(pool)).toBeNull();
  });

  it("fail terminal -> failed and PURGES the payload", async () => {
    const id = await enqueueIngestJob(pool, ctx, { text: "give up on me" });
    const claimed = await claimIngestJob(pool);
    await failIngestJob(pool, ctx, id, {
      error: "fatal",
      retry: false,
      attempt: claimed?.attempts,
    });
    const row = await jobRow(id);
    expect(row?.status).toBe("failed");
    expect(row?.payload).toBeNull();
  });

  it("reclaim leaves a live (fresh) running job alone", async () => {
    const id = await enqueueIngestJob(pool, ctx, { text: "live" });
    await claimIngestJob(pool);
    expect(await reclaimExpiredIngestJobs(pool)).toBe(0);
    expect((await jobRow(id))?.status).toBe("running");
  });

  it("reclaim resets ONLY expired running jobs", async () => {
    const a = await enqueueIngestJob(pool, ctx, { text: "stale" });
    const b = await enqueueIngestJob(pool, ctx, { text: "fresh" });
    await claimIngestJob(pool);
    await claimIngestJob(pool);
    await backdate(a, "10 minutes");
    expect(await reclaimExpiredIngestJobs(pool)).toBe(1);
    expect((await jobRow(a))?.status).toBe("pending");
    expect((await jobRow(b))?.status).toBe("running");
  });

  it("clamps tiny leases to the 60s minimum", async () => {
    const id = await enqueueIngestJob(pool, ctx, { text: "clamp" });
    await claimIngestJob(pool);
    await backdate(id, "30 seconds");
    expect(await reclaimExpiredIngestJobs(pool, 1)).toBe(0);
    expect((await jobRow(id))?.status).toBe("running");
    await backdate(id, "90 seconds");
    expect(await reclaimExpiredIngestJobs(pool, 1)).toBe(1);
  });

  it("an active heartbeat protects the job from reclamation", async () => {
    const id = await enqueueIngestJob(pool, ctx, { text: "heartbeat" });
    const claimed = await claimIngestJob(pool);
    await backdate(id, "10 minutes");
    expect(await renewIngestJobLease(pool, ctx, id, claimed?.attempts ?? -1)).toBe(true);
    expect(await reclaimExpiredIngestJobs(pool)).toBe(0);
    expect((await jobRow(id))?.status).toBe("running");
  });

  it("a stale attempt cannot ack, fail, or renew a re-claimed job", async () => {
    const id = await enqueueIngestJob(pool, ctx, { text: "fenced" });
    const first = await claimIngestJob(pool);
    expect(first?.attempts).toBe(1);
    await backdate(id, "10 minutes");
    expect(await reclaimExpiredIngestJobs(pool)).toBe(1);
    const second = await claimIngestJob(pool);
    expect(second?.attempts).toBe(2);

    expect(await completeIngestJob(pool, ctx, id, 1)).toBe(false);
    expect(await failIngestJob(pool, ctx, id, { error: "stale", retry: false, attempt: 1 })).toBe(
      false,
    );
    expect(await renewIngestJobLease(pool, ctx, id, 1)).toBe(false);
    let row = await jobRow(id);
    expect(row?.status).toBe("running");
    expect(row?.attempts).toBe(2);
    expect(row?.payload).toBe("fenced");
    expect(row?.last_error).toBeNull();

    expect(await completeIngestJob(pool, ctx, id, 2)).toBe(true);
    row = await jobRow(id);
    expect(row?.status).toBe("done");
    expect(row?.payload).toBeNull();
  });

  it("acks are no-ops once a job is no longer running", async () => {
    const id = await enqueueIngestJob(pool, ctx, { text: "twice" });
    const claimed = await claimIngestJob(pool);
    expect(await completeIngestJob(pool, ctx, id, claimed?.attempts)).toBe(true);
    expect(await completeIngestJob(pool, ctx, id, claimed?.attempts)).toBe(false);
    expect(await renewIngestJobLease(pool, ctx, id, claimed?.attempts ?? -1)).toBe(false);
  });

  it("the legacy zero-arg SQL function and helper no longer reset live jobs", async () => {
    const id = await enqueueIngestJob(pool, ctx, { text: "legacy reclaim" });
    await claimIngestJob(pool);
    const res = await pool.query<{ n: number }>("SELECT dolores_reclaim_ingest_jobs() AS n");
    expect(Number(res.rows[0]?.n)).toBe(0);
    expect(await reclaimRunningIngestJobs(pool)).toBe(0);
    expect((await jobRow(id))?.status).toBe("running");
  });

  it("SKIP LOCKED hands two concurrent claimers distinct jobs", async () => {
    const a = await enqueueIngestJob(pool, ctx, { text: "job a" });
    const b = await enqueueIngestJob(pool, ctx, { text: "job b" });
    const [c1, c2] = await Promise.all([claimIngestJob(pool), claimIngestJob(pool)]);
    const ids = [c1?.id, c2?.id].sort();
    expect(ids).toEqual([a, b].sort());
    expect(c1?.id).not.toBe(c2?.id);
  });

  it("RLS hides a job from another workspace (status and renewal)", async () => {
    const id = await enqueueIngestJob(pool, ctx, { text: "private" });
    const claimed = await claimIngestJob(pool);
    const intruder: MemoryContext = { workspaceId: QUEUE_WS2, userId: null };
    expect(await getIngestJobStatus(pool, intruder, id)).toBeNull();
    expect(await renewIngestJobLease(pool, intruder, id, claimed?.attempts ?? -1)).toBe(false);
    expect(await completeIngestJob(pool, intruder, id, claimed?.attempts)).toBe(false);
  });
});
