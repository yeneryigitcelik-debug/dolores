import type { RememberRequest, RememberResponse, Scope } from "@dolores/core";
import { z } from "zod";
import { DaemonError, daemonPost } from "../client.js";
import { getConfig, memoryContext } from "../config.js";

// Yanıt doğrulaması: kimlik boş olmamalı; değer olduğu gibi korunur (trim/UUID dönüşümü yok).
const rememberResponseSchema = z.object({
  id: z.string().refine((s) => s.trim().length > 0, {
    message: "Boş olmayan hafıza kimliği bekleniyor",
  }),
  deduped: z.boolean(),
}) satisfies z.ZodType<RememberResponse>;

interface RememberOptions {
  scope?: string;
  importance?: number;
  source?: string;
}

export async function runRemember(content: string, opts: RememberOptions): Promise<void> {
  const config = getConfig();
  const ctx = memoryContext(config);

  const body: RememberRequest = {
    ...ctx,
    content,
    scope: opts.scope as Scope | undefined,
    importance: opts.importance,
    source: opts.source,
  };

  try {
    const res = await daemonPost<RememberRequest, RememberResponse>(
      config,
      "/remember",
      body,
      rememberResponseSchema,
    );
    const dedupeNote = res.deduped ? " (yakın kopya birleştirildi)" : "";
    console.log(`✓ Kaydedildi [${res.id}]${dedupeNote}`);
  } catch (err) {
    if (err instanceof DaemonError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}
