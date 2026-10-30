import { BGE_SMALL_DIM, type Embedder } from "../types.js";

/**
 * fastembed (bge-small-en-v1.5, 384 dims, CPU/onnxruntime) — the free default.
 *
 * fastembed + onnxruntime-node are loaded lazily so that the noop/openai paths
 * never pull in the native ONNX binary. The model is materialised exactly once
 * (`ready()` is idempotent); concurrent callers share a single load promise.
 * A freshly initialised model is probed and only published after it proves it
 * returns finite 384-dim vectors (the VECTOR(384) column width).
 */

// Minimal structural view of the bits of `fastembed` we touch. Keeps strict
// typing without depending on its enums at compile time (dynamic import).
export interface FlagEmbeddingLike {
  embed(texts: string[], batchSize?: number): AsyncGenerator<number[][], void, unknown>;
  // fastembed exposes the underlying onnxruntime InferenceSession at runtime.
  session?: { release(): Promise<void> };
}
export interface FastembedModuleLike {
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

export interface LocalEmbedderOptions {
  /** Override the dynamic `fastembed` import (tests). */
  loadModule?: () => Promise<FastembedModuleLike>;
}

const PROBE_TEXT = "dolores dimension probe";

async function defaultLoadModule(): Promise<FastembedModuleLike> {
  const specifier = "fastembed";
  return (await import(specifier)) as FastembedModuleLike;
}

/** Map a friendly model name onto fastembed's enum value; reject unknown names. */
function resolveModelId(name: string, enumMap: Record<string, string>): string {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(enumMap)) {
    const v = value.toLowerCase();
    if (v === wanted || v === `fast-${wanted}` || key.toLowerCase() === wanted) {
      return value;
    }
  }
  throw new Error(
    `LocalEmbedder: unknown fastembed model "${name}". Known: ${Object.values(enumMap).join(", ")}`,
  );
}

function defaultCacheDir(): string {
  return process.env.DOLORES_MODEL_CACHE ?? ".dolores-models";
}

function validateVectors(vectors: number[][], expected: number, what: string): void {
  if (vectors.length !== expected) {
    throw new Error(
      `LocalEmbedder: ${what} returned ${vectors.length} vectors for ${expected} inputs`,
    );
  }
  for (const vec of vectors) {
    if (!Array.isArray(vec) && !ArrayBuffer.isView(vec)) {
      throw new Error(`LocalEmbedder: ${what} returned a non-vector value`);
    }
    if (vec.length !== BGE_SMALL_DIM) {
      throw new Error(
        `LocalEmbedder: ${what} returned ${vec.length}-dim vectors; the memories table requires ${BGE_SMALL_DIM} dims (use a ${BGE_SMALL_DIM}-dim model such as bge-small-en-v1.5)`,
      );
    }
    for (const n of vec) {
      if (!Number.isFinite(n)) {
        throw new Error(`LocalEmbedder: ${what} returned a non-finite vector component`);
      }
    }
  }
}

async function collect(model: FlagEmbeddingLike, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for await (const batch of model.embed(texts)) {
    for (const vec of batch) out.push(vec);
  }
  return out;
}

async function releaseQuietly(model: FlagEmbeddingLike | undefined): Promise<void> {
  try {
    await model?.session?.release();
  } catch {
    // best-effort — never throw from cleanup
  }
}

export class LocalEmbedder implements Embedder {
  readonly id: string;
  readonly dim = BGE_SMALL_DIM;

  private readonly modelName: string;
  private readonly loadModule: () => Promise<FastembedModuleLike>;
  private model: FlagEmbeddingLike | undefined;
  private loading: Promise<void> | undefined;

  constructor(modelName = "bge-small-en-v1.5", options: LocalEmbedderOptions = {}) {
    this.modelName = modelName;
    this.id = `local:${modelName}`;
    this.loadModule = options.loadModule ?? defaultLoadModule;
  }

  /** Load + validate the ONNX model once. Safe to call repeatedly / concurrently. */
  async ready(): Promise<void> {
    if (this.model) return;
    if (!this.loading) {
      const attempt: Promise<void> = this.load()
        .then((m) => {
          this.model = m;
        })
        .catch((err: unknown) => {
          // Reset so a later call can retry instead of caching a rejected promise.
          if (this.loading === attempt) this.loading = undefined;
          throw err;
        });
      this.loading = attempt;
    }
    await this.loading;
  }

  private async load(): Promise<FlagEmbeddingLike> {
    const mod = await this.loadModule();
    const modelId = resolveModelId(this.modelName, mod.EmbeddingModel);
    const candidate = await mod.FlagEmbedding.init({
      model: modelId,
      executionProviders: [mod.ExecutionProvider.CPU ?? "cpu"],
      // Never write progress to stdout — daemon/MCP stdio must stay protocol-clean.
      showDownloadProgress: false,
      cacheDir: defaultCacheDir(),
    });
    try {
      // Probe the candidate directly (not this.embed → no ready() recursion).
      const probe = await collect(candidate, [PROBE_TEXT]);
      validateVectors(probe, 1, `startup probe of model "${modelId}"`);
    } catch (err) {
      await releaseQuietly(candidate);
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `LocalEmbedder startup failed: model must produce finite ${BGE_SMALL_DIM}-dim vectors. ${msg}`,
      );
    }
    return candidate;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    await this.ready();
    const model = this.model;
    if (!model) throw new Error("LocalEmbedder: model failed to initialise");
    const out = await collect(model, texts);
    validateVectors(out, texts.length, "embed");
    return out;
  }

  /**
   * Release the onnxruntime session so the process can exit cleanly. If a load
   * is in flight, wait for it so the model it produces is not orphaned. The
   * load-bearing crash fix is avoiding process.exit() in the daemon; this is
   * good native hygiene on top of that.
   */
  async dispose(): Promise<void> {
    const pending = this.loading;
    if (pending) {
      try {
        await pending;
      } catch {
        // failed load already released its own candidate
      }
    }
    const model = this.model;
    this.model = undefined;
    if (this.loading === pending) this.loading = undefined;
    await releaseQuietly(model);
  }
}
