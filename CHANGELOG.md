# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Memory consolidation** (v0.4 EPIC L). Collapses clusters of related active
  memories into one higher-order note and *supersedes* the members (EPIC F chain
  — never deletes), shrinking the corpus and sharpening recall.
  - Opt-in `DOLORES_CONSOLIDATION_MODE=on`; `POST /consolidate` + `dolores
    consolidate`. Clusters by cosine ≥ 0.82 (below the 0.9 dedup line → merges
    *related* notes, not duplicates), synthesises one note per cluster (min 3
    members) with the cheap extraction LLM — off any DB transaction and off the
    recall path. No provider → graceful no-op. Members stay queryable via `asOf`.
- **Observability** (v0.4 EPIC K). Local, no external egress:
  - Rich **`GET /metrics`** (JSON): per-route p50/p95/p99 latency (rolling 1024-req
    window), 4xx/5xx counts, all-time totals, `dedupRate`, DB connectivity, and
    ingest-queue depth by status.
  - **`GET /metrics/prometheus`**: the same data in Prometheus exposition format.
  - `pnpm loadtest` — a dependency-free load harness reporting p50/p95/p99,
    throughput, and error rate against a running daemon.
  - _(OpenTelemetry/OTLP tracing intentionally deferred — heavy optional deps +
    external egress, niche for a localhost daemon. Metrics + pino logs cover it.)_
- **Durable ingest queue** (v0.4 EPIC J). `/ingest` no longer fire-and-forgets:
  the text is persisted as a job in a Postgres-native queue and a background
  worker distils it asynchronously, so **work survives daemon restarts**.
  - `POST /ingest` returns `{ queued, jobId }`; new `POST /ingest/status` polls a
    job (`pending → running → done | failed`).
  - Workers claim jobs with `FOR UPDATE SKIP LOCKED` (SECURITY DEFINER, like the
    decay jobs); per-tenant writes still run under RLS. `DOLORES_INGEST_WORKERS`,
    `DOLORES_INGEST_POLL_MS`, `DOLORES_INGEST_MAX_ATTEMPTS` (exponential backoff).
  - **Privacy (rule 1):** `payload` is purged the instant a job is terminal; a
    nightly `pg_cron` job deletes old terminal rows. dolores never stores raw text.
  - On startup the worker reclaims jobs stuck in `running` from a crashed run.
- **HNSW vector index option** (v0.4 EPIC I). `DOLORES_VECTOR_INDEX=hnsw` (pgvector
  ≥0.5) builds an HNSW index instead of ivfflat — higher recall + lower latency at
  scale. `applyMigrations()` builds the selected index and drops the other
  (idempotent, no rebuild on re-run with the same kind). recall sets the matching
  query-time GUC automatically: `DOLORES_IVFFLAT_PROBES` or `DOLORES_HNSW_EF_SEARCH`.
  `pnpm bench` labels the active index so ivfflat-vs-hnsw runs are comparable.
  Closes the last open "ivfflat vs hnsw" question. Default stays ivfflat.
- **Retrieval ranking v2** (v0.3 EPIC H, partial). Recall stays LLM-free (pure
  SQL + vector + math):
  - **Tunable weighted fusion** — `DOLORES_FUSION_VECTOR_WEIGHT` /
    `DOLORES_FUSION_FT_WEIGHT` bias the RRF score toward semantic or keyword
    match (default 1=1 = classic equal-weight RRF). Closes the open "hybrid score
    weighting" question.
  - **MMR diversity** — `DOLORES_MMR_LAMBDA` (<1) trades relevance for diversity
    so the top-N isn't near-duplicate memories; candidate embeddings are fetched
    only when MMR is on. Pure cosine math, no model. Default 1 = off (unchanged).
  - **Pluggable reranker seam** — a `Reranker` interface + `NoOpReranker` (default,
    identity) wired as an optional final stage in `recall`/`buildContext`,
    selected via `DOLORES_RERANKER`. The documented extension point for a LOCAL
    cross-encoder (never an LLM); the concrete model is deferred (fastembed ships
    no reranker, so it needs its own dependency + eval).
- **Extraction quality v2** (v0.3 EPIC G). The async distiller is more robust and
  measurable, still off the critical path:
  - **Per-item validation** — one malformed fact/memory no longer drops the whole
    payload; valid items survive.
  - **Confidence gating** — items may carry a `confidence` (0..1); set
    `DOLORES_EXTRACTION_MIN_CONFIDENCE` to drop low-confidence ones (default 0 =
    keep all; confidence-less items always kept).
  - **Contradiction-aware** — `ingestText` feeds the tenant's existing facts into
    the prompt so the model reuses the SAME category+key on an update (→ upsert
    overwrites instead of creating a near-duplicate). Stronger few-shot prompt.
  - **Extraction eval harness** — `pnpm bench:extraction` scores fact/memory
    recall + ephemeral-discipline on labelled fixtures (skips without an API key).
- **Temporal memory evolution** (v0.3 EPIC F). A near-duplicate write can now
  *supersede* the old memory instead of silently overwriting it:
  - `DOLORES_EVOLUTION_MODE=versioned` keeps history — the old row is chained
    (`superseded_by`) and its validity window is closed (`valid_to`), while a fresh
    active row carries the current value. Default stays `inplace` (overwrite).
  - `/recall` gains `asOf` (ISO date/datetime → point-in-time recall) and
    `includeSuperseded` (surface historical rows). Default recall and the static
    `/context` blob show the **active** set only.
  - New raw-SQL columns on `memories` (`superseded_by`, `valid_from`, `valid_to`)
    + a partial active-set index, applied idempotently by `applyMigrations()`.
  - Dedup now compares against active rows only; recency (`last_accessed`) is not
    bumped on `asOf`/`includeSuperseded` reads (no pollution of the live signal).

## [0.2.0] - 2026-06-20

### Added
- **Anthropic/Claude extraction provider** — the intended default for Claude
  subscribers; `createLlmProviderFromEnv` auto-selects anthropic/openai/none.
- **Query-aware context**: `dolores context "<task>"` fills the blob with the most
  RELEVANT memories (hybrid recall) instead of just important/recent ones.
- Optional **bearer auth** (`DOLORES_AUTH_TOKEN`) + a startup safety gate that
  refuses to start on a non-localhost bind without a token.
- **`/metrics`** endpoint (auth-protected) and structured logging (pino,
  `DOLORES_LOG_LEVEL`).
- **DB backup/restore** (`scripts/backup.sh`, `scripts/restore.sh`) +
  `docs/OPERATIONS.md` runbook.
- **Reproducible benchmarks** (`pnpm bench`): token savings (72–98%) and recall@k
  (hybrid 87% vs full-text 33%) — summarized in the README.
- `examples/` — Claude Code MCP, agent-context pipe, Node SDK.
- ivfflat probe tuning (`DOLORES_IVFFLAT_PROBES`) and an importance/recency boost
  on the retrieval score.

### Changed
- **Memory decay now works**: `pg_cron` runs via SECURITY DEFINER functions —
  previously a silent no-op under FORCE RLS (the scheduler saw zero rows).
- `dolores_app` password from `DOLORES_APP_PASSWORD` (no longer hardcoded).
- Daemon: body-length limits and redacted error responses (`{error:{code,message}}`).
- **fastembed** is now an optional peer dependency of `@dolores/core` and a direct
  dependency of the daemon — `@dolores/mcp` and `@dolores/cli` no longer pull the
  ~80MB ONNX runtime.
- `prune` requires `--confirm` (no silent data loss).
- Pinned base image `postgres:17.2-bookworm`; CI least-privilege permissions.

### Fixed
- `remember()` dedup race (advisory lock + explicit tenant filter).
- N+1 in ingest (single batch embed + batch fact upsert).
- Missing composite ranking index, `fillfactor=80`, RLS `WITH CHECK`, and
  transactional migrations.

## [0.1.0] - 2026-06-20

### Added

- Initial release.
- **Two memory kinds:** structured `facts` (deterministic key/value upsert) and semantic `memories` (free text + 384-dim embedding).
- **Hybrid retrieval** via Reciprocal Rank Fusion — pgvector cosine **+** Postgres full-text — with a full-text-only "lite mode".
- **Free local embeddings** by default (`fastembed`, bge-small, 384d); pluggable OpenAI and `noop` embedders behind the `Embedder` interface.
- **Multi-tenant Row-Level Security** — `personal` / `workspace` scopes isolated at the database level; the daemon connects as a non-superuser so RLS is always enforced.
- **memory-daemon** (fastify, localhost) — loads the embedder once (no cold-start), owns the single connection pool, graceful shutdown with no native crash.
- **CLI** — `init`, `remember`, `recall`, `context`, `ingest`, `facts`, `prune`, `status`.
- **MCP server** — `remember` / `recall` tools for Claude Code & Cursor.
- **Self-maintaining decay** via `pg_cron` — conservative (soften, never delete) by default; aggressive (delete) is opt-in.
- Docker Compose stack: Postgres 17 + pgvector + pg_cron.

[Unreleased]: https://github.com/yeneryigitcelik-debug/dolores/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/yeneryigitcelik-debug/dolores/releases/tag/v0.1.0
