import type { Pool } from "pg";
import { z } from "zod";
import { batchUpsertFacts } from "../retrieval/facts.js";
import { _rememberPreembedded } from "../retrieval/remember.js";
import type { Embedder, FactInput, MemoryContext, RememberInput } from "../types.js";
import { type LlmProvider, createLlmProviderFromEnv } from "./provider.js";

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
}

export interface ExtractionResult {
  facts: FactInput[];
  memories: RememberInput[];
}

const scopeZ = z.enum(["personal", "workspace"]);

const factZ = z.object({
  category: z.string().min(1),
  key: z.string().min(1),
  value: z.string().min(1),
  scope: scopeZ.optional(),
});

const memoryZ = z.object({
  content: z.string().min(1),
  importance: z.number().int().min(1).max(10).optional(),
  scope: scopeZ.optional(),
  source: z.string().optional(),
});

const payloadZ = z.object({
  facts: z.array(factZ).default([]),
  memories: z.array(memoryZ).default([]),
});

const SYSTEM_PROMPT = `You distil durable memory from text for an AI assistant.
Extract only STABLE, reusable information — never transient chit-chat.
Return STRICT JSON: {"facts":[{"category","key","value","scope?"}],"memories":[{"content","importance?","scope?"}]}.
- facts: deterministic key-value truths (category one of stack|preference|project|decision). key is a short slug.
- memories: free-text notes worth recalling later; importance 1..10 (default 5).
- scope: "personal" (default) or "workspace".
If nothing is worth keeping, return {"facts":[],"memories":[]}.`;

const EMPTY: ExtractionResult = { facts: [], memories: [] };

/** Whether extraction is enabled via env (default OFF). */
export function isExtractionEnabled(): boolean {
  const raw = (process.env.DOLORES_EXTRACTION_ENABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
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
    raw = await provider.complete({ system: SYSTEM_PROMPT, prompt: text });
  } catch (err) {
    console.warn(`[dolores] extraction LLM call failed: ${asMessage(err)}`);
    return EMPTY;
  }

  const parsed = safeParse(raw);
  if (!parsed) return EMPTY;

  const maxFacts = opts.maxFacts ?? 20;
  const maxMemories = opts.maxMemories ?? 20;

  const facts: FactInput[] = parsed.facts.slice(0, maxFacts).map((f) => ({
    category: f.category,
    key: f.key,
    value: f.value,
    scope: f.scope,
  }));
  const memories: RememberInput[] = parsed.memories.slice(0, maxMemories).map((m) => ({
    content: m.content,
    importance: m.importance,
    scope: m.scope,
    source: m.source ?? opts.source,
  }));

  return { facts, memories };
}

export interface IngestSummary {
  factsWritten: number;
  memoriesWritten: number;
  deduped: number;
}

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
  const { facts, memories } = await extractFromText(text, opts);

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

/** Tolerantly parse the model's JSON: direct parse, then first {...} block. */
function safeParse(raw: string): z.infer<typeof payloadZ> | null {
  const candidate = extractJsonObject(raw);
  if (!candidate) return null;
  let json: unknown;
  try {
    json = JSON.parse(candidate);
  } catch {
    return null;
  }
  const result = payloadZ.safeParse(json);
  return result.success ? result.data : null;
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
