# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
