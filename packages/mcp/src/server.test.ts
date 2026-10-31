import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer as createHttpServer,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WORKSPACE_ID,
  type McpConfig,
  createServer,
  daemonBaseUrl,
  loadMcpConfig,
  recallInputSchema,
  rememberInputSchema,
} from "./server.js";

const WS = "11111111-1111-4111-8111-111111111111";
const TOKEN = "s3cr3t-token-value";

const httpServers: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(
    httpServers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections();
          s.close(() => resolve());
        }),
    ),
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cfg(env: Record<string, string> = {}): McpConfig {
  return loadMcpConfig({ DOLORES_WORKSPACE_ID: WS, ...env });
}

async function makeClient(
  config: McpConfig,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = createServer(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, cleanup: async () => client.close() };
}

async function call(
  config: McpConfig,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { client, cleanup } = await makeClient(config);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await cleanup();
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function textOf(result: unknown): string {
  if (!isObj(result) || !Array.isArray(result.content)) throw new Error("no content array");
  const first: unknown = result.content[0];
  if (!isObj(first) || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("first content is not text");
  }
  return first.text;
}

function isErr(result: unknown): boolean {
  return isObj(result) && result.isError === true;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(impl: () => Promise<Response>) {
  const fn = vi.fn<typeof fetch>(impl);
  vi.stubGlobal("fetch", fn);
  return fn;
}

function authHeaderOf(fn: ReturnType<typeof stubFetch>, i = 0): string | null {
  const call = fn.mock.calls[i];
  if (!call) throw new Error("fetch not called");
  return new Headers(call[1]?.headers).get("authorization");
}

const recallFixture = {
  hits: [
    {
      id: "h1",
      content: "pgvector kullanıyoruz",
      importance: 8,
      scope: "workspace",
      score: 0.95,
      source: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  tokenEstimate: 10,
};

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<number> {
  const server = createHttpServer(handler);
  httpServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe("rememberInputSchema", () => {
  it("requires non-empty content", () => {
    expect(rememberInputSchema.safeParse({}).success).toBe(false);
    expect(rememberInputSchema.safeParse({ content: "" }).success).toBe(false);
  });

  it("accepts valid input with all fields", () => {
    const r = rememberInputSchema.safeParse({
      content: "TypeScript kullanıyoruz",
      scope: "workspace",
      importance: 7,
    });
    expect(r.success).toBe(true);
  });

  it("rejects unknown scope and out-of-range importance", () => {
    expect(rememberInputSchema.safeParse({ content: "x", scope: "team" }).success).toBe(false);
    expect(rememberInputSchema.safeParse({ content: "x", importance: 11 }).success).toBe(false);
    expect(rememberInputSchema.safeParse({ content: "x", importance: 0 }).success).toBe(false);
  });
});

describe("recallInputSchema", () => {
  it("requires non-empty query", () => {
    expect(recallInputSchema.safeParse({}).success).toBe(false);
    expect(recallInputSchema.safeParse({ query: "" }).success).toBe(false);
  });

  it("accepts valid input and rejects limit above 20", () => {
    expect(recallInputSchema.safeParse({ query: "embedding", limit: 5 }).success).toBe(true);
    expect(recallInputSchema.safeParse({ query: "x", limit: 25 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe("loadMcpConfig", () => {
  it("applies defaults, accepting the sentinel workspace UUID", () => {
    const c = loadMcpConfig({});
    expect(c.workspaceId).toBe(DEFAULT_WORKSPACE_ID);
    expect(c.authToken).toBeUndefined();
    expect(c.requestTimeoutMs).toBeGreaterThan(0);
    expect(daemonBaseUrl(c)).toBe("http://127.0.0.1:4505");
  });

  it("accepts legacy GUID workspace and user ids from explicit env", () => {
    const c = loadMcpConfig({
      DOLORES_WORKSPACE_ID: "00000000-0000-0000-0000-000000000001",
      DOLORES_USER_ID: "11111111-1111-1111-1111-111111111111",
    });
    expect(c.workspaceId).toBe("00000000-0000-0000-0000-000000000001");
    expect(c.userId).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("treats a blank token as absent and trims a real one", () => {
    expect(loadMcpConfig({ DOLORES_AUTH_TOKEN: "   " }).authToken).toBeUndefined();
    expect(loadMcpConfig({ DOLORES_AUTH_TOKEN: `  ${TOKEN}  ` }).authToken).toBe(TOKEN);
  });

  it("formats raw and bracketed IPv6 and custom hostnames", () => {
    expect(daemonBaseUrl(loadMcpConfig({ DOLORES_DAEMON_HOST: "::1" }))).toBe("http://[::1]:4505");
    expect(daemonBaseUrl(loadMcpConfig({ DOLORES_DAEMON_HOST: "[::1]" }))).toBe(
      "http://[::1]:4505",
    );
    expect(
      daemonBaseUrl(
        loadMcpConfig({ DOLORES_DAEMON_HOST: "daemon.internal", DOLORES_DAEMON_PORT: "8080" }),
      ),
    ).toBe("http://daemon.internal:8080");
  });

  it.each([
    "http://evil.example",
    "host:80",
    "user@host",
    "host/path",
    "1.2.3",
    "[localhost]",
    "fe80::1%eth0",
  ])("rejects bad host %s without echoing it", (host) => {
    expect(() => loadMcpConfig({ DOLORES_DAEMON_HOST: host })).toThrow(/DOLORES_DAEMON_HOST/);
    try {
      loadMcpConfig({ DOLORES_DAEMON_HOST: host });
    } catch (e) {
      expect(e instanceof Error ? e.message : "").not.toContain(host);
    }
  });

  it("requires a positive integer timeout", () => {
    expect(loadMcpConfig({ DOLORES_REQUEST_TIMEOUT_MS: "250" }).requestTimeoutMs).toBe(250);
    for (const bad of ["0", "-5", "1.5", "abc"]) {
      expect(() => loadMcpConfig({ DOLORES_REQUEST_TIMEOUT_MS: bad })).toThrow(
        /DOLORES_REQUEST_TIMEOUT_MS/,
      );
    }
  });

  it("rejects an invalid workspace UUID", () => {
    expect(() => loadMcpConfig({ DOLORES_WORKSPACE_ID: "not-a-uuid" })).toThrow(
      /DOLORES_WORKSPACE_ID/,
    );
  });
});

// ---------------------------------------------------------------------------
// MCP protocol tests (stubbed fetch)
// ---------------------------------------------------------------------------

describe("MCP server tool registration", () => {
  it("lists exactly two tools: remember and recall", async () => {
    const { client, cleanup } = await makeClient(cfg());
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(["recall", "remember"]);
    } finally {
      await cleanup();
    }
  });
});

describe("remember tool", () => {
  it("returns isError when the daemon is unreachable", async () => {
    stubFetch(() => Promise.reject(new Error("ECONNREFUSED 127.0.0.1:4505")));
    const result = await call(cfg(), "remember", { content: "test memory" });
    expect(isErr(result)).toBe(true);
    expect(textOf(result)).toMatch(/daemon/i);
  });

  it("returns the memory id on success", async () => {
    stubFetch(() => Promise.resolve(jsonResponse({ id: "mem_abc", deduped: false })));
    const result = await call(cfg(), "remember", { content: "pnpm workspace kullanıyoruz" });
    expect(isErr(result)).toBe(false);
    expect(textOf(result)).toContain("mem_abc");
  });
});

describe("recall tool", () => {
  it("returns isError when the daemon is unreachable", async () => {
    stubFetch(() => Promise.reject(new Error("fetch failed")));
    expect(isErr(await call(cfg(), "recall", { query: "embedding strategy" }))).toBe(true);
  });

  it("returns formatted hits on success", async () => {
    stubFetch(() => Promise.resolve(jsonResponse(recallFixture)));
    const result = await call(cfg(), "recall", { query: "database" });
    expect(isErr(result)).toBe(false);
    expect(textOf(result)).toContain("pgvector kullanıyoruz");
  });
});

describe("authorization header", () => {
  it.each([
    ["remember", { content: "x" }, { id: "m1", deduped: false }],
    ["recall", { query: "x" }, recallFixture],
  ] as const)(
    "%s sends Bearer when configured and nothing when absent",
    async (tool, args, body) => {
      const withAuth = stubFetch(() => Promise.resolve(jsonResponse(body)));
      expect(isErr(await call(cfg({ DOLORES_AUTH_TOKEN: TOKEN }), tool, args))).toBe(false);
      expect(authHeaderOf(withAuth)).toBe(`Bearer ${TOKEN}`);

      const noAuth = stubFetch(() => Promise.resolve(jsonResponse(body)));
      expect(isErr(await call(cfg(), tool, args))).toBe(false);
      expect(authHeaderOf(noAuth)).toBeNull();
    },
  );

  it("captures config at creation, unaffected by later env mutation", async () => {
    vi.stubEnv("DOLORES_WORKSPACE_ID", WS);
    vi.stubEnv("DOLORES_USER_ID", "22222222-2222-4222-8222-222222222222");
    vi.stubEnv("DOLORES_AUTH_TOKEN", "first-token");
    const { client, cleanup } = await makeClient(loadMcpConfig());
    vi.stubEnv("DOLORES_WORKSPACE_ID", "33333333-3333-4333-8333-333333333333");
    vi.stubEnv("DOLORES_USER_ID", "44444444-4444-4444-8444-444444444444");
    vi.stubEnv("DOLORES_AUTH_TOKEN", "second-token");
    vi.stubEnv("DOLORES_DAEMON_HOST", "bad host!");
    const fn = stubFetch(() => Promise.resolve(jsonResponse({ id: "m1", deduped: false })));
    try {
      const result = await client.callTool({ name: "remember", arguments: { content: "x" } });
      expect(isErr(result)).toBe(false);
      expect(authHeaderOf(fn)).toBe("Bearer first-token");
      expect(String(fn.mock.calls[0]?.[0])).toContain("127.0.0.1:4505");
      expect(JSON.parse(String(fn.mock.calls[0]?.[1]?.body))).toEqual({
        workspaceId: WS,
        userId: "22222222-2222-4222-8222-222222222222",
        content: "x",
      });
    } finally {
      await cleanup();
    }
  });
});

describe("malformed daemon responses", () => {
  it.each(["remember", "recall"] as const)("%s: invalid JSON returns isError", async (tool) => {
    stubFetch(() => Promise.resolve(new Response("{not json", { status: 200 })));
    const args = tool === "remember" ? { content: "x" } : { query: "x" };
    const result = await call(cfg(), tool, args);
    expect(isErr(result)).toBe(true);
    expect(textOf(result)).toMatch(/JSON/);
  });

  it.each(["remember", "recall"] as const)(
    "%s: valid JSON with wrong shape returns isError",
    async (tool) => {
      const wrong =
        tool === "remember" ? { id: 42 } : { hits: [{ id: "h1", content: "x" }], tokenEstimate: 1 };
      stubFetch(() => Promise.resolve(jsonResponse(wrong)));
      const args = tool === "remember" ? { content: "x" } : { query: "x" };
      const result = await call(cfg(), tool, args);
      expect(isErr(result)).toBe(true);
      expect(textOf(result)).toMatch(/beklenmeyen/);
    },
  );
});

describe("token redaction", () => {
  it("redacts a token reflected in an HTTP error body", async () => {
    stubFetch(() =>
      Promise.resolve(new Response(`unauthorized: Bearer ${TOKEN} raw=${TOKEN}`, { status: 401 })),
    );
    const result = await call(cfg({ DOLORES_AUTH_TOKEN: TOKEN }), "recall", { query: "x" });
    expect(isErr(result)).toBe(true);
    const text = textOf(result);
    expect(text).toContain("401");
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain(TOKEN);
  });

  it("redacts a token reflected in a network error", async () => {
    stubFetch(() => Promise.reject(new Error(`socket hang up (auth ${TOKEN})`)));
    const result = await call(cfg({ DOLORES_AUTH_TOKEN: TOKEN }), "remember", { content: "x" });
    expect(isErr(result)).toBe(true);
    expect(textOf(result)).not.toContain(TOKEN);
    expect(textOf(result)).toContain("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// Real loopback HTTP (no stubbed fetch)
// ---------------------------------------------------------------------------

describe("end-to-end over loopback HTTP", () => {
  it("tool → HTTP → daemon stub requiring Bearer", async () => {
    const seen: string[] = [];
    const port = await listen((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401).end("missing auth");
        return;
      }
      req.resume();
      req.on("end", () => {
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify(recallFixture));
      });
    });

    const ok = await call(
      cfg({ DOLORES_DAEMON_PORT: String(port), DOLORES_AUTH_TOKEN: TOKEN }),
      "recall",
      {
        query: "db",
      },
    );
    expect(isErr(ok)).toBe(false);
    expect(textOf(ok)).toContain("pgvector kullanıyoruz");

    const denied = await call(cfg({ DOLORES_DAEMON_PORT: String(port) }), "recall", {
      query: "db",
    });
    expect(isErr(denied)).toBe(true);
    expect(textOf(denied)).toContain("401");
    expect(seen.every((s) => s.startsWith("POST "))).toBe(true);
  });

  it("times out when the daemon stalls before headers", async () => {
    const port = await listen(() => {
      /* never respond */
    });
    const result = await call(
      cfg({ DOLORES_DAEMON_PORT: String(port), DOLORES_REQUEST_TIMEOUT_MS: "150" }),
      "remember",
      { content: "x" },
    );
    expect(isErr(result)).toBe(true);
    expect(textOf(result)).toMatch(/zaman aşımı/);
  });

  it("times out when the daemon stalls mid-body", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"hits":[');
    });
    const result = await call(
      cfg({ DOLORES_DAEMON_PORT: String(port), DOLORES_REQUEST_TIMEOUT_MS: "150" }),
      "recall",
      { query: "x" },
    );
    expect(isErr(result)).toBe(true);
    expect(textOf(result)).toMatch(/zaman aşımı/);
  });
});
