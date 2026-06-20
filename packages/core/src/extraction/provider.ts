/**
 * LLM provider abstraction for extraction. The extractor never imports a vendor
 * SDK directly — it talks to this interface, so the cheap model stays swappable
 * and fully OFF the critical (recall/context) path.
 */
export interface LlmProvider {
  readonly id: string;
  /** Return raw model text (expected to be a JSON object for extraction). */
  complete(input: { prompt: string; system?: string; maxTokens?: number }): Promise<string>;
}

// Structural view of the slice of the OpenAI SDK we use (optional dependency).
interface OpenAiChatClient {
  chat: {
    completions: {
      create(args: {
        model: string;
        messages: { role: "system" | "user"; content: string }[];
        temperature?: number;
        max_tokens?: number;
        response_format?: { type: "json_object" };
      }): Promise<{ choices: { message: { content: string | null } }[] }>;
    };
  };
}
interface OpenAiModule {
  default: new (opts: { apiKey: string }) => OpenAiChatClient;
}

export interface OpenAiProviderOptions {
  model?: string;
  apiKey?: string;
}

/** Same shape for both vendors today; kept separate for future divergence. */
export type AnthropicProviderOptions = OpenAiProviderOptions;

/** Cheap, fast default for extraction (off the critical path). */
const ANTHROPIC_DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const OPENAI_DEFAULT_MODEL = "gpt-4o-mini";

/**
 * Build an OpenAI-backed provider, or return null if no API key is configured
 * (caller treats null as "extraction unavailable → graceful no-op"). The SDK is
 * an OPTIONAL dependency, lazily imported on first use.
 */
export function createOpenAiProvider(opts: OpenAiProviderOptions = {}): LlmProvider | null {
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const model = opts.model ?? OPENAI_DEFAULT_MODEL;

  let clientPromise: Promise<OpenAiChatClient> | undefined;
  const getClient = async (): Promise<OpenAiChatClient> => {
    // `: string` keeps TS from statically resolving the optional dependency.
    const specifier: string = "openai";
    let mod: OpenAiModule;
    try {
      mod = (await import(specifier)) as OpenAiModule;
    } catch {
      throw new Error(
        "Extraction needs the optional 'openai' package. Install it (pnpm add openai) " +
          "or set DOLORES_EXTRACTION_ENABLED=false.",
      );
    }
    return new mod.default({ apiKey });
  };

  return {
    id: `openai:${model}`,
    async complete({ prompt, system, maxTokens }) {
      if (!clientPromise) clientPromise = getClient();
      const client = await clientPromise;
      const messages: { role: "system" | "user"; content: string }[] = [];
      if (system) messages.push({ role: "system", content: system });
      messages.push({ role: "user", content: prompt });
      const res = await client.chat.completions.create({
        model,
        messages,
        temperature: 0,
        max_tokens: maxTokens ?? 700,
        response_format: { type: "json_object" },
      });
      return res.choices[0]?.message?.content ?? "";
    },
  };
}

// Structural view of the slice of the Anthropic SDK we use (optional dependency).
interface AnthropicMessagesClient {
  messages: {
    create(args: {
      model: string;
      max_tokens: number;
      temperature?: number;
      system?: string;
      messages: { role: "user" | "assistant"; content: string }[];
    }): Promise<{ content: { type: string; text?: string }[] }>;
  };
}
interface AnthropicModule {
  default: new (opts: { apiKey: string }) => AnthropicMessagesClient;
}

/**
 * Build an Anthropic (Claude)-backed provider, or return null if no API key is
 * configured (caller treats null as "extraction unavailable → graceful no-op").
 * The `@anthropic-ai/sdk` package is an OPTIONAL dependency, lazily imported on
 * first use — mirrors createOpenAiProvider().
 *
 * Anthropic has no `response_format: json_object`, so JSON discipline is enforced
 * purely through the system prompt ("Return STRICT JSON ..."); the extractor's
 * tolerant safeParse() recovers the object even if the model adds prose/fences.
 */
export function createAnthropicProvider(opts: AnthropicProviderOptions = {}): LlmProvider | null {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const model = opts.model ?? process.env.DOLORES_EXTRACTION_MODEL ?? ANTHROPIC_DEFAULT_MODEL;

  let clientPromise: Promise<AnthropicMessagesClient> | undefined;
  const getClient = async (): Promise<AnthropicMessagesClient> => {
    // `: string` keeps TS from statically resolving the optional dependency.
    const specifier: string = "@anthropic-ai/sdk";
    let mod: AnthropicModule;
    try {
      mod = (await import(specifier)) as AnthropicModule;
    } catch {
      throw new Error(
        "Extraction needs the optional '@anthropic-ai/sdk' package. Install it " +
          "(pnpm add @anthropic-ai/sdk) or set DOLORES_EXTRACTION_ENABLED=false.",
      );
    }
    return new mod.default({ apiKey });
  };

  return {
    id: `anthropic:${model}`,
    async complete({ prompt, system, maxTokens }) {
      if (!clientPromise) clientPromise = getClient();
      const client = await clientPromise;
      const res = await client.messages.create({
        model,
        max_tokens: maxTokens ?? 700,
        temperature: 0,
        // Anthropic takes `system` as a top-level field, not a message role.
        ...(system ? { system } : {}),
        messages: [{ role: "user", content: prompt }],
      });
      // Concatenate text blocks (Claude returns a content-block array).
      return res.content
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text ?? "")
        .join("");
    },
  };
}

/**
 * Resolve an extraction provider from the environment.
 *
 * - `DOLORES_EXTRACTION_PROVIDER=anthropic|openai` forces a vendor.
 * - Otherwise AUTO: prefer Anthropic when ANTHROPIC_API_KEY is set (users on a
 *   Claude subscription), else OpenAI when OPENAI_API_KEY is set.
 * - Neither key (or a forced vendor whose key is missing) → null, preserving the
 *   graceful no-op contract (extraction silently disabled).
 *
 * `DOLORES_EXTRACTION_MODEL` overrides the chosen vendor's default model.
 */
export function createLlmProviderFromEnv(opts: OpenAiProviderOptions = {}): LlmProvider | null {
  const model = opts.model ?? process.env.DOLORES_EXTRACTION_MODEL;
  const forced = (process.env.DOLORES_EXTRACTION_PROVIDER ?? "").trim().toLowerCase();

  if (forced === "anthropic") return createAnthropicProvider({ ...opts, model });
  if (forced === "openai") return createOpenAiProvider({ ...opts, model });

  // Auto-select: Claude first (matches the common "I already pay for Claude" case).
  if (process.env.ANTHROPIC_API_KEY) return createAnthropicProvider({ ...opts, model });
  if (process.env.OPENAI_API_KEY) return createOpenAiProvider({ ...opts, model });
  return null;
}
