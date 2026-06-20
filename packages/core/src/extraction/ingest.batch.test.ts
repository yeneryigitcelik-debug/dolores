/**
 * Unit tests for ingestText batch performance (no real DB needed).
 * Verifies that all memory contents are embedded in a single batch call.
 */
import { describe, expect, it, vi } from "vitest";
import type { Embedder, MemoryContext } from "../types.js";
import { ingestText } from "./extract.js";
import type { LlmProvider } from "./provider.js";

function makeCountingEmbedder(): { embedder: Embedder; callCount: () => number } {
  let calls = 0;
  const embedder: Embedder = {
    id: "mock-counting",
    dim: 2,
    ready: async () => {},
    embed: async (texts: string[]) => {
      calls++;
      return texts.map(() => [0.1, 0.2]);
    },
  };
  return { embedder, callCount: () => calls };
}

function stubProvider(memories: { content: string; importance?: number }[]): LlmProvider {
  const payload = JSON.stringify({ facts: [], memories });
  return { id: "stub", complete: async () => payload };
}

describe("ingestText batch embed", () => {
  it("embeds all memory contents in a single embed() call regardless of count", async () => {
    const { embedder, callCount } = makeCountingEmbedder();

    // Mock the pool: capture all queries without executing against a real DB.
    const queries: string[] = [];
    const mockPool = {
      connect: async () => ({
        query: async (sql: string, _params?: unknown[]) => {
          queries.push(typeof sql === "string" ? (sql.trim().split("\n")[0] ?? "") : "");
          // Fake RETURNING id responses for INSERT / SELECT
          if (sql.includes("RETURNING id")) return { rows: [{ id: "fake-id" }] };
          if (sql.includes("unnest")) return { rows: [] };
          return { rows: [] };
        },
        release: () => {},
      }),
    } as unknown as import("pg").Pool;

    const ctx: MemoryContext = { workspaceId: "test-batch-embed", userId: null };
    const provider = stubProvider([
      { content: "memory one", importance: 5 },
      { content: "memory two", importance: 6 },
      { content: "memory three", importance: 7 },
      { content: "memory four", importance: 8 },
      { content: "memory five", importance: 9 },
    ]);

    const summary = await ingestText(mockPool, ctx, embedder, "dummy text", {
      enabled: true,
      provider,
    });

    expect(summary.memoriesWritten).toBe(5);
    // Crucial: embed() called exactly once for all 5 memories.
    expect(callCount()).toBe(1);
  });

  it("returns correct IngestSummary shape and does not throw when embed fails", async () => {
    const brokenEmbedder: Embedder = {
      id: "broken",
      dim: 2,
      ready: async () => {},
      embed: async () => {
        throw new Error("ONNX exploded");
      },
    };

    const mockPool = {
      connect: async () => ({
        query: async (sql: string, _params?: unknown[]) => {
          if (sql.includes("RETURNING id")) return { rows: [{ id: "fake-id" }] };
          return { rows: [] };
        },
        release: () => {},
      }),
    } as unknown as import("pg").Pool;

    const ctx: MemoryContext = { workspaceId: "test-batch-embed-fail", userId: null };
    const provider = stubProvider([{ content: "memory with broken embed" }]);

    // Should NOT throw even when embed fails — degrades to full-text only.
    const summary = await ingestText(mockPool, ctx, brokenEmbedder, "text", {
      enabled: true,
      provider,
    });
    expect(summary.memoriesWritten).toBe(1);
    expect(summary.factsWritten).toBe(0);
  });
});
