import type { Reranker } from "../types.js";
import { NoOpReranker } from "./noop.js";

/**
 * Build a reranker from a kind string (e.g. DOLORES_RERANKER).
 *
 * EXTENSION POINT: only "noop" (identity) exists today. To add a local
 * cross-encoder reranker — keeping recall LLM-free — implement the `Reranker`
 * interface (lazy-loading its model like the embedder / LLM providers do), add a
 * `RerankerKind`, and return it from a new `case` here. Unknown or absent kinds
 * fall back to NoOp so callers never break.
 */
export function createReranker(kind?: string): Reranker {
  switch ((kind ?? "").trim().toLowerCase()) {
    case "":
    case "noop":
      return new NoOpReranker();
    default:
      console.warn(`[dolores] unknown DOLORES_RERANKER="${kind}", falling back to noop`);
      return new NoOpReranker();
  }
}
