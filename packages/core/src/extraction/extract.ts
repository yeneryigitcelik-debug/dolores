import type { Pool } from "pg";
import { z } from "zod";
import { batchUpsertFacts, listFacts } from "../retrieval/facts.js";
import { _rememberPreembedded } from "../retrieval/remember.js";
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
   * reuses the SAME category+key when the text updates one (→ upsert overwrites
   * instead of a near-duplicate). ingestText fills this in automatically.
   */
  knownFacts?: KnownFact[];
}

export interface ExtractionResult {
  facts: FactInput[];
  memories: RememberInput[];
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
- scope "workspace" = team-wide; "personal" = this user only (default personal).
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

/** Resolve the confidence floor from env (default 0 = keep every item). */
function resolveMinConfidence(): number {
  const raw = Number(process.env.DOLORES_EXTRACTION_MIN_CONFIDENCE);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(1, raw);
}

/** Missing confidence always passes; otherwise it must clear the floor. */
function passesConfidence(confidence: number | undefined, floor: number): boolean {
  return confidence === undefined || confidence >= floor;
}

/**
 * Distil facts + memories from raw text with a cheap LLM. OFF the critical path.
 * Disabled, no provider, an LLM error, or unparseable output all degrade to a
 * graceful no-op ({facts:[],memories:[]}) — extraction must never throw into a
 * caller's request flow.
 */
export async function extractFromText(
  text: string,
  opts: ExtractionOptions = {},
): Promise<ExtractionResult> {
  const enabled = opts.enabled ?? isExtractionEnabled();
  if (!enabled || !text.trim()) return EMPTY;

  const provider =
    opts.provider !== undefined ? opts.provider : createLlmProviderFromEnv({ model: opts.model });
  if (!provider) return EMPTY;

  let raw: string;
  try {
    raw = await provider.complete({ system: buildSystemPrompt(opts.knownFacts), prompt: text });
  } catch (err) {
    console.warn(`[dolores] extraction LLM call failed: ${asMessage(err)}`);
    return EMPTY;
  }

  const parsed = safeParse(raw);
  if (!parsed) return EMPTY;

  const floor = opts.minConfidence ?? resolveMinConfidence();
  const maxFacts = opts.maxFacts ?? 20;
  const maxMemories = opts.maxMemories ?? 20;

  const facts = parseFacts(parsed.facts, floor).slice(0, maxFacts);
  const memories = parseMemories(parsed.memories, floor, opts.source).slice(0, maxMemories);

  return { facts, memories };
}

/** Validate facts item-by-item; one malformed item never sinks the rest. */
function parseFacts(items: unknown[], floor: number): FactInput[] {
  const out: FactInput[] = [];
  for (const item of items) {
    const r = factZ.safeParse(item);
    if (!r.success || !passesConfidence(r.data.confidence, floor)) continue;
    out.push({
      category: r.data.category,
      key: r.data.key,
      value: r.data.value,
      scope: r.data.scope,
    });
  }
  return out;
}

/** Validate memories item-by-item; one malformed item never sinks the rest. */
function parseMemories(items: unknown[], floor: number, fallbackSource?: string): RememberInput[] {
  const out: RememberInput[] = [];
  for (const item of items) {
    const r = memoryZ.safeParse(item);
    if (!r.success || !passesConfidence(r.data.confidence, floor)) continue;
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
 * async ingest worker — never call it on the recall/context path.
 */
export async function ingestText(
  pool: Pool,
  ctx: MemoryContext,
  embedder: Embedder,
  text: string,
  opts: ExtractionOptions = {},
): Promise<IngestSummary> {
  // Contradiction context: hand the model the facts we already hold so it reuses
  // the same category+key (→ upsert overwrites) instead of inventing duplicates.
  // Best-effort and only when extraction will actually run.
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

  // All facts in a single transaction via unnest (N→1 round-trips).
  await batchUpsertFacts(pool, ctx, facts);

  // Embed all memory contents in one batch call (N ONNX inferences → 1).
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
 * first {...} block. Items themselves are validated per-item by parseFacts /
 * parseMemories, so a single malformed entry can't drop the whole payload.
 */
function safeParse(raw: string): { facts: unknown[]; memories: unknown[] } | null {
  const candidate = extractJsonObject(raw);
  if (!candidate) return null;
  let json: unknown;
  try {
    json = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const obj = json as Record<string, unknown>;
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
