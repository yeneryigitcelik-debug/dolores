# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
