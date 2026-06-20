# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
