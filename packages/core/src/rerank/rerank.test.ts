import { describe, expect, it } from "vitest";
import type { RerankCandidate } from "../types.js";
import { createReranker } from "./factory.js";
import { NoOpReranker } from "./noop.js";

describe("NoOpReranker", () => {
  it("returns candidates unchanged (identity) and reports id 'noop'", async () => {
    const r = new NoOpReranker();
    const cands: RerankCandidate[] = [
      { id: "a", content: "x", score: 0.9 },
      { id: "b", content: "y", score: 0.5 },
    ];
    expect(r.id).toBe("noop");
    expect(await r.rerank("q", cands)).toBe(cands);
  });
});

describe("createReranker", () => {
  it("returns NoOp for noop / empty / undefined", () => {
    expect(createReranker("noop").id).toBe("noop");
    expect(createReranker("").id).toBe("noop");
    expect(createReranker(undefined).id).toBe("noop");
  });

  it("falls back to NoOp on an unknown kind", () => {
    expect(createReranker("magic-model").id).toBe("noop");
  });
});
