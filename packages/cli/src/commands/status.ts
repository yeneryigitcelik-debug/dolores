import type { StatusResponse } from "@dolores/core";
import { DaemonError, daemonGet } from "../client.js";
import { daemonBaseUrl, getConfig } from "../config.js";

export async function runStatus(): Promise<void> {
  const config = getConfig();

  try {
    const res = await daemonGet<StatusResponse>(config, "/status");

    const dbStatus = res.db.connected ? "✓ bağlı" : "✗ bağlantı yok";
    const decayLabel = res.decayMode === "aggressive" ? "⚡ agresif" : "🌿 ılımlı";

    console.log("\ndolores daemon durumu\n");
    console.log(`  Daemon:              ${daemonBaseUrl(config)}`);
    console.log(
      `  Embedder:            ${res.embedder.id}  dim=${res.embedder.dim}  hazır=${res.embedder.ready}`,
    );
    console.log(`  Veritabanı:          ${dbStatus}`);
    console.log(`  Bellek sayısı:       ${res.db.memories}`);
    console.log(`  Fact sayısı:         ${res.db.facts}`);
    console.log(`  Decay modu:          ${decayLabel}`);
    console.log(`  Token tasarrufu:     ~${res.estimatedTokenSavings} token (tahmini)`);
    console.log();
  } catch (err) {
    if (err instanceof DaemonError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}
