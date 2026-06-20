#!/usr/bin/env bash
# inject-context.sh
#
# Pipe dolores context into an agent's system prompt at startup.
#
# Usage:
#   ./inject-context.sh "implement the auth refactor"
#   ./inject-context.sh                   # no task → just returns memory blob
#
# The script prints a JSON payload you can pass to any LLM API as the
# system message content. Pipe it into your agent launcher or capture
# it in a variable.
#
# Requirements: dolores CLI installed + daemon running.

set -euo pipefail

TASK="${1:-}"

# Pull the minimal-token memory blob for the current workspace.
MEMORY_BLOB="$(dolores context ${TASK:+"$TASK"} 2>/dev/null || echo "")"

if [[ -z "$MEMORY_BLOB" ]]; then
  echo '{"role":"system","content":"No prior context available."}'
  exit 0
fi

# Emit as a JSON system message (ready for the messages[] array).
# jq ensures the blob is properly escaped.
echo "$MEMORY_BLOB" | jq -Rs '{"role":"system","content":.}'
