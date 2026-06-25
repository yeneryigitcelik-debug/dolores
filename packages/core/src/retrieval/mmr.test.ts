import { describe, expect, it } from "vitest";
import { type MmrCandidate, cosine, mmrSelect } from "./mmr.js";

describe("cosine", () => {
  it("is 1 for identical, 0 for orthogonal", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1, 6);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });
  it("returns 0 on a zero vector (no NaN)", () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe("mmrSelect", () => {
  const c = (id: string, score: number, embedding: number[] | null): MmrCandidate => ({
    id,
    score,
    embedding,
  });

  it("λ=1 is identity — a pure-relevance slice", () => {
    const cands = [c("a", 0.9, [1, 0]), c("b", 0.8, [1, 0]), c("c", 0.7, [0, 1])];
    expect(mmrSelect(cands, 1, 2).map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("diversifies: a slightly-less-relevant DIFFERENT item beats a near-duplicate", () => {
    // a,b are near-identical; c is orthogonal but lower-scored. With λ=0.5, after
    // picking a, the redundancy penalty sinks b and the diverse c wins second.
    const cands = [c("a", 0.95, [1, 0]), c("b", 0.9, [1, 0.01]), c("c", 0.8, [0, 1])];
    const picked = mmrSelect(cands, 0.5, 2).map((x) => x.id);
    expect(picked[0]).toBe("a");
    expect(picked[1]).toBe("c");
  });

  it("treats a missing embedding as maximally diverse (never throws)", () => {
    const cands = [c("a", 0.9, [1, 0]), c("b", 0.8, null)];
    const picked = mmrSelect(cands, 0.5, 2).map((x) => x.id);
    expect(picked).toContain("a");
    expect(picked).toContain("b");
  });
});
