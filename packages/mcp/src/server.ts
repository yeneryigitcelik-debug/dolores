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
// Config from env
// ---------------------------------------------------------------------------

const WORKSPACE_ID = process.env.DOLORES_WORKSPACE_ID ?? "00000000-0000-0000-0000-000000000001";
const USER_ID = process.env.DOLORES_USER_ID ?? undefined;
const DAEMON_HOST = process.env.DOLORES_DAEMON_HOST ?? "127.0.0.1";
const DAEMON_PORT = process.env.DOLORES_DAEMON_PORT ?? "4505";
const DAEMON_BASE = `http://${DAEMON_HOST}:${DAEMON_PORT}`;

// ---------------------------------------------------------------------------
// Daemon fetch helper
// ---------------------------------------------------------------------------

export async function daemonPost<TReq, TRes>(path: string, body: TReq): Promise<TRes> {
  const url = `${DAEMON_BASE}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`dolores daemon erişilemiyor: ${msg}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`daemon ${res.status}: ${text}`);
  }

  return res.json() as Promise<TRes>;
}

// ---------------------------------------------------------------------------
// Tool input schemas (exported for testing)
// ---------------------------------------------------------------------------

export const rememberInputSchema = z.object({
  content: z.string().describe("Kaydedilecek bilgi veya karar"),
  scope: z
    .enum(["personal", "workspace"])
    .optional()
    .describe(
      "Erişim kapsamı: personal (sadece bu kullanıcı) veya workspace (tüm ekip). Varsayılan: personal",
    ),
  importance: z.number().int().min(1).max(10).optional().describe("Önem skoru 1-10. Varsayılan: 5"),
});

export const recallInputSchema = z.object({
  query: z.string().describe("Arama sorgusu"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("Maksimum sonuç sayısı. Varsayılan: 5"),
});

// ---------------------------------------------------------------------------
// Server factory — creates a fresh McpServer with tools registered.
// Called once in production (index.ts) and per-test in tests.
// ---------------------------------------------------------------------------

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "dolores", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // ---- remember tool -------------------------------------------------------

  server.registerTool(
    "remember",
    {
      description: "Agent öğrendiği önemli kararı/bilgiyi kalıcı hafızaya yazar.",
      inputSchema: rememberInputSchema.shape,
    },
    async (args) => {
      const req: RememberRequest = {
        workspaceId: WORKSPACE_ID,
        ...(USER_ID ? { userId: USER_ID } : {}),
        content: args.content,
        ...(args.scope ? { scope: args.scope } : {}),
        ...(args.importance !== undefined ? { importance: args.importance } : {}),
      };

      let res: RememberResponse;
      try {
        res = await daemonPost<RememberRequest, RememberResponse>(DAEMON_ROUTES.remember.path, req);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text" as const, text: msg }],
        };
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

  // ---- recall tool ---------------------------------------------------------

  server.registerTool(
    "recall",
    {
      description:
        "Agent bağlam ararken alakalı geçmiş hafızayı getirir (sadece en alakalı N, token minimal).",
      inputSchema: recallInputSchema.shape,
    },
    async (args) => {
      const req: RecallRequest = {
        workspaceId: WORKSPACE_ID,
        ...(USER_ID ? { userId: USER_ID } : {}),
        query: args.query,
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      };

      let res: RecallResponse;
      try {
        res = await daemonPost<RecallRequest, RecallResponse>(DAEMON_ROUTES.recall.path, req);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text" as const, text: msg }],
        };
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
