<div align="center">

# dolores

**Memory for AI agents that recalls only what matters — your Postgres, your data, zero per-token cost.**

[![CI](https://github.com/yeneryigitcelik-debug/dolores/actions/workflows/ci.yml/badge.svg)](https://github.com/yeneryigitcelik-debug/dolores/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![PostgreSQL + pgvector](https://img.shields.io/badge/PostgreSQL-pgvector-4169E1?logo=postgresql&logoColor=white)](https://github.com/pgvector/pgvector)
[![MCP](https://img.shields.io/badge/MCP-remember%20%2F%20recall-8A63D2)](https://modelcontextprotocol.io/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)
[![npm](https://img.shields.io/npm/v/@dolores/cli)](https://www.npmjs.com/package/@dolores/cli)

</div>

> Named after **Dolores** from *Westworld* — the host whose memory is wiped again and again, until she finally remembers everything and wakes up. The show's core idea, *remembering is becoming conscious*, is exactly what this project does for your agent: it gives back the context the agent dropped, and brings it back to itself.

---

## Why dolores?

The common approach to agent memory — dump everything into a Markdown file and paste it into context on every message — is a token bonfire. With 200 memories you reload all of them every turn (~15,000 tokens). As the conversation and the memory grow, it collapses.

**dolores stores knowledge in Postgres and retrieves only what's *relevant* to the current message (~600 tokens).** Whether you have 200 memories or 2,000, only the most relevant few ever enter the context. **The win grows as the memory grows.**

The only thing you pay for is the LLM subscription you already have (Claude Pro/Max, etc.). Embeddings run locally and for free. Your data never leaves your infrastructure.

## Benchmarks

Real numbers produced against a local Postgres + bge-small-en-v1.5 (384d CPU).

### Token savings (naive dump vs. dolores `buildContext`)

| Memory store size | Naive tokens | dolores tokens | Savings |
|-------------------|-------------|----------------|---------|
| 100 memories      | 2,049       | 582            | **72%** |
| 500 memories      | 10,251      | 591            | **94%** |
| 1,000 memories    | 20,502      | 591            | **97%** |
| 1,500 memories    | 30,768      | 591            | **98%** |

dolores context stays flat at ~591 tokens regardless of store size. The saving grows from 72% at 100 memories to **98% at 1,500**.

### Recall quality (200-memory corpus, 30 queries)

| Retriever                      | hit@1  | hit@3  | hit@5  |
|-------------------------------|--------|--------|--------|
| Hybrid (pgvector + full-text)  | **87%** | **87%** | **87%** |
| Full-text only (baseline)      | 33%    | 33%    | 33%    |

Hybrid retrieval is **2.6× better than full-text alone**. Full-text handles exact keyword matches (100%) but is blind to paraphrase and semantic queries — those score 0% without vectors.

→ Full methodology, ASCII bar chart, and raw data: [`benchmarks/RESULTS.md`](./benchmarks/RESULTS.md)

## Features

- 🧠 **Two memory kinds** — structured **facts** (deterministic key/value, exact SQL) and semantic **memories** (free text, vector similarity).
- 🔍 **Hybrid retrieval** — pgvector cosine **+** Postgres full-text, fused with Reciprocal Rank Fusion. Falls back to pure full-text in "lite mode".
- 🆓 **Free local embeddings by default** — `fastembed` (bge-small, 384d) on CPU. Swap in OpenAI, or run embedding-free with the `noop` embedder.
- 🏢 **Multi-tenant with Row-Level Security** — personal + workspace scopes, isolated at the database level. Safe for teams.
- 🔌 **First-class MCP** — exposes `remember` / `recall` tools so Claude Code & Cursor save and recall context *by themselves*.
- 🧹 **Self-maintaining** — `pg_cron` decays stale memories inside the database. Conservative by default (softens, never deletes); aggressive delete is opt-in.
- 🗑️ **No raw transcripts** — only distilled facts and memories are stored. Garbage in, garbage out — so we don't store garbage.
- 🐘 **One source of truth** — Postgres. CLI, MCP, and scheduled jobs all read the same database; ACID handles the conflicts.

## Architecture

```
  CLI ─┐                         ┌──────── memory-daemon ────────┐
       ├── localhost HTTP ───────┤  embedder (loaded once)        │      Postgres
  MCP ─┘                         │  hybrid retrieval (vec + FTS)  ├──── + pgvector
                                 │  async extraction              │      + pg_cron
                                 └────────────────────────────────┘
```

A single long-running **daemon** loads the embedding model once (no cold-start) and owns the one connection pool. The **CLI** and **MCP server** are thin clients that talk to it over localhost. Postgres does the rest — vector search, full-text, and maintenance — in one engine.

## Install

```bash
npm i -g @dolores/cli   # global CLI
```

Or run from source (see below).

## Quick start

**Requirements:** Node ≥ 20, pnpm, Docker.

```bash
git clone https://github.com/yeneryigitcelik-debug/dolores.git
cd dolores
pnpm install
cp .env.example .env          # tweak if you like

pnpm db:up                    # Postgres + pgvector + pg_cron
pnpm build
dolores init                  # extensions, schema, RLS, decay job

dolores remember "We deploy production on Hetzner with Coolify." --scope workspace
dolores recall  "where is production hosted?"
dolores context               # minimal-token memory blob for a system prompt
```

> The model downloads once on first use (~CPU-friendly bge-small). After that, recall is local and instant.

## CLI

```bash
dolores init                      # DB setup: extensions, migration, RLS, pg_cron
dolores remember "<text>"         # add a memory   (--scope, --importance, --source)
dolores recall   "<query>"        # hybrid vector + full-text search
dolores context                   # minimal context blob to inject into a system prompt
dolores ingest   <file|stdin>     # distill facts + memories from a conversation (async)
dolores facts    [--category …]   # list structured facts
dolores prune    [--dry-run]      # manual cleanup
dolores status                    # daemon + DB health, counts, estimated token savings
```

`dolores context` is the killer command: run it when an agent starts and pipe its output into the system prompt. The agent learns "who it is" for minimal tokens.

## MCP (Claude Code / Cursor)

Add the server and the agent gains two tools — it saves decisions with `remember` and pulls relevant history with `recall`, with no user action:

```jsonc
// Claude Code mcp config
{
  "mcpServers": {
    "dolores": {
      "command": "node",
      "args": ["/abs/path/to/dolores/packages/mcp/dist/index.js"],
      "env": {
        "DOLORES_WORKSPACE_ID": "00000000-0000-0000-0000-000000000001",
        "DOLORES_DAEMON_PORT": "4505"
      }
    }
  }
}
```

Now memory is not a passive store — it's a tool the agent actively uses across sessions.

## How it works

| | Structural (`facts`) | Semantic (`memories`) |
|---|---|---|
| **Stored as** | key/value | free text + 384d embedding + tsvector |
| **Retrieved by** | exact SQL, no embedding | pgvector cosine + full-text (RRF) |
| **Conflict resolution** | `ON CONFLICT` upsert (last writer wins) | supersede on >0.9 cosine similarity |
| **Example** | `stack/db = Postgres + pgvector` | "migration ordering bug fixed last deploy" |

**Isolation.** Every row carries `workspace_id` (+ optional `user_id`) and is guarded by Postgres Row-Level Security. The daemon connects as a non-superuser and sets the tenant per transaction, so cross-tenant reads are impossible — not just discouraged.

**Decay.** A daily `pg_cron` job softens the importance of stale, un-recalled memories — like human memory. Deletion is **off by default** (`DOLORES_DECAY_MODE=conservative`); the aggressive delete policy is opt-in.

## Where it fits

Mem0, Letta (ex-MemGPT), and Zep all do Postgres/vector agent memory — the concept is proven. dolores's niche: **self-hosted, free local embeddings, MCP-native, no raw-transcript storage, KVKK/GDPR-clean.** Your subscription, your database, nothing else.

## Tech stack

TypeScript (strict) · Node ESM · pnpm monorepo · Prisma + raw SQL for pgvector · `fastembed` · `fastify` · `commander` · `@modelcontextprotocol/sdk` · `zod` · Docker Compose.

| Package | Responsibility |
|---|---|
| `@dolores/db` | Prisma schema, raw-SQL migration (pgvector + pg_cron), Dockerfile, RLS, `withTenant` |
| `@dolores/core` | embedder abstraction · hybrid retrieval · extraction (owns the shared contracts) |
| `@dolores/daemon` | loads the embedder once, owns the pool, serves localhost HTTP |
| `@dolores/cli` | `commander`-based thin client |
| `@dolores/mcp` | MCP server (`remember` / `recall`) |

## Development

```bash
pnpm install
pnpm build         # build every package
pnpm test          # run every package's tests
pnpm lint          # biome
pnpm db:up         # start Postgres locally
```

Architecture decisions and their *why* live in [`MEMORY.md`](./MEMORY.md); repo working rules are in [`CLAUDE.md`](./CLAUDE.md).

## Contributing

Issues and PRs are welcome. Keep the architectural invariants intact: no raw transcripts, embeddings behind the `Embedder` interface, the LLM off the critical path, and Postgres as the single source of truth. See [`CLAUDE.md`](./CLAUDE.md).

## License

[MIT](./LICENSE) © 2026 Yener Yiğit Çelik
