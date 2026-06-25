/**
 * Shared contracts for ALL dolores packages — single source of truth.
 *
 * db / core / daemon / cli / mcp must agree on these shapes. Do NOT redefine
 * these types locally in other packages; import them from `@dolores/core`.
 */

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

/** Memory isolation scope (drives Row Level Security). */
export type Scope = "personal" | "workspace";

/** Decay policy. conservative = soften only; aggressive = pg_cron deletes. */
export type DecayMode = "conservative" | "aggressive";

/**
 * Memory evolution policy on near-duplicate write (EPIC F).
 *  - inplace   : overwrite the existing row (default; no history, least storage).
 *  - versioned : insert a fresh active row and mark the old one superseded
 *                (keeps history → `asOf` point-in-time recall works).
 */
export type EvolutionMode = "inplace" | "versioned";

/** Structured-fact category. Free-form, but these are the conventional ones. */
export type FactCategory = "stack" | "preference" | "project" | "decision";

/** A structured fact (deterministic key-value memory → `facts` table). */
export interface Fact {
  id: string;
  workspaceId: string;
  userId: string | null;
  scope: Scope;
  category: string;
  key: string;
  value: string;
  createdAt: string;
  updatedAt: string;
}

/** A semantic memory (free text + embedding → `memories` table). */
export interface Memory {
  id: string;
  workspaceId: string;
  userId: string | null;
  scope: Scope;
  content: string;
  importance: number; // 1..10
  source: string | null;
  createdAt: string;
  lastAccessed: string;
  // --- Temporal evolution (EPIC F) ---
  /** id of the memory that replaced this one; null = active (current). */
  supersededBy: string | null;
  /** when this statement became true. */
  validFrom: string;
  /** when it stopped being true (set on supersede); null = still true. */
  validTo: string | null;
}

/** Identity passed with every request — RLS isolation key. */
export interface MemoryContext {
  workspaceId: string;
  /** null/undefined = workspace-level (visible to whole team). */
  userId?: string | null;
}

// ---------------------------------------------------------------------------
// Embedder abstraction (pluggable, free by default)
// ---------------------------------------------------------------------------

/**
 * Embedder is the foundation everything else builds on. Keep it behind this
 * interface — never let pgvector dims or a vendor SDK leak into retrieval.
 * `dim` MUST equal the VECTOR(n) column size in the `memories` table.
 */
export interface Embedder {
  /** Stable id, e.g. "local:bge-small-en-v1.5" | "openai:text-embedding-3-small" | "noop". */
  readonly id: string;
  /** Vector dimensions. NoOpEmbedder reports 0 (lite mode → full-text only). */
  readonly dim: number;
  /** Warm up / load the model once. Safe to call multiple times. */
  ready(): Promise<void>;
  /** Embed a batch. Returns [] for NoOpEmbedder. */
  embed(texts: string[]): Promise<number[][]>;
  /**
   * Release native resources (e.g. the onnxruntime session) before the process
   * exits. Optional — implementations without native handles may omit it.
   */
  dispose?(): Promise<void>;
}

export type EmbedderKind = "local" | "openai" | "noop";

// ---------------------------------------------------------------------------
// Reranker abstraction (optional final-stage re-ranking — EPIC H)
// ---------------------------------------------------------------------------

/** A candidate handed to a Reranker: id + content + the current hybrid score. */
export interface RerankCandidate {
  id: string;
  content: string;
  /** Current hybrid (fused + boosted) score, 0..1, before reranking. */
  score: number;
}

/**
 * Optional final-stage reranker. Reorders the candidate pool by query relevance
 * after hybrid fusion. MUST be LOCAL — a CPU model or pure heuristic, NEVER a
 * network LLM — so recall stays off the critical LLM path. Default is the
 * identity NoOpReranker; a concrete local cross-encoder can be plugged in via
 * createReranker (see `@dolores/core` rerank/).
 */
export interface Reranker {
  /** Stable id, e.g. "noop" | "local:bge-reranker-base". */
  readonly id: string;
  /** Return the candidates reordered (and optionally re-scored) for `query`. */
  rerank(query: string, candidates: RerankCandidate[]): Promise<RerankCandidate[]>;
  /** Warm up / load the model once. Optional. */
  ready?(): Promise<void>;
  /** Release native resources before exit. Optional. */
  dispose?(): Promise<void>;
}

/** Only "noop" exists today; the extension point for a local cross-encoder. */
export type RerankerKind = "noop";

// ---------------------------------------------------------------------------
// Retrieval / write inputs
// ---------------------------------------------------------------------------

export interface RememberInput {
  content: string;
  /** default "personal" */
  scope?: Scope;
  /** 1..10, default 5 */
  importance?: number;
  /** free-form provenance, e.g. a conversation id */
  source?: string;
}

export interface RecallQuery {
  query: string;
  /** default 5 */
  limit?: number;
  /** omit = search BOTH personal + workspace */
  scope?: Scope;
  /** 1..10 floor */
  minImportance?: number;
  /**
   * Point-in-time recall (EPIC F): return the version of each memory that was
   * valid at this ISO timestamp (valid_from <= asOf < valid_to). Implies
   * searching superseded rows, since historical versions carry a valid_to.
   */
  asOf?: string;
  /**
   * Include superseded (historical) memories in the result. Ignored when `asOf`
   * is set (asOf already selects by validity window). Default false = active only.
   */
  includeSuperseded?: boolean;
}

export interface RecallHit {
  id: string;
  content: string;
  importance: number;
  scope: Scope;
  /** hybrid (vector + full-text) score, normalized 0..1 */
  score: number;
  source: string | null;
  createdAt: string;
  /**
   * id of the memory that superseded this one; null = active. Populated so
   * `asOf` / `includeSuperseded` callers can tell historical hits from current
   * ones. Omitted/null on the default (active-only) path.
   */
  supersededBy?: string | null;
}

export interface RecallResult {
  hits: RecallHit[];
  /** rough token count of the rendered hits (savings reporting) */
  tokenEstimate: number;
}

export interface FactInput {
  category: string;
  key: string;
  value: string;
  scope?: Scope;
}

// ---------------------------------------------------------------------------
// Daemon HTTP API contract (localhost). CLI + MCP are thin clients of these.
// Bodies always carry MemoryContext (workspaceId [+ userId]).
// ---------------------------------------------------------------------------

export const DAEMON_ROUTES = {
  health: { method: "GET", path: "/health" },
  status: { method: "GET", path: "/status" },
  remember: { method: "POST", path: "/remember" },
  recall: { method: "POST", path: "/recall" },
  context: { method: "POST", path: "/context" },
  factsList: { method: "POST", path: "/facts/list" },
  factsUpsert: { method: "POST", path: "/facts/upsert" },
  ingest: { method: "POST", path: "/ingest" },
  ingestStatus: { method: "POST", path: "/ingest/status" },
  prune: { method: "POST", path: "/prune" },
} as const;

export interface RememberRequest extends MemoryContext, RememberInput {}
export interface RememberResponse {
  id: string;
  /** true if it merged into / superseded a near-duplicate (>0.9 similarity) */
  deduped: boolean;
}

export interface RecallRequest extends MemoryContext, RecallQuery {}
export type RecallResponse = RecallResult;

export interface ContextRequest extends MemoryContext {
  /** token budget for the rendered context blob, default ~600 */
  maxTokens?: number;
  /**
   * Optional task query. When set, the context is filled with the most RELEVANT
   * memories (hybrid recall) for that query instead of just the most
   * important/recent ones. Omit for a static identity blob.
   */
  query?: string;
}
export interface ContextResponse {
  /** ready-to-inject system-prompt text (facts + top memories) */
  text: string;
  tokenEstimate: number;
}

export interface FactsListRequest extends MemoryContext {
  category?: string;
}
export interface FactsListResponse {
  facts: Fact[];
}

export interface FactsUpsertRequest extends MemoryContext, FactInput {}
export interface FactsUpsertResponse {
  fact: Fact;
}

export interface IngestRequest extends MemoryContext {
  /** raw conversation/text to distill facts+memories from (async) */
  text: string;
  source?: string;
}
export interface IngestResponse {
  queued: boolean;
  jobId?: string;
}

/** Lifecycle of a durable ingest job (EPIC J). */
export type IngestJobStatus = "pending" | "running" | "done" | "failed";

export interface IngestStatusRequest extends MemoryContext {
  jobId: string;
}
export interface IngestStatusResponse {
  id: string;
  status: IngestJobStatus;
  attempts: number;
  /** last failure message (null until a failure). */
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PruneRequest extends MemoryContext {
  dryRun?: boolean;
}
export interface PruneResponse {
  deleted: number;
  softened: number;
  dryRun: boolean;
}

export interface HealthResponse {
  ok: boolean;
}

export interface StatusResponse {
  ok: boolean;
  embedder: { id: string; dim: number; ready: boolean };
  db: { connected: boolean; memories: number; facts: number };
  decayMode: DecayMode;
  /** rough tokens saved vs. dumping all memories into context */
  estimatedTokenSavings: number;
}

// ---------------------------------------------------------------------------
// Daemon runtime config (resolved from env). Shared so cli can locate daemon.
// ---------------------------------------------------------------------------

export interface DaemonConfig {
  host: string; // DOLORES_DAEMON_HOST, default 127.0.0.1
  port: number; // DOLORES_DAEMON_PORT, default 4505
  databaseUrl: string; // DATABASE_URL
  embedder: EmbedderKind; // DOLORES_EMBEDDER
  embedModel: string; // DOLORES_EMBED_MODEL
  decayMode: DecayMode; // DOLORES_DECAY_MODE
  extractionEnabled: boolean; // DOLORES_EXTRACTION_ENABLED
}

/** Default embedding dimensions for the conventional local model. */
export const BGE_SMALL_DIM = 384;
