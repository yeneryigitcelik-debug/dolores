# dolores — Examples

Runnable examples showing how to integrate dolores in different setups.

| Example | What it shows |
|---------|---------------|
| [`claude-code-mcp/`](./claude-code-mcp/) | Wire dolores into Claude Code or Cursor via MCP so the agent auto-saves and auto-recalls context |
| [`agent-context/`](./agent-context/) | Pipe `dolores context` output into an agent's system prompt at startup |
| [`node-sdk/`](./node-sdk/) | Programmatic `remember` + `recall` from Node.js using `@dolores/core` directly |

## Prerequisites

- **Node ≥ 20**, **pnpm**
- **Docker** (for Postgres + pgvector + pg_cron)
- dolores installed and initialised:

```bash
npm i -g @dolores/cli
pnpm db:up           # or: docker compose up -d
dolores init
```

The daemon must be running for CLI and MCP examples:

```bash
dolores-daemon &     # or: npx @dolores/daemon
```
