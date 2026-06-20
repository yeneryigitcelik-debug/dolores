import type { Embedder, EmbedderKind } from "../types.js";
import { LocalEmbedder } from "./local.js";
import { NoOpEmbedder } from "./noop.js";
import { OpenAIEmbedder } from "./openai.js";

/**
 * Build the embedder selected by config. `model` is interpreted per-kind
 * (fastembed model name for local, OpenAI model id for openai, ignored for noop).
 */
export function createEmbedder(kind: EmbedderKind, model?: string): Embedder {
  switch (kind) {
    case "local":
      return new LocalEmbedder(model);
    case "openai":
      return new OpenAIEmbedder(model);
    case "noop":
      return new NoOpEmbedder();
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unknown embedder kind: ${String(exhaustive)}`);
    }
  }
}
