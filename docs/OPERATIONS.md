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
| `DOLORES_IVFFLAT_PROBES` | `10` | `ivfflat.probes` for pgvector ANN searches (higher = more accurate, slower) |
| `DOLORES_DECAY_MODE` | `conservative` | `conservative` (soften) or `aggressive` (delete) — see Decay Modes above |
| `DOLORES_EVOLUTION_MODE` | `inplace` | `inplace` (overwrite) or `versioned` (keep history for `asOf` recall) — see Memory Evolution above |
| `DOLORES_EXTRACTION_MODEL` | — | LLM model ID used for async fact extraction (`ingest` command) |
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
