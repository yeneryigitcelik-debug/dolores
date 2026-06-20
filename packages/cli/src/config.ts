import type { MemoryContext } from "@dolores/core";
import { z } from "zod";

export const configSchema = z.object({
  workspaceId: z.string().uuid().default("00000000-0000-0000-0000-000000000001"),
  userId: z.string().uuid().optional(),
  daemonHost: z.string().default("127.0.0.1"),
  daemonPort: z.coerce.number().int().min(1).max(65535).default(4505),
});

export type CliConfig = z.infer<typeof configSchema>;

let _config: CliConfig | null = null;

export function getConfig(): CliConfig {
  if (_config) return _config;
  const raw = {
    workspaceId: process.env.DOLORES_WORKSPACE_ID ?? "00000000-0000-0000-0000-000000000001",
    userId: process.env.DOLORES_USER_ID,
    daemonHost: process.env.DOLORES_DAEMON_HOST ?? "127.0.0.1",
    daemonPort: process.env.DOLORES_DAEMON_PORT ?? "4505",
  };
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    console.error(`dolores config hatası:\n${issues}`);
    process.exit(1);
  }
  _config = result.data;
  return _config;
}

export function daemonBaseUrl(config: CliConfig): string {
  return `http://${config.daemonHost}:${config.daemonPort}`;
}

export function memoryContext(config: CliConfig): MemoryContext {
  return {
    workspaceId: config.workspaceId,
    userId: config.userId ?? null,
  };
}
