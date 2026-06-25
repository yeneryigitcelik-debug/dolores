import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MemoryContext } from "../types.js";
import {
  claimIngestJob,
  completeIngestJob,
  enqueueIngestJob,
  failIngestJob,
  getIngestJobStatus,
  reclaimRunningIngestJobs,
} from "./jobs.js";

const APP_URL = process.env.DOLORES_APP_DATABASE_URL ?? "";
const ADMIN_URL = process.env.DATABASE_URL ?? "";
const liveDescribe = APP_URL && ADMIN_URL ? describe : describe.skip;

const QUEUE_WS = "00000000-0000-0000-0000-0000000a0001";
const QUEUE_WS2 = "00000000-0000-0000-0000-0000000a0002";

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

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: APP_URL, max: 5 });
    admin = new pg.Pool({ connectionString: ADMIN_URL, max: 3 });
  });

  // Clear the WHOLE queue so the cross-tenant claim only ever sees this test's jobs.
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
    // No more runnable jobs.
    expect(await claimIngestJob(pool)).toBeNull();
  });

  it("complete marks done and PURGES the payload (rule 1)", async () => {
    const id = await enqueueIngestJob(pool, ctx, { text: "secret transcript" });
    await claimIngestJob(pool);
    await completeIngestJob(pool, ctx, id);
    const row = await jobRow(id);
    expect(row?.status).toBe("done");
    expect(row?.payload).toBeNull();
  });

  it("fail with retry → pending, keeps payload, sets a future run_after", async () => {
    const id = await enqueueIngestJob(pool, ctx, { text: "retry me" });
    await claimIngestJob(pool);
    await failIngestJob(pool, ctx, id, { error: "boom", retry: true, backoffMs: 60_000 });
    const row = await jobRow(id);
    expect(row?.status).toBe("pending");
    expect(row?.payload).toBe("retry me"); // kept for the next attempt
    expect(row?.last_error).toBe("boom");
    // Backoff: not immediately runnable again.
    expect(await claimIngestJob(pool)).toBeNull();
  });

  it("fail terminal → failed and PURGES the payload", async () => {
    const id = await enqueueIngestJob(pool, ctx, { text: "give up on me" });
    await claimIngestJob(pool);
    await failIngestJob(pool, ctx, id, { error: "fatal", retry: false });
    const row = await jobRow(id);
    expect(row?.status).toBe("failed");
    expect(row?.payload).toBeNull();
  });

  it("reclaim resets stuck 'running' jobs back to pending", async () => {
    const id = await enqueueIngestJob(pool, ctx, { text: "interrupted" });
    await claimIngestJob(pool); // now 'running'
    expect((await jobRow(id))?.status).toBe("running");
    const n = await reclaimRunningIngestJobs(pool);
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await jobRow(id))?.status).toBe("pending");
  });

  it("SKIP LOCKED hands two concurrent claimers distinct jobs", async () => {
    const a = await enqueueIngestJob(pool, ctx, { text: "job a" });
    const b = await enqueueIngestJob(pool, ctx, { text: "job b" });
    const [c1, c2] = await Promise.all([claimIngestJob(pool), claimIngestJob(pool)]);
    const ids = [c1?.id, c2?.id].sort();
    expect(ids).toEqual([a, b].sort());
    expect(c1?.id).not.toBe(c2?.id);
  });

  it("RLS hides a job from another workspace", async () => {
    const id = await enqueueIngestJob(pool, ctx, { text: "private" });
    const intruder: MemoryContext = { workspaceId: QUEUE_WS2, userId: null };
    expect(await getIngestJobStatus(pool, intruder, id)).toBeNull();
  });
});
