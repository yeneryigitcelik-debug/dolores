import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { IngestStatusResponse } from "@dolores/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runIngestStatus } from "./ingest-status.js";

const state = vi.hoisted(() => ({
  port: 4505,
  token: "tok-secret-xyz",
  ws: "00000000-0000-0000-0000-000000000001",
  user: "11111111-1111-1111-1111-111111111111",
}));

vi.mock("../config.js", () => ({
  DEFAULT_REQUEST_TIMEOUT_MS: 60_000,
  getConfig: () => ({
    workspaceId: state.ws,
    userId: state.user,
    daemonHost: "127.0.0.1",
    daemonPort: state.port,
    authToken: state.token,
    requestTimeoutMs: 150,
  }),
  memoryContext: (c: { workspaceId: string; userId?: string }) => ({
    workspaceId: c.workspaceId,
    userId: c.userId ?? null,
  }),
  daemonBaseUrl: (c: { daemonHost: string; daemonPort: number }) =>
    `http://${c.daemonHost}:${c.daemonPort}`,
}));

const JOB = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const servers: Server[] = [];

function job(over: Partial<IngestStatusResponse> = {}): IngestStatusResponse {
  return {
    id: JOB,
    status: "pending",
    attempts: 0,
    lastError: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:01.000Z",
    ...over,
  };
}

function stubFetch(body: unknown, status = 200) {
  const f = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", f);
  return f;
}

function capture() {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const text = (s: typeof log) => s.mock.calls.map((c) => c.join(" ")).join("\n");
  return { log, err, out: () => text(log), errOut: () => text(err) };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.exitCode = undefined;
  state.port = 4505;
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections();
          s.close(() => resolve());
        }),
    ),
  );
});

describe("runIngestStatus", () => {
  it.each([
    ["pending", "beklemede"],
    ["running", "işleniyor"],
    ["done", "tamamlandı"],
    ["failed", "başarısız"],
  ] as const)("reports %s with exit code 0", async (status, label) => {
    const lastError = status === "failed" ? "extractor timeout" : null;
    stubFetch(job({ status, attempts: 2, lastError }));
    const c = capture();
    await runIngestStatus(JOB, {});
    expect(process.exitCode).toBeUndefined();
    expect(c.out()).toContain(label);
    expect(c.out()).toContain(JOB);
    expect(c.out()).toContain("2024-01-01T00:00:01.000Z");
    if (status === "failed") expect(c.out()).toContain("extractor timeout");
    if (status === "pending") expect(c.out()).not.toContain("tamamlandı");
    expect(c.err).not.toHaveBeenCalled();
  });

  it("--json prints exactly one contract object, stripping extra fields", async () => {
    stubFetch({ ...job({ status: "done", attempts: 1 }), secret: "leak" });
    const c = capture();
    await runIngestStatus(JOB, { json: true });
    expect(c.log).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(c.out());
    expect(parsed).toEqual(job({ status: "done", attempts: 1 }));
    expect(Object.keys(parsed).sort()).toEqual([
      "attempts",
      "createdAt",
      "id",
      "lastError",
      "status",
      "updatedAt",
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  it("sends bearer auth and tenant-scoped body to /ingest/status", async () => {
    const f = stubFetch(job());
    capture();
    await runIngestStatus(JOB, {});
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4505/ingest/status");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${state.token}` });
    expect(JSON.parse(init.body as string)).toEqual({
      workspaceId: state.ws,
      userId: state.user,
      jobId: JOB,
    });
  });

  it("accepts a case-different matching id", async () => {
    stubFetch(job({ id: JOB.toUpperCase() }));
    capture();
    await runIngestStatus(JOB, {});
    expect(process.exitCode).toBeUndefined();
  });

  it("rejects a malformed UUID without any network call", async () => {
    const f = stubFetch(job());
    const c = capture();
    await runIngestStatus("not-a-uuid", { json: true });
    expect(f).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(c.log).not.toHaveBeenCalled();
    expect(c.errOut()).toMatch(/UUID/);
  });

  it.each([
    ["malformed shape", { status: "weird", raw: "payload-xyz" }],
    ["negative attempts", job({ attempts: -1 })],
    ["wrong id", job({ id: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee" })],
  ])("rejects %s response", async (_name, body) => {
    stubFetch(body);
    const c = capture();
    await runIngestStatus(JOB, { json: true });
    expect(process.exitCode).toBe(1);
    expect(c.log).not.toHaveBeenCalled();
    expect(c.errOut()).not.toContain("payload-xyz");
  });

  it.each([
    [404, "iş bulunamadı"],
    [401, "yetkisiz"],
  ])("surfaces HTTP %i on stderr with exit code 1", async (status, message) => {
    stubFetch({ error: { code: "E", message: `${message} ${state.token}` } }, status);
    const c = capture();
    await runIngestStatus(JOB, { json: true });
    expect(process.exitCode).toBe(1);
    expect(c.log).not.toHaveBeenCalled();
    expect(c.errOut()).toContain(message);
    expect(c.errOut()).not.toContain(state.token);
  });

  it("renders external job errors without terminal controls", async () => {
    stubFetch(job({ status: "failed", lastError: "x\u009b2J\u001b[Hgizli\u0085end" }));
    const c = capture();
    await runIngestStatus(JOB);
    expect(c.out()).toContain("gizli");
    expect(c.out()).not.toContain("\u001b");
    expect(c.out()).not.toMatch(/[\u007f-\u009f]/);
  });

  it("escapes JSON C1 controls without changing the parsed error value", async () => {
    const value = job({ lastError: "x\u009b2J\u0085end" });
    stubFetch(value);
    const c = capture();
    await runIngestStatus(JOB, { json: true });
    expect(c.out()).not.toMatch(/[\u007f-\u009f]/);
    expect(JSON.parse(c.out())).toEqual(value);
  });

  it("renders daemon errors on stderr without terminal controls", async () => {
    stubFetch({ error: { message: "\u001b[2J\u009bHnot found" } }, 404);
    const c = capture();
    await runIngestStatus(JOB);
    expect(process.exitCode).toBe(1);
    expect(c.errOut()).toContain("not found");
    expect(c.errOut()).not.toContain("\u001b");
    expect(c.errOut()).not.toMatch(/[\u007f-\u009f]/);
    expect(c.log).not.toHaveBeenCalled();
  });

  it("aborts when the daemon stalls mid-body", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write("{");
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    state.port = (server.address() as AddressInfo).port;
    const c = capture();
    await runIngestStatus(JOB, {});
    expect(process.exitCode).toBe(1);
    expect(c.log).not.toHaveBeenCalled();
    expect(c.errOut()).toMatch(/zaman aşımı/);
  });
});
