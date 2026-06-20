import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, recallInputSchema, rememberInputSchema } from "./server.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helper: spin up a fresh server+client pair over InMemoryTransport
// ---------------------------------------------------------------------------

async function makeClient(): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    cleanup: async () => {
      await client.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Schema validation (pure zod — no network)
// ---------------------------------------------------------------------------

describe("rememberInputSchema", () => {
  it("requires content", () => {
    expect(rememberInputSchema.safeParse({}).success).toBe(false);
  });

  it("accepts valid input with all fields", () => {
    const result = rememberInputSchema.safeParse({
      content: "TypeScript kullanıyoruz",
      scope: "workspace",
      importance: 7,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown scope value", () => {
    expect(rememberInputSchema.safeParse({ content: "x", scope: "team" }).success).toBe(false);
  });

  it("rejects importance above 10", () => {
    expect(rememberInputSchema.safeParse({ content: "x", importance: 11 }).success).toBe(false);
  });

  it("rejects importance below 1", () => {
    expect(rememberInputSchema.safeParse({ content: "x", importance: 0 }).success).toBe(false);
  });
});

describe("recallInputSchema", () => {
  it("requires query", () => {
    expect(recallInputSchema.safeParse({}).success).toBe(false);
  });

  it("accepts valid input", () => {
    expect(recallInputSchema.safeParse({ query: "embedding", limit: 5 }).success).toBe(true);
  });

  it("rejects limit above 20", () => {
    expect(recallInputSchema.safeParse({ query: "x", limit: 25 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MCP protocol tests (InMemoryTransport)
// ---------------------------------------------------------------------------

describe("MCP server tool registration", () => {
  it("lists exactly two tools: remember and recall", async () => {
    const { client, cleanup } = await makeClient();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("remember");
      expect(names).toContain("recall");
      expect(tools).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });
});

describe("remember tool", () => {
  it("returns isError:true when the daemon is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:4505")));

    const { client, cleanup } = await makeClient();
    try {
      const result = await client.callTool({
        name: "remember",
        arguments: { content: "test memory" },
      });
      expect(result.isError).toBe(true);
      const firstContent = result.content[0] as { type: string; text: string };
      expect(firstContent.type).toBe("text");
      expect(firstContent.text).toMatch(/daemon/i);
    } finally {
      await cleanup();
    }
  });

  it("returns the memory id on a successful daemon response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "mem_abc", deduped: false }),
      }),
    );

    const { client, cleanup } = await makeClient();
    try {
      const result = await client.callTool({
        name: "remember",
        arguments: { content: "pnpm workspace kullanıyoruz" },
      });
      expect(result.isError).toBeFalsy();
      const firstContent = result.content[0] as { type: string; text: string };
      expect(firstContent.text).toContain("mem_abc");
    } finally {
      await cleanup();
    }
  });
});

describe("recall tool", () => {
  it("returns isError:true when the daemon is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fetch failed")));

    const { client, cleanup } = await makeClient();
    try {
      const result = await client.callTool({
        name: "recall",
        arguments: { query: "embedding strategy" },
      });
      expect(result.isError).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("returns formatted hits on a successful daemon response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
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
          }),
      }),
    );

    const { client, cleanup } = await makeClient();
    try {
      const result = await client.callTool({
        name: "recall",
        arguments: { query: "database" },
      });
      expect(result.isError).toBeFalsy();
      const firstContent = result.content[0] as { type: string; text: string };
      expect(firstContent.text).toContain("pgvector kullanıyoruz");
    } finally {
      await cleanup();
    }
  });
});
