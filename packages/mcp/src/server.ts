import { isIP } from "node:net";
import type {
  RecallRequest,
  RecallResponse,
  RememberRequest,
  RememberResponse,
} from "@dolores/core";
import { DAEMON_ROUTES } from "@dolores/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Yapılandırma: CLI ile aynı doğrulama kuralları
// ---------------------------------------------------------------------------

export const DEFAULT_WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";
export const DEFAULT_DAEMON_HOST = "127.0.0.1";
export const DEFAULT_DAEMON_PORT = 4505;
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const MAX_REQUEST_TIMEOUT_MS = 3_600_000;
const MAX_ERROR_BODY_CHARS = 500;

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

export const mcpConfigSchema = z.object({
  workspaceId: z.guid().default(DEFAULT_WORKSPACE_ID),
  userId: z.guid().optional(),
  daemonHost: z
    .string()
    .trim()
    .refine(isValidDaemonHost, { message: HOST_MESSAGE })
    .default(DEFAULT_DAEMON_HOST),
  daemonPort: z.coerce.number().int().min(1).max(65535).default(DEFAULT_DAEMON_PORT),
  authToken: z.string().trim().min(1).optional(),
  requestTimeoutMs: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_REQUEST_TIMEOUT_MS)
    .default(DEFAULT_REQUEST_TIMEOUT_MS),
});

export type McpConfig = z.infer<typeof mcpConfigSchema>;

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

/** Hataları ortam değişkeninin adıyla gösterir; girilen değerleri içermez. */
export function formatMcpConfigIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const key = issue.path.map(String).join(".");
      return `  ${ENV_NAMES[key] ?? key}: ${issue.message}`;
    })
    .join("\n");
}

/** MCP yapılandırmasını doğrular; geçersiz girişte değeri içermeyen hata üretir. */
export function loadMcpConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const result = mcpConfigSchema.safeParse({
    workspaceId: envValue(env, "DOLORES_WORKSPACE_ID"),
    userId: envValue(env, "DOLORES_USER_ID"),
    daemonHost: envValue(env, "DOLORES_DAEMON_HOST"),
    daemonPort: envValue(env, "DOLORES_DAEMON_PORT"),
    authToken: envValue(env, "DOLORES_AUTH_TOKEN"),
    requestTimeoutMs: envValue(env, "DOLORES_REQUEST_TIMEOUT_MS"),
  });
  if (!result.success) {
    throw new Error(`dolores mcp config hatası:\n${formatMcpConfigIssues(result.error)}`);
  }
  return Object.freeze({ ...result.data });
}

export function daemonBaseUrl(config: McpConfig): string {
  return `http://${formatHostForUrl(config.daemonHost)}:${config.daemonPort}`;
}

// ---------------------------------------------------------------------------
// Hata mesajlarında hassas değerlerin gizlenmesi
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitize(text: string, config: McpConfig): string {
  let out = text;
  if (config.authToken) {
    out = out.replace(new RegExp(escapeRegExp(config.authToken), "g"), "[REDACTED]");
  }
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]");
  if (out.length > MAX_ERROR_BODY_CHARS) {
    out = `${out.slice(0, MAX_ERROR_BODY_CHARS)}… (kısaltıldı)`;
  }
  return out;
}

function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

// ---------------------------------------------------------------------------
// Daemon isteği: tek deneme, otomatik tekrar yok
// ---------------------------------------------------------------------------

export async function daemonPost<TReq, TRes>(
  path: string,
  body: TReq,
  config: McpConfig = loadMcpConfig(),
): Promise<TRes> {
  const url = `${daemonBaseUrl(config)}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.authToken) headers.Authorization = `Bearer ${config.authToken}`;

  // Tek sinyal isteği ve yanıt gövdesinin tamamını okumayı kapsar.
  const signal = AbortSignal.timeout(config.requestTimeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    if (signal.aborted || isTimeoutError(cause)) {
      throw new Error(`dolores daemon zaman aşımı (${config.requestTimeoutMs} ms)`);
    }
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`dolores daemon erişilemiyor: ${sanitize(msg, config)}`);
  }

  let text: string;
  try {
    text = await res.text();
  } catch (cause) {
    if (signal.aborted || isTimeoutError(cause)) {
      throw new Error(`dolores daemon yanıtı zaman aşımına uğradı (${config.requestTimeoutMs} ms)`);
    }
    const msg = cause instanceof Error ? cause.message : String(cause);
    if (!res.ok) throw new Error(`daemon ${res.status}: (no body)`);
    throw new Error(`daemon yanıtı okunamadı: ${sanitize(msg, config)}`);
  }

  if (!res.ok) {
    throw new Error(`daemon ${res.status}: ${sanitize(text || "(no body)", config)}`);
  }

  try {
    return JSON.parse(text) as TRes;
  } catch {
    throw new Error("daemon geçersiz JSON yanıtı döndürdü");
  }
}

// ---------------------------------------------------------------------------
// Yanıt biçimi doğrulaması
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isRememberResponse(v: unknown): v is RememberResponse {
  // Kimlik boş olmamalı; değer değiştirilmeden korunur.
  return (
    isRecord(v) &&
    typeof v.id === "string" &&
    v.id.trim().length > 0 &&
    typeof v.deduped === "boolean"
  );
}

function isRecallResponse(v: unknown): v is RecallResponse {
  return (
    isRecord(v) &&
    typeof v.tokenEstimate === "number" &&
    Number.isFinite(v.tokenEstimate) &&
    Array.isArray(v.hits) &&
    v.hits.every(
      (h: unknown) =>
        isRecord(h) &&
        typeof h.id === "string" &&
        typeof h.content === "string" &&
        typeof h.importance === "number" &&
        Number.isFinite(h.importance) &&
        (h.scope === "personal" || h.scope === "workspace") &&
        typeof h.score === "number" &&
        Number.isFinite(h.score) &&
        (h.source === null || typeof h.source === "string") &&
        typeof h.createdAt === "string" &&
        (h.supersededBy === undefined ||
          h.supersededBy === null ||
          typeof h.supersededBy === "string"),
    )
  );
}

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}

// ---------------------------------------------------------------------------
// Testler için dışa aktarılan araç giriş şemaları
// ---------------------------------------------------------------------------

export const rememberInputSchema = z.object({
  content: z.string().min(1).max(50_000).describe("Kaydedilecek bilgi veya karar"),
  scope: z
    .enum(["personal", "workspace"])
    .optional()
    .describe(
      "Erişim kapsamı: personal (sadece bu kullanıcı) veya workspace (tüm ekip). Varsayılan: kullanıcı belirtilmişse personal, aksi halde workspace",
    ),
  importance: z.number().int().min(1).max(10).optional().describe("Önem skoru 1-10. Varsayılan: 5"),
});

export const recallInputSchema = z.object({
  query: z.string().min(1).max(2_000).describe("Arama sorgusu"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("Maksimum sonuç sayısı. Varsayılan: 5"),
});

// ---------------------------------------------------------------------------
// Yeni MCP sunucusunu kayıtlı araçlarla oluşturur.
// Yapılandırma yalnızca oluşturma anında alınır.
// ---------------------------------------------------------------------------

export function createServer(config: McpConfig = loadMcpConfig()): McpServer {
  const ctx: McpConfig = Object.freeze({ ...config });

  const server = new McpServer(
    { name: "dolores", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // ---- remember aracı ------------------------------------------------------

  server.registerTool(
    "remember",
    {
      description: "Agent öğrendiği önemli kararı/bilgiyi kalıcı hafızaya yazar.",
      inputSchema: rememberInputSchema.shape,
    },
    async (args) => {
      const req: RememberRequest = {
        workspaceId: ctx.workspaceId,
        ...(ctx.userId ? { userId: ctx.userId } : {}),
        content: args.content,
        ...(args.scope ? { scope: args.scope } : {}),
        ...(args.importance !== undefined ? { importance: args.importance } : {}),
      };

      let res: unknown;
      try {
        res = await daemonPost<RememberRequest, unknown>(DAEMON_ROUTES.remember.path, req, ctx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(sanitize(msg, ctx));
      }

      if (!isRememberResponse(res)) {
        return errorResult(
          "daemon beklenmeyen yanıt biçimi döndürdü. Kaydetme sonucu doğrulanamadı; istek tekrarlanmadı. Yeniden göndermeden önce hafızayı kontrol et.",
        );
      }

      const detail = res.deduped ? " (mevcut hafıza güncellendi)" : "";
      return {
        content: [
          {
            type: "text" as const,
            text: `Kaydedildi (id: ${res.id})${detail}`,
          },
        ],
      };
    },
  );

  // ---- recall aracı --------------------------------------------------------

  server.registerTool(
    "recall",
    {
      description:
        "Agent bağlam ararken alakalı geçmiş hafızayı getirir (sadece en alakalı N, token minimal).",
      inputSchema: recallInputSchema.shape,
    },
    async (args) => {
      const req: RecallRequest = {
        workspaceId: ctx.workspaceId,
        ...(ctx.userId ? { userId: ctx.userId } : {}),
        query: args.query,
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      };

      let res: unknown;
      try {
        res = await daemonPost<RecallRequest, unknown>(DAEMON_ROUTES.recall.path, req, ctx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(sanitize(msg, ctx));
      }

      if (!isRecallResponse(res)) {
        return errorResult("daemon beklenmeyen yanıt biçimi döndürdü");
      }

      if (res.hits.length === 0) {
        return {
          content: [{ type: "text" as const, text: "İlgili hafıza bulunamadı." }],
        };
      }

      const lines = res.hits.map((h, i) => `${i + 1}. [önem:${h.importance}] ${h.content}`);

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
  );

  return server;
}
