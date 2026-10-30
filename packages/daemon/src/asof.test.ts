import type { DaemonConfig, RecallQuery, RecallResult } from "@dolores/core";
import { NoOpEmbedder } from "@dolores/core";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./server.js";

const recallMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<RecallResult>>(async () => ({
    hits: [],
    tokenEstimate: 0,
  })),
);

vi.mock("@dolores/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dolores/core")>();
  return { ...actual, recall: recallMock };
});

const WORKSPACE_ID = "a1a1a1a1-b2b2-c3c3-d4d4-e5e5e5e5e5e5";
const USER_ID = "f6f6f6f6-a7a7-b8b8-c9c9-d0d0d0d0d0d0";

const cfg: DaemonConfig = {
  host: "127.0.0.1",
  port: 4505,
  databaseUrl: "postgresql://noop:noop@localhost:1/noop",
  embedder: "noop",
  embedModel: "bge-small-en-v1.5",
  decayMode: "conservative",
  extractionEnabled: false,
};

describe("POST /recall asOf normalization", () => {
  let pool: Pool;
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: cfg.databaseUrl });
    const embedder = new NoOpEmbedder();
    await embedder.ready();
    app = await createApp(pool, embedder, cfg);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.end().catch(() => undefined);
  });

  beforeEach(() => {
    recallMock.mockClear();
  });

  const post = (extra: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/recall",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ workspaceId: WORKSPACE_ID, userId: USER_ID, query: "q", ...extra }),
    });

  const recalledQuery = (): RecallQuery => {
    expect(recallMock).toHaveBeenCalledTimes(1);
    return recallMock.mock.calls[0]?.[3] as RecallQuery;
  };

  it.each([
    ["2026-05-01", "2026-05-01T00:00:00.000Z"],
    ["2026-05-01T02:30:00+02:00", "2026-05-01T00:30:00.000Z"],
    ["2026-05-01T10:15:30Z", "2026-05-01T10:15:30.000Z"],
    ["1 May 2026 00:00:00 GMT", "2026-05-01T00:00:00.000Z"],
  ])("normalizes %s to UTC ISO before calling recall", async (input, expected) => {
    const res = await post({ asOf: input });
    expect(res.statusCode).toBe(200);
    expect(recalledQuery().asOf).toBe(expected);
  });

  it("leaves asOf undefined when omitted", async () => {
    const res = await post({});
    expect(res.statusCode).toBe(200);
    expect(recalledQuery().asOf).toBeUndefined();
  });

  it.each([
    "0000-01-01T00:00:00Z",
    "+010000-01-01T00:00:00Z",
    "+275760-09-13T00:00:01Z",
    "not-a-date",
    "",
  ])("rejects %j with 400 without calling recall", async (input) => {
    const res = await post({ asOf: input });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(recallMock).not.toHaveBeenCalled();
  });
});
