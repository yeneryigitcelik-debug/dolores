import type { FactsListRequest, FactsListResponse } from "@dolores/core";
import { DaemonError, daemonPost } from "../client.js";
import { getConfig, memoryContext } from "../config.js";

interface FactsOptions {
  category?: string;
}

export async function runFacts(opts: FactsOptions): Promise<void> {
  const config = getConfig();
  const ctx = memoryContext(config);

  const body: FactsListRequest = {
    ...ctx,
    category: opts.category,
  };

  try {
    const res = await daemonPost<FactsListRequest, FactsListResponse>(config, "/facts/list", body);

    if (res.facts.length === 0) {
      console.log("Kayıtlı fact bulunamadı.");
      return;
    }

    const W = { cat: 12, key: 22, scope: 9 };
    const header = `  ${"CATEGORY".padEnd(W.cat)}  ${"KEY".padEnd(W.key)}  ${"SCOPE".padEnd(W.scope)}  VALUE`;
    const sep = `  ${"─".repeat(85)}`;

    console.log(`\n${res.facts.length} fact:\n`);
    console.log(header);
    console.log(sep);

    for (const f of res.facts) {
      const cat = f.category.padEnd(W.cat);
      const key = f.key.padEnd(W.key);
      const scope = f.scope.padEnd(W.scope);
      const val = f.value.length > 40 ? `${f.value.slice(0, 37)}...` : f.value;
      console.log(`  ${cat}  ${key}  ${scope}  ${val}`);
    }
    console.log();
  } catch (err) {
    if (err instanceof DaemonError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}
