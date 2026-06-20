import type { RecallRequest, RecallResponse, Scope } from "@dolores/core";
import { DaemonError, daemonPost } from "../client.js";
import { getConfig, memoryContext } from "../config.js";

interface RecallOptions {
  limit?: number;
  scope?: string;
}

export async function runRecall(query: string, opts: RecallOptions): Promise<void> {
  const config = getConfig();
  const ctx = memoryContext(config);

  const body: RecallRequest = {
    ...ctx,
    query,
    limit: opts.limit,
    scope: opts.scope as Scope | undefined,
  };

  try {
    const res = await daemonPost<RecallRequest, RecallResponse>(config, "/recall", body);

    if (res.hits.length === 0) {
      console.log("Sonuç bulunamadı.");
      return;
    }

    console.log(`${res.hits.length} sonuç (~${res.tokenEstimate} token):\n`);
    for (const hit of res.hits) {
      const score = (hit.score * 100).toFixed(1);
      const imp = String(hit.importance).padStart(2);
      const scope = hit.scope.padEnd(9);
      const src = hit.source ? ` [${hit.source}]` : "";
      console.log(`  [${score}% · imp:${imp} · ${scope}] ${hit.content}${src}`);
    }
  } catch (err) {
    if (err instanceof DaemonError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}
