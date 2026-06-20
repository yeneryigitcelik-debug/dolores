import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonError, daemonGet, daemonPost } from "./client.js";
import type { CliConfig } from "./config.js";

const cfg: CliConfig = {
  workspaceId: "00000000-0000-0000-0000-000000000001",
  daemonHost: "127.0.0.1",
  daemonPort: 4505,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DaemonError", () => {
  it("is an Error subclass with name DaemonError", () => {
    const err = new DaemonError("oops", 503);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("DaemonError");
    expect(err.message).toBe("oops");
    expect(err.status).toBe(503);
  });

  it("works without a status argument", () => {
    const err = new DaemonError("no status");
    expect(err.status).toBeUndefined();
  });
});

describe("daemonGet", () => {
  it("returns parsed JSON on a 200 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      }),
    );

    const result = await daemonGet<{ ok: boolean }>(cfg, "/health");
    expect(result).toEqual({ ok: true });
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("http://127.0.0.1:4505/health");
  });

  it("throws DaemonError with daemon message when fetch fails with ECONNREFUSED", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1")));

    const err = await daemonGet(cfg, "/health").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonError);
    expect((err as DaemonError).message).toMatch(/daemon/i);
  });

  it("throws DaemonError carrying the HTTP status on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: () => Promise.resolve("service unavailable"),
      }),
    );

    const err = await daemonGet(cfg, "/status").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonError);
    expect((err as DaemonError).status).toBe(503);
  });
});

describe("daemonPost", () => {
  it("sends a POST request with JSON body and returns the parsed response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "mem_1", deduped: false }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await daemonPost<{ content: string }, { id: string; deduped: boolean }>(
      cfg,
      "/remember",
      { content: "test content" },
    );

    expect(result).toEqual({ id: "mem_1", deduped: false });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4505/remember");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({ content: "test content" });
  });

  it("throws DaemonError when the network request fails with 'fetch failed'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fetch failed")));

    const err = await daemonPost(cfg, "/recall", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonError);
  });

  it("throws DaemonError with 4xx status when daemon rejects the request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve("bad request"),
      }),
    );

    const err = await daemonPost(cfg, "/remember", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonError);
    expect((err as DaemonError).status).toBe(400);
  });
});
