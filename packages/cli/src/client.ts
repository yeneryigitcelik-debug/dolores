import { z } from "zod";
import type { CliConfig } from "./config.js";
import { DEFAULT_REQUEST_TIMEOUT_MS, daemonBaseUrl } from "./config.js";

const DAEMON_NOT_RUNNING = "dolores daemon çalışmıyor; başlat: pnpm --filter @dolores/daemon start";
const MAX_MESSAGE_LENGTH = 500;
const MAX_DETAIL_LENGTH = 200;
const MAX_DETAILS = 3;
const REDACTED = "[gizli]";

export class DaemonError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "DaemonError";
  }
}

const zodIssueSchema = z.object({
  message: z.string(),
  path: z.array(z.union([z.string(), z.number()])).optional(),
});

const daemonErrorBodySchema = z.object({
  error: z.object({
    code: z.string().optional(),
    message: z.string(),
    issues: z.array(z.unknown()).optional(),
  }),
});

function redact(text: string, token: string | undefined): string {
  return token ? text.split(token).join(REDACTED) : text;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function sanitize(text: string, max: number, token: string | undefined): string {
  return truncate(redact(text, token), max);
}

function formatIssue(issue: unknown): string | null {
  if (typeof issue === "string") return issue;
  const parsed = zodIssueSchema.safeParse(issue);
  if (!parsed.success) return null;
  const path = parsed.data.path?.map(String).join(".") ?? "";
  return path ? `${path}: ${parsed.data.message}` : parsed.data.message;
}

function fallbackError(status: number): DaemonError {
  if (status === 401) {
    return new DaemonError(
      "Daemon yetkilendirmeyi reddetti (401): DOLORES_AUTH_TOKEN değerini kontrol et",
      status,
    );
  }
  return new DaemonError(`Daemon hatası (${status}): beklenmeyen yanıt formatı`, status);
}

function parseDaemonError(body: string, status: number, token: string | undefined): DaemonError {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return fallbackError(status);
  }
  const parsed = daemonErrorBodySchema.safeParse(json);
  if (!parsed.success) return fallbackError(status);
  const { message, issues } = parsed.data.error;
  const main = sanitize(message, MAX_MESSAGE_LENGTH, token);
  const details = (issues ?? [])
    .map(formatIssue)
    .filter((detail): detail is string => detail !== null);
  const shown = details.slice(0, MAX_DETAILS).map((d) => sanitize(d, MAX_DETAIL_LENGTH, token));
  let suffix = shown.length > 0 ? `\n  ${shown.join("\n  ")}` : "";
  if (details.length > MAX_DETAILS) suffix += `\n  (+${details.length - MAX_DETAILS} sorun daha)`;
  return new DaemonError(`${main}${suffix}`, status);
}

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause: unknown = err.cause;
  const causeText = cause instanceof Error ? ` (${cause.message})` : "";
  return `${err.message}${causeText}`;
}

function isDaemonDown(err: unknown): boolean {
  const msg = describeError(err);
  return (
    msg.includes("ECONNREFUSED") ||
    msg.includes("fetch failed") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("ETIMEDOUT")
  );
}

function isTimeout(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

interface RequestOptions {
  method: "GET" | "POST";
  body?: string;
}

async function request<T>(
  config: CliConfig,
  path: string,
  options: RequestOptions,
  schema?: z.ZodType<T>,
): Promise<T> {
  const url = `${daemonBaseUrl(config)}${path}`;
  const timeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const token = config.authToken;
  // Tek sinyal bağlantıyı, başlıkları ve yanıt gövdesinin tamamını kapsar.
  const signal = AbortSignal.timeout(timeoutMs);
  const timeoutError = (): DaemonError =>
    new DaemonError(`Daemon ${timeoutMs} ms içinde yanıt vermedi (zaman aşımı)`);

  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    const init: RequestInit = { method: options.method, headers, signal };
    if (options.body !== undefined) init.body = options.body;
    response = await fetch(url, init);
  } catch (err) {
    if (isTimeout(err, signal)) throw timeoutError();
    if (isDaemonDown(err)) throw new DaemonError(DAEMON_NOT_RUNNING);
    throw new DaemonError(`Ağ hatası: ${sanitize(describeError(err), MAX_MESSAGE_LENGTH, token)}`);
  }

  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    if (isTimeout(err, signal)) throw timeoutError();
    throw new DaemonError(
      `Daemon yanıtı okunamadı: ${sanitize(describeError(err), MAX_MESSAGE_LENGTH, token)}`,
      response.status,
    );
  }

  if (!response.ok) throw parseDaemonError(text, response.status, token);

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new DaemonError("Daemon geçersiz JSON yanıtı döndürdü", response.status);
  }

  if (schema) {
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new DaemonError(
        `Beklenmeyen daemon yanıtı: ${sanitize(result.error.issues[0]?.message ?? "geçersiz şema", MAX_MESSAGE_LENGTH, token)}`,
      );
    }
    return result.data;
  }
  return data as T;
}

export async function daemonGet<T>(
  config: CliConfig,
  path: string,
  schema?: z.ZodType<T>,
): Promise<T> {
  return request(config, path, { method: "GET" }, schema);
}

export async function daemonPost<TBody, TRes>(
  config: CliConfig,
  path: string,
  body: TBody,
  schema?: z.ZodType<TRes>,
): Promise<TRes> {
  return request(config, path, { method: "POST", body: JSON.stringify(body) }, schema);
}
