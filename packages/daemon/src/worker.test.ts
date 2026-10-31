import {
  type DaemonConfig,
  NoOpEmbedder,
  enqueueIngestJob,
  getIngestJobStatus,
} from "@dolores/core";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./server.js";
import { type IngestWorkerHandle, resolveWorkerTuning, startIngestWorkers } from "./worker.js";

// NOTE: the worker claims ACROSS tenants — run against an isolated test database
// (no live daemon, no concurrently running queue tests).
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

interface FakeProvider {
  id: string;
  calls: number;
  complete(input: { prompt: string; system?: string; maxTokens?: number }): Promise<string>;
}

function fakeProvider(failTimes = 0): FakeProvider {
  const p: FakeProvider = {
    id: "fake",
    calls: 0,
    complete: async () => {
      p.calls += 1;
      if (p.calls <= failTimes) throw new Error("transient vendor outage sk-secret");
      return '{"facts":[],"memories":[]}';
    },
  };
  return p;
}

/** Replies in order (last one repeats); an Error entry is thrown. */
function scriptedProvider(replies: Array<string | Error>): FakeProvider {
  const p: FakeProvider = {
    id: "scripted",
    calls: 0,
    complete: async () => {
      p.calls += 1;
      const r = replies[Math.min(p.calls, replies.length) - 1];
      if (r instanceof Error) throw r;
      return r ?? "";
    },
  };
  return p;
}

const ENV_KEYS = [
  "DOLORES_INGEST_POLL_MS",
  "DOLORES_INGEST_BASE_BACKOFF_MS",
  "DOLORES_INGEST_MAX_ATTEMPTS",
] as const;

liveDescribe("ingest worker (live DB)", () => {
  let pool: Pool;
  let admin: Pool;
  let app: Awaited<ReturnType<typeof createApp>>;
  let embedder: NoOpEmbedder;
  let worker: IngestWorkerHandle | undefined;
  const saved: Record<string, string | undefined> = {};
  const ctx = { workspaceId: WS, userId: null };

  const waitForTerminal = async (id: string): Promise<{ status?: string; attempts?: number }> => {
    for (let i = 0; i < 100; i++) {
      const s = await getIngestJobStatus(pool, ctx, id);
      if (s?.status === "done" || s?.status === "failed") {
        return { status: s.status, attempts: s.attempts };
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    const s = await getIngestJobStatus(pool, ctx, id);
    return { status: s?.status, attempts: s?.attempts };
  };

  beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.DOLORES_INGEST_POLL_MS = "50";
    process.env.DOLORES_INGEST_BASE_BACKOFF_MS = "0";
    process.env.DOLORES_INGEST_MAX_ATTEMPTS = "3";
    pool = new Pool({ connectionString: APP_URL, max: 5 });
    admin = new Pool({ connectionString: ADMIN_URL, max: 2 });
    embedder = new NoOpEmbedder();
    await embedder.ready();
    // createApp only for a real logger — it does NOT start a worker.
    app = await createApp(pool, embedder, cfg);
  });

  beforeEach(async () => {
    await admin.query("DELETE FROM ingest_jobs WHERE workspace_id = $1", [WS]);
  });

  afterEach(async () => {
    await worker?.stop();
    worker = undefined;
    await admin.query("DELETE FROM ingest_jobs WHERE workspace_id = $1", [WS]);
  });

  afterAll(async () => {
    for (const k of ENV_KEYS) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await app.close();
    await pool.end();
    await admin.end();
  });

  it("drains an enqueued job to done with the injected provider and purges the payload", async () => {
    const provider = fakeProvider();
    worker = await startIngestWorkers({
      pool,
      embedder,
      extractionEnabled: true,
      log: app.log,
      provider,
    });
    const id = await enqueueIngestJob(pool, ctx, { text: "process me" });

    const res = await waitForTerminal(id);
    expect(res.status).toBe("done");
    expect(provider.calls).toBe(1);

    const { rows } = await admin.query<{ payload: string | null }>(
      "SELECT payload FROM ingest_jobs WHERE id = $1",
      [id],
    );
    expect(rows[0]?.payload).toBeNull();
  });

  it("a disabled worker leaves jobs pending (never falsely done)", async () => {
    const provider = fakeProvider();
    worker = await startIngestWorkers({
      pool,
      embedder,
      extractionEnabled: false,
      log: app.log,
      provider,
    });
    const id = await enqueueIngestJob(pool, ctx, { text: "wait for me" });
    await new Promise((r) => setTimeout(r, 400));
    const s = await getIngestJobStatus(pool, ctx, id);
    expect(s?.status).toBe("pending");
    expect(s?.attempts).toBe(0);
    expect(provider.calls).toBe(0);
  });

  it("a worker with no provider leaves jobs pending", async () => {
    worker = await startIngestWorkers({
      pool,
      embedder,
      extractionEnabled: true,
      log: app.log,
      provider: null,
    });
    const id = await enqueueIngestJob(pool, ctx, { text: "no provider" });
    await new Promise((r) => setTimeout(r, 400));
    expect((await getIngestJobStatus(pool, ctx, id))?.status).toBe("pending");
  });

  it("a transient provider failure is retried, then the job completes", async () => {
    const provider = fakeProvider(1);
    worker = await startIngestWorkers({
      pool,
      embedder,
      extractionEnabled: true,
      log: app.log,
      provider,
    });
    const id = await enqueueIngestJob(pool, ctx, { text: "flaky" });

    const res = await waitForTerminal(id);
    expect(res.status).toBe("done");
    expect(res.attempts).toBe(2);
    expect(provider.calls).toBe(2);

    const { rows } = await admin.query<{ last_error: string | null }>(
      "SELECT last_error FROM ingest_jobs WHERE id = $1",
      [id],
    );
    // Generic error text only — never the raw vendor message.
    expect(rows[0]?.last_error ?? "").not.toContain("sk-secret");
  });

  it("invalid JSON on the first attempt is retried, then completes", async () => {
    const provider = scriptedProvider(["definitely not json", '{"facts":[],"memories":[]}']);
    worker = await startIngestWorkers({
      pool,
      embedder,
      extractionEnabled: true,
      log: app.log,
      provider,
    });
    const id = await enqueueIngestJob(pool, ctx, { text: "retry on bad json" });

    const res = await waitForTerminal(id);
    expect(res.status).toBe("done");
    expect(res.attempts).toBe(2);
    expect(provider.calls).toBe(2);
  });

  it("a persistently failing provider ends FAILED after maxAttempts with a generic error", async () => {
    const provider = scriptedProvider([
      new Error("vendor 500 sk-live-SECRET999 transcript: my password is hunter2"),
    ]);
    worker = await startIngestWorkers({
      pool,
      embedder,
      extractionEnabled: true,
      log: app.log,
      provider,
    });
    const id = await enqueueIngestJob(pool, ctx, { text: "my password is hunter2" });

    const res = await waitForTerminal(id);
    expect(res.status).toBe("failed");
    expect(res.attempts).toBe(3);
    expect(provider.calls).toBe(3);

    const { rows } = await admin.query<{ payload: string | null; last_error: string | null }>(
      "SELECT payload, last_error FROM ingest_jobs WHERE id = $1",
      [id],
    );
    expect(rows[0]?.payload).toBeNull();
    const lastError = rows[0]?.last_error ?? "";
    expect(lastError).toBe("extraction LLM provider call failed");
    expect(lastError).not.toContain("SECRET999");
    expect(lastError).not.toContain("hunter2");
  });
});

describe("resolveWorkerTuning (no DB)", () => {
  it("caps a large own heartbeat at 30s regardless of a large own lease", () => {
    const t = resolveWorkerTuning({
      DOLORES_INGEST_LEASE_MS: "600000",
      DOLORES_INGEST_HEARTBEAT_MS: "300000",
    });
    expect(t.leaseMs).toBe(600_000);
    expect(t.heartbeatMs).toBe(30_000);
  });

  it("preserves a shorter configured heartbeat", () => {
    const t = resolveWorkerTuning({
      DOLORES_INGEST_LEASE_MS: "600000",
      DOLORES_INGEST_HEARTBEAT_MS: "5000",
    });
    expect(t.heartbeatMs).toBe(5000);
  });

  it("a tiny lease clamps to the minimum and the heartbeat stays within half of it", () => {
    const t = resolveWorkerTuning({ DOLORES_INGEST_LEASE_MS: "1" });
    expect(t.leaseMs).toBe(60_000);
    expect(t.heartbeatMs).toBeLessThanOrEqual(30_000);
  });

  it("defaults are pure (independent of process.env)", () => {
    const t = resolveWorkerTuning({});
    expect(t.leaseMs).toBe(300_000);
    expect(t.heartbeatMs).toBe(30_000);
    expect(t.count).toBe(1);
    expect(t.maxAttempts).toBe(3);
  });
});
