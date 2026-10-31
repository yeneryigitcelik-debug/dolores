import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, loadMcpConfig } from "./server.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function callRemember(payload: unknown) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const server = createServer(
    loadMcpConfig({ DOLORES_WORKSPACE_ID: "11111111-1111-4111-8111-111111111111" }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "ack-fixture", version: "0.0.0" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "remember",
      arguments: { content: "Synthetic memory only" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    return result;
  } finally {
    await client.close();
    await server.close();
  }
}

describe("remember mutation ACK", () => {
  it.each(["", "   "])("blank string ID is an error, never a saved claim: %j", async (id) => {
    const result = await callRemember({ id, deduped: false, diagnostic: "ACK_BODY_SENTINEL" });
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).not.toContain("Kaydedildi");
    expect(text).not.toContain("ACK_BODY_SENTINEL");
    expect(text).toMatch(/doğrulanamadı/);
  });

  it.each([
    { id: "m1", deduped: false },
    { id: "mem_abc", deduped: true },
    { id: "  legacy id  ", deduped: false },
  ])("valid string ID remains compatible and unchanged: %j", async (payload) => {
    const result = await callRemember({ ...payload, futureField: true });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain(`id: ${payload.id}`);
    expect(JSON.stringify(result.content).includes("mevcut hafıza")).toBe(payload.deduped);
  });
});
