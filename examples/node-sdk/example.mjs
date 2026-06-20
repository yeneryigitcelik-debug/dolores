/**
 * dolores Node.js SDK example
 *
 * Demonstrates programmatic remember + recall using @dolores/core directly
 * (without the CLI or MCP). The daemon must be running; this script calls
 * its HTTP API via the core client helpers.
 *
 * Run:
 *   node example.mjs
 *
 * Requirements:
 *   - dolores daemon running (dolores-daemon or: node packages/daemon/dist/index.js)
 *   - DATABASE_URL set (or defaults: see .env.example in repo root)
 */

import { createDaemonClient } from "@dolores/core/daemon-client";

const WORKSPACE_ID = process.env.DOLORES_WORKSPACE_ID ?? "00000000-0000-0000-0000-000000000001";
const DAEMON_URL = process.env.DOLORES_DAEMON_URL ?? "http://localhost:4505";

const client = createDaemonClient({ daemonUrl: DAEMON_URL, workspaceId: WORKSPACE_ID });

// --- remember -----------------------------------------------------------------

console.log("Storing a memory…");
const stored = await client.remember({
  content: "We use Fastify for the daemon because it has native ESM support and TypeScript types.",
  scope: "workspace",
  importance: 0.8,
  source: "node-sdk-example",
});
console.log("Stored:", stored.id);

// --- recall -------------------------------------------------------------------

console.log("\nRecalling…");
const results = await client.recall({
  query: "why did we choose the HTTP framework?",
  limit: 3,
});

for (const mem of results.memories) {
  console.log(`  [${mem.score.toFixed(3)}] ${mem.content}`);
}

// --- context ------------------------------------------------------------------

console.log("\nBuilding context blob…");
const ctx = await client.context({ query: "daemon architecture" });
console.log(ctx.text.slice(0, 300), "…");
