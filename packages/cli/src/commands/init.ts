import { applyMigrations, enableAggressiveDecay, getPool } from "@dolores/db";

export async function runInit(opts: { noDocker: boolean }): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("Hata: DATABASE_URL ortam değişkeni gerekli (superuser/admin bağlantısı).");
    console.error(
      "  Örnek: DATABASE_URL=postgresql://dolores:dolores@localhost:5544/dolores dolores init",
    );
    process.exit(1);
  }

  if (!opts.noDocker) {
    console.log("Not: Docker konteynerinin çalıştığından emin ol: docker compose up -d");
    console.log("  (Bu komutu çalıştırmak için --no-docker bayrağını kullan)\n");
  }

  console.log("Migrasyon uygulanıyor...");
  const pool = getPool();
  try {
    await applyMigrations(pool);
    console.log("✓ Şema hazır (pgvector, pg_cron, facts, memories, RLS)");

    const decayMode = process.env.DOLORES_DECAY_MODE ?? "conservative";
    if (decayMode === "aggressive") {
      await enableAggressiveDecay(pool);
      console.log("✓ Agresif decay (cron DELETE) etkinleştirildi");
    }

    console.log("\ndolores başarıyla başlatıldı.");
    if (decayMode !== "aggressive") {
      console.log("  Agresif decay için: DOLORES_DECAY_MODE=aggressive dolores init");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\nMigrasyon hatası: ${msg}`);
    console.error("İpucu: DATABASE_URL superuser yetkisi gerektirir (extension kurulumu için).");
    process.exit(1);
  } finally {
    await pool.end();
  }
}
