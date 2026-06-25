# MEMORY.md — dolores geliştirme hafızası

Bu dosya projenin *kendi* geliştirme hafızasıdır: vizyon, alınan mimari kararlar ve
*nedenleri*, çözülmüş problemler, açık sorular. Projeye sonradan dönen bir agent veya
geliştirici bağlamı minimal token'la buradan kavrar — yani inşa ettiğimiz sistemin
felsefesinin dosya formundaki örneği.

## Vizyon

Self-hosted, açık kaynak agent hafıza sistemi. Bilgi kullanıcının kendi Postgres'inde
durur; OAuth'lu LLM aboneliği dışında maliyet yok; embedding bile ücretsiz (local).
Farkımız (Mem0 / Letta / Zep karşısında): **OAuth aboneliğiyle çalışan, embedding'i bile
ücretsiz, KVKK-temiz, self-hosted** versiyon.

**Çözdüğümüz problem:** "Her anıyı her mesajda context'e basmak" O(n) token israfıdır.
Biz Postgres'te saklayıp sorguya göre sadece alakalı birkaçını çekeriz → ~600 token sabit.

## Mimari Kararlar ve Nedenleri

- **Neden daemon?** CLI ve MCP'nin ikisi de gerekli. Ortada tek long-running daemon olursa
  embedding modeli bir kere yüklenir (cold-start yok), connection pool tek yerde durur.
  CLI ve MCP ona bağlanan ince istemcilerdir.
- **Neden local embedding varsayılan?** Ücretsiz, KVKK-temiz (veri dışarı çıkmaz), cold-start'ı
  daemon çözer. fastembed `bge-small` (384 dim) CPU'da yeterince hızlı. OpenAI/noop alternatif.
- **Neden muhafazakâr decay varsayılan?** Açık kaynak güvenliği: kimse verisinin habersiz
  silinmesini istemez. Varsayılan sadece importance düşürür; agresif silme `config` ile opt-in.
- **Neden iki tür hafıza?** Yapısal `facts` (deterministik SQL, embedding yok, upsert) +
  semantik `memories` (pgvector cosine + full-text hibrit). Farklı sorgu doğası, farklı tablo.
- **Neden Postgres tek kaynak?** ACID/transaction çelişkiyi önler; pg_cron bakımı DB içinde
  yapar (CLI açık olmak zorunda değil); pgvector + full-text tek motorda.
- **Neden kontratlar `@dolores/core`'da?** Tüm paketler aynı tip setine (`Embedder`,
  `DAEMON_ROUTES`, request/response) bakar → paralel geliştirmede uyum, drift yok.

## Çözülmüş Problemler

- **pg_cron + pgvector tek image:** `packages/db/Dockerfile` — `postgres:17` üstüne PGDG apt'tan
  `postgresql-17-pgvector` + `postgresql-17-cron`. Derleme gerekmez. `shared_preload_libraries=pg_cron`
  docker-compose `command`'iyle veriliyor.
- **facts upsert (ON CONFLICT 42P10):** Workspace-level fact'lerde (`user_id IS NULL`) dedupe için
  iki partial unique index DEĞİL, tek `NULLS NOT DISTINCT` index (PG15+) gerekir — yoksa core'un
  predicate-siz `ON CONFLICT (workspace_id,user_id,category,key)` inference'ı eşleşmez.
- **RLS izolasyonu:** Daemon `dolores_app` (non-superuser) ile bağlanmalı — superuser RLS'i FORCE
  altında bile bypass eder. Transaction-local GUC commit sonrası `''` (boş string) döner, NULL değil;
  policy `CASE WHEN nullif(current_setting(...), '') IS NOT NULL THEN ...::uuid END` ile korunur
  (AND short-circuit garantisi yok). Migration admin URL ile, runtime app URL ile.
- **Hibrit skor:** RRF (Reciprocal Rank Fusion, k=60) — vector cosine (`<=>`) + full-text (`ts_rank`)
  iki arm; skor aktif arm sayısına göre normalize. noop embedder'da yalnız full-text.
- **Çelişki çözümü:** facts upsert (last-writer-wins); memories >0.9 cosine benzerlikte süpersede.
- **daemon shutdown native crash:** fastembed/onnxruntime, `process.exit(0)` çağrılınca native atexit
  destructor'da mutex EINVAL → SIGABRT (exit 134). Çözüm: graceful shutdown sonunda `process.exit()`
  ÇAĞIRMA — `process.exitCode=0` set edip event loop'un doğal drain'ine bırak (fastify+pg kapanınca
  süreç kendiliğinden çıkar). `Embedder.dispose()` native session release iyi hijyen ama load-bearing
  fix exit kaldırımı. Regresyon testi: `packages/daemon/src/shutdown.test.ts`.
- **embed çıktısı:** fastembed `Float32Array[]` döndürür (`number[][]` değil); pgvector yazımı sorunsuz.
- **Lokal port:** docker host portu varsayılan 5433; agent-orchestra ile çakışırsa `.env` `POSTGRES_PORT`
  override (bu makinede 5544).
- **Temporal evolution (EPIC F):** `memories`'e `superseded_by`/`valid_from`/`valid_to` (raw-SQL,
  Prisma model'de değil — `embedding`/`content_tsv` gibi). Vektör index env-koşullu olduğu için
  `INIT_SQL`'den çıkarılıp `applyMigrations`'ta `vectorIndexSql(kind)` ile uygulanır (hnsw seçiliyken
  ivfflat'ı her başlangıçta yeniden kurmasın diye).
- **Durable ingest queue (EPIC J):** Postgres-native kuyruk; cross-tenant claim `FOR UPDATE SKIP LOCKED`
  + SECURITY DEFINER (decay gibi RLS-bypass), per-tenant yazımlar `withTenant` altında. `payload` terminal
  state'te purge (kural 1). Restart'ta `running→pending` reclaim. LLM çağırdığı için pg_cron değil, daemon worker.
- **Consolidation (EPIC L):** LLM **transaction dışında** çağrılır (uzun-tutulan tx yok); aynı-scope cosine
  kümeleme; üyeler supersede edilir (silme yok). Cluster eşiği 0.82 < dedup 0.9 (related ≠ duplicate).
- **Test izolasyonu:** live-DB testleri paylaşılan Postgres'e vurduğundan core+daemon `vitest.config`
  `fileParallelism:false`; kök `pnpm test` `--workspace-concurrency=1` (paket-seri) — timing flake'i önler.
- **Observability (EPIC K):** local `/metrics` (ring-buffer p50/p95/p99 + queue depth + dedup) + Prometheus;
  dış egress yok. OTel ertelendi (ağır opsiyonel dep, localhost için niş).

## Çözülen Sorular (v0.3–v0.4)

Brief'in 4 açık sorusu kapandı (detay: `docs/ROADMAP.md`, `CHANGELOG.md`):

- **Extraction "ne zaman yaz":** EPIC G — structured + confidence eşiği
  (`DOLORES_EXTRACTION_MIN_CONFIDENCE`) + contradiction-aware prompt; EPIC J durable
  queue ile async/restart-safe. Eval: `pnpm bench:extraction`.
- **Çelişki yönetimi (memory):** EPIC F — `DOLORES_EVOLUTION_MODE=versioned` supersede
  zinciri + validity penceresi → `asOf` point-in-time recall. Deterministik (>0.9 cosine);
  LLM contradiction'ı extraction'da opsiyonel.
- **Hibrit skor ağırlığı:** EPIC H — tunable weighted RRF (`DOLORES_FUSION_VECTOR/FT_WEIGHT`)
  + MMR diversity (`DOLORES_MMR_LAMBDA`, saf matematik) + opsiyonel local reranker seam.
- **ivfflat vs hnsw:** EPIC I — `DOLORES_VECTOR_INDEX` ile seçilir; `applyMigrations` seçileni
  build edip diğerini drop eder; `recall` doğru GUC'u (probes/ef_search) set eder.

## En Zor %20 (brief'ten)

1. **Extraction kalitesi** — projenin can damarı. İyi extraction = altın hafıza, kötü = çöp DB.
2. **Çelişki yönetimi** — "artık X kullanıyorum" dediğinde eskiyi güncellemek.
3. **"Ne zaman yaz" kararı** — yukarıda.

Geri kalan %80 (şema, CRUD, vector search, CLI) rutin iş.
