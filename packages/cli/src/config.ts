import { isIP } from "node:net";
import type { MemoryContext } from "@dolores/core";
import { z } from "zod";

export const DEFAULT_WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";
export const DEFAULT_DAEMON_HOST = "127.0.0.1";
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const MAX_REQUEST_TIMEOUT_MS = 3_600_000;

const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const HOSTNAME_RE = new RegExp(`^${LABEL}(?:[.]${LABEL})*[.]?$`);
const NUMERIC_HOST_RE = /^[0-9.]+$/;
const HOST_MESSAGE =
  "geçerli bir hostname veya IP adresi olmalı (protokol, kimlik bilgisi, port, yol, sorgu veya fragment içeremez)";

/**
 * Hostname, IPv4 ve köşeli parantezli veya düz IPv6 adreslerini kabul eder.
 * Protokol, kimlik bilgisi, port, yol, sorgu, fragment ve zone id değerlerini reddeder.
 */
export function isValidDaemonHost(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  const bracketed = host.startsWith("[") && host.endsWith("]");
  const inner = bracketed ? host.slice(1, -1) : host;
  if (inner.includes("[") || inner.includes("]") || inner.includes("%")) return false;
  const kind = isIP(inner);
  if (bracketed) return kind === 6;
  if (kind !== 0) return true;
  if (NUMERIC_HOST_RE.test(inner)) return false;
  return HOSTNAME_RE.test(inner);
}

/** IPv6 adresini URL için tam bir çift köşeli parantezle biçimlendirir. */
export function formatHostForUrl(host: string): string {
  const trimmed = host.trim();
  const inner = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return isIP(inner) === 6 ? `[${inner}]` : inner;
}

export const configSchema = z.object({
  workspaceId: z.guid().default(DEFAULT_WORKSPACE_ID),
  userId: z.guid().optional(),
  daemonHost: z
    .string()
    .trim()
    .refine(isValidDaemonHost, { message: HOST_MESSAGE })
    .default(DEFAULT_DAEMON_HOST),
  daemonPort: z.coerce.number().int().min(1).max(65535).default(4505),
  authToken: z.string().trim().min(1).optional(),
  requestTimeoutMs: z.coerce.number().int().positive().max(MAX_REQUEST_TIMEOUT_MS).optional(),
});

export type CliConfig = z.infer<typeof configSchema>;

const ENV_NAMES: Record<string, string> = {
  workspaceId: "DOLORES_WORKSPACE_ID",
  userId: "DOLORES_USER_ID",
  daemonHost: "DOLORES_DAEMON_HOST",
  daemonPort: "DOLORES_DAEMON_PORT",
  authToken: "DOLORES_AUTH_TOKEN",
  requestTimeoutMs: "DOLORES_REQUEST_TIMEOUT_MS",
};

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** CLI yapılandırmasını ortamdan okuyan tek nokta. */
export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env) {
  return configSchema.safeParse({
    workspaceId: envValue(env, "DOLORES_WORKSPACE_ID") ?? DEFAULT_WORKSPACE_ID,
    userId: envValue(env, "DOLORES_USER_ID"),
    daemonHost: envValue(env, "DOLORES_DAEMON_HOST") ?? DEFAULT_DAEMON_HOST,
    daemonPort: envValue(env, "DOLORES_DAEMON_PORT") ?? "4505",
    authToken: envValue(env, "DOLORES_AUTH_TOKEN"),
    requestTimeoutMs: envValue(env, "DOLORES_REQUEST_TIMEOUT_MS"),
  });
}

/** Hataları ortam değişkeninin adıyla gösterir; girilen değerleri içermez. */
export function formatConfigIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const key = issue.path.map(String).join(".");
      return `  ${ENV_NAMES[key] ?? key}: ${issue.message}`;
    })
    .join("\n");
}

let _config: CliConfig | null = null;

export function getConfig(): CliConfig {
  if (_config) return _config;
  const result = loadConfigFromEnv(process.env);
  if (!result.success) {
    console.error(`dolores config hatası:\n${formatConfigIssues(result.error)}`);
    process.exit(1);
  }
  _config = result.data;
  return _config;
}

export function daemonBaseUrl(config: CliConfig): string {
  return `http://${formatHostForUrl(config.daemonHost)}:${config.daemonPort}`;
}

export function memoryContext(config: CliConfig): MemoryContext {
  return {
    workspaceId: config.workspaceId,
    userId: config.userId ?? null,
  };
}
