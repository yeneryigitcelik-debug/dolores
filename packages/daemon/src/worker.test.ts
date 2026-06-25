import {
  type DaemonConfig,
  NoOpEmbedder,
  enqueueIngestJob,
  getIngestJobStatus,
} from "@dolores/core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./server.js";
import { type IngestWorkerHandle, startIngestWorkers } from "./worker.js";

const APP_URL = process.env.DOLORES_APP_DATABASE_URL ?? "";
const ADMIN_URL = process.env.DATABASE_URL ?? "";
const liveDescribe = APP_URL && ADMIN_URL ? describe : describe.skip;
const WS = "00000000-0000-0000-0000-0000000b0001";

const cfg: DaemonConfig = {
  host: "127.0.0.1",
  port: 4599,
  databaseUrl: APP_URL,
  embedder: "noop",
  embedModel: "bge-small-en-v1.5",
  decayMode: "conservative",
  extractionEnabled: false,
};

liveDescribe("ingest worker (live DB)", () => {
  let pool: Pool;
  let admin: Pool;
  let app: Awaited<ReturnType<typeof createApp>>;
  let worker: IngestWorkerHandle;
  const POLL = "DOLORES_INGEST_POLL_MS";
  const savedPoll = process.env[POLL];

  beforeAll(async () => {
    pool = new Pool({ connectionString: APP_URL, max: 5 });
    admin = new Pool({ connectionString: ADMIN_URL, max: 2 });
    await admin.query("DELETE FROM ingest_jobs WHERE workspace_id = $1", [WS]);
    const embedder = new NoOpEmbedder();
    await embedder.ready();
    // createApp only for a real logger — it does NOT start a worker.
    app = await createApp(pool, embedder, cfg);
    process.env[POLL] = "50"; // fast poll for the test
    worker = await startIngestWorkers({ pool, embedder, extractionEnabled: false, log: app.log });
  });

  afterAll(async () => {
    await worker.stop();
    if (savedPoll === undefined) delete process.env[POLL];
    else process.env[POLL] = savedPoll;
    await admin.query("DELETE FROM ingest_jobs WHERE workspace_id = $1", [WS]);
    await app.close();
    await pool.end();
    await admin.end();
  });

  it("drains an enqueued job to done and purges the payload (end-to-end)", async () => {
    const ctx = { workspaceId: WS, userId: null };
    const id = await enqueueIngestJob(pool, ctx, { text: "process me" });

    // With extraction off, ingestText is a no-op — the job still completes,
    // proving claim → process → complete → purge runs durably.
    let status: string | undefined;
    for (let i = 0; i < 60; i++) {
      const s = await getIngestJobStatus(pool, ctx, id);
      status = s?.status;
      if (status === "done" || status === "failed") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(status).toBe("done");

    const { rows } = await admin.query<{ payload: string | null }>(
      "SELECT payload FROM ingest_jobs WHERE id = $1",
      [id],
    );
    expect(rows[0]?.payload).toBeNull();
  });
});
