import type { PruneResponse } from "@dolores/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPrune } from "./prune.js";

// Config mock: tüm export'ları kapsıyor — daemonBaseUrl dahil
vi.mock("../config.js", () => ({
  getConfig: () => ({
    workspaceId: "00000000-0000-0000-0000-000000000001",
    daemonHost: "127.0.0.1",
    daemonPort: 4505,
  }),
  memoryContext: () => ({
    workspaceId: "00000000-0000-0000-0000-000000000001",
    userId: null,
  }),
  daemonBaseUrl: (cfg: { daemonHost: string; daemonPort: number }) =>
    `http://${cfg.daemonHost}:${cfg.daemonPort}`,
}));

const DRY_RES: PruneResponse = { deleted: 5, softened: 3, dryRun: true };
const REAL_RES: PruneResponse = { deleted: 5, softened: 3, dryRun: false };

function makeFetch(payload: PruneResponse) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(payload),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runPrune — confirm gate", () => {
  it("calls daemon with dryRun:true when --confirm is not set", async () => {
    vi.stubGlobal("fetch", makeFetch(DRY_RES));
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runPrune({});

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ dryRun: true });
  });

  it("calls daemon with dryRun:true when --dry-run flag is explicitly set", async () => {
    vi.stubGlobal("fetch", makeFetch(DRY_RES));
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runPrune({ dryRun: true });

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ dryRun: true });
  });

  it("calls daemon with dryRun:false when --confirm is set", async () => {
    vi.stubGlobal("fetch", makeFetch(REAL_RES));
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runPrune({ confirm: true });

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ dryRun: false });
  });

  it("shows --confirm hint when run without any flags", async () => {
    vi.stubGlobal("fetch", makeFetch(DRY_RES));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runPrune({});

    const combined = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(combined).toContain("--confirm");
  });

  it("does NOT show --confirm hint when --dry-run is used", async () => {
    vi.stubGlobal("fetch", makeFetch(DRY_RES));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runPrune({ dryRun: true });

    const combined = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(combined).not.toContain("dolores prune --confirm");
  });

  it("exits with code 1 when daemon returns invalid response shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ unexpected: "shape" }),
      }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code) => {
      throw new Error("process.exit called");
    });

    await expect(runPrune({ confirm: true })).rejects.toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
