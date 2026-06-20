import type { Embedder } from "../types.js";

/**
 * "Lite mode" embedder: stores no vectors, so retrieval falls back to Postgres
 * full-text search only. `dim === 0` signals downstream code to skip pgvector.
 */
export class NoOpEmbedder implements Embedder {
  readonly id = "noop";
  readonly dim = 0;

  async ready(): Promise<void> {
    // nothing to warm up
  }

  async embed(_texts: string[]): Promise<number[][]> {
    return [];
  }
}
