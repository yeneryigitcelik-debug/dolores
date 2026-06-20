import { z } from "zod";
import type { CliConfig } from "./config.js";
import { daemonBaseUrl } from "./config.js";

const DAEMON_NOT_RUNNING = "dolores daemon çalışmıyor; başlat: pnpm --filter @dolores/daemon start";

export class DaemonError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "DaemonError";
  }
}

const daemonErrorBodySchema = z.object({
  error: z.object({
    code: z.string().optional(),
    message: z.string(),
    issues: z.array(z.string()).optional(),
  }),
});

function parseDaemonError(body: string, status: number): DaemonError {
  try {
    const parsed = daemonErrorBodySchema.parse(JSON.parse(body));
    const { message, issues } = parsed.error;
    const suffix = issues?.length ? `\n  ${issues.slice(0, 3).join("\n  ")}` : "";
    return new DaemonError(`${message}${suffix}`, status);
  } catch {
    return new DaemonError(`Daemon hatası (${status}): beklenmeyen yanıt formatı`, status);
  }
}

function isDaemonDown(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("ECONNREFUSED") ||
    msg.includes("fetch failed") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("ETIMEDOUT")
  );
}

export async function daemonGet<T>(
  config: CliConfig,
  path: string,
  schema?: z.ZodType<T>,
): Promise<T> {
  const url = `${daemonBaseUrl(config)}${path}`;
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    if (isDaemonDown(err)) throw new DaemonError(DAEMON_NOT_RUNNING);
    const msg = err instanceof Error ? err.message : String(err);
    throw new DaemonError(`Ağ hatası: ${msg}`);
  }
  if (!response.ok) {
    const body = await response.text();
    throw parseDaemonError(body, response.status);
  }
  const data: unknown = await response.json();
  if (schema) {
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new DaemonError(
        `Beklenmeyen daemon yanıtı: ${result.error.issues[0]?.message ?? "geçersiz şema"}`,
      );
    }
    return result.data;
  }
  return data as T;
}

export async function daemonPost<TBody, TRes>(
  config: CliConfig,
  path: string,
  body: TBody,
  schema?: z.ZodType<TRes>,
): Promise<TRes> {
  const url = `${daemonBaseUrl(config)}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (isDaemonDown(err)) throw new DaemonError(DAEMON_NOT_RUNNING);
    const msg = err instanceof Error ? err.message : String(err);
    throw new DaemonError(`Ağ hatası: ${msg}`);
  }
  if (!response.ok) {
    const text = await response.text();
    throw parseDaemonError(text, response.status);
  }
  const data: unknown = await response.json();
  if (schema) {
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new DaemonError(
        `Beklenmeyen daemon yanıtı: ${result.error.issues[0]?.message ?? "geçersiz şema"}`,
      );
    }
    return result.data;
  }
  return data as TRes;
}
