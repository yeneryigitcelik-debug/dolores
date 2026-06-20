# Example: Claude Code / Cursor MCP Integration

This example shows how to attach dolores to **Claude Code** (or any MCP-compatible client such as Cursor) so the agent automatically saves decisions and recalls relevant history without any user action.

## What happens

When the MCP server is wired in, the agent gains two tools:

- `remember(text, scope?, importance?, source?)` — persist a memory
- `recall(query, limit?)` — hybrid vector + full-text retrieval

The agent decides when to call them. Typically it calls `recall` at the start of a task ("what do I know about this codebase?") and `remember` after a significant decision ("I chose Fastify because …").

## Setup

### 1. Start the daemon

The MCP server is a thin proxy — it does **not** load an embedding model. The daemon owns the model and the connection pool.

```bash
# From the dolores repo root
pnpm db:up          # Postgres + pgvector
dolores init        # schema + RLS + pg_cron (once)
dolores-daemon      # keep running (or use a process manager)
```

### 2. Add the MCP server to Claude Code

Add or merge the following into your **project** `.mcp.json` (or `~/.claude/mcp.json` for global):

```jsonc
// .mcp.json
{
  "mcpServers": {
    "dolores": {
      "command": "node",
      "args": ["/absolute/path/to/dolores/packages/mcp/dist/index.js"],
      "env": {
        "DOLORES_WORKSPACE_ID": "00000000-0000-0000-0000-000000000001",
        "DOLORES_DAEMON_PORT": "4505"
      }
    }
  }
}
```

**Using npx (no local clone needed):**

```jsonc
{
  "mcpServers": {
    "dolores": {
      "command": "npx",
      "args": ["-y", "@dolores/mcp"],
      "env": {
        "DOLORES_WORKSPACE_ID": "00000000-0000-0000-0000-000000000001",
        "DOLORES_DAEMON_PORT": "4505"
      }
    }
  }
}
```

### 3. Cursor

In Cursor settings → MCP → add server, use the same `command` / `args` / `env` as above.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DOLORES_WORKSPACE_ID` | required | UUID that scopes all memories to your project/team |
| `DOLORES_DAEMON_URL` | `http://localhost:4505` | Override if the daemon runs elsewhere |
| `DOLORES_DAEMON_PORT` | `4505` | Shorthand when daemon is on localhost |
| `DOLORES_USER_ID` | — | Optional per-user isolation inside the workspace |

## How the agent uses it

Once the server is registered, Claude Code and Cursor will list `remember` and `recall` in their available tools. The model decides autonomously when to call them. A typical session looks like:

```
[task starts]
→ agent calls recall("auth middleware patterns in this project")
← dolores returns 3 relevant memories
→ agent works, makes a decision
→ agent calls remember("Using JWT in httpOnly cookies for CSRF resistance")
← dolores confirms stored
[next session, same workspace]
→ agent calls recall("cookie auth")
← agent finds the JWT decision from last session
```

No user action required after the initial setup.
