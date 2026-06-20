import type { PruneRequest, PruneResponse } from "@dolores/core";
import { z } from "zod";
import { DaemonError, daemonPost } from "../client.js";
import { getConfig, memoryContext } from "../config.js";

export interface PruneOptions {
  dryRun?: boolean;
  confirm?: boolean;
}

const pruneResponseSchema = z.object({
  deleted: z.number().int().nonnegative(),
  softened: z.number().int().nonnegative(),
  dryRun: z.boolean(),
}) satisfies z.ZodType<PruneResponse>;

export async function runPrune(opts: PruneOptions): Promise<void> {
  const config = getConfig();
  const ctx = memoryContext(config);

  try {
    if (opts.confirm) {
      // Gerçek silme — agresif decay modunda ekstra uyarı
      if (process.env.DOLORES_DECAY_MODE === "aggressive") {
        console.error(
          "⚠  Agresif decay modu aktif — bu işlem pg_cron kurallarıyla birlikte" +
            " daha fazla kaydı etkileyebilir.",
        );
      }

      const body: PruneRequest = { ...ctx, dryRun: false };
      const res = await daemonPost<PruneRequest, PruneResponse>(
        config,
        "/prune",
        body,
        pruneResponseSchema,
      );

      console.log("Prune tamamlandı:");
      console.log(`  Silindi:       ${res.deleted}`);
      console.log(`  Hafifletildi:  ${res.softened}`);
    } else {
      // Önizleme (dry-run) — --confirm olmadan varsayılan davranış
      const body: PruneRequest = { ...ctx, dryRun: true };
      const res = await daemonPost<PruneRequest, PruneResponse>(
        config,
        "/prune",
        body,
        pruneResponseSchema,
      );

      if (opts.dryRun) {
        console.log("Prune önizlemesi [DRY RUN — gerçek silme yok]:");
      } else {
        console.log("Prune önizlemesi:");
      }
      console.log(`  Silinecek:     ${res.deleted}`);
      console.log(`  Hafifletilecek: ${res.softened}`);

      if (!opts.dryRun) {
        console.log("\nGerçekten silmek için: dolores prune --confirm");
      }
    }
  } catch (err) {
    if (err instanceof DaemonError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}
