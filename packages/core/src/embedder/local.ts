import { BGE_SMALL_DIM, type Embedder } from "../types.js";

/**
 * fastembed (bge-small-en-v1.5, 384 dims, CPU/onnxruntime) — the free default.
 *
 * fastembed + onnxruntime-node are loaded lazily so that the noop/openai paths
 * never pull in the native ONNX binary. The model is materialised exactly once
 * (`ready()` is idempotent); concurrent callers share a single load promise.
 */

// Minimal structural view of the bits of `fastembed` we touch. Keeps strict
// typing without depending on its enums at compile time (dynamic import).
interface FlagEmbeddingLike {
  embed(texts: string[], batchSize?: number): AsyncGenerator<number[][], void, unknown>;
  // fastembed exposes the underlying onnxruntime InferenceSession at runtime.
  session?: { release(): Promise<void> };
}
interface FastembedModule {
  FlagEmbedding: {
    init(opts: {
      model?: string;
      executionProviders?: string[];
      maxLength?: number;
      cacheDir?: string;
      showDownloadProgress?: boolean;
    }): Promise<FlagEmbeddingLike>;
  };
  EmbeddingModel: Record<string, string>;
  ExecutionProvider: Record<string, string>;
}

/** Map a friendly model name onto fastembed's enum value. */
function resolveModelId(name: string, enumMap: Record<string, string>): string {
  const wanted = name.toLowerCase();
  // Accept "bge-small-en-v1.5", "fast-bge-small-en-v1.5", or an enum value as-is.
  for (const value of Object.values(enumMap)) {
    if (value.toLowerCase() === wanted || value.toLowerCase() === `fast-${wanted}`) {
      return value;
    }
  }
  return enumMap.BGESmallENV15 ?? "fast-bge-small-en-v1.5";
}

function defaultCacheDir(): string {
  return process.env.DOLORES_MODEL_CACHE ?? ".dolores-models";
}

export class LocalEmbedder implements Embedder {
  readonly id: string;
  readonly dim = BGE_SMALL_DIM;

  private readonly modelName: string;
  private model: FlagEmbeddingLike | undefined;
  private loading: Promise<void> | undefined;

  constructor(modelName = "bge-small-en-v1.5") {
    this.modelName = modelName;
    this.id = `local:${modelName}`;
  }

  /** Load the ONNX model once. Safe to call repeatedly / concurrently. */
  async ready(): Promise<void> {
    if (this.model) return;
    if (!this.loading) {
      this.loading = this.load().catch((err) => {
        // Reset so a later call can retry instead of caching a rejected promise.
        this.loading = undefined;
        throw err;
      });
    }
    await this.loading;
  }

  private async load(): Promise<void> {
    const specifier = "fastembed";
    const mod = (await import(specifier)) as FastembedModule;
    this.model = await mod.FlagEmbedding.init({
      model: resolveModelId(this.modelName, mod.EmbeddingModel),
      executionProviders: [mod.ExecutionProvider.CPU ?? "cpu"],
      // Never write progress to stdout — daemon/MCP stdio must stay protocol-clean.
      showDownloadProgress: false,
      cacheDir: defaultCacheDir(),
    });
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    await this.ready();
    const model = this.model;
    if (!model) throw new Error("LocalEmbedder: model failed to initialise");
    const out: number[][] = [];
    for await (const batch of model.embed(texts)) {
      for (const vec of batch) out.push(vec);
    }
    return out;
  }

  /**
   * Release the onnxruntime session so the process can exit cleanly. The
   * load-bearing crash fix is avoiding process.exit() in the daemon; this is
   * good native hygiene on top of that.
   */
  async dispose(): Promise<void> {
    try {
      await this.model?.session?.release();
    } catch {
      // best-effort — never throw from shutdown
    }
    this.model = undefined;
    this.loading = undefined;
  }
}
