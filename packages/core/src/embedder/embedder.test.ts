import { describe, expect, it } from "vitest";
import { BGE_SMALL_DIM } from "../types.js";
import { createEmbedder } from "./factory.js";
import { LocalEmbedder } from "./local.js";
import { NoOpEmbedder } from "./noop.js";
import { OpenAIEmbedder } from "./openai.js";

describe("NoOpEmbedder", () => {
  it("reports dim 0 and returns no vectors", async () => {
    const e = new NoOpEmbedder();
    expect(e.id).toBe("noop");
    expect(e.dim).toBe(0);
    await e.ready();
    expect(await e.embed(["hello", "world"])).toEqual([]);
  });
});

describe("createEmbedder", () => {
  it("builds each kind with a stable id and dim", () => {
    expect(createEmbedder("noop").id).toBe("noop");

    const local = createEmbedder("local");
    expect(local).toBeInstanceOf(LocalEmbedder);
    expect(local.id).toBe("local:bge-small-en-v1.5");
    expect(local.dim).toBe(BGE_SMALL_DIM);

    const openai = createEmbedder("openai");
    expect(openai).toBeInstanceOf(OpenAIEmbedder);
    expect(openai.id).toBe("openai:text-embedding-3-small");
    // OpenAI embedder is truncated to the VECTOR(384) column width.
    expect(openai.dim).toBe(BGE_SMALL_DIM);
  });

  it("honours a custom model name", () => {
    expect(createEmbedder("local", "bge-base-en-v1.5").id).toBe("local:bge-base-en-v1.5");
  });
});

describe("LocalEmbedder", () => {
  it("advertises 384 dims before any load", () => {
    expect(new LocalEmbedder().dim).toBe(384);
  });

  it("embed([]) is safe and never loads the model", async () => {
    expect(await new LocalEmbedder().embed([])).toEqual([]);
  });

  // Heavy: downloads ~130MB ONNX model + needs onnxruntime. Opt-in only.
  const liveIt = process.env.DOLORES_TEST_LOCAL_EMBED ? it : it.skip;
  liveIt(
    "really loads bge-small and returns 384-dim vectors",
    async () => {
      const e = new LocalEmbedder();
      await e.ready();
      await e.ready(); // idempotent
      const [v] = await e.embed(["dolores remembers things"]);
      expect(v).toHaveLength(384);
      expect(v?.every((n) => Number.isFinite(n))).toBe(true);
    },
    120_000,
  );
});
