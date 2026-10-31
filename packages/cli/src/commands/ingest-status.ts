import type { IngestStatusRequest, IngestStatusResponse } from "@dolores/core";
import { z } from "zod";
import { DaemonError, daemonPost } from "../client.js";
import { getConfig, memoryContext } from "../config.js";

const MAX_ERROR_LENGTH = 500;

/** Same broad UUID acceptance as the daemon contract. */
const jobIdSchema = z.guid();

export const ingestStatusResponseSchema: z.ZodType<IngestStatusResponse> = z.object({
  id: z.guid(),
  status: z.enum(["pending", "running", "done", "failed"]),
  attempts: z.number().int().min(0),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const STATUS_LABELS: Record<IngestStatusResponse["status"], string> = {
  pending: "beklemede (henüz işlenmedi)",
  running: "işleniyor",
  done: "tamamlandı",
  failed: "başarısız",
};

export interface IngestStatusOptions {
  json?: boolean;
}

function fail(message: string): void {
  console.error(clean(message));
  process.exitCode = 1;
}

/** Replaces control characters and bounds length for terminal output. */
function clean(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 32 || (code >= 0x7f && code <= 0x9f) ? " " : ch;
  }
  return out.length > MAX_ERROR_LENGTH ? `${out.slice(0, MAX_ERROR_LENGTH - 1)}…` : out;
}

export async function runIngestStatus(
  jobId: string,
  opts: IngestStatusOptions = {},
): Promise<void> {
  const parsedId = jobIdSchema.safeParse(jobId.trim());
  if (!parsedId.success) {
    fail("Hata: geçersiz iş kimliği (UUID bekleniyor).");
    return;
  }
  const requestedId = parsedId.data;

  const config = getConfig();
  const body: IngestStatusRequest = { ...memoryContext(config), jobId: requestedId };

  let res: IngestStatusResponse;
  try {
    res = await daemonPost<IngestStatusRequest, IngestStatusResponse>(
      config,
      "/ingest/status",
      body,
      ingestStatusResponseSchema,
    );
  } catch (err) {
    fail(err instanceof DaemonError ? err.message : "Hata: iş durumu sorgulanamadı.");
    return;
  }

  if (res.id.toLowerCase() !== requestedId.toLowerCase()) {
    fail("Hata: daemon istenenden farklı bir iş kimliği döndürdü.");
    return;
  }

  if (opts.json) {
    const out: IngestStatusResponse = {
      id: res.id,
      status: res.status,
      attempts: res.attempts,
      lastError: res.lastError,
      createdAt: res.createdAt,
      updatedAt: res.updatedAt,
    };
    // Preserve JSON values while preventing C1 terminal controls in the wire text.
    console.log(
      JSON.stringify(out).replace(
        /[\u007f-\u009f]/g,
        (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
      ),
    );
    return;
  }

  console.log("\nIngest işi durumu\n");
  console.log(`  İş:            ${res.id}`);
  console.log(`  Durum:         ${STATUS_LABELS[res.status]}`);
  console.log(`  Deneme sayısı: ${res.attempts}`);
  console.log(`  Oluşturulma:   ${clean(res.createdAt)}`);
  console.log(`  Güncellenme:   ${clean(res.updatedAt)}`);
  if (res.lastError !== null) {
    console.log(`  Son hata:      ${clean(res.lastError)}`);
  }
  console.log();
}
