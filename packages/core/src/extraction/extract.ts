import type { Pool } from "pg";
import { z } from "zod";
import { batchUpsertFacts, listFacts } from "../retrieval/facts.js";
import { _rememberPreembedded } from "../retrieval/remember.js";
import { resolveWriteOwner } from "../retrieval/scope.js";
import type { Embedder, FactInput, MemoryContext, RememberInput } from "../types.js";
import { type LlmProvider, createLlmProviderFromEnv } from "./provider.js";

/** A fact the model is told we already hold, so it can align keys on contradiction. */
export interface KnownFact {
  category: string;
  key: string;
  value: string;
}

export interface ExtractionOptions {
  /** Override DOLORES_EXTRACTION_ENABLED. */
  enabled?: boolean;
  /** Inject a provider (tests, alt vendors). If omitted, resolved from env. */
  provider?: LlmProvider | null;
  /** Cheap model id passed through to the env provider. */
  model?: string;
  /** Provenance stamped onto produced memories that don't carry their own. */
  source?: string;
  maxFacts?: number;
  maxMemories?: number;
  /**
   * Drop any item whose model-reported `confidence` is below this (0..1).
   * Items without a confidence are always kept. Overrides
   * DOLORES_EXTRACTION_MIN_CONFIDENCE (default 0 = keep everything).
   */
  minConfidence?: number;
  /**
   * Facts already stored for this tenant. Rendered into the prompt so the model
   * reuses the SAME category+key when the text updates one (-> upsert overwrites
   * instead of a near-duplicate). ingestText fills this in automatically.
   */
  knownFacts?: KnownFact[];
  /**
   * Strict mode (durable ingest worker). Instead of degrading to an empty result,
   * disabled / no provider / provider failure / invalid top-level output THROW an
   * ExtractionError with a generic message (never the raw vendor message, API
   * keys, or transcript). A legitimate {"facts":[],"memories":[]} still succeeds.
   * Default false = the existing graceful no-op contract.
   */
  strict?: boolean;
  /**
   * Per-call provider deadline in ms. Overrides DOLORES_EXTRACTION_TIMEOUT_MS
   * (default 30000, clamped to 300000). Non-finite / <= 0 values are ignored
   * (falls back to env, then default). On expiry the provider's AbortSignal is
   * aborted, then strict throws EXTRACTION_TIMEOUT / graceful returns empty.
   */
  timeoutMs?: number;
}

export interface ExtractionResult {
  facts: FactInput[];
  memories: RememberInput[];
}

export type ExtractionErrorCode =
  | "EXTRACTION_DISABLED"
  | "EXTRACTION_NO_PROVIDER"
  | "EXTRACTION_PROVIDER_FAILED"
  | "EXTRACTION_INVALID_OUTPUT"
  | "EXTRACTION_TIMEOUT";

const ERROR_MESSAGES: Record<ExtractionErrorCode, string> = {
  EXTRACTION_DISABLED: "extraction is disabled",
  EXTRACTION_NO_PROVIDER: "no extraction LLM provider is configured",
  EXTRACTION_PROVIDER_FAILED: "extraction LLM provider call failed",
  EXTRACTION_INVALID_OUTPUT: "extraction LLM returned invalid output",
  EXTRACTION_TIMEOUT: "extraction LLM call timed out",
};

/** Generic, non-leaking error thrown by strict extraction. */
export class ExtractionError extends Error {
  readonly code: ExtractionErrorCode;
  constructor(code: ExtractionErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ExtractionError";
    this.code = code;
  }
}

const scopeZ = z.enum(["personal", "workspace"]);
const confidenceZ = z.number().min(0).max(1).optional();

const factZ = z.object({
  category: z.string().min(1),
  key: z.string().min(1),
  value: z.string().min(1),
  scope: scopeZ.optional(),
  confidence: confidenceZ,
});

const memoryZ = z.object({
  content: z.string().min(1),
  importance: z.number().int().min(1).max(10).optional(),
  scope: scopeZ.optional(),
  source: z.string().optional(),
  confidence: confidenceZ,
});

const BASE_PROMPT = `You distil DURABLE memory from text for an AI coding assistant.
Keep only stable, reusable information; discard transient chit-chat, one-off task
chatter, and anything tied only to the current moment.

Return STRICT JSON: {"facts":[...],"memories":[...]}.
- facts item:   {"category":"stack"|"preference"|"project"|"decision","key":short-slug,"value":string,"scope"?:"personal"|"workspace","confidence"?:0..1}
- memories item:{"content":string,"importance"?:1..10,"scope"?:"personal"|"workspace","confidence"?:0..1}

Guidance:
- A FACT is a deterministic key-value truth ("db = Postgres"). A MEMORY is a
  free-text note worth recalling ("migration ordering bit us during the deploy").
- confidence = how sure you are this is durable AND correct (1 = certain).
- scope "workspace" = team-wide; "personal" = this user only (requires a known
  user identity). If you omit scope, the caller's context decides: personal when
  a user is present, otherwise workspace. Set scope explicitly only when the text
  clearly marks something as team-wide or as one person's own preference.
- If nothing is worth keeping, return {"facts":[],"memories":[]}.

Example
input: "btw we moved the queue from redis to sqs last sprint, and I personally prefer tabs"
output: {"facts":[{"category":"stack","key":"queue","value":"SQS","scope":"workspace","confidence":0.9},{"category":"preference","key":"indentation","value":"tabs","scope":"personal","confidence":0.8}],"memories":[]}`;

/** System prompt, optionally extended with the tenant's known facts (EPIC F/G). */
function buildSystemPrompt(knownFacts?: KnownFact[]): string {
  if (!knownFacts || knownFacts.length === 0) return BASE_PROMPT;
  const lines = knownFacts.map((f) => `- [${f.category}] ${f.key}: ${f.value}`).join("\n");
  return `${BASE_PROMPT}

Facts already stored for this user/team. If the text updates or contradicts one,
emit a fact with the SAME category+key and the new value (it will overwrite):
${lines}`;
}

const EMPTY: ExtractionResult = { facts: [], memories: [] };

/** Whether extraction is enabled via env (default OFF). */
export function isExtractionEnabled(): boolean {
  const raw = (process.env.DOLORES_EXTRACTION_ENABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * Resolve the provider extraction would use, or null when extraction is disabled
 * or no provider is available. `provider: null` means explicitly unavailable;
 * `provider: undefined` resolves from env. Does not call the provider.
 */
export function resolveExtractionProvider(
  opts: Pick<ExtractionOptions, "enabled" | "provider" | "model"> = {},
): LlmProvider | null {
  if (!(opts.enabled ?? isExtractionEnabled())) return null;
  return opts.provider !== undefined
    ? opts.provider
    : createLlmProviderFromEnv({ model: opts.model });
}

/** Resolve the confidence floor from env (default 0 = keep every item). */
function resolveMinConfidence(): number {
  const raw = Number(process.env.DOLORES_EXTRACTION_MIN_CONFIDENCE);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(1, raw);
}

/** Default extraction provider deadline (ms). */
export const DEFAULT_EXTRACTION_TIMEOUT_MS = 30_000;
/** Upper bound for any extraction provider deadline (ms). */
export const MAX_EXTRACTION_TIMEOUT_MS = 300_000;

function normalizeTimeout(v: number | undefined): number | undefined {
  if (v === undefined || !Number.isFinite(v)) return undefined;
  const n = Math.floor(v);
  if (n <= 0) return undefined;
  return Math.min(n, MAX_EXTRACTION_TIMEOUT_MS);
}

/**
 * Resolve the extraction deadline: valid override, else valid
 * DOLORES_EXTRACTION_TIMEOUT_MS, else 30000. Overlarge values clamp to 300000;
 * blank / non-numeric / non-positive values are ignored.
 */
export function resolveExtractionTimeoutMs(
  override?: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const fromOverride = normalizeTimeout(override);
  if (fromOverride !== undefined) return fromOverride;
  const raw = env.DOLORES_EXTRACTION_TIMEOUT_MS;
  const fromEnv =
    raw === undefined || raw.trim() === "" ? undefined : normalizeTimeout(Number(raw));
  return fromEnv ?? DEFAULT_EXTRACTION_TIMEOUT_MS;
}

/** Internal sentinel: the deadline fired (never leaks to callers). */
class DeadlineExceeded extends Error {
  constructor() {
    super("deadline exceeded");
    this.name = "DeadlineExceeded";
  }
}

/**
 * Call the provider with an AbortSignal and race it against a deadline. The
 * signal is aborted BEFORE the deadline rejects, so honouring SDKs cancel the
 * request before any retry. A provider that ignores the signal still cannot
 * hold the caller past the deadline. Sync throws and late rejections are
 * absorbed (no unhandled rejection). The timer is always cleared.
 */
async function completeWithDeadline(
  provider: LlmProvider,
  input: { system: string; prompt: string },
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  // Sync throws propagate as ordinary provider errors (async fn -> rejection).
  const call = Promise.resolve(provider.complete({ ...input, signal: controller.signal }));
  call.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DeadlineExceeded());
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([call, deadline]);
    if (controller.signal.aborted) throw new DeadlineExceeded();
    return result;
  } catch (err) {
    // A provider may settle synchronously from its abort listener before the
    // deadline promise wins the race. Expiry still takes precedence.
    if (controller.signal.aborted) throw new DeadlineExceeded();
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Missing confidence always passes; otherwise it must clear the floor. */
function passesConfidence(confidence: number | undefined, floor: number): boolean {
  return confidence === undefined || confidence >= floor;
}

/**
 * Distil facts + memories from raw text with a cheap LLM. OFF the critical path.
 * Default (graceful): disabled, no provider, an LLM error, or unparseable output
 * all degrade to {facts:[],memories:[]}. With `strict: true` those cases throw a
 * generic ExtractionError instead (used by the durable ingest worker so a
 * transient failure is retried rather than silently marked done).
 */
export async function extractFromText(
  text: string,
  opts: ExtractionOptions = {},
): Promise<ExtractionResult> {
  const strict = opts.strict === true;
  const enabled = opts.enabled ?? isExtractionEnabled();
  if (!enabled) {
    if (strict) throw new ExtractionError("EXTRACTION_DISABLED");
    return EMPTY;
  }
  if (!text.trim()) return EMPTY;

  const provider = resolveExtractionProvider({
    enabled,
    provider: opts.provider,
    model: opts.model,
  });
  if (!provider) {
    if (strict) throw new ExtractionError("EXTRACTION_NO_PROVIDER");
    return EMPTY;
  }

  const timeoutMs = resolveExtractionTimeoutMs(opts.timeoutMs);
  let raw: string;
  try {
    raw = await completeWithDeadline(
      provider,
      { system: buildSystemPrompt(opts.knownFacts), prompt: text },
      timeoutMs,
    );
  } catch (err) {
    if (err instanceof DeadlineExceeded) {
      if (strict) throw new ExtractionError("EXTRACTION_TIMEOUT");
      console.warn(`[dolores] extraction LLM call timed out after ${timeoutMs}ms`);
      return EMPTY;
    }
    if (strict) throw new ExtractionError("EXTRACTION_PROVIDER_FAILED");
    console.warn(`[dolores] extraction LLM call failed: ${asMessage(err)}`);
    return EMPTY;
  }

  const parsed = parseTopLevel(raw, strict);
  if (!parsed) {
    if (strict) throw new ExtractionError("EXTRACTION_INVALID_OUTPUT");
    return EMPTY;
  }

  const floor = opts.minConfidence ?? resolveMinConfidence();
  const maxFacts = opts.maxFacts ?? 20;
  const maxMemories = opts.maxMemories ?? 20;

  // Strict: any schema-invalid item rejects the whole output (worker retries)
  // instead of silently dropping it and acking DONE. Confidence filtering and
  // max caps remain intentional in both modes.
  const facts = parseFacts(parsed.facts, floor, strict).slice(0, maxFacts);
  const memories = parseMemories(parsed.memories, floor, opts.source, strict).slice(0, maxMemories);

  return { facts, memories };
}

/**
 * Validate facts item-by-item. Graceful: one malformed item never sinks the rest.
 * Strict: a malformed item throws EXTRACTION_INVALID_OUTPUT.
 */
function parseFacts(items: unknown[], floor: number, strict = false): FactInput[] {
  const out: FactInput[] = [];
  for (const item of items) {
    const r = factZ.safeParse(item);
    if (!r.success) {
      if (strict) throw new ExtractionError("EXTRACTION_INVALID_OUTPUT");
      continue;
    }
    if (!passesConfidence(r.data.confidence, floor)) continue;
    out.push({
      category: r.data.category,
      key: r.data.key,
      value: r.data.value,
      scope: r.data.scope,
    });
  }
  return out;
}

/**
 * Validate memories item-by-item. Graceful: one malformed item never sinks the
 * rest. Strict: a malformed item throws EXTRACTION_INVALID_OUTPUT.
 */
function parseMemories(
  items: unknown[],
  floor: number,
  fallbackSource?: string,
  strict = false,
): RememberInput[] {
  const out: RememberInput[] = [];
  for (const item of items) {
    const r = memoryZ.safeParse(item);
    if (!r.success) {
      if (strict) throw new ExtractionError("EXTRACTION_INVALID_OUTPUT");
      continue;
    }
    if (!passesConfidence(r.data.confidence, floor)) continue;
    out.push({
      content: r.data.content,
      importance: r.data.importance,
      scope: r.data.scope,
      source: r.data.source ?? fallbackSource,
    });
  }
  return out;
}

export interface IngestSummary {
  factsWritten: number;
  memoriesWritten: number;
  deduped: number;
}

/** Cap on facts injected as contradiction context (bounds prompt token cost). */
const KNOWN_FACTS_LIMIT = 40;

/**
 * Convenience: extract then persist. Facts go through upsertFact (contradiction
 * = last-writer-wins on the unique key); memories go through remember (>0.9
 * cosine similarity supersedes the near-duplicate). Intended for the daemon's
 * async ingest worker — never call it on the recall/context path. All options
 * (including `strict` and `provider`) are forwarded to extractFromText.
 */
export async function ingestText(
  pool: Pool,
  ctx: MemoryContext,
  embedder: Embedder,
  text: string,
  opts: ExtractionOptions = {},
): Promise<IngestSummary> {
  // Contradiction context: best-effort and only when extraction will actually run.
  let knownFacts = opts.knownFacts;
  if (knownFacts === undefined && (opts.enabled ?? isExtractionEnabled())) {
    try {
      const existing = await listFacts(pool, ctx);
      knownFacts = existing
        .slice(0, KNOWN_FACTS_LIMIT)
        .map((f) => ({ category: f.category, key: f.key, value: f.value }));
    } catch (err) {
      console.warn(`[dolores] ingestText: known-facts fetch failed: ${asMessage(err)}`);
    }
  }

  const { facts, memories } = await extractFromText(text, { ...opts, knownFacts });

  // Privacy pre-validation: every item must resolve to a legal owner BEFORE any
  // write or embedding, so an invalid personal item (no ctx user) can neither
  // leave earlier workspace facts persisted nor send private content to the
  // embedder. Validation only; item scopes stay as returned (omitted remains
  // omitted) and the downstream writers resolve the actual owner themselves.
  for (const fact of facts) {
    resolveWriteOwner(ctx, fact.scope);
  }
  for (const memory of memories) {
    resolveWriteOwner(ctx, memory.scope);
  }

  // All facts in a single transaction via unnest (N->1 round-trips).
  await batchUpsertFacts(pool, ctx, facts);

  // Embed all memory contents in one batch call (N ONNX inferences -> 1).
  let vectors: number[][] = [];
  if (embedder.dim > 0 && memories.length > 0) {
    try {
      vectors = await embedder.embed(memories.map((m) => m.content.trim()));
    } catch (err) {
      console.warn(
        `[dolores] ingestText: batch embed failed, falling back to full-text only: ${asMessage(err)}`,
      );
    }
  }

  // Write memories with pre-computed vectors (dedup logic preserved).
  let deduped = 0;
  let vi = 0;
  for (const memory of memories) {
    const vec = vectors[vi++] ?? null;
    const res = await _rememberPreembedded(pool, ctx, memory, vec);
    if (res.deduped) deduped += 1;
  }

  return { factsWritten: facts.length, memoriesWritten: memories.length, deduped };
}

/**
 * Tolerantly parse the model's JSON into raw item arrays: direct parse, then the
 * first {...} block. Graceful mode treats missing/non-array keys as empty; strict
 * mode requires a JSON object with at least one of facts/memories, and any
 * present key must be an array. Items are validated per-item afterwards.
 */
function parseTopLevel(
  raw: string,
  strict: boolean,
): { facts: unknown[]; memories: unknown[] } | null {
  const candidate = extractJsonObject(raw);
  if (!candidate) return null;
  let json: unknown;
  try {
    json = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
  const obj = json as Record<string, unknown>;
  if (strict) {
    const hasFacts = "facts" in obj;
    const hasMemories = "memories" in obj;
    if (!hasFacts && !hasMemories) return null;
    if (hasFacts && !Array.isArray(obj.facts)) return null;
    if (hasMemories && !Array.isArray(obj.memories)) return null;
  }
  return {
    facts: Array.isArray(obj.facts) ? obj.facts : [],
    memories: Array.isArray(obj.memories) ? obj.memories : [],
  };
}

function extractJsonObject(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) return trimmed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return trimmed.slice(start, end + 1);
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
