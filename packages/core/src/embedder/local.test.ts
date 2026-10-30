import { describe, expect, it } from "vitest";
import type { FastembedModuleLike, FlagEmbeddingLike } from "./local.js";
import { LocalEmbedder } from "./local.js";

type Producer = (texts: string[], call: number) => number[][];

const vec = (dim: number, fill = 0.1): number[] => Array.from({ length: dim }, () => fill);
const good: Producer = (texts) => texts.map(() => vec(384));

interface FakeState {
  loads: number;
  inits: number;
  releases: number;
  initOpts: unknown[];
}

function fakeModel(produce: Producer, state: FakeState): FlagEmbeddingLike {
  let call = 0;
  return {
    async *embed(texts: string[]): AsyncGenerator<number[][], void, unknown> {
      yield produce(texts, call++);
    },
    session: {
      release: async () => {
        state.releases++;
      },
    },
  };
}

function fakeModule(
  producers: Producer[],
  initGate?: () => Promise<void>,
): { state: FakeState; load: () => Promise<FastembedModuleLike> } {
  const state: FakeState = { loads: 0, inits: 0, releases: 0, initOpts: [] };
  const mod: FastembedModuleLike = {
    FlagEmbedding: {
      init: async (opts) => {
        const idx = state.inits++;
        state.initOpts.push(opts);
        if (initGate) await initGate();
        const p = producers[Math.min(idx, producers.length - 1)] ?? good;
        return fakeModel(p, state);
      },
    },
    EmbeddingModel: {
      BGESmallENV15: "fast-bge-small-en-v1.5",
      BGEBaseENV15: "fast-bge-base-en-v1.5",
    },
    ExecutionProvider: { CPU: "cpu" },
  };
  return {
    state,
    load: async () => {
      state.loads++;
      return mod;
    },
  };
}

function bounded<T>(p: Promise<T>, ms = 2000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

describe("LocalEmbedder (fake fastembed)", () => {
  it("loads, probes and embeds 384-dim vectors with CPU + quiet config", async () => {
    const { state, load } = fakeModule([good]);
    const e = new LocalEmbedder("bge-small-en-v1.5", { loadModule: load });
    const out = await bounded(e.embed(["a", "b"]));
    expect(out).toHaveLength(2);
    expect(out[0]).toHaveLength(384);
    expect(state.initOpts[0]).toMatchObject({
      model: "fast-bge-small-en-v1.5",
      executionProviders: ["cpu"],
      showDownloadProgress: false,
    });
  });

  it("rejects unknown model names before init", async () => {
    const { state, load } = fakeModule([good]);
    const e = new LocalEmbedder("nope-model", { loadModule: load });
    await expect(bounded(e.ready())).rejects.toThrow(/unknown fastembed model/);
    expect(state.inits).toBe(0);
  });

  it("rejects a 768-dim model at startup and releases it", async () => {
    const { state, load } = fakeModule([(t) => t.map(() => vec(768))]);
    const e = new LocalEmbedder("bge-base-en-v1.5", { loadModule: load });
    await expect(bounded(e.ready())).rejects.toThrow(/384/);
    expect(state.releases).toBe(1);
  });

  it("rejects NaN probe vectors", async () => {
    const { state, load } = fakeModule([(t) => t.map(() => vec(384, Number.NaN))]);
    const e = new LocalEmbedder(undefined, { loadModule: load });
    await expect(bounded(e.ready())).rejects.toThrow(/non-finite/);
    expect(state.releases).toBe(1);
  });

  it("rejects missing / extra probe vectors", async () => {
    for (const p of [(): number[][] => [], (): number[][] => [vec(384), vec(384)]]) {
      const { load } = fakeModule([p]);
      const e = new LocalEmbedder(undefined, { loadModule: load });
      await expect(bounded(e.ready())).rejects.toThrow(/vectors for 1 inputs/);
    }
  });

  it("validates every batch after warmup (cardinality, dim, finite)", async () => {
    const bad: Producer[] = [
      (t, c) => (c === 0 ? good(t, c) : t.slice(1).map(() => vec(384))),
      (t, c) => (c === 0 ? good(t, c) : [...good(t, c), vec(384)]),
      (t, c) => (c === 0 ? good(t, c) : t.map(() => vec(768))),
      (t, c) => (c === 0 ? good(t, c) : t.map(() => vec(384, Number.POSITIVE_INFINITY))),
    ];
    for (const p of bad) {
      const { load } = fakeModule([p]);
      const e = new LocalEmbedder(undefined, { loadModule: load });
      await bounded(e.ready());
      await expect(bounded(e.embed(["x", "y"]))).rejects.toThrow(/LocalEmbedder/);
    }
  });

  it("concurrent ready() initialises once", async () => {
    const { state, load } = fakeModule([good]);
    const e = new LocalEmbedder(undefined, { loadModule: load });
    await bounded(Promise.all([e.ready(), e.ready(), e.embed(["q"]), e.ready()]));
    expect(state.inits).toBe(1);
  });

  it("retries after a failed probe", async () => {
    const { state, load } = fakeModule([(t) => t.map(() => vec(768)), good]);
    const e = new LocalEmbedder(undefined, { loadModule: load });
    await expect(bounded(e.ready())).rejects.toThrow();
    await bounded(e.ready());
    expect(state.inits).toBe(2);
    expect(state.releases).toBe(1);
    expect(await bounded(e.embed(["z"]))).toHaveLength(1);
  });

  it("dispose during pending load waits and releases exactly once", async () => {
    let open: () => void = () => {};
    const gate = new Promise<void>((r) => {
      open = r;
    });
    const { state, load } = fakeModule([good], () => gate);
    const e = new LocalEmbedder(undefined, { loadModule: load });
    const r = e.ready();
    const d1 = e.dispose();
    const d2 = e.dispose();
    open();
    await bounded(Promise.all([r, d1, d2]));
    expect(state.releases).toBe(1);
    await bounded(e.dispose());
    expect(state.releases).toBe(1);
  });

  it("embed([]) never loads the module", async () => {
    const { state, load } = fakeModule([good]);
    const e = new LocalEmbedder(undefined, { loadModule: load });
    expect(await e.embed([])).toEqual([]);
    expect(state.loads).toBe(0);
    expect(state.inits).toBe(0);
  });
});
