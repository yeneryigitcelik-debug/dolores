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

function isDaemonDown(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("ECONNREFUSED") ||
    msg.includes("fetch failed") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("ETIMEDOUT")
  );
}

export async function daemonGet<T>(config: CliConfig, path: string): Promise<T> {
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
    throw new DaemonError(`Daemon hatası ${response.status}: ${body}`, response.status);
  }
  return response.json() as Promise<T>;
}

export async function daemonPost<TBody, TRes>(
  config: CliConfig,
  path: string,
  body: TBody,
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
    const body = await response.text();
    throw new DaemonError(`Daemon hatası ${response.status}: ${body}`, response.status);
  }
  return response.json() as Promise<TRes>;
}
