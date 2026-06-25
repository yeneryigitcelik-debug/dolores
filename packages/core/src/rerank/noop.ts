import type { RerankCandidate, Reranker } from "../types.js";

/**
 * Identity reranker — returns candidates untouched. The default, so recall is
 * unchanged unless a concrete local reranker is explicitly plugged in.
 */
export class NoOpReranker implements Reranker {
  readonly id = "noop";
  async rerank(_query: string, candidates: RerankCandidate[]): Promise<RerankCandidate[]> {
    return candidates;
  }
}
