#!/usr/bin/env bash
set -euo pipefail

# dolores DB restore — gunzip | psql via docker exec. DESTRUCTIVE.
# Usage: ./scripts/restore.sh <backup-file.sql.gz>
# Environment overrides:
#   POSTGRES_USER     (default: dolores)
#   POSTGRES_DB       (default: dolores)
#   DOLORES_CONTAINER (default: dolores-db)

BACKUP_FILE="${1:-}"

if [ -z "${BACKUP_FILE}" ]; then
  echo "Usage: $0 <backup-file.sql.gz>" >&2
  exit 1
fi

if [ ! -f "${BACKUP_FILE}" ]; then
  echo "Error: file not found: ${BACKUP_FILE}" >&2
  exit 1
fi

POSTGRES_USER="${POSTGRES_USER:-dolores}"
POSTGRES_DB="${POSTGRES_DB:-dolores}"
DOLORES_CONTAINER="${DOLORES_CONTAINER:-dolores-db}"

echo ""
echo "WARNING: This will drop and re-create all data in database '${POSTGRES_DB}'"
echo "         on container '${DOLORES_CONTAINER}'."
echo "         Source file: ${BACKUP_FILE}"
echo ""
read -r -p "Type YES to continue: " CONFIRM

if [ "${CONFIRM}" != "YES" ]; then
  echo "Aborted." >&2
  exit 1
fi

echo "[restore] dropping and restoring ${POSTGRES_DB} from ${BACKUP_FILE} …"

# Drop existing connections, then drop+re-create the DB, then restore.
docker exec "${DOLORES_CONTAINER}" \
  psql -U "${POSTGRES_USER}" postgres \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${POSTGRES_DB}' AND pid <> pg_backend_pid();" \
  -c "DROP DATABASE IF EXISTS \"${POSTGRES_DB}\";" \
  -c "CREATE DATABASE \"${POSTGRES_DB}\" OWNER \"${POSTGRES_USER}\";"

gunzip -c "${BACKUP_FILE}" | docker exec -i "${DOLORES_CONTAINER}" \
  psql -U "${POSTGRES_USER}" "${POSTGRES_DB}"

echo "[restore] done."
