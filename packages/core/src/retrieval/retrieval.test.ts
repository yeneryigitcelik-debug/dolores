import { describe, expect, it } from "vitest";
import type { Fact } from "../types.js";
import { renderContext } from "./context.js";
import { fuseRrf } from "./rrf.js";
import { clampImportance, toVectorLiteral } from "./sql.js";
import { tokenEstimate } from "./tokens.js";

describe("tokenEstimate", () => {
  it("is ~length/4 and zero for empty", () => {
    expect(tokenEstimate("")).toBe(0);
    expect(tokenEstimate("abcd")).toBe(1);
    expect(tokenEstimate("abcde")).toBe(2);
  });
});

describe("toVectorLiteral / clampImportance", () => {
  it("renders a pgvector literal", () => {
    expect(toVectorLiteral([0.1, 0.2, -0.3])).toBe("[0.1,0.2,-0.3]");
  });
  it("clamps importance into 1..10", () => {
    expect(clampImportance(undefined)).toBe(5);
    expect(clampImportance(0)).toBe(1);
    expect(clampImportance(99)).toBe(10);
    expect(clampImportance(7)).toBe(7);
    expect(clampImportance(Number.NaN)).toBe(5);
  });
});

describe("fuseRrf", () => {
  it("rewards documents ranked highly by BOTH arms", () => {
    const vector = ["a", "b", "c"];
    const fullText = ["b", "a", "d"];
    const fused = fuseRrf([vector, fullText]);
    // 'a' (#1 + #2) and 'b' (#2 + #1) appear in both → outrank single-arm hits.
    expect(fused[0]?.id === "a" || fused[0]?.id === "b").toBe(true);
    const ids = fused.map((f) => f.id);
    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("d"));
    expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("c"));
  });

  it("normalises scores into 0..1, top-of-both ~1.0", () => {
    const fused = fuseRrf([
      ["x", "y"],
      ["x", "z"],
    ]);
    const x = fused.find((f) => f.id === "x");
    expect(x?.score).toBeCloseTo(1, 5); // rank #1 in both active arms
    for (const f of fused) {
      expect(f.score).toBeGreaterThan(0);
      expect(f.score).toBeLessThanOrEqual(1);
    }
  });

  it("single active arm still tops out at 1.0 (noop / full-text only)", () => {
    const fused = fuseRrf([[], ["only", "second"]]);
    expect(fused[0]?.id).toBe("only");
    expect(fused[0]?.score).toBeCloseTo(1, 5);
  });

  it("respects limit", () => {
    expect(fuseRrf([["a", "b", "c", "d"]], { limit: 2 })).toHaveLength(2);
  });
});

describe("renderContext", () => {
  const fact = (category: string, key: string, value: string): Fact => ({
    id: `${category}:${key}`,
    workspaceId: "w",
    userId: null,
    scope: "personal",
    category,
    key,
    value,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  it("renders facts then memories with headers", () => {
    const { text, tokenEstimate: est } = renderContext(
      [fact("stack", "lang", "TypeScript")],
      [{ content: "prefers pnpm", importance: 8 }],
      600,
    );
    expect(text).toContain("# Facts");
    expect(text).toContain("- [stack] lang: TypeScript");
    expect(text).toContain("# Memories");
    expect(text).toContain("- (8) prefers pnpm");
    expect(est).toBe(tokenEstimate(text));
  });

  it("respects the token budget and emits no dangling headers", () => {
    const facts = Array.from({ length: 50 }, (_, i) =>
      fact("project", `k${i}`, `value number ${i} with some length`),
    );
    const { text, tokenEstimate: est } = renderContext(facts, [], 30);
    expect(est).toBeLessThanOrEqual(30);
    // If "# Memories" appears, at least one memory line must follow it.
    expect(text).not.toContain("# Memories");
  });

  it("is empty when there is nothing to render", () => {
    expect(renderContext([], [], 600)).toEqual({ text: "", tokenEstimate: 0 });
  });
});
