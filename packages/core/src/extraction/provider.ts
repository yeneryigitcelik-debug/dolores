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

/**
 * Build an OpenAI-backed provider, or return null if no API key is configured
 * (caller treats null as "extraction unavailable → graceful no-op"). The SDK is
 * an OPTIONAL dependency, lazily imported on first use.
 */
export function createOpenAiProvider(opts: OpenAiProviderOptions = {}): LlmProvider | null {
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const model = opts.model ?? "gpt-4o-mini";

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

/** Resolve a provider from the environment (currently OpenAI). */
export function createLlmProviderFromEnv(opts: OpenAiProviderOptions = {}): LlmProvider | null {
  return createOpenAiProvider(opts);
}
