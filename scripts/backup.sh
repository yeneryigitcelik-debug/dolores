#!/usr/bin/env bash
set -euo pipefail

# dolores DB backup — pg_dump via docker exec, gzip compressed, 7-day retention.
# Usage: ./scripts/backup.sh
# Environment overrides (same defaults as docker-compose.yml):
#   POSTGRES_USER     (default: dolores)
#   POSTGRES_DB       (default: dolores)
#   DOLORES_CONTAINER (default: dolores-db)
#   BACKUP_DIR        (default: ./backups relative to repo root)
#   RETENTION_DAYS    (default: 7)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

POSTGRES_USER="${POSTGRES_USER:-dolores}"
POSTGRES_DB="${POSTGRES_DB:-dolores}"
DOLORES_CONTAINER="${DOLORES_CONTAINER:-dolores-db}"
BACKUP_DIR="${BACKUP_DIR:-${REPO_ROOT}/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_FILE="${BACKUP_DIR}/dolores-${TIMESTAMP}.sql.gz"

mkdir -p "${BACKUP_DIR}"

echo "[backup] container=${DOLORES_CONTAINER} db=${POSTGRES_DB} → ${BACKUP_FILE}"

docker exec "${DOLORES_CONTAINER}" \
  pg_dump -U "${POSTGRES_USER}" "${POSTGRES_DB}" \
  | gzip > "${BACKUP_FILE}"

echo "[backup] done: $(du -sh "${BACKUP_FILE}" | cut -f1)"

# Retention: delete backups older than RETENTION_DAYS days.
OLD_COUNT=$(find "${BACKUP_DIR}" -maxdepth 1 -name "dolores-*.sql.gz" \
  -mtime "+${RETENTION_DAYS}" | wc -l | tr -d ' ')
if [ "${OLD_COUNT}" -gt 0 ]; then
  find "${BACKUP_DIR}" -maxdepth 1 -name "dolores-*.sql.gz" \
    -mtime "+${RETENTION_DAYS}" -delete
  echo "[backup] pruned ${OLD_COUNT} backup(s) older than ${RETENTION_DAYS} days"
fi
