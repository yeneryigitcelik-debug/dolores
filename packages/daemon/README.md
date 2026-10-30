# @dolores/daemon

Long-running HTTP service that owns the tenant Postgres pool, optional admin maintenance pool, and embedding model. CLI and MCP packages are thin HTTP clients of this daemon.

## Startup

```bash
# With pnpm workspace (recommended)
DOLORES_APP_DATABASE_URL=postgresql://dolores_app:dolores@localhost:5544/dolores \
DOLORES_EMBED_MODEL=bge-small-en-v1.5 \
DOLORES_MODEL_CACHE=.dolores-models \
node packages/daemon/dist/index.js
```

The daemon:
1. Checks that the runtime database role cannot bypass RLS and that tenant tables enable and force it. An unsafe connection fails before model loading, workers, or listening.
2. Loads and validates the embedding model **once** (no per-request cold-start); local output must be finite and 384-dimensional.
3. Does **not** run migrations — run `dolores init` (CLI) first.
4. Binds to `127.0.0.1` by default. A non-loopback bind requires `DOLORES_AUTH_TOKEN`; clients must send it as a Bearer token.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `DOLORES_APP_DATABASE_URL` | — | App role connection string (**required**, enables RLS). Falls back to `DATABASE_URL`. |
| `DATABASE_URL` | — | Admin/migration URL; optional runtime maintenance pool. A runtime fallback to a superuser URL is rejected by the preflight. |
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
| `POST` | `/ingest` | Enqueue durable extraction and return 202 with a job ID. Disabled/unavailable extraction returns 503. Delivery is at least once. |
| `POST` | `/ingest/status` | Read the caller-visible job state by `jobId`; no mutation or retry. |
| `POST` | `/prune` | Preview by default (`dryRun: true`). Conservative mode only softens; aggressive mode may also delete eligible unreferenced rows. Explicit `dryRun: false` applies. |

## Graceful shutdown

On `SIGTERM` or `SIGINT`:

1. Fastify stops accepting new connections and drains in-flight handlers (including any ONNX/fastembed ops).
2. Ingest workers finish their current work and stop claiming new jobs.
3. The native embedding session is released, then both Postgres pools end.
4. The event loop drains naturally with exit code 0; no forced successful `process.exit()` runs ONNX destructors during active native work.

A 30-second safety timer forces `process.exit(1)` if draining stalls.
