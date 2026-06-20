import type { DaemonConfig } from "@dolores/core";
import { z } from "zod";

export type DaemonRuntimeConfig = DaemonConfig & {
  authToken?: string;
};

function parseBool(val: string | undefined): boolean {
  const v = (val ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

const schema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535),
  databaseUrl: z.string().min(1, "DOLORES_APP_DATABASE_URL or DATABASE_URL is required"),
  embedder: z.enum(["local", "openai", "noop"]),
  embedModel: z.string().min(1),
  decayMode: z.enum(["conservative", "aggressive"]),
  extractionEnabled: z.boolean(),
});

/**
 * Parse env vars into a validated DaemonRuntimeConfig. Throws on startup if:
 * - required vars are missing or malformed, OR
 * - DOLORES_DAEMON_HOST is non-localhost and DOLORES_AUTH_TOKEN is unset.
 */
export function loadConfig(): DaemonRuntimeConfig {
  const raw = {
    host: process.env.DOLORES_DAEMON_HOST ?? "127.0.0.1",
    port: process.env.DOLORES_DAEMON_PORT ?? "4505",
    databaseUrl: process.env.DOLORES_APP_DATABASE_URL ?? process.env.DATABASE_URL ?? "",
    embedder: process.env.DOLORES_EMBEDDER ?? "local",
    embedModel: process.env.DOLORES_EMBED_MODEL ?? "bge-small-en-v1.5",
    decayMode: process.env.DOLORES_DECAY_MODE ?? "conservative",
    extractionEnabled: parseBool(process.env.DOLORES_EXTRACTION_ENABLED),
  };

  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`[dolores-daemon] config error:\n${issues}`);
  }

  const authToken = process.env.DOLORES_AUTH_TOKEN?.trim() || undefined;

  // Security gate: if bound to a non-localhost address without an auth token,
  // refuse to start — the daemon would be publicly accessible without auth (A01).
  const host = result.data.host;
  const isLocalhost = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!isLocalhost && !authToken) {
    throw new Error(
      "[dolores-daemon] FATAL: DOLORES_DAEMON_HOST is not a localhost address but " +
        "DOLORES_AUTH_TOKEN is not set. Refusing to start — the daemon would be publicly " +
        "accessible without authentication. Set DOLORES_AUTH_TOKEN or bind to 127.0.0.1.",
    );
  }

  return { ...result.data, authToken };
}
