import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAnthropicProvider,
  createLlmProviderFromEnv,
  createOpenAiProvider,
} from "./provider.js";

// Mock the OPTIONAL @anthropic-ai/sdk dependency (not installed in this package).
// The provider imports it lazily via a variable specifier; vitest still intercepts.
const created: { apiKey?: string } = {};
const lastCall: {
  model?: string;
  max_tokens?: number;
  system?: string;
  messages?: { role: string; content: string }[];
} = {};

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      create: async (args: {
        model: string;
        max_tokens: number;
        system?: string;
        messages: { role: string; content: string }[];
      }) => {
        Object.assign(lastCall, args);
        // Claude returns a content-block array; include a non-text block to prove filtering.
        return {
          content: [
            { type: "text", text: '{"facts":[],' },
            { type: "tool_use", id: "ignored" },
            { type: "text", text: '"memories":[]}' },
          ],
        };
      },
    };
    constructor(opts: { apiKey: string }) {
      created.apiKey = opts.apiKey;
    }
  }
  return { default: FakeAnthropic };
});

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "DOLORES_EXTRACTION_PROVIDER",
  "DOLORES_EXTRACTION_MODEL",
] as const;

describe("createAnthropicProvider", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    created.apiKey = undefined;
    for (const k of Object.keys(lastCall)) delete (lastCall as Record<string, unknown>)[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("returns null when no API key is configured (graceful no-op)", () => {
    expect(createAnthropicProvider()).toBeNull();
  });

  it("defaults to the cheap haiku model", () => {
    expect(createAnthropicProvider({ apiKey: "k" })?.id).toBe(
      "anthropic:claude-haiku-4-5-20251001",
    );
  });

  it("honours an explicit model and DOLORES_EXTRACTION_MODEL", () => {
    expect(createAnthropicProvider({ apiKey: "k", model: "claude-x" })?.id).toBe(
      "anthropic:claude-x",
    );
    process.env.DOLORES_EXTRACTION_MODEL = "claude-from-env";
    expect(createAnthropicProvider({ apiKey: "k" })?.id).toBe("anthropic:claude-from-env");
  });

  it("complete() sends system top-level + a user message, and joins text blocks", async () => {
    const provider = createAnthropicProvider({ apiKey: "sk-ant", model: "claude-test" });
    const out = await provider?.complete({ prompt: "extract this", system: "SYS", maxTokens: 256 });

    expect(created.apiKey).toBe("sk-ant");
    expect(lastCall.model).toBe("claude-test");
    expect(lastCall.max_tokens).toBe(256);
    expect(lastCall.system).toBe("SYS"); // top-level field, NOT a message role
    expect(lastCall.messages).toEqual([{ role: "user", content: "extract this" }]);
    // Non-text content blocks are filtered; text blocks concatenated.
    expect(out).toBe('{"facts":[],"memories":[]}');
  });
});

describe("createLlmProviderFromEnv auto-select", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("returns null when neither key is present", () => {
    expect(createLlmProviderFromEnv()).toBeNull();
  });

  it("prefers Anthropic when ANTHROPIC_API_KEY is set", () => {
    process.env.ANTHROPIC_API_KEY = "k-ant";
    process.env.OPENAI_API_KEY = "k-oai";
    expect(createLlmProviderFromEnv()?.id).toMatch(/^anthropic:/);
  });

  it("falls back to OpenAI when only OPENAI_API_KEY is set", () => {
    process.env.OPENAI_API_KEY = "k-oai";
    expect(createLlmProviderFromEnv()?.id).toMatch(/^openai:/);
  });

  it("DOLORES_EXTRACTION_PROVIDER forces a vendor over the auto rule", () => {
    process.env.ANTHROPIC_API_KEY = "k-ant";
    process.env.OPENAI_API_KEY = "k-oai";
    process.env.DOLORES_EXTRACTION_PROVIDER = "openai";
    expect(createLlmProviderFromEnv()?.id).toMatch(/^openai:/);

    process.env.DOLORES_EXTRACTION_PROVIDER = "anthropic";
    expect(createLlmProviderFromEnv()?.id).toMatch(/^anthropic:/);
  });

  it("a forced vendor with no key still yields null (graceful)", () => {
    process.env.DOLORES_EXTRACTION_PROVIDER = "anthropic";
    expect(createLlmProviderFromEnv()).toBeNull();
  });

  it("DOLORES_EXTRACTION_MODEL overrides the chosen vendor's default", () => {
    process.env.OPENAI_API_KEY = "k-oai";
    process.env.DOLORES_EXTRACTION_MODEL = "gpt-custom";
    expect(createLlmProviderFromEnv()?.id).toBe("openai:gpt-custom");
  });
});

describe("createOpenAiProvider", () => {
  it("returns null without an API key", () => {
    const key = "OPENAI_API_KEY";
    const saved = process.env[key];
    delete process.env[key];
    expect(createOpenAiProvider()).toBeNull();
    if (saved !== undefined) process.env[key] = saved;
  });
});
