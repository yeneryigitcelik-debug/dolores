import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runIngest } from "./ingest.js";
import { runPrune } from "./prune.js";
import { runRemember } from "./remember.js";

const TOKEN = "synthetic-ack-token-not-a-credential";
vi.mock("../config.js", () => ({
  DEFAULT_REQUEST_TIMEOUT_MS: 60_000,
  getConfig: () => ({
    workspaceId: "11111111-1111-4111-8111-111111111111",
    daemonHost: "127.0.0.1",
    daemonPort: 4505,
    authToken: "synthetic-ack-token-not-a-credential",
  }),
  memoryContext: () => ({ workspaceId: "11111111-1111-4111-8111-111111111111" }),
  daemonBaseUrl: () => "http://127.0.0.1:4505",
}));

let fixtureDir: string;
let inputFile: string;
beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "dolores-mutation-ack-"));
  inputFile = join(fixtureDir, "synthetic.txt");
  writeFileSync(inputFile, "Synthetic acknowledgement fixture. No user conversation.");
});
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function response(payload: unknown) {
  const request = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", request);
  return request;
}
async function rejectsWithoutSuccess(payload: unknown, run: () => Promise<void>) {
  const request = response(payload);
  const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw Error("synthetic-exit");
  });
  await expect(run()).rejects.toThrow("synthetic-exit");
  expect(exit).toHaveBeenCalledWith(1);
  expect(stdout).not.toHaveBeenCalled();
  expect(stderr).toHaveBeenCalled();
  const text = stderr.mock.calls.flat().join(" ");
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain("ACK_BODY_SENTINEL");
  expect(request).toHaveBeenCalledTimes(1);
}

describe("mutation acknowledgement truthfulness", () => {
  it.each([
    {},
    { id: "", deduped: false },
    { id: "   ", deduped: false },
    { id: "m1", deduped: "false" },
    { id: 42, deduped: false },
    { id: "m1" },
  ])("remember rejects unusable 2xx ACK without a saved claim: %j", async (payload) => {
    await rejectsWithoutSuccess({ ...payload, diagnostic: `ACK_BODY_SENTINEL ${TOKEN}` }, () =>
      runRemember("Synthetic memory", {}),
    );
  });

  it.each([
    { id: "m1", deduped: false },
    { id: "mem_abc", deduped: true },
    { id: "  legacy id  ", deduped: false },
  ])("remember preserves valid string IDs and boolean dedupe: %j", async (payload) => {
    const request = response({ ...payload, futureField: true });
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    await runRemember("Synthetic memory", {});
    const text = stdout.mock.calls.flat().join(" ");
    expect(text).toContain(`[${payload.id}]`);
    expect(text.includes("yakın kopya")).toBe(payload.deduped);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    { queued: false },
    { queued: "false" },
    {},
    { queued: true, jobId: "" },
    { queued: true, jobId: "   " },
    { queued: true, jobId: 7 },
  ])("ingest refuses negative or malformed 2xx ACK: %j", async (payload) => {
    await rejectsWithoutSuccess({ ...payload, diagnostic: `ACK_BODY_SENTINEL ${TOKEN}` }, () =>
      runIngest(inputFile),
    );
  });

  it.each([
    { queued: true },
    { queued: true, jobId: "job_7" },
    { queued: true, jobId: "  legacy job  " },
  ])("ingest retains optional legacy job IDs: %j", async (payload) => {
    const request = response({ ...payload, futureField: "compatible" });
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    await runIngest(inputFile);
    const text = stdout.mock.calls.flat().join(" ");
    expect(text).toContain("kuyruğa alındı");
    if ("jobId" in payload) expect(text).toContain(`(iş: ${payload.jobId})`);
    else expect(text).not.toContain("(iş:");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    "prune rejects response mode opposite to request dryRun=%s",
    async (dryRun) => {
      await rejectsWithoutSuccess({ deleted: 1, softened: 2, dryRun: !dryRun }, () =>
        runPrune(dryRun ? { dryRun: true } : { confirm: true }),
      );
    },
  );

  it.each([true, false])(
    "prune accepts matching dryRun=%s and truthful count labels",
    async (dryRun) => {
      const request = response({ deleted: 1, softened: 2, dryRun });
      const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
      await runPrune(dryRun ? { dryRun: true } : { confirm: true });
      const text = stdout.mock.calls.flat().join(" ");
      expect(text).toContain(dryRun ? "önizlemesi" : "tamamlandı");
      expect(request).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({ dryRun });
    },
  );
});
