import { BGE_SMALL_DIM, type Embedder } from "../types.js";

/**
 * OpenAI `text-embedding-3-*`. `openai` is an OPTIONAL dependency — if it is not
 * installed we throw a clear, actionable error rather than a module-not-found.
 *
 * The `memories.embedding` column is fixed at VECTOR(384), so we request the
 * v3 `dimensions` truncation (default 384) to stay schema-compatible.
 */

interface OpenAiEmbeddingClient {
  embeddings: {
    create(args: { model: string; input: string[]; dimensions?: number }): Promise<{
      data: { embedding: number[] }[];
    }>;
  };
}
interface OpenAiModule {
  default: new (opts: { apiKey: string }) => OpenAiEmbeddingClient;
}

export class OpenAIEmbedder implements Embedder {
  readonly id: string;
  readonly dim: number;

  private readonly model: string;
  private client: OpenAiEmbeddingClient | undefined;

  constructor(model = "text-embedding-3-small", dim: number = BGE_SMALL_DIM) {
    this.model = model;
    this.dim = dim;
    this.id = `openai:${model}`;
  }

  async ready(): Promise<void> {
    await this.getClient();
  }

  private async getClient(): Promise<OpenAiEmbeddingClient> {
    if (this.client) return this.client;
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OpenAIEmbedder requires OPENAI_API_KEY to be set.");
    }
    // `: string` (not a literal) stops TS from statically resolving the optional dep.
    const specifier: string = "openai";
    let mod: OpenAiModule;
    try {
      mod = (await import(specifier)) as OpenAiModule;
    } catch {
      throw new Error(
        "OpenAIEmbedder needs the optional 'openai' package. Install it (pnpm add openai) " +
          "or set DOLORES_EMBEDDER=local|noop.",
      );
    }
    this.client = new mod.default({ apiKey });
    return this.client;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const client = await this.getClient();
    const res = await client.embeddings.create({
      model: this.model,
      input: texts,
      dimensions: this.dim,
    });
    return res.data.map((d) => d.embedding);
  }
}
