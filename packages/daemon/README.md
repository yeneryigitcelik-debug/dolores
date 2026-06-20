# @dolores/daemon

Long-running HTTP service that owns the single Postgres pool and the embedding
model. CLI and MCP packages are thin HTTP clients of this daemon.

## Startup

```bash
# With pnpm workspace (recommended)
DOLORES_APP_DATABASE_URL=postgresql://dolores_app:dolores@localhost:5544/dolores \
DOLORES_EMBED_MODEL=bge-small-en-v1.5 \
DOLORES_MODEL_CACHE=.dolores-models \
node packages/daemon/dist/index.js
```

The daemon:
1. Loads the embedding model **once** (no per-request cold-start).
2. Opens a single `pg.Pool` as the `dolores_app` non-superuser → RLS is enforced on every query.
3. Does **not** run migrations — run `dolores init` (CLI) first.
4. Binds only to `127.0.0.1` (never 0.0.0.0) for security.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `DOLORES_APP_DATABASE_URL` | — | App role connection string (**required**, enables RLS). Falls back to `DATABASE_URL`. |
| `DATABASE_URL` | — | Fallback DB URL (used if `DOLORES_APP_DATABASE_URL` is not set). |
| `DOLORES_DAEMON_HOST` | `127.0.0.1` | Bind address. |
| `DOLORES_DAEMON_PORT` | `4505` | Listen port. |
| `DOLORES_EMBEDDER` | `local` | `local` \| `openai` \| `noop`. |
| `DOLORES_EMBED_MODEL` | `bge-small-en-v1.5` | Model name (fastembed for local, OpenAI model id for openai). |
| `DOLORES_MODEL_CACHE` | `.dolores-models` | Directory for cached fastembed model files. |
| `DOLORES_DECAY_MODE` | `conservative` | `conservative` (soften) \| `aggressive` (delete via pg_cron). |
| `DOLORES_EXTRACTION_ENABLED` | `false` | Enable LLM-based fact/memory extraction in `/ingest`. |

## Endpoints

All POST bodies must carry `workspaceId` (UUID) and optionally `userId` (UUID) — these
drive Postgres RLS tenant isolation. Request body type errors return **400**.

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | `{ ok: true }` — always 200 if process is up. |
| `GET` | `/status` | Embedder info, DB connectivity + counts, decay mode. |
| `POST` | `/remember` | Write a semantic memory (deduplicates >0.9 cosine similarity). |
| `POST` | `/recall` | Hybrid vector + full-text search, returns ranked hits. |
| `POST` | `/context` | Build a system-prompt blob (facts + memories) under a token budget. |
| `POST` | `/facts/list` | List structured facts, optionally filtered by `category`. |
| `POST` | `/facts/upsert` | Insert or update a fact (last-writer-wins on `(workspace, user, category, key)`). |
| `POST` | `/ingest` | Fire-and-forget: extract facts + memories from raw text via LLM (async, graceful if disabled). |
| `POST` | `/prune` | Conservative prune: soften stale memories (>30 days), delete abandoned ones (>90 days, importance<3). Supports `dryRun`. |

## Graceful shutdown

On `SIGTERM` or `SIGINT`:

1. Fastify stops accepting new connections and drains in-flight handlers (including any ONNX/fastembed ops).
2. The Postgres pool ends (waits for in-flight queries).
3. `process.exit(0)` — **no** `libc++abi: mutex lock failed` crash from onnxruntime.

A 30-second safety timer forces `process.exit(1)` if draining stalls.
