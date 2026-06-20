/**
 * @dolores/daemon — long-running retrieval service.
 *
 * Loads the embedder ONCE (no cold-start), owns the single pg pool, and exposes
 * retrieval + extraction over localhost HTTP per the @dolores/core DAEMON_ROUTES
 * contract. CLI and MCP are thin clients.
 */
import { loadConfig } from "./config.js";
import { startDaemon } from "./server.js";

const config = loadConfig();

startDaemon(config).catch((err: unknown) => {
  console.error("[dolores-daemon] fatal startup error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
