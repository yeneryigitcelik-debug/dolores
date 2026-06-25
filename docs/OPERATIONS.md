# dolores — Operations Runbook

## Database Backup & Restore

### Backup

`scripts/backup.sh` runs `pg_dump` inside the `dolores-db` container and writes a gzip-compressed SQL file to `backups/`.

```bash
./scripts/backup.sh
# → backups/dolores-YYYYMMDD-HHMMSS.sql.gz
```

**Environment overrides** (all optional, same defaults as `docker-compose.yml`):

| Variable | Default | Description |
|---|---|---|
| `POSTGRES_USER` | `dolores` | Postgres superuser |
| `POSTGRES_DB` | `dolores` | Database name |
| `DOLORES_CONTAINER` | `dolores-db` | Docker container name |
| `BACKUP_DIR` | `./backups` | Output directory |
| `RETENTION_DAYS` | `7` | Backups older than this are deleted |

**Retention:** files matching `dolores-*.sql.gz` older than `RETENTION_DAYS` days are deleted automatically on each run.

**Scheduling (cron example):**

```cron
# Daily backup at 03:00, log to /var/log/dolores-backup.log
0 3 * * * cd /path/to/dolores && ./scripts/backup.sh >> /var/log/dolores-backup.log 2>&1
```

**Verify a backup:**

```bash
gunzip -t backups/dolores-YYYYMMDD-HHMMSS.sql.gz && echo "OK"
```

---

### Restore

`scripts/restore.sh` is **destructive** — it drops and re-creates the target database before restoring. It asks for explicit confirmation (`YES`) before proceeding.

```bash
./scripts/restore.sh backups/dolores-20260620-030000.sql.gz
```

The script:
1. Terminates all active connections to the database.
2. Drops and re-creates the database.
3. Pipes the decompressed SQL through `psql`.

**Do not run restore against a live production database without a maintenance window.**

---

## Decay Modes

dolores uses `pg_cron` to run a nightly decay job that softens the importance of stale, un-recalled memories.

| Mode | Behaviour | How to enable |
|---|---|---|
| `conservative` (default) | Reduces `importance` of stale memories; never deletes | `DOLORES_DECAY_MODE=conservative` (or unset) |
| `aggressive` | Deletes memories whose importance drops below threshold | `DOLORES_DECAY_MODE=aggressive` |

Aggressive delete is explicitly opt-in to prevent accidental data loss. Set it only when running dolores as a short-session scratchpad rather than a long-term memory store.

---

## Memory Evolution (temporal history)

When a new memory closely matches an existing one (cosine > 0.9), `DOLORES_EVOLUTION_MODE` controls what happens:

| Mode | Behaviour | Trade-off |
|---|---|---|
| `inplace` (default) | Overwrites the existing memory in place | No history; least storage |
| `versioned` | Inserts a fresh **active** row and marks the old one *superseded* (chained via `superseded_by`, validity window closed via `valid_to`) | Keeps full history → point-in-time recall; table grows with every contradiction |

`versioned` enables point-in-time queries — the `/recall` body accepts `asOf` (ISO date or datetime) to return the value that was current at that moment, and `includeSuperseded: true` to surface historical rows:

```bash
# current value
curl -s localhost:4505/recall -d '{"workspaceId":"…","query":"hosting provider"}'
# value as of a past date
curl -s localhost:4505/recall -d '{"workspaceId":"…","query":"hosting provider","asOf":"2026-05-01"}'
```

Default recall and the static `/context` blob always show the **active** set only; superseded rows never leak into normal retrieval. The required columns are added automatically by `applyMigrations()` (idempotent) — no manual migration step. If you run `versioned`, monitor table growth and rely on `prune` / decay for cleanup of old superseded rows.

---

## Memory Consolidation (EPIC L)

Over time, many related-but-distinct memories accumulate. Consolidation collapses a **cluster** of related active memories into one higher-order note and *supersedes* the members (EPIC F chain — **never deletes**), shrinking the corpus and sharpening recall.

Opt-in via `DOLORES_CONSOLIDATION_MODE=on`. Trigger it manually or from your own cron (a `pg_cron` job can't call an LLM):

```bash
dolores consolidate                 # current workspace, all scopes
dolores consolidate --scope workspace
# or directly: curl -s localhost:4505/consolidate -d '{"workspaceId":"…"}'
```

How it works: it pulls active, embedded memories, clusters them by cosine similarity (default ≥ 0.82 — below the 0.9 dedup line, so it merges *related* notes, not near-duplicates), asks the cheap extraction LLM to synthesise one note per cluster (min 3 members), writes it, and points the members' `superseded_by` at it. The LLM call runs **off** any DB transaction and **off** the recall path. No provider / API key → graceful no-op. Superseded members remain queryable via `asOf` / `includeSuperseded`.

---

## Observability (EPIC K)

The daemon exposes in-memory request metrics — no external egress (KVKK-clean):

- **`GET /metrics`** (JSON): uptime, total requests, `dedupRate`, per-route
  `count` / `avgMs` / `p50Ms` / `p95Ms` / `p99Ms` / `errors4xx` / `errors5xx`, DB
  connectivity, and (with an admin pool) `queue` depth by ingest-job status.
- **`GET /metrics/prometheus`**: the same data in Prometheus exposition format —
  point a scraper at it. Metrics: `dolores_requests_total`, `dolores_dedup_rate`,
  `dolores_route_latency_ms{route,quantile}`, `dolores_route_errors_total{route,class}`,
  `dolores_ingest_jobs{status}`, `dolores_db_connected`, `dolores_uptime_seconds`.

Both are auth-protected when `DOLORES_AUTH_TOKEN` is set (the `/health` route is the
only exception). Percentiles are computed over a rolling window of the last 1024
requests per route; counts/errors are all-time.

**Load test.** `pnpm loadtest` drives `/recall` (or `/remember` / `mixed`) against a
running daemon and reports p50/p95/p99, throughput, and error rate:

```bash
LOADTEST_CONCURRENCY=50 LOADTEST_DURATION_MS=20000 LOADTEST_OP=mixed pnpm loadtest
```

> Distributed tracing (OpenTelemetry/OTLP) is intentionally **not** bundled — it
> needs heavy optional `@opentelemetry/*` deps and external egress, which is niche
> for a localhost daemon. Metrics + structured pino logs cover local observability;
> OTLP can be added later behind an opt-in flag.

---

## Durable Ingest Queue (EPIC J)

`POST /ingest` (and `dolores ingest`) no longer fire-and-forget. The text is persisted as a job in the `ingest_jobs` table and a background worker distils it asynchronously, so **work survives daemon restarts**. Poll progress with `POST /ingest/status` (`{ workspaceId, jobId }`).

Lifecycle: `pending → running → done | failed`. A failed attempt is retried with exponential backoff up to `DOLORES_INGEST_MAX_ATTEMPTS`, then marked `failed`.

**Privacy (rule 1):** `payload` (the raw text) is a transient work buffer — it is set `NULL` the instant a job reaches a terminal state (`done`/`failed`). dolores never becomes a chat-log store. A nightly `pg_cron` job (`ingest-jobs-purge`) deletes terminal job rows older than 7 days.

**Concurrency & recovery:** workers claim jobs with `FOR UPDATE SKIP LOCKED` (a SECURITY DEFINER function, like the decay jobs — the worker is tenant-agnostic; per-tenant writes still run under RLS). Set `DOLORES_INGEST_WORKERS` > 1 to parallelise. On startup the worker reclaims any job stuck in `running` from a crashed run (back to `pending`). Assumes a single daemon owns the queue (architecture rule 4).

---

## Vector Index (ivfflat vs hnsw)

`DOLORES_VECTOR_INDEX` selects the pgvector access method for the `memories.embedding` column. `applyMigrations()` builds the selected index and drops the other (idempotent — re-running with the same kind never rebuilds).

| Kind | Build | Query latency / recall | Memory | Best for |
|---|---|---|---|---|
| `ivfflat` (default) | fast | good with enough probes | low | small–medium corpora |
| `hnsw` | slower | higher recall, lower latency at scale | higher | large corpora |

Query-time recall/latency is tuned per kind: `DOLORES_IVFFLAT_PROBES` (ivfflat) or `DOLORES_HNSW_EF_SEARCH` (hnsw). recall sets the matching GUC automatically.

**Switching kinds rebuilds the index.** `applyMigrations()` runs inside a transaction, so it uses a plain `CREATE INDEX` (table lock during build). On a large, live table prefer building out-of-band with `CREATE INDEX CONCURRENTLY` (cannot run in a transaction), then drop the old index:

```sql
-- hnsw, no long write-lock:
CREATE INDEX CONCURRENTLY idx_memories_embedding_hnsw
  ON memories USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
DROP INDEX CONCURRENTLY idx_memories_embedding;   -- the old ivfflat index
```

Then set `DOLORES_VECTOR_INDEX=hnsw` so recall uses `hnsw.ef_search`. Benchmark both with `pnpm bench` (the output labels the active index) to pick per your scale.

---

## Daemon Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | — | Postgres superuser URL (used by `dolores init`) |
| `DOLORES_APP_DATABASE_URL` | — | Postgres app-role URL (used by the daemon at runtime) |
| `DOLORES_AUTH_TOKEN` | — | Bearer token the daemon requires on every HTTP request. **Set this in production.** |
| `DOLORES_DAEMON_PORT` | `4505` | Port the daemon listens on (localhost only) |
| `DOLORES_LOG_LEVEL` | `info` | Fastify log level (`trace` / `debug` / `info` / `warn` / `error`) |
| `DOLORES_EMBED_MODEL` | `bge-small-en-v1.5` | fastembed model name (`bge-small-en-v1.5` = 384d CPU) |
| `DOLORES_MODEL_CACHE` | `~/.dolores-models` | Where fastembed stores downloaded model weights |
| `DOLORES_VECTOR_INDEX` | `ivfflat` | Vector index access method: `ivfflat` (default) or `hnsw` (pgvector ≥0.5). See Vector Index below |
| `DOLORES_IVFFLAT_PROBES` | `10` | `ivfflat.probes` for pgvector ANN searches (higher = more accurate, slower) |
| `DOLORES_HNSW_EF_SEARCH` | `40` | `hnsw.ef_search` when `DOLORES_VECTOR_INDEX=hnsw` (higher = more accurate, slower) |
| `DOLORES_FUSION_VECTOR_WEIGHT` | `1` | RRF weight for the pgvector arm (bias the hybrid score toward semantic match) |
| `DOLORES_FUSION_FT_WEIGHT` | `1` | RRF weight for the full-text arm (bias toward keyword match) |
| `DOLORES_MMR_LAMBDA` | `1` | MMR diversity: `1` = pure relevance (off); `<1` trades relevance for diversity to avoid near-duplicate hits (pure math, no model) |
| `DOLORES_RERANKER` | `noop` | Final-stage reranker kind. Only `noop` (identity) exists today; the extension point for a local cross-encoder (never an LLM). Unknown values fall back to `noop` |
| `DOLORES_DECAY_MODE` | `conservative` | `conservative` (soften) or `aggressive` (delete) — see Decay Modes above |
| `DOLORES_EVOLUTION_MODE` | `inplace` | `inplace` (overwrite) or `versioned` (keep history for `asOf` recall) — see Memory Evolution above |
| `DOLORES_EXTRACTION_MODEL` | — | LLM model ID used for async fact extraction (`ingest` command) |
| `DOLORES_INGEST_WORKERS` | `1` | Concurrent ingest worker loops draining the durable queue |
| `DOLORES_INGEST_POLL_MS` | `1000` | Worker idle poll interval (ms) |
| `DOLORES_INGEST_MAX_ATTEMPTS` | `3` | Retries (exponential backoff) before a job is marked `failed` |
| `DOLORES_EXTRACTION_MIN_CONFIDENCE` | `0` | Drop extracted items whose model-reported confidence is below this (0..1); confidence-less items always kept |
| `DOLORES_EXTRACTION_MAX_FACTS` | `20` | Maximum facts extracted per `ingest` call |
| `DOLORES_EXTRACTION_TIMEOUT_MS` | `30000` | Timeout for a single extraction LLM call (ms) |
| `WORKSPACE_ID` | — | Default workspace UUID for CLI operations |
| `USER_ID` | — | Optional user UUID for per-user memory isolation |

---

## Production Deployment Notes

### Bind to localhost only

The daemon must **never** be exposed on a public interface. The default port (`4505`) is localhost-only by design. Reverse-proxy via nginx or Caddy if external access is required, and terminate TLS there.

```nginx
# Example: expose dolores daemon behind nginx on /dolores/
location /dolores/ {
    proxy_pass http://127.0.0.1:4505/;
    proxy_set_header Authorization "Bearer $DOLORES_AUTH_TOKEN";
}
```

### Auth token

Set `DOLORES_AUTH_TOKEN` to a long random secret (32+ hex chars). Without it the daemon accepts all connections.

```bash
openssl rand -hex 32  # generate a token
```

Export it in `.env` (not committed) and reference it in your reverse proxy or MCP config.

### Postgres port — localhost bind

The default `docker-compose.yml` binds Postgres to `${POSTGRES_PORT:-5433}` on all interfaces. In production, bind to localhost only:

```yaml
ports:
  - "127.0.0.1:${POSTGRES_PORT:-5433}:5432"
```

Never expose port 5432/5433 publicly.

### Reverse proxy + TLS

dolores itself does not terminate TLS. Put Caddy or nginx in front:

- Caddy auto-renews Let's Encrypt certificates.
- nginx: `listen 80;` → `return 301 https://...;`, `listen 443 ssl;` with `ssl_protocols TLSv1.2 TLSv1.3;`.
- Add `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`.

### Container resource limits

The `db` service in `docker-compose.yml` is configured with:

- Memory limit: `1g` (hard ceiling, prevents OOM-kill cascade)
- CPU limit: `2.0` cores
- Memory reservation: `512m`

Tune these for your host. A Postgres instance for dolores typically needs 256–512 MB under normal load.
