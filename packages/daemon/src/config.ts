import type { DaemonConfig } from "@dolores/core";
import { z } from "zod";

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
 * Parse env vars into a validated DaemonConfig. Throws on first startup if
 * required vars (databaseUrl) are missing or a value is malformed.
 */
export function loadConfig(): DaemonConfig {
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

  return result.data as DaemonConfig;
}
