import { readFileSync } from "node:fs";
import type { IngestRequest, IngestResponse } from "@dolores/core";
import { DaemonError, daemonPost } from "../client.js";
import { getConfig, memoryContext } from "../config.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export async function runIngest(filePath: string | undefined): Promise<void> {
  let text: string;

  if (filePath) {
    try {
      text = readFileSync(filePath, "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Dosya okunamadı: ${msg}`);
      process.exit(1);
    }
  } else {
    if (process.stdin.isTTY) {
      console.error(
        "Hata: dosya yolu belirt ya da stdin'den metin pipe et.\n  Örnek: cat conv.txt | dolores ingest\n         dolores ingest conv.txt",
      );
      process.exit(1);
    }
    text = await readStdin();
  }

  if (!text.trim()) {
    console.error("Hata: Boş metin ingest edilemez.");
    process.exit(1);
  }

  const config = getConfig();
  const ctx = memoryContext(config);
  const source = filePath ?? "stdin";

  const body: IngestRequest = { ...ctx, text, source };

  try {
    const res = await daemonPost<IngestRequest, IngestResponse>(config, "/ingest", body);
    if (res.queued) {
      const jobNote = res.jobId ? ` (iş: ${res.jobId})` : "";
      console.log(`✓ Ingest kuyruğa alındı${jobNote} — arka planda işleniyor`);
    }
  } catch (err) {
    if (err instanceof DaemonError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}
