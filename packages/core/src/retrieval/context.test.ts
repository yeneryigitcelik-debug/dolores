import { describe, expect, it } from "vitest";
import type { Fact } from "../types.js";
import { renderContext } from "./context.js";
import { tokenEstimate } from "./tokens.js";

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

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = ["a", "b", "z", " ", "ç", "ğ", "ş", "日", "本", "😀", "é", "-", ":"];

function randText(r: () => number, max: number): string {
  const n = Math.floor(r() * max);
  let s = "";
  for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(r() * ALPHABET.length)] ?? "a";
  return s;
}

interface Mem {
  content: string;
  importance: number;
}

function assertInvariants(
  text: string,
  est: number,
  budget: number,
  facts: Fact[],
  memories: Mem[],
): void {
  expect(est).toBe(tokenEstimate(text));
  expect(est).toBeLessThanOrEqual(Math.max(0, Math.floor(budget)));
  if (text === "") return;
  const lines = text.split("\n");
  let i = 0;
  let factCount = 0;
  if (lines[i] === "# Facts") {
    i++;
    while (i < lines.length && lines[i] !== "# Memories") {
      const f = facts[factCount];
      expect(f).toBeDefined();
      expect(lines[i]).toBe(`- [${f?.category}] ${f?.key}: ${f?.value}`);
      factCount++;
      i++;
    }
    expect(factCount).toBeGreaterThan(0);
  }
  if (i < lines.length) {
    expect(lines[i]).toBe("# Memories");
    i++;
    let memCount = 0;
    while (i < lines.length) {
      const m = memories[memCount];
      expect(m).toBeDefined();
      expect(lines[i]).toBe(`- (${m?.importance}) ${m?.content}`);
      memCount++;
      i++;
    }
    expect(memCount).toBeGreaterThan(0);
  }
}

describe("renderContext budget accounting", () => {
  it("counts newlines: header + 3 short facts at budget 11 stays within 11 (old returned 12)", () => {
    const facts = [fact("xy", "a1", "1"), fact("xy", "a2", "1"), fact("xy", "a3", "1")];
    const { text, tokenEstimate: est } = renderContext(facts, [], 11);
    expect(est).toBeLessThanOrEqual(11);
    expect(est).toBe(tokenEstimate(text));
    expect(text.startsWith("# Facts\n")).toBe(true);
    expect(text.split("\n")).toHaveLength(3);
  });

  it("budget 0, negative and NaN render nothing", () => {
    const facts = [fact("a", "b", "c")];
    const mems = [{ content: "x", importance: 5 }];
    for (const b of [0, -5, Number.NaN, Number.NEGATIVE_INFINITY]) {
      expect(renderContext(facts, mems, b)).toEqual({ text: "", tokenEstimate: 0 });
    }
  });

  it("fractional budgets are floored", () => {
    const facts = Array.from({ length: 20 }, (_, i) => fact("c", `k${i}`, "v"));
    const { tokenEstimate: est } = renderContext(facts, [], 7.9);
    expect(est).toBeLessThanOrEqual(7);
  });

  it("infinite budget renders everything", () => {
    const facts = [fact("a", "b", "c")];
    const mems = [{ content: "m", importance: 3 }];
    const { text } = renderContext(facts, mems, Number.POSITIVE_INFINITY);
    expect(text).toBe("# Facts\n- [a] b: c\n# Memories\n- (3) m");
  });

  it("empty inputs render empty", () => {
    expect(renderContext([], [], 1000)).toEqual({ text: "", tokenEstimate: 0 });
  });

  it("memories header never appears without a memory line", () => {
    const facts = [fact("a", "b", "c")];
    const mems = [{ content: "x".repeat(200), importance: 9 }];
    const { text } = renderContext(facts, mems, 10);
    expect(text).not.toContain("# Memories");
    expect(text).toContain("# Facts");
  });

  it("memories still fill budget when facts are empty", () => {
    const { text } = renderContext([], [{ content: "hi", importance: 1 }], 1000);
    expect(text).toBe("# Memories\n- (1) hi");
  });

  it("handles a large fact list quickly", () => {
    const facts = Array.from({ length: 20000 }, (_, i) => fact("p", `k${i}`, `v${i}`));
    const start = Date.now();
    const { text, tokenEstimate: est } = renderContext(facts, [], 1000);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(est).toBeLessThanOrEqual(1000);
    expect(est).toBe(tokenEstimate(text));
  });

  it("property: random unicode facts/memories across budgets 0..1000 keep invariants", () => {
    const r = rng(42);
    for (let iter = 0; iter < 400; iter++) {
      const nf = Math.floor(r() * 12);
      const nm = Math.floor(r() * 12);
      const facts = Array.from({ length: nf }, (_, i) =>
        fact(randText(r, 8), `${randText(r, 6)}${i}`, randText(r, 40)),
      );
      const memories: Mem[] = Array.from({ length: nm }, () => ({
        content: randText(r, 80),
        importance: 1 + Math.floor(r() * 10),
      }));
      const budget = iter < 60 ? iter : Math.floor(r() * 1001);
      const { text, tokenEstimate: est } = renderContext(facts, memories, budget);
      assertInvariants(text, est, budget, facts, memories);
    }
  });
});
