import { describe, expect, it } from "vitest";
import { extractFromText } from "./extract.js";
import type { LlmProvider } from "./provider.js";

function stubProvider(reply: string): LlmProvider {
  return { id: "stub", complete: async () => reply };
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
    const provider: LlmProvider = {
      id: "boom",
      complete: async () => {
        throw new Error("rate limited");
      },
    };
    const res = await extractFromText("x", { enabled: true, provider });
    expect(res).toEqual({ facts: [], memories: [] });
  });

  it("drops invalid items via schema validation", async () => {
    const provider = stubProvider(
      JSON.stringify({
        facts: [{ category: "stack", key: "db" }], // missing value → invalid item
        memories: [],
      }),
    );
    const res = await extractFromText("x", { enabled: true, provider });
    // The only item is invalid → dropped per-item → graceful empty.
    expect(res).toEqual({ facts: [], memories: [] });
  });

  it("keeps valid items when a sibling item is malformed (per-item resilience)", async () => {
    const provider = stubProvider(
      JSON.stringify({
        facts: [
          { category: "stack", key: "db", value: "Postgres" }, // valid
          { category: "stack", key: "broken" }, // missing value → invalid
        ],
        memories: [
          { content: "ships on fridays" }, // valid
          { importance: 5 }, // missing content → invalid
        ],
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
          { category: "stack", key: "cache", value: "Redis", confidence: 0.2 }, // below floor
          { category: "preference", key: "editor", value: "vim" }, // no confidence → kept
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
