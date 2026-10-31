import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Embedder, MemoryContext } from "../types.js";
import {
  DEFAULT_EXTRACTION_TIMEOUT_MS,
  ExtractionError,
  MAX_EXTRACTION_TIMEOUT_MS,
  extractFromText,
  ingestText,
  resolveExtractionProvider,
  resolveExtractionTimeoutMs,
} from "./extract.js";
import type { LlmProvider } from "./provider.js";

function stubProvider(reply: string): LlmProvider {
  return { id: "stub", complete: async () => reply };
}

function throwingProvider(message: string): LlmProvider {
  return {
    id: "boom",
    complete: async () => {
      throw new Error(message);
    },
  };
}

describe("extractFromText", () => {
  it("is a graceful no-op when disabled", async () => {
    const res = await extractFromText("anything", { enabled: false });
    expect(res).toEqual({ facts: [], memories: [] });
  });

  it("no-ops with no provider even when enabled", async () => {
    const res = await extractFromText("text", { enabled: true, provider: null });
    expect(res).toEqual({ facts: [], memories: [] });
  });

  it("no-ops on empty input", async () => {
    const res = await extractFromText("   ", { enabled: true, provider: stubProvider("{}") });
    expect(res).toEqual({ facts: [], memories: [] });
  });

  it("parses a well-formed LLM payload", async () => {
    const provider = stubProvider(
      JSON.stringify({
        facts: [{ category: "stack", key: "db", value: "Postgres" }],
        memories: [{ content: "ships on Fridays", importance: 7, scope: "workspace" }],
      }),
    );
    const res = await extractFromText("we use postgres, ship fridays", {
      enabled: true,
      provider,
      source: "conv-1",
    });
    expect(res.facts).toEqual([
      { category: "stack", key: "db", value: "Postgres", scope: undefined },
    ]);
    expect(res.memories[0]).toMatchObject({
      content: "ships on Fridays",
      importance: 7,
      scope: "workspace",
      source: "conv-1",
    });
  });

  it("recovers JSON wrapped in prose / code fences", async () => {
    const provider = stubProvider(
      'Sure! Here you go:\n```json\n{"facts":[{"category":"preference","key":"editor","value":"vim"}],"memories":[]}\n```',
    );
    const res = await extractFromText("uses vim", { enabled: true, provider });
    expect(res.facts).toEqual([
      { category: "preference", key: "editor", value: "vim", scope: undefined },
    ]);
  });

  it("degrades to no-op on unparseable output", async () => {
    const res = await extractFromText("x", { enabled: true, provider: stubProvider("not json") });
    expect(res).toEqual({ facts: [], memories: [] });
  });

  it("degrades to no-op when the provider throws", async () => {
    const res = await extractFromText("x", {
      enabled: true,
      provider: throwingProvider("rate limited"),
    });
    expect(res).toEqual({ facts: [], memories: [] });
  });

  it("drops invalid items via schema validation", async () => {
    const provider = stubProvider(
      JSON.stringify({
        facts: [{ category: "stack", key: "db" }],
        memories: [],
      }),
    );
    const res = await extractFromText("x", { enabled: true, provider });
    expect(res).toEqual({ facts: [], memories: [] });
  });

  it("keeps valid items when a sibling item is malformed (per-item resilience)", async () => {
    const provider = stubProvider(
      JSON.stringify({
        facts: [
          { category: "stack", key: "db", value: "Postgres" },
          { category: "stack", key: "broken" },
        ],
        memories: [{ content: "ships on fridays" }, { importance: 5 }],
      }),
    );
    const res = await extractFromText("x", { enabled: true, provider });
    expect(res.facts).toEqual([
      { category: "stack", key: "db", value: "Postgres", scope: undefined },
    ]);
    expect(res.memories).toHaveLength(1);
    expect(res.memories[0]?.content).toBe("ships on fridays");
  });

  it("drops items below the confidence floor but keeps confidence-less items", async () => {
    const provider = stubProvider(
      JSON.stringify({
        facts: [
          { category: "stack", key: "db", value: "Postgres", confidence: 0.95 },
          { category: "stack", key: "cache", value: "Redis", confidence: 0.2 },
          { category: "preference", key: "editor", value: "vim" },
        ],
        memories: [],
      }),
    );
    const res = await extractFromText("x", { enabled: true, provider, minConfidence: 0.5 });
    const values = res.facts.map((f) => f.value);
    expect(values).toContain("Postgres");
    expect(values).toContain("vim");
    expect(values).not.toContain("Redis");
  });

  it("renders knownFacts into the system prompt for contradiction alignment", async () => {
    let capturedSystem = "";
    const provider: LlmProvider = {
      id: "rec",
      complete: async ({ system }) => {
        capturedSystem = system ?? "";
        return '{"facts":[],"memories":[]}';
      },
    };
    await extractFromText("we switched db to mysql", {
      enabled: true,
      provider,
      knownFacts: [{ category: "stack", key: "db", value: "Postgres" }],
    });
    expect(capturedSystem).toContain("[stack] db: Postgres");
    expect(capturedSystem).toContain("SAME category+key");
  });
});

describe("extractFromText — strict mode", () => {
  it("rejects when disabled", async () => {
    await expect(
      extractFromText("x", { enabled: false, strict: true, provider: stubProvider("{}") }),
    ).rejects.toMatchObject({ name: "ExtractionError", code: "EXTRACTION_DISABLED" });
  });

  it("rejects when no provider is available", async () => {
    await expect(
      extractFromText("x", { enabled: true, strict: true, provider: null }),
    ).rejects.toMatchObject({ code: "EXTRACTION_NO_PROVIDER" });
  });

  it("rejects with a generic message when the provider throws (no raw vendor text)", async () => {
    const secret = "sk-live-SECRET123 rate limited; transcript: my password is hunter2";
    let caught: unknown;
    try {
      await extractFromText("my password is hunter2", {
        enabled: true,
        strict: true,
        provider: throwingProvider(secret),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ExtractionError);
    const e = caught as ExtractionError;
    expect(e.code).toBe("EXTRACTION_PROVIDER_FAILED");
    expect(e.message).not.toContain("SECRET123");
    expect(e.message).not.toContain("hunter2");
  });

  it("rejects unparseable output", async () => {
    await expect(
      extractFromText("x", { enabled: true, strict: true, provider: stubProvider("not json") }),
    ).rejects.toMatchObject({ code: "EXTRACTION_INVALID_OUTPUT" });
  });

  it("rejects an invalid top-level shape", async () => {
    for (const reply of ['{"facts":"nope"}', "{}", '{"memories":{}}', "[1,2]"]) {
      await expect(
        extractFromText("x", { enabled: true, strict: true, provider: stubProvider(reply) }),
      ).rejects.toMatchObject({ code: "EXTRACTION_INVALID_OUTPUT" });
    }
  });

  it("treats a legitimate empty result as success", async () => {
    const res = await extractFromText("chit chat", {
      enabled: true,
      strict: true,
      provider: stubProvider('{"facts":[],"memories":[]}'),
    });
    expect(res).toEqual({ facts: [], memories: [] });
  });

  it("still returns parsed items in strict mode", async () => {
    const res = await extractFromText("x", {
      enabled: true,
      strict: true,
      provider: stubProvider('{"facts":[{"category":"stack","key":"db","value":"pg"}]}'),
    });
    expect(res.facts).toHaveLength(1);
    expect(res.memories).toEqual([]);
  });

  it("rejects a schema-invalid fact item instead of dropping it", async () => {
    const reply = JSON.stringify({
      facts: [
        { category: "stack", key: "db", value: "Postgres" },
        { category: "stack", key: "broken" },
      ],
      memories: [],
    });
    await expect(
      extractFromText("x", { enabled: true, strict: true, provider: stubProvider(reply) }),
    ).rejects.toMatchObject({ name: "ExtractionError", code: "EXTRACTION_INVALID_OUTPUT" });
  });

  it("rejects a schema-invalid memory item instead of dropping it", async () => {
    const reply = JSON.stringify({
      facts: [],
      memories: [{ content: "ships on fridays" }, { importance: 5 }],
    });
    await expect(
      extractFromText("x", { enabled: true, strict: true, provider: stubProvider(reply) }),
    ).rejects.toMatchObject({ code: "EXTRACTION_INVALID_OUTPUT" });
  });

  it("still applies confidence filtering and caps intentionally (no rejection)", async () => {
    const reply = JSON.stringify({
      facts: [
        { category: "stack", key: "db", value: "Postgres", confidence: 0.95 },
        { category: "stack", key: "cache", value: "Redis", confidence: 0.2 },
        { category: "stack", key: "queue", value: "SQS", confidence: 0.9 },
      ],
      memories: [{ content: "low confidence note", confidence: 0.1 }],
    });
    const res = await extractFromText("x", {
      enabled: true,
      strict: true,
      provider: stubProvider(reply),
      minConfidence: 0.5,
      maxFacts: 1,
    });
    expect(res.facts).toEqual([
      { category: "stack", key: "db", value: "Postgres", scope: undefined },
    ]);
    expect(res.memories).toEqual([]);
  });

  it("preserves omitted scopes (no personal default injected)", async () => {
    const res = await extractFromText("x", {
      enabled: true,
      strict: true,
      provider: stubProvider(
        '{"facts":[{"category":"stack","key":"db","value":"pg"}],"memories":[{"content":"note"}]}',
      ),
    });
    expect(res.facts[0]?.scope).toBeUndefined();
    expect(res.memories[0]?.scope).toBeUndefined();
  });
});

describe("resolveExtractionProvider", () => {
  it("returns null when disabled even with a provider", () => {
    expect(resolveExtractionProvider({ enabled: false, provider: stubProvider("{}") })).toBeNull();
  });

  it("returns null for an explicit null provider", () => {
    expect(resolveExtractionProvider({ enabled: true, provider: null })).toBeNull();
  });

  it("returns the injected provider when enabled", () => {
    const p = stubProvider("{}");
    expect(resolveExtractionProvider({ enabled: true, provider: p })).toBe(p);
  });
});

describe("extractFromText — deadline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function hangingProvider(): { provider: LlmProvider; signal: () => AbortSignal | undefined } {
    let captured: AbortSignal | undefined;
    return {
      provider: {
        id: "hang",
        complete: ({ signal }) => {
          captured = signal;
          return new Promise<string>(() => undefined);
        },
      },
      signal: () => captured,
    };
  }

  it("strict: a never-resolving provider times out and its signal is aborted", async () => {
    vi.useFakeTimers();
    const h = hangingProvider();
    const p = extractFromText("x", {
      enabled: true,
      strict: true,
      provider: h.provider,
      timeoutMs: 1000,
    });
    const assertion = expect(p).rejects.toMatchObject({
      name: "ExtractionError",
      code: "EXTRACTION_TIMEOUT",
      message: "extraction LLM call timed out",
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(h.signal()?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(h.signal()?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["reject", "resolve"] as const)(
    "deadline takes precedence when an abort-aware provider settles with %s",
    async (mode) => {
      vi.useFakeTimers();
      const provider: LlmProvider = {
        id: "abort-aware",
        complete: ({ signal }) =>
          new Promise<string>((resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                if (mode === "reject") reject(new Error("vendor abort detail"));
                else resolve('{"facts":[],"memories":[]}');
              },
              { once: true },
            );
          }),
      };
      const assertion = expect(
        extractFromText("x", { enabled: true, strict: true, provider, timeoutMs: 1000 }),
      ).rejects.toMatchObject({ code: "EXTRACTION_TIMEOUT" });
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("graceful: a timeout degrades to EMPTY", async () => {
    vi.useFakeTimers();
    const h = hangingProvider();
    const p = extractFromText("x", { enabled: true, provider: h.provider, timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    await expect(p).resolves.toEqual({ facts: [], memories: [] });
    expect(h.signal()?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a fast success clears the deadline; a later clock advance never aborts", async () => {
    vi.useFakeTimers();
    let captured: AbortSignal | undefined;
    const provider: LlmProvider = {
      id: "fast",
      complete: async ({ signal }) => {
        captured = signal;
        return '{"facts":[{"category":"stack","key":"db","value":"pg"}],"memories":[]}';
      },
    };
    const res = await extractFromText("x", {
      enabled: true,
      strict: true,
      provider,
      timeoutMs: 1000,
    });
    expect(res.facts).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(captured).toBeDefined();
    expect(captured?.aborted).toBe(false);
  });

  it("a synchronous provider throw stays a generic provider failure", async () => {
    vi.useFakeTimers();
    const provider: LlmProvider = {
      id: "sync",
      complete: () => {
        throw new Error("sync sk-SECRET");
      },
    };
    await expect(
      extractFromText("x", { enabled: true, strict: true, provider, timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "EXTRACTION_PROVIDER_FAILED" });
    expect(vi.getTimerCount()).toBe(0);
    await expect(
      extractFromText("x", { enabled: true, provider, timeoutMs: 1000 }),
    ).resolves.toEqual({ facts: [], memories: [] });
  });

  it("a late provider rejection after the timeout is absorbed", async () => {
    vi.useFakeTimers();
    const provider: LlmProvider = {
      id: "late",
      complete: () =>
        new Promise<string>((_, reject) => {
          setTimeout(() => reject(new Error("late")), 5000);
        }),
    };
    const p = extractFromText("x", { enabled: true, strict: true, provider, timeoutMs: 1000 });
    const assertion = expect(p).rejects.toMatchObject({ code: "EXTRACTION_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    await vi.advanceTimersByTimeAsync(5000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves the timeout from env with default, invalid, and upper bound", () => {
    expect(resolveExtractionTimeoutMs(undefined, {})).toBe(DEFAULT_EXTRACTION_TIMEOUT_MS);
    expect(DEFAULT_EXTRACTION_TIMEOUT_MS).toBe(30_000);
    expect(MAX_EXTRACTION_TIMEOUT_MS).toBe(300_000);
    for (const bad of ["", "  ", "abc", "0", "-5", "Infinity", "NaN"]) {
      expect(resolveExtractionTimeoutMs(undefined, { DOLORES_EXTRACTION_TIMEOUT_MS: bad })).toBe(
        30_000,
      );
    }
    expect(resolveExtractionTimeoutMs(undefined, { DOLORES_EXTRACTION_TIMEOUT_MS: "1500.9" })).toBe(
      1500,
    );
    expect(
      resolveExtractionTimeoutMs(undefined, { DOLORES_EXTRACTION_TIMEOUT_MS: "999999999" }),
    ).toBe(300_000);
  });

  it("an explicit override wins, is clamped, and invalid overrides fall back", () => {
    const env = { DOLORES_EXTRACTION_TIMEOUT_MS: "2000" };
    expect(resolveExtractionTimeoutMs(500, env)).toBe(500);
    expect(resolveExtractionTimeoutMs(1e9, env)).toBe(300_000);
    expect(resolveExtractionTimeoutMs(Number.NaN, env)).toBe(2000);
    expect(resolveExtractionTimeoutMs(0, env)).toBe(2000);
    expect(resolveExtractionTimeoutMs(-1, {})).toBe(30_000);
  });
});

describe("ingestText — privacy pre-validation (no DB)", () => {
  interface Harness {
    pool: Pool;
    embedder: Embedder;
    dbCalls: string[];
    embedCalls: () => number;
  }

  function harness(): Harness {
    const dbCalls: string[] = [];
    let embeds = 0;
    const fakePool = {
      connect: async (): Promise<never> => {
        dbCalls.push("connect");
        throw new Error("db must not be touched");
      },
      query: async (): Promise<never> => {
        dbCalls.push("query");
        throw new Error("db must not be touched");
      },
    };
    const embedder: Embedder = {
      id: "fixture:privacy",
      ready: async () => undefined,
      dim: 384,
      embed: async (texts: string[]): Promise<number[][]> => {
        embeds += 1;
        return texts.map(() => new Array<number>(384).fill(0.01));
      },
    };
    return {
      pool: fakePool as unknown as Pool,
      embedder,
      dbCalls,
      embedCalls: () => embeds,
    };
  }

  // No userId: personal writes are illegal in this context.
  const noUserCtx: MemoryContext = {
    workspaceId: "00000000-0000-0000-0000-0000000c0001",
    userId: null,
  };

  it("rejects explicit personal memory without a user before any write or embed", async () => {
    const h = harness();
    const provider = stubProvider(
      JSON.stringify({
        facts: [{ category: "stack", key: "db", value: "Postgres", scope: "workspace" }],
        memories: [{ content: "my private note", scope: "personal" }],
      }),
    );
    await expect(
      ingestText(h.pool, noUserCtx, h.embedder, "x", {
        enabled: true,
        strict: true,
        provider,
        knownFacts: [],
      }),
    ).rejects.toThrow(/personal' requires a userId/);
    expect(h.dbCalls).toEqual([]);
    expect(h.embedCalls()).toBe(0);
  });

  it("rejects explicit personal fact without a user before any write or embed", async () => {
    const h = harness();
    const provider = stubProvider(
      JSON.stringify({
        facts: [{ category: "preference", key: "editor", value: "vim", scope: "personal" }],
        memories: [{ content: "team ships on fridays", scope: "workspace" }],
      }),
    );
    await expect(
      ingestText(h.pool, noUserCtx, h.embedder, "x", {
        enabled: true,
        strict: true,
        provider,
        knownFacts: [],
      }),
    ).rejects.toThrow(/personal' requires a userId/);
    expect(h.dbCalls).toEqual([]);
    expect(h.embedCalls()).toBe(0);
  });
});
