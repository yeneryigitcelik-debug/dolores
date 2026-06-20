#!/usr/bin/env node
/**
 * @dolores/mcp — stdio MCP server for Claude Code / Cursor.
 *
 * Exposes two tools:
 *   remember(content, scope?, importance?) → daemon POST /remember
 *   recall(query, limit?)                 → daemon POST /recall
 *
 * Thin proxy — no DB, no embedder. All heavy lifting in the daemon.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const server = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);
