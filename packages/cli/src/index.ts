#!/usr/bin/env node
/**
 * @dolores/cli — commander-based thin client for the dolores daemon.
 *
 * Commands: init · remember · recall · context · ingest · facts · prune · status
 *
 * Identity env:
 *   DOLORES_WORKSPACE_ID  — default 00000000-0000-0000-0000-000000000001
 *   DOLORES_USER_ID       — optional, personal scope isolation
 *
 * Daemon address:
 *   DOLORES_DAEMON_HOST   — default 127.0.0.1
 *   DOLORES_DAEMON_PORT   — default 4505
 */
import { Command } from "commander";
import { runContext } from "./commands/context.js";
import { runFacts } from "./commands/facts.js";
import { runIngest } from "./commands/ingest.js";
import { runInit } from "./commands/init.js";
import { runPrune } from "./commands/prune.js";
import { runRecall } from "./commands/recall.js";
import { runRemember } from "./commands/remember.js";
import { runStatus } from "./commands/status.js";

const program = new Command();

program.name("dolores").description("dolores — agent memory CLI").version("0.1.0");

// ---------------------------------------------------------------------------
// init — bypasses daemon, talks directly to DB via @dolores/db
// ---------------------------------------------------------------------------
program
  .command("init")
  .description("Şemayı kur (pgvector + pg_cron + tables + RLS). DATABASE_URL superuser gerektirir.")
  .option("--no-docker", "docker compose up hatırlatmasını atla")
  .action(async (opts: { docker: boolean }) => {
    await runInit({ noDocker: !opts.docker });
  });

// ---------------------------------------------------------------------------
// remember — POST /remember
// ---------------------------------------------------------------------------
program
  .command("remember <content>")
  .description("Yeni bir bellek kaydet")
  .option("--scope <scope>", "personal veya workspace (varsayılan: personal)", "personal")
  .option(
    "--importance <n>",
    "1..10 önem skoru (varsayılan: 5)",
    (v: string) => Number.parseInt(v, 10),
    5,
  )
  .option("--source <source>", "kaynak etiketi (örn: convo-id veya dosya adı)")
  .action(
    async (content: string, opts: { scope?: string; importance?: number; source?: string }) => {
      await runRemember(content, opts);
    },
  );

// ---------------------------------------------------------------------------
// recall — POST /recall
// ---------------------------------------------------------------------------
program
  .command("recall <query>")
  .description("Hybrid (vector + full-text) bellek arama")
  .option(
    "--limit <n>",
    "maksimum sonuç sayısı (varsayılan: 5)",
    (v: string) => Number.parseInt(v, 10),
    5,
  )
  .option("--scope <scope>", "personal veya workspace filtresi (ikisi için atla)")
  .action(async (query: string, opts: { limit?: number; scope?: string }) => {
    await runRecall(query, opts);
  });

// ---------------------------------------------------------------------------
// context — POST /context  (pipe target for system prompts)
// ---------------------------------------------------------------------------
program
  .command("context [query]")
  .description(
    "System prompt'a inject edilecek bellek bloğunu stdout'a yaz (pipe edilebilir). " +
      "[query] verilirse o göreve ALAKALI bellekler getirilir (hibrit recall).",
  )
  .option("--max-tokens <n>", "token bütçesi (varsayılan: ~600)", (v: string) =>
    Number.parseInt(v, 10),
  )
  .action(async (query: string | undefined, opts: { maxTokens?: number }) => {
    await runContext({ ...opts, query });
  });

// ---------------------------------------------------------------------------
// ingest — POST /ingest  (file or stdin, fire-and-forget)
// ---------------------------------------------------------------------------
program
  .command("ingest [file]")
  .description(
    "Ham metin ya da dosya ingest et (facts + bellek çıkarımı, arka planda async).\n" +
      "  Dosya belirtilmezse stdin'den okur: cat conv.txt | dolores ingest",
  )
  .action(async (file?: string) => {
    await runIngest(file);
  });

// ---------------------------------------------------------------------------
// facts — POST /facts/list
// ---------------------------------------------------------------------------
program
  .command("facts")
  .description("Kayıtlı structured fact'leri tablo olarak listele")
  .option("--category <cat>", "kategori filtresi: stack | preference | project | decision")
  .action(async (opts: { category?: string }) => {
    await runFacts(opts);
  });

// ---------------------------------------------------------------------------
// prune — POST /prune
// ---------------------------------------------------------------------------
program
  .command("prune")
  .description(
    "Eski / düşük önemli bellekleri temizle (30 gün+ erişilmeyenleri yumuşat, 90 gün+ sil)",
  )
  .option("--dry-run", "gerçek silme yapma, sadece etkilenecek sayıları göster")
  .option("--confirm", "önizlemeyi atla ve gerçekten sil (geri alınamaz)")
  .action(async (opts: { dryRun?: boolean; confirm?: boolean }) => {
    await runPrune(opts);
  });

// ---------------------------------------------------------------------------
// status — GET /status
// ---------------------------------------------------------------------------
program
  .command("status")
  .description("Daemon + DB sağlık durumu, embedder bilgisi ve istatistikler")
  .action(async () => {
    await runStatus();
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------
program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Hata: ${msg}`);
  process.exit(1);
});
