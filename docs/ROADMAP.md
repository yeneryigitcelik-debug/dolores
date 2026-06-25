# dolores — Geliştirme Roadmap'i (v0.3 → v0.5)

> Bu doküman v0.2.0 sonrası kapsamlı geliştirme planıdır. EPIC formatı v0.2'nin
> (A–E) konvansiyonunu sürdürür: her EPIC bir **Hedef / Neden / Tasarım / Şema &
> dosyalar / Test / Kabul kriteri / Mimari uyum** bloğudur. Açıklamalar Türkçe,
> teknik terimler İngilizce (CLAUDE.md kuralı).

## Yön → EPIC haritası

Kullanıcı dört yönü birden seçti. Her yön ilgili EPIC'lere dağıldı:

| Yön | EPIC'ler |
|-----|----------|
| **Memory Intelligence** (en zor %20) | F (temporal evolution), G (extraction v2), L (consolidation) |
| **Retrieval & Ranking** | H (MMR + weighted fusion + reranker), I (HNSW) |
| **Scale & Production** | I (HNSW), J (durable ingest queue), K (observability + load) |
| **Ecosystem & DX** | M (genişletilmiş API + MCP tools), N (Python SDK), O (framework adapters), P (web dashboard) |

## MEMORY.md açık sorularının kapatılması

`MEMORY.md`'deki "Açık Sorular / Gelecek Kararlar" bu roadmap'le doğrudan kapanır:

1. Extraction "ne zaman yaz" → **EPIC G** (confidence eşiği + structured prompt) + **EPIC M** (auto-remember rehberi)
2. Çelişki yönetimi (memory) → **EPIC F** (supersede zinciri + validity penceresi)
3. Hibrit skor ağırlığı (RRF mı, ağırlıklı toplam mı?) → **EPIC H** (tunable weighted fusion + eval)
4. ivfflat vs hnsw → **EPIC I**

## Sürüm planı

| Sürüm | Tema | EPIC'ler | Bağımlılık |
|-------|------|----------|-----------|
| **v0.3** | Memory Evolution & Ranking (ayrıştırıcı değer) | F, G, H | F şema temeli; G, F'in supersede'ini kullanır |
| **v0.4** | Scale & Operability | I, J, K, L | L, J worker altyapısını + F supersede'ini kullanır |
| **v0.5** | Ecosystem & DX | M, N, O, P | M, F'e (asOf/forget) bağımlı; N/O/P, M'in stabil API'sine bağımlı |

Bağımlılık zinciri (kritik yol): **F → G → (H ‖ I) → J → L → M → (N ‖ O ‖ P)**.
H, I, K büyük ölçüde bağımsız; paralel ilerleyebilir.

---

# v0.3 — Memory Evolution & Ranking

## EPIC F — Temporal Memory Evolution

**Hedef.** Anılar yalnız dedupe edilmez; **evrilir**. Yeni bilgi eskiyle çeliştiğinde
eski anı *kaybolmaz* — supersede zinciriyle işaretlenir, geçerlilik penceresi kapanır.
"Şu tarihte ne biliyorduk?" (as-of) sorgusu mümkün olur. Mem0/Zep karşısında asıl
ayrıştırıcı budur.

**Neden.** Bugün `remember()` >0.9 cosine benzerlikte in-place UPDATE yapıyor → tarih
kayboluyor. "Hetzner → Vultr geçtim" dendiğinde Hetzner anısı yok oluyor; geçmiş
sorgulanamıyor. Dürüst hafıza zaman boyutunu tutmalı.

**Tasarım.**
- `remember()` iki mod: `DOLORES_EVOLUTION_MODE = inplace` (varsayılan, mevcut davranış)
  veya `versioned`. Versioned'da: benzer anı bulununca yeni satır INSERT edilir, eski
  satır `superseded_by = <yeni id>`, `valid_to = now()` ile işaretlenir.
- `recall()` varsayılan olarak yalnız aktif (`superseded_by IS NULL`) anıları döner.
  Yeni `asOf?: string` parametresi → `valid_from <= asOf AND (valid_to IS NULL OR valid_to > asOf)`.
  Yeni `includeSuperseded?: boolean`.
- Çelişki tespiti **deterministik** kalır (>0.9 cosine = supersede). LLM tabanlı
  "B, A ile çelişiyor mu?" kontrolü yalnız extraction/ingest yolunda (EPIC G), recall'da değil.

**Şema & dosyalar.**
- Migration `..._memory_evolution`:
  - `memories.superseded_by UUID NULL REFERENCES memories(id) ON DELETE SET NULL`
  - `memories.valid_from TIMESTAMPTZ NOT NULL DEFAULT now()`
  - `memories.valid_to TIMESTAMPTZ NULL`
  - Partial index `ON memories (workspace_id) WHERE superseded_by IS NULL` (sıcak aktif set)
  - RLS politikaları superseded satırları da kapsamaya devam eder (mevcut policy yeterli).
- `core/types.ts`: `Memory`'ye `supersededBy/validFrom/validTo`; `RecallQuery`'ye `asOf?/includeSuperseded?`.
- `core/retrieval/remember.ts`: versioned dal.
- `core/retrieval/recall.ts`: aktif-filtre + asOf dalı (her iki arm'ın WHERE'ine eklenir).
- `core/retrieval/sql.ts`: `MemoryRow`'a yeni kolonlar.

**Test.** Supersede zinciri bütünlüğü; as-of recall doğru sürümü döner; aktif filtre
superseded'i hariç tutar; superseded satırlarda RLS hâlâ izole; in-place mod regresyonu yok.

**Kabul.** "Hetzner → Vultr" senaryosu: `recall("hosting")` → Vultr; `recall("hosting", asOf=geçen-ay)` → Hetzner; iki satır da var, zincir gezilebilir.

**Mimari uyum.** Recall'da LLM yok (kural 3); revizyonlar damıtılmış memory'dir, ham chat değil (kural 1); tek kaynak Postgres (kural 4).

---

## EPIC G — Extraction Quality v2

**Hedef.** Extraction'ı "varsayılan kapalı, tek-atışlık prompt"tan, varsayılan açılabilecek
güvenilir can damarına çevirmek.

**Neden.** `MEMORY.md`: "iyi extraction = altın hafıza, kötü = çöp DB" — en zor %20'nin
1. ve 2. maddesi. Bugün `DOLORES_EXTRACTION_ENABLED=false`, prompt tek atış, confidence yok,
çelişki farkındalığı yok.

**Tasarım.**
- **Structured extraction**: her item `{type, content|key|value, category, importance, confidence, entities?}`.
  Provider'ın JSON/structured mode'u + zod şeması.
- **Confidence eşiği**: `DOLORES_EXTRACTION_MIN_CONFIDENCE` altındakiler yazılmaz.
- **Few-shot + "kalıcı fact damıt, gelip geçen sohbeti değil"** sistem prompt'u.
- **Çelişki-farkında**: workspace'in mevcut fact'leri (ucuz, deterministik SELECT) prompt'a
  verilir → model supersede/update niyeti üretir → EPIC F'i besler.
- **Extraction eval harness**: etiketli fixture seti (transcript → beklenen facts/memories),
  precision/recall skoru. `benchmarks/extraction-eval.ts`.
- Hâlâ async, hâlâ kritik yoldan uzak. Kalite barı + eval geçince varsayılan-açık yol dokümante edilir.

**Şema & dosyalar.** `core/extraction/extract.ts` (structured schema), `provider.ts` (JSON mode),
yeni `benchmarks/extraction-eval.ts` + `benchmarks/fixtures/`.

**Test + eval.** Fixture precision/recall ≥ hedef; çelişki supersede niyeti üretir; düşük-confidence elenir; LLM hatası graceful no-op kalır.

**Kabul.** Örnek transcript'ten beklenen fact'lerin ≥%80'i, gürültü <%10 ile çıkar; çelişen
girdi EPIC F supersede'ini tetikler.

**Mimari uyum.** LLM kritik yoldan uzak (kural 3); ham log saklanmaz, yalnız damıtılmış (kural 1).

---

## EPIC H — Retrieval Ranking v2

**Hedef.** "Hibrit skor ağırlığı" açık sorusunu kapatmak + context'teki tekrarı (diversity)
gidermek + opsiyonel local reranker.

**Tasarım.**
1. **Tunable weighted fusion**: `fuseRrf`'e arm-başı ağırlık (`DOLORES_FUSION_VECTOR_WEIGHT`,
   `DOLORES_FUSION_FT_WEIGHT`). Varsayılan mevcut davranış. Alternatif "weighted-sum" modu
   config arkasında; eval ile karşılaştırılır.
2. **MMR diversity**: fusion sonrası top adaylar Maximal Marginal Relevance ile yeniden sıralanır
   (λ = relevance↔diversity dengesi). Aday embedding'leri arm SELECT'lerine eklenir, pairwise
   cosine JS'te hesaplanır. **Saf matematik, model yok → recall hattında güvenli.**
   `DOLORES_MMR_LAMBDA` (1.0 = kapalı/saf relevance, ~0.7 önerilen).
3. **Opsiyonel local reranker (LLM DEĞİL)**: `Reranker` interface (Embedder pattern'i),
   varsayılan `NoOpReranker`. `LocalCrossEncoderReranker` (küçük ONNX cross-encoder, ör. bge-reranker-base)
   yalnız final aday dilimine uygulanır, latency-bounded. **Varsayılan KAPALI**, `DOLORES_RERANKER` ile opt-in.
   → *Karar gerekiyor:* kural 3 "LLM" der; cross-encoder generative değil ama recall-hattı latency'sine
   dokunur. Opt-in + local-only + bounded ile çözülüyor; senin onayın gerek (bkz. Kararlar §1).
4. **Genişletilmiş eval**: recall@k + nDCG + diversity metriği; RRF vs weighted vs +MMR vs +reranker.

**Şema & dosyalar.** `core/retrieval/rrf.ts` (ağırlık), yeni `core/retrieval/mmr.ts`,
yeni `core/rerank/` (interface + noop + local), `core/retrieval/recall.ts` (embedding'leri çek, MMR/rerank uygula),
`benchmarks/recall-eval.ts` (metrik genişletme).

**Test.** MMR near-duplicate oranını düşürür; weighted fusion ağırlıklara saygı duyar; reranker swappable; noop varsayılan davranışı değişmez.

**Kabul.** Eval'de +MMR diversity↑ ve recall@5 düşmeden; weighted fusion en iyi konfig dokümante.

**Mimari uyum.** MMR saf matematik; reranker local+opt-in+bounded; ağırlıklar config-tek-yer (kural: env tek yerde).

---

# v0.4 — Scale & Operability

## EPIC I — HNSW & Index Strategy

**Hedef.** ivfflat↔hnsw açık sorusunu kapatmak; vektör index'i ölçeğe taşımak.

**Tasarım.**
- HNSW index opsiyonu (pgvector ≥0.5): `USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64)`.
  `DOLORES_VECTOR_INDEX = ivfflat | hnsw`. ivfflat eski pgvector için fallback kalır.
- Query-time `SET LOCAL hnsw.ef_search` (ivfflat.probes analoğu): `DOLORES_HNSW_EF_SEARCH`.
- `CREATE INDEX CONCURRENTLY` txn dışında çalışır → OPERATIONS.md'ye operasyonel rehber.
- Benchmark: recall@k + latency, ivfflat vs hnsw, N = 1k/10k/100k (sentetik korpus).

**Şema & dosyalar.** Migration `..._hnsw_index`, `core/retrieval/recall.ts` (ef_search), `benchmarks/index-bench.ts`, `docs/OPERATIONS.md`.

**Test.** Her iki index'le recall doğru; ef_search/probes tunable; migration idempotent.

**Kabul.** Benchmark tablosu ile "şu ölçekte şu index" net önerisi; varsayılan seçim gerekçeli.

**Mimari uyum.** Embedder dim sızıntısı yok; tek kaynak Postgres.

---

## EPIC J — Durable Async Ingest Queue

**Hedef.** Fire-and-forget `void` promise'i (restart'ta iş kaybı) dayanıklı, retry'lı, Postgres-native
kuyrukla değiştirmek — **chat-log deposu olmadan** (kural 1).

**Tasarım.**
- `ingest_jobs` tablosu: `id, workspace_id, user_id, status(pending|running|done|failed), payload TEXT,
  source, attempts INT, last_error TEXT, created_at, updated_at`. RLS uygulanır.
- **Kural 1 uyumu**: `payload` (ham metin) `done`/`failed` olunca derhal PURGE edilir (NULL) — kuyruk
  geçici iş tamponu, kalıcı transcript deposu değil. pg_cron eski job'ları temizler. Açıkça dokümante.
- Worker: daemon-içi background loop, `SELECT ... FOR UPDATE SKIP LOCKED` ile job claim (harici broker yok
  → "Postgres tek kaynak"). Bounded concurrency; backoff'lu retry; max attempts.
- `/ingest` artık INSERT edip `{queued:true, jobId}` döner (mevcut `IngestResponse` şekli zaten uygun).
  Yeni `/ingest/status` route'u job poll eder.
- Restart'ta pending/running job'lar geri alınır.

**Şema & dosyalar.** Migration `..._ingest_jobs`, yeni `daemon/src/worker.ts`, `daemon/src/server.ts`
(`/ingest` enqueue + `/ingest/status`), `core/types.ts` (`DAEMON_ROUTES.ingestStatus`, job tipleri).

**Test.** SKIP LOCKED altında job tek kez claim; payload completion'da purge; failure retry; restart reclaim; RLS izolasyonu.

**Kabul.** Daemon ingest ortasında restart edilince iş kaybolmaz; payload kalıcı saklanmaz.

**Mimari uyum.** Postgres-native kuyruk (kural 4); payload purge (kural 1); extraction kritik yoldan uzak (kural 3).

---

## EPIC K — Observability & Load

**Hedef.** Production-grade görünürlük.

**Tasarım.**
- OpenTelemetry trace: remember/recall/context/ingest span'leri, DB query + embedder span'leri, OTLP exporter,
  `DOLORES_OTEL_*`, varsayılan kapalı.
- Zengin `/metrics`: latency histogram (p50/p95/p99), arm-başı recall süresi, queue depth, dedup oranı.
  Prometheus text format opsiyonu.
- Load test harness (autocannon/k6) `scripts/` altında: sürekli recall/remember RPS, p95 + error rate raporu.

**Şema & dosyalar.** `daemon/src/telemetry.ts`, `daemon/src/server.ts` (/metrics genişletme), `scripts/loadtest.*`.

**Test.** Trace span'leri çıkar; metrics şekli; load script çalışır.

**Kabul.** p95 latency ve hata oranı raporlanır; trace bir backend'de görünür.

**Mimari uyum.** Telemetry varsayılan kapalı; veri dışarı sızmaz (KVKK).

---

## EPIC L — Memory Consolidation

**Hedef.** İlişkili anı kümelerini periyodik olarak tek üst-seviye özete indirgemek → küçük korpus, daha iyi recall.
Intelligence işi; J worker'ını + F supersede'ini kullanır; LLM kritik yoldan UZAK (background, extraction gibi).

**Tasarım.**
- Background job (J worker + pg_cron tetik): aktif anıları embedding yakınlığıyla kümele (eşik/DBSCAN-vari),
  her yoğun küme için ucuz LLM tek konsolide anı sentezler, yazar, üyeleri konsolidasyona `superseded_by` ile bağlar (EPIC F zinciri).
- Varsayılan muhafazakâr/opt-in (`DOLORES_CONSOLIDATION_MODE`), asla silmez (supersede).
- Tunable: min küme boyutu, benzerlik eşiği, schedule.

**Şema & dosyalar.** `core/consolidation/`, worker entegrasyonu, pg_cron job.

**Test.** Küme→konsolide tek özet üretir; üyeler superseded; recall özeti döner; opt-in gating.

**Kabul.** N anılı küme tek özetle temsil edilir, recall kalitesi düşmez, kaynak anılar gezilebilir.

**Mimari uyum.** LLM kritik yoldan uzak (kural 3); supersede≠silme (kural 7 muhafazakâr); tek kaynak Postgres.

---

# v0.5 — Ecosystem & DX

## EPIC M — Genişletilmiş API & MCP Tools

**Hedef.** API'yi tamamlamak + agent'lara zengin hafıza kontrolü vermek.

**Tasarım.**
- Yeni daemon route'ları (+ `DAEMON_ROUTES`):
  - `/forget` — id ile anıyı supersede/archive (confirm semantiği), RLS-safe.
  - `/memory/update` — id ile content/importance düzenle.
  - `/stats` — workspace başına sayımlar, top source'lar, dedup oranı, büyüme.
  - `/facts/delete` — fact sil.
  - `/recall` `asOf` kazanır (EPIC F).
- Yeni MCP tool'ları (ayna): `forget`, `update_memory`, `list_facts`, `get_context`, `stats`.
  Agent'lar için auto-remember heuristik rehberi (dokümantasyon).

**Şema & dosyalar.** `core/types.ts` (route + tipler), `daemon/src/server.ts`, `core/retrieval/*` (forget/update),
`mcp/src/server.ts` (yeni tool'lar), `cli/src/commands/*` (forget/update/stats).

**Test.** Her route kontratı; MCP tool şemaları geçerli + doğru proxy; forget/update'te RLS.

**Kabul.** Agent bir anıyı recall→update→forget edebilir; CLI/MCP/daemon kontrat parite.

**Mimari uyum.** Tipler `@dolores/core`'dan (kural 5); RLS her yeni route'ta (kural 6); DAEMON_ROUTES geriye-uyumlu eklenir.

---

## EPIC N — Python SDK

**Hedef.** Agent ekosistemini bulunduğu yerde (Python) karşılamak.

**Tasarım.**
- Yeni `sdks/python/` (pnpm workspace dışı, kendi `pyproject`). Daemon HTTP API'sinin ince istemcisi.
  `DoloresClient(workspace_id, user_id, base_url)` → `remember/recall/context/ingest/facts/forget`. Sync + async, pydantic-typed.
- `DAEMON_ROUTES` ile kontrat paritesi (üretilen ya da elle aynalanan tipler). PyPI yayını (sonra).

**Şema & dosyalar.** `sdks/python/dolores/`, `tests/`, `pyproject.toml`, CI job.

**Test.** Ephemeral daemon'a (docker) karşı pytest; DAEMON_ROUTES parite kontrolü.

**Kabul.** `pip install` → 5 satırda remember/recall çalışır; kontrat TS daemon'la birebir.

**Mimari uyum.** Daemon API'nin ince istemcisi; tek kaynak Postgres; tip parite (kural 5'in ruhu).

---

## EPIC O — Framework Adapters

**Hedef.** Popüler agent framework'lerine drop-in hafıza.

**Tasarım.**
- LangChain (Python): `BaseChatMessageHistory`/memory adapter, dolores recall/remember ile besli (SDK paketi içinde).
- LlamaIndex (Python): memory/vector-store-vari adapter.
- TS: Vercel AI SDK / LangChain.js için küçük adapter (examples veya yeni paket).
- Hepsi SDK üstünde ince sarmalayıcı; pattern dokümante.

**Test.** Adapter round-trip: framework arayüzü üzerinden remember→recall.

**Kabul.** Bir LangChain agent'ı dolores'u memory backend olarak değişiklikle kullanır.

---

## EPIC P — Web Dashboard

**Hedef.** Görsel hafıza tarayıcı/editör: incele, ara, düzenle, supersede, decay/evolution gör.

**Tasarım.**
- Yeni `apps/web/` (hafif Vite SPA veya daemon'ın serve ettiği tek dosya). Daemon HTTP'ye konuşur, mevcut bearer token ile auth.
- Görünümler: memory list (scope/importance/source/superseded filtre), arama (/recall), fact tablo editörü,
  memory detay + supersede zinciri + validity timeline, stats dashboard (/stats), prune/forget (confirm'li).
- RLS-scoped, workspace seçici.
- **Gerilim:** yeni web yüzeyi. Opsiyonel, localhost-first, aynı auth gate arkasında; localhost-bind güvenlik gate'ini zayıflatmaz.

**Test.** Hafif component/e2e; API entegrasyonu.

**Kabul.** Dashboard'dan bir anı aranır, düzenlenir, supersede zinciri görülür; auth gate korunur.

---

# Cross-cutting (her EPIC'te geçerli)

- **Migration disiplini**: her şema değişikliği transactional migration; idempotent; RLS yeni tablolara uygulanır; OPERATIONS.md güncellenir.
- **DAEMON_ROUTES geriye-uyum**: yalnız ekleme; mevcut route şekilleri kırılmaz.
- **Benchmark güncel**: her retrieval/scale EPIC'i `benchmarks/` ve README rakamlarını günceller.
- **Test barı**: CLAUDE.md'deki paket-bazı test beklentileri korunur + her EPIC kendi testini ekler.
- **Lint/format**: biome temiz; `any` yok; `.js` uzantılı ESM import.
- **Docs**: her EPIC ilgili README/OPERATIONS/CHANGELOG bölümünü günceller.

# Kararlar (onaylandı — 2026-06-25)

1. **Reranker kapsamı (EPIC H)** — ✅ Kapsamda. Opt-in + local-only ONNX cross-encoder, varsayılan kapalı, bounded latency. Cross-encoder generative değil → opt-in olarak kural 3 ile uyumlu. MMR + weighted fusion her zaman aktif.
2. **Evolution varsayılanı (EPIC F)** — ✅ Varsayılan `inplace` (mevcut güvenli davranış); `versioned` (supersede zinciri + tarih) `DOLORES_EVOLUTION_MODE=versioned` ile opt-in.
3. **Ingest payload retention (EPIC J)** — ✅ Purge-on-done. Ham metin `done`/`failed` olunca NULL'lanır; kalıcı transcript saklanmaz (kural 1).
4. **Extraction varsayılanı (EPIC G)** — ✅ Eval barı geçene kadar opt-in; sonra README'de "önerilen açık" olarak işaretlenir, varsayılan değişmez.
5. **Web dashboard (EPIC P)** — ✅ v0.5 kapsamında kalır. Opsiyonel, localhost-first, mevcut auth gate arkasında.
6. **Python SDK yeri (EPIC N)** — ✅ Monorepo `sdks/python/` (pnpm workspace dışı, kendi `pyproject`).

# Sonraki adım

Onayından sonra **v0.3 / EPIC F** ile başlarız (şema temeli — diğerleri buna dayanıyor).
Uygulama sırasında her EPIC için TaskCreate ile alt-görevler açılır, migration + test + benchmark birlikte gider.
