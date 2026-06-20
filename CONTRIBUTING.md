# Contributing to dolores

Thank you for your interest in contributing. dolores is a small, focused project — we value clarity, correctness, and keeping the architectural invariants intact.

## Development setup

**Requirements:** Node ≥ 20, pnpm, Docker.

```bash
git clone https://github.com/yeneryigitcelik-debug/dolores.git
cd dolores
pnpm install

# Start Postgres (pgvector + pg_cron) — needed for db and daemon tests
pnpm db:up

# Build every package
pnpm build

# Apply schema (extensions, tables, RLS, pg_cron decay job)
DATABASE_URL=postgresql://dolores:dolores@localhost:5433/dolores \
  node packages/cli/dist/index.js init --no-docker

# Run all tests
pnpm test

# Lint (biome)
pnpm lint
```

Tests for `core`, `cli`, and `mcp` pass without a running database.
Tests for `db` and `daemon` require Postgres (run `pnpm db:up` first) and the two env vars below:

```
DATABASE_URL=postgresql://dolores:dolores@localhost:5433/dolores
DOLORES_APP_DATABASE_URL=postgresql://dolores_app:dolores@localhost:5433/dolores
DOLORES_EMBED_MODEL=bge-small-en-v1.5
```

The fastembed model (~22 MB) downloads once on first use and is cached in `.dolores-models/`.

## Monorepo map

| Package | Responsibility |
|---|---|
| `packages/db` | Prisma schema, raw-SQL migration (`applyMigrations`), `withTenant` helper, RLS |
| `packages/core` | `Embedder` abstraction, hybrid retrieval, extraction — shared contracts |
| `packages/daemon` | Fastify HTTP server; loads embedder once; owns the connection pool |
| `packages/cli` | `commander`-based thin client that proxies to the daemon |
| `packages/mcp` | MCP server exposing `remember` / `recall` tools |

Shared types (`Embedder`, `Memory`, `Fact`, `DAEMON_ROUTES`, request/response shapes) live in `packages/core/src/types.ts`. Never redefine them in other packages.

## Architectural invariants

These are non-negotiable (see [`CLAUDE.md`](./CLAUDE.md) for the full rationale):

1. **No raw transcripts.** Only distilled facts and memories are stored — never full conversation logs.
2. **Embedder behind an interface.** All embedding goes through the `Embedder` type from `@dolores/core`. pgvector dimensions and vendor SDK details must not leak into retrieval or extraction code.
3. **LLM off the critical path.** `recall` and `context` are pure SQL + vector — no LLM calls. Extraction is async and uses a cheap model. A memory store that needs an LLM to read defeats the purpose.
4. **Postgres as the single source of truth.** No in-process state caches. The daemon owns one pool; CLI and MCP are stateless HTTP clients.
5. **RLS isolation.** Every query carries `workspace_id` (and optionally `user_id`). The daemon connects as `dolores_app` (non-superuser) so RLS applies at all times. Cross-tenant reads are structurally impossible.
6. **Conservative decay by default.** Automatic deletion is opt-in (`DOLORES_DECAY_MODE=aggressive`). The default `conservative` mode only softens importance scores.

## Coding conventions

- **TypeScript strict** — no `any`. Use `unknown` + type narrowing where needed.
- **ESM + `.js` extensions** on all imports (`import { x } from "./y.js"`).
- **No comments explaining what the code does** — names should do that. Comments are for non-obvious *why*: hidden constraints, subtle invariants, workarounds.
- **No silent `catch`** — every error either surfaces to the user (CLI: human-readable message) or the caller (daemon: structured JSON).
- **Env vars validated with zod** in one place per package, not scattered.
- Formatter: `pnpm format` (biome). Linter: `pnpm lint`. Both must be clean before merging.

## Pull request flow

1. Fork the repo and create a feature branch from `main`.
2. Write or update tests for your change.
3. Run `pnpm build && pnpm test && pnpm lint` — all must pass.
4. Open a PR against `main` with a clear description of *what* changed and *why*.
5. Reference any related issue with `Closes #N`.
6. A maintainer will review. Small, focused PRs merge faster.

## Reporting issues

Use the [issue tracker](https://github.com/yeneryigitcelik-debug/dolores/issues). For security vulnerabilities, see [`SECURITY.md`](./SECURITY.md).
