import type { ContextRequest, ContextResponse } from "@dolores/core";
import { DaemonError, daemonPost } from "../client.js";
import { getConfig, memoryContext } from "../config.js";

interface ContextOptions {
  maxTokens?: number;
}

export async function runContext(opts: ContextOptions): Promise<void> {
  const config = getConfig();
  const ctx = memoryContext(config);

  const body: ContextRequest = {
    ...ctx,
    maxTokens: opts.maxTokens,
  };

  try {
    const res = await daemonPost<ContextRequest, ContextResponse>(config, "/context", body);
    // Sade stdout — system prompt'a doğrudan pipe edilebilsin
    process.stdout.write(res.text);
    if (res.text && !res.text.endsWith("\n")) {
      process.stdout.write("\n");
    }
  } catch (err) {
    if (err instanceof DaemonError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}
