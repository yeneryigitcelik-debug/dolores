import type { ConsolidateRequest, ConsolidateResponse, Scope } from "@dolores/core";
import { DaemonError, daemonPost } from "../client.js";
import { getConfig, memoryContext } from "../config.js";

export async function runConsolidate(opts: { scope?: string }): Promise<void> {
  const config = getConfig();
  const ctx = memoryContext(config);
  const scope: Scope | undefined =
    opts.scope === "workspace" || opts.scope === "personal" ? opts.scope : undefined;
  const body: ConsolidateRequest = { ...ctx, scope };

  try {
    const res = await daemonPost<ConsolidateRequest, ConsolidateResponse>(
      config,
      "/consolidate",
      body,
    );
    if (!res.enabled) {
      console.log(
        "Consolidation kapalı. Açmak için daemon'da DOLORES_CONSOLIDATION_MODE=on ayarla.",
      );
      return;
    }
    console.log("\n✓ Consolidation tamamlandı\n");
    console.log(`  Aday bellek:   ${res.candidates}`);
    console.log(`  Küme:          ${res.clusters}`);
    console.log(`  Konsolide:     ${res.consolidated}`);
    console.log(`  Superseded:    ${res.superseded}`);
    console.log();
  } catch (err) {
    if (err instanceof DaemonError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}
