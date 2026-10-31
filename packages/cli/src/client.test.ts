import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DaemonError, daemonGet, daemonPost } from "./client.js";
import type { CliConfig } from "./config.js";

const TOKEN = "tok-very-secret-123";

const cfg: CliConfig = {
  workspaceId: "00000000-0000-0000-0000-000000000001",
  daemonHost: "127.0.0.1",
  daemonPort: 4505,
};

const servers: Server[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((err) => (err ? reject(err) : resolve()));
        }),
    ),
  );
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(text: string, status: number): Response {
  return new Response(text, { status });
}

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<CliConfig> {
  const server = createHttpServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { ...cfg, daemonPort: port };
}

async function catchError(promise: Promise<unknown>): Promise<DaemonError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DaemonError);
  return err as DaemonError;
}

describe("DaemonError", () => {
  it("is an Error subclass with name DaemonError", () => {
    const err = new DaemonError("oops", 503);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("DaemonError");
    expect(err.message).toBe("oops");
    expect(err.status).toBe(503);
  });

  it("works without a status argument", () => {
    expect(new DaemonError("no status").status).toBeUndefined();
  });
});

describe("daemonGet", () => {
  it("returns parsed JSON on a 200 response without auth header when no token", async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", mockFetch);

    const result = await daemonGet<{ ok: boolean }>(cfg, "/health");
    expect(result).toEqual({ ok: true });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4505/health");
    expect(init.method).toBe("GET");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers as Record<string, string>).not.toHaveProperty("Authorization");
  });

  it("sends a bearer token when configured", async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", mockFetch);

    await daemonGet({ ...cfg, authToken: TOKEN }, "/status");
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain(TOKEN);
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
  });

  it("throws DaemonError with daemon message when fetch fails with ECONNREFUSED", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1")));
    const err = await catchError(daemonGet(cfg, "/health"));
    expect(err.message).toMatch(/daemon/i);
  });

  it("throws DaemonError carrying the HTTP status on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse("service unavailable", 503)));
    const err = await catchError(daemonGet(cfg, "/status"));
    expect(err.status).toBe(503);
  });

  it("extracts error.message from structured JSON error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ error: { code: "INVALID_INPUT", message: "content zorunludur" } }, 400),
        ),
    );
    const err = await catchError(daemonGet(cfg, "/remember"));
    expect(err.message).toBe("content zorunludur");
    expect(err.status).toBe(400);
  });

  it("falls back to generic Turkish message when error body is not valid JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse("Internal Server Error", 500)));
    const err = await catchError(daemonGet(cfg, "/status"));
    expect(err.message).toMatch(/beklenmeyen/i);
    expect(err.status).toBe(500);
  });

  it("turns a malformed 200 JSON body into a controlled DaemonError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse("{not json", 200)));
    const err = await catchError(daemonGet(cfg, "/status"));
    expect(err.message).toMatch(/JSON/);
  });

  it("returns validated data when response matches provided schema", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ ok: true })));
    const result = await daemonGet(cfg, "/health", z.object({ ok: z.boolean() }));
    expect(result).toEqual({ ok: true });
  });

  it("throws DaemonError when response does not match provided schema", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ unexpected: "shape" })));
    const err = await catchError(daemonGet(cfg, "/health", z.object({ ok: z.boolean() })));
    expect(err.message).toMatch(/beklenmeyen/i);
  });

  it("redacts a token reflected by the daemon error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { error: { message: `invalid token ${TOKEN}`, issues: [`header Bearer ${TOKEN}`] } },
            401,
          ),
        ),
    );
    const err = await catchError(daemonGet({ ...cfg, authToken: TOKEN }, "/status"));
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain("[gizli]");
    expect(err.status).toBe(401);
  });

  it("redacts a token from a network error and its cause", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValue(new Error(`socket ${TOKEN}`, { cause: new Error(`auth ${TOKEN}`) })),
    );
    const err = await catchError(daemonGet({ ...cfg, authToken: TOKEN }, "/status"));
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain("[gizli]");
  });

  it("redacts a token from a response schema validation message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ ok: true })));
    const schema = z.object({ ok: z.boolean() }).refine(() => false, `invalid ${TOKEN}`);
    const err = await catchError(daemonGet({ ...cfg, authToken: TOKEN }, "/status", schema));
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain("[gizli]");
  });
});

describe("daemonPost", () => {
  it("sends a POST request with JSON body and returns the parsed response", async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ id: "mem_1", deduped: false }));
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
    expect(init.headers as Record<string, string>).not.toHaveProperty("Authorization");
    expect(JSON.parse(init.body as string)).toEqual({ content: "test content" });
  });

  it("sends a bearer token on POST when configured", async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ id: "m", deduped: false }));
    vi.stubGlobal("fetch", mockFetch);
    await daemonPost({ ...cfg, authToken: TOKEN }, "/remember", { content: "x" });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
  });

  it("throws DaemonError when the network request fails with 'fetch failed'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fetch failed")));
    await catchError(daemonPost(cfg, "/recall", {}));
  });

  it("throws DaemonError with 4xx status when daemon rejects the request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse("bad request", 400)));
    const err = await catchError(daemonPost(cfg, "/remember", {}));
    expect(err.status).toBe(400);
  });

  it("retains string issues from a structured error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: "VALIDATION_ERROR",
              message: "importance must be between 1 and 10",
              issues: ["importance: out of range"],
            },
          },
          422,
        ),
      ),
    );
    const err = await catchError(daemonPost(cfg, "/remember", {}));
    expect(err.message).toContain("importance must be between 1 and 10");
    expect(err.message).toContain("importance: out of range");
    expect(err.status).toBe(422);
  });

  it("retains the message and Zod issue objects from real daemon validation errors", async () => {
    const issues = Array.from({ length: 5 }, (_, i) => ({
      code: "too_small",
      path: ["items", i, "content"],
      message: `boş olamaz ${i}`,
    }));
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { error: { code: "VALIDATION_ERROR", message: "Geçersiz istek", issues } },
            400,
          ),
        ),
    );
    const err = await catchError(daemonPost(cfg, "/remember", {}));
    expect(err.message).toContain("Geçersiz istek");
    expect(err.message).toContain("items.0.content: boş olamaz 0");
    expect(err.message).not.toContain("boş olamaz 4");
    expect(err.message).toContain("+2");
  });

  it("bounds very long error messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: { message: "x".repeat(10_000) } }, 400)),
    );
    const err = await catchError(daemonPost(cfg, "/remember", {}));
    expect(err.message.length).toBeLessThanOrEqual(500);
  });

  it("validates POST response with schema and throws on invalid shape", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ wrong: "field" })));
    const schema = z.object({ id: z.string(), deduped: z.boolean() });
    const err = await catchError(daemonPost(cfg, "/remember", {}, schema));
    expect(err.message).toMatch(/beklenmeyen/i);
  });
});

describe("real HTTP daemon stub", () => {
  async function startAuthServer(): Promise<CliConfig> {
    return startServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "yetkisiz" } }));
        return;
      }
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        raw += chunk;
      });
      req.on("end", () => {
        const received: unknown = JSON.parse(raw);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ received }));
      });
    });
  }

  it("connects with bearer auth for GET and POST", async () => {
    const config = { ...(await startAuthServer()), authToken: TOKEN };
    await expect(daemonGet(config, "/status")).resolves.toEqual({ ok: true });
    await expect(daemonPost(config, "/remember", { content: "hi" })).resolves.toEqual({
      received: { content: "hi" },
    });
  });

  it("surfaces 401 as DaemonError when no token is configured", async () => {
    const config = await startAuthServer();
    const err = await catchError(daemonGet(config, "/status"));
    expect(err.status).toBe(401);
    expect(err.message).toBe("yetkisiz");
  });

  it("times out when the daemon never sends headers", async () => {
    const config = await startServer(() => undefined);
    const err = await catchError(daemonGet({ ...config, requestTimeoutMs: 100 }, "/status"));
    expect(err.message).toMatch(/zaman aşımı/);
  });

  it("times out when the daemon stalls mid-body", async () => {
    const config = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write("{");
    });
    const err = await catchError(
      daemonPost({ ...config, requestTimeoutMs: 100 }, "/remember", { content: "x" }),
    );
    expect(err.message).toMatch(/zaman aşımı/);
  });
});
