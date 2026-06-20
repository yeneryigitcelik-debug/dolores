import type { PruneRequest, PruneResponse } from "@dolores/core";
import { DaemonError, daemonPost } from "../client.js";
import { getConfig, memoryContext } from "../config.js";

interface PruneOptions {
  dryRun?: boolean;
}

export async function runPrune(opts: PruneOptions): Promise<void> {
  const config = getConfig();
  const ctx = memoryContext(config);
  const dryRun = opts.dryRun ?? false;

  const body: PruneRequest = { ...ctx, dryRun };

  try {
    const res = await daemonPost<PruneRequest, PruneResponse>(config, "/prune", body);

    const dryNote = res.dryRun ? " [DRY RUN — gerçek silme yok]" : "";
    console.log(`Prune tamamlandı${dryNote}:`);
    console.log(`  Silindi:       ${res.deleted}`);
    console.log(`  Hafifletildi:  ${res.softened}`);
  } catch (err) {
    if (err instanceof DaemonError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}
