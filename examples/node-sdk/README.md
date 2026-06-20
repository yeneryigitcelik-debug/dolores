# Example: Programmatic Node.js SDK usage

Use `@dolores/core` directly from Node.js — no CLI required. Useful when you want to embed dolores `remember` / `recall` inside an existing Node application or agent loop.

## Prerequisites

```bash
# Install the package
npm install @dolores/core

# The daemon must be running (it owns the DB pool and embedding model)
npx @dolores/daemon
```

## Run the example

```bash
node example.mjs
```

Expected output:

```
Storing a memory…
Stored: <uuid>

Recalling…
  [0.832] We use Fastify for the daemon because it has native ESM support and TypeScript types.

Building context blob…
[dolores context text …]
```

## Core API

```js
import { createDaemonClient } from "@dolores/core/daemon-client";

const client = createDaemonClient({
  daemonUrl: "http://localhost:4505",
  workspaceId: "00000000-0000-0000-0000-000000000001",
});

// Store a memory
await client.remember({
  content: "We chose PostgreSQL for ACID compliance and pgvector support.",
  scope: "workspace",   // "workspace" | "user" | "session"
  importance: 0.9,      // 0–1; influences decay rate
  source: "my-agent",
});

// Retrieve relevant memories
const { memories } = await client.recall({
  query: "why postgres?",
  limit: 5,
});

// Build a minimal system-prompt blob
const { text } = await client.context({ query: "database decisions" });
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DOLORES_DAEMON_URL` | `http://localhost:4505` | Daemon base URL |
| `DOLORES_WORKSPACE_ID` | required | Workspace UUID |
| `DOLORES_USER_ID` | — | Optional per-user scope |

## Notes

- The daemon must be running; `@dolores/core` **does not** connect to Postgres directly in this pattern — the daemon owns the pool.
- If you need direct DB access (e.g. in a migration script), use `@dolores/db` and `@dolores/core`'s retrieval functions with a direct pool — see `packages/core/src/retrieval/` for the API.
- `fastembed` (the local embedding model) is loaded by the daemon, **not** by `@dolores/core` itself. Only the daemon needs `fastembed` installed.
