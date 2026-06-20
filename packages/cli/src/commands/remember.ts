import type { RememberRequest, RememberResponse, Scope } from "@dolores/core";
import { DaemonError, daemonPost } from "../client.js";
import { getConfig, memoryContext } from "../config.js";

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
    scope: (opts.scope as Scope | undefined) ?? "personal",
    importance: opts.importance,
    source: opts.source,
  };

  try {
    const res = await daemonPost<RememberRequest, RememberResponse>(config, "/remember", body);
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
