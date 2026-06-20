# CLAUDE.md — dolores repo çalışma kuralları

Bu repo'da kod yazan herhangi bir agent (Claude Code dahil) aşağıdaki kurallara uyar.
Kod/komut/teknik terimler İngilizce, açıklamalar Türkçe.

## Tech Stack & Versiyon Kısıtları

- **TypeScript strict** (`tsconfig.base.json`'dan extend). `any` kullanma; gerekiyorsa `unknown` + daraltma.
- **Node ≥ 20**, ESM (`"type": "module"`). Import'larda **`.js` uzantısı zorunlu** (NodeNext): `import { x } from "./y.js"`.
- **pnpm workspace** monorepo. Paketler arası bağımlılık `workspace:*`.
- **Prisma 6** (Postgres). `VECTOR`/`TSVECTOR` Prisma'da yok → raw SQL migration ile yönetilir.
- **fastembed** (local embedding varsayılanı, 384 dim). **fastify** (daemon HTTP). **commander** (CLI). **@modelcontextprotocol/sdk** (MCP). **zod** (config + input validation).
- Formatter/linter: **biome** (`pnpm lint`, `pnpm format`).

## Mimari Kurallar — İHLAL ETME

1. **Ham sohbet logu SAKLAMA.** Sadece damıtılmış fact/memory yazılır. (`memories.content`, `facts.value`)
2. **Embedding'i interface arkasında tut.** Her şey `Embedder` (`@dolores/core` `types.ts`) üzerinden. pgvector dim'i veya bir vendor SDK retrieval'a sızmaz.
3. **LLM'i kritik yoldan uzak tut.** Extraction async + ucuz model. `recall`/`context` ASLA LLM çağırmaz — saf SQL + vector.
4. **Tek gerçek kaynağı Postgres.** State'i başka yerde tutma. Daemon tek pool sahibidir.
5. **Paketler-arası tipleri yeniden tanımlama.** Hepsi `@dolores/core`'dan import edilir (`Embedder`, `Memory`, `Fact`, `DAEMON_ROUTES`, request/response tipleri).
6. **RLS izolasyonu.** Her sorgu `workspace_id` (+ `user_id`) taşır; cross-tenant sızıntı olamaz.
7. **Muhafazakâr decay varsayılan.** Otomatik silme yalnızca `DOLORES_DECAY_MODE=aggressive` ile açılır.

## Komutlar

```bash
pnpm install              # tüm workspace bağımlılıkları (kökte çalıştır)
pnpm build                # tüm paketleri derle (pnpm -r build)
pnpm test                 # tüm paket testleri
pnpm lint                 # biome check
pnpm db:up / db:down      # docker compose (postgres+pgvector+pg_cron)

# db paketi
pnpm --filter @dolores/db migrate:dev   # migration üret + uygula (dev)
pnpm --filter @dolores/db generate      # prisma client üret
```

## Test Beklentileri (paket bazında)

- **db**: migration uygulanıyor; extension'lar (vector, pg_cron) kuruluyor; RLS bir başka workspace'in satırını gizliyor.
- **core/embedder**: `LocalEmbedder` 384-dim vektör döndürüyor; `NoOpEmbedder` boş döndürüyor; `embed([])` güvenli.
- **core/retrieval**: hibrit skor vector+full-text birleştiriyor; `last_accessed` recall'da güncelleniyor; `limit` saygı görüyor.
- **core/extraction**: bir konuşma parçasından beklenen fact'leri çıkarıyor; çelişen fact upsert ile güncelleniyor (>0.9 benzerlik memory'de süperseding).
- **daemon**: her `DAEMON_ROUTES` endpoint'i kontrata uygun cevap veriyor; embedder bir kere yükleniyor.
- **cli**: her komut daemon'a doğru request atıyor; daemon yoksa anlamlı hata.
- **mcp**: `remember`/`recall` tool şemaları geçerli; daemon'a düzgün proxy'liyor.

## Konvansiyonlar

- Her paket kendi `dist/`'ine derler; `src/` dışına yazma.
- Hata mesajları kullanıcı-dostu (CLI) veya yapısal (daemon JSON). Sessiz `catch` yok.
- Env okuma tek yerde (zod ile validate), dağıtma yok.
- `pgdata/`, `.env`, `dist/` git'e girmez (`.gitignore`).
