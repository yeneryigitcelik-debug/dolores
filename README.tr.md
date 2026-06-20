<div align="center">

# dolores

**Yapay zekâ agent'ları için, yalnızca *önemli* olanı hatırlayan bellek — kendi Postgres'in, kendi verin, token başına sıfır maliyet.**

[![CI](https://github.com/yeneryigitcelik-debug/dolores/actions/workflows/ci.yml/badge.svg)](https://github.com/yeneryigitcelik-debug/dolores/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![PostgreSQL + pgvector](https://img.shields.io/badge/PostgreSQL-pgvector-4169E1?logo=postgresql&logoColor=white)](https://github.com/pgvector/pgvector)
[![MCP](https://img.shields.io/badge/MCP-remember%20%2F%20recall-8A63D2)](https://modelcontextprotocol.io/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#katkı)
[![npm](https://img.shields.io/npm/v/@dolores/cli)](https://www.npmjs.com/package/@dolores/cli)

[English](./README.md) · **Türkçe**

</div>

> Adını *Westworld*'deki **Dolores**'ten alır — hafızası defalarca silinen, sonunda tüm geçmişini hatırlayarak uyanan host. Dizinin özündeki fikir, *hatırlamak bilinç kazanmaktır*, bu projenin agent için yaptığı şeyin tam olarak kendisidir: agent'ın düşürdüğü bağlamı geri verir, onu kendine getirir.

---

## Neden dolores?

Agent belleğine yaygın yaklaşım — her şeyi bir Markdown dosyasına yazıp her mesajda bağlama basmak — bir token şenlik ateşidir. 200 anınız varsa her turda hepsini yeniden yüklersiniz (~15.000 token). Konuşma ve bellek büyüdükçe bu çöker.

**dolores bilgiyi Postgres'te saklar ve yalnızca o anki mesaja *alakalı* olanı getirir (~600 token).** İster 200 ister 2.000 anınız olsun, bağlama yalnızca en alakalı birkaçı girer. **Kazanç, bellek büyüdükçe artar.**

Ödediğiniz tek şey zaten sahip olduğunuz LLM aboneliğidir (Claude Pro/Max vb.). Embedding'ler yerel ve ücretsiz çalışır. Veriniz altyapınızdan hiç çıkmaz.

## Benchmark'lar

Yerel bir Postgres + bge-small-en-v1.5 (384d, CPU) üzerinde üretilen gerçek sayılar.

### Token tasarrufu (naif dump vs. dolores `buildContext`)

| Bellek deposu boyutu | Naif token | dolores token | Tasarruf |
|----------------------|-----------|---------------|----------|
| 100 anı              | 2.049     | 582           | **%72**  |
| 500 anı              | 10.251    | 591           | **%94**  |
| 1.000 anı            | 20.502    | 591           | **%97**  |
| 1.500 anı            | 30.768    | 591           | **%98**  |

dolores bağlamı, depo boyutundan bağımsız olarak ~591 token'da sabit kalır. Tasarruf, 100 anıda %72'den **1.500 anıda %98'e** çıkar.

### Recall kalitesi (200 anılık korpus, 30 sorgu)

| Retriever                       | hit@1   | hit@3   | hit@5   |
|---------------------------------|---------|---------|---------|
| Hibrit (pgvector + full-text)   | **%87** | **%87** | **%87** |
| Yalnızca full-text (temel)      | %33     | %33     | %33     |

Hibrit retrieval, **yalnızca full-text'ten 2,6× daha iyidir**. Full-text birebir anahtar kelime eşleşmelerini yakalar (%100) ama açımlama (paraphrase) ve anlamsal sorgulara kördür — bunlar vektör olmadan %0 alır.

→ Tam yöntem, ASCII grafiği ve ham veri: [`benchmarks/RESULTS.md`](./benchmarks/RESULTS.md)

## Özellikler

- 🧠 **İki tür bellek** — yapısal **facts** (deterministik anahtar/değer, kesin SQL) ve anlamsal **memories** (serbest metin, vektör benzerliği).
- 🔍 **Hibrit retrieval** — pgvector cosine **+** Postgres full-text, Reciprocal Rank Fusion ile birleştirilir. "Lite mode"da saf full-text'e düşer.
- 🆓 **Varsayılan ücretsiz yerel embedding** — `fastembed` (bge-small, 384d) CPU'da. OpenAI ile değiştirilebilir veya `noop` embedder ile embedding'siz çalışır.
- 🏢 **Row-Level Security ile çok kiracılı** — personal + workspace kapsamları, veritabanı seviyesinde izole. Takımlar için güvenli.
- 🔌 **Birinci sınıf MCP** — `remember` / `recall` tool'larını sunar; böylece Claude Code & Cursor bağlamı *kendileri* kaydedip geri çağırır.
- 🧹 **Kendi kendini bakımlı** — `pg_cron` eski anıları veritabanı içinde çürütür. Varsayılan muhafazakâr (yumuşatır, asla silmez); agresif silme opt-in.
- 🗑️ **Ham transkript yok** — yalnızca damıtılmış fact ve memory saklanır. Çöp girer çöp çıkar — bu yüzden çöp saklamayız.
- 🐘 **Tek gerçek kaynağı** — Postgres. CLI, MCP ve zamanlanmış işler aynı veritabanını okur; çakışmaları ACID halleder.

## Mimari

```
  CLI ─┐                         ┌──────── memory-daemon ────────┐
       ├── localhost HTTP ───────┤  embedder (bir kez yüklenir)   │      Postgres
  MCP ─┘                         │  hibrit retrieval (vec + FTS)  ├──── + pgvector
                                 │  async extraction              │      + pg_cron
                                 └────────────────────────────────┘
```

Tek bir uzun-ömürlü **daemon** embedding modelini bir kez yükler (cold-start yok) ve tek bağlantı havuzunu (pool) tutar. **CLI** ve **MCP server**, localhost üzerinden ona konuşan ince istemcilerdir. Gerisini — vektör arama, full-text, bakım — Postgres tek motorda yapar.

## Kurulum

```bash
npm i -g @dolores/cli   # global CLI
```

Veya kaynaktan çalıştırın (aşağıya bakın).

## Hızlı Başlangıç

**Gereksinimler:** Node ≥ 20, pnpm, Docker.

```bash
git clone https://github.com/yeneryigitcelik-debug/dolores.git
cd dolores
pnpm install
cp .env.example .env          # isterseniz düzenleyin

pnpm db:up                    # Postgres + pgvector + pg_cron
pnpm build
dolores init                  # extension'lar, şema, RLS, decay job

dolores remember "Production Hetzner'da Coolify ile deploy ediliyor." --scope workspace
dolores recall  "production nerede barınıyor?"
dolores context               # system prompt'a basılacak minimal-token bellek bloğu
```

> Model ilk kullanımda bir kez indirilir (CPU-dostu bge-small). Sonrasında recall yerel ve anlıktır.

## CLI

```bash
dolores init                      # DB kurulumu: extension, migration, RLS, pg_cron
dolores remember "<metin>"        # bir anı ekle   (--scope, --importance, --source)
dolores recall   "<sorgu>"        # hibrit vektör + full-text arama
dolores context                   # system prompt'a inject edilecek minimal bağlam bloğu
dolores ingest   <dosya|stdin>    # bir konuşmadan fact + memory damıt (async)
dolores facts    [--category …]   # yapısal fact'leri listele
dolores prune    [--dry-run]      # manuel temizlik
dolores status                    # daemon + DB sağlığı, sayılar, tahmini token tasarrufu
```

`dolores context` öne çıkan komuttur: bir agent başlarken çalıştırın ve çıktısını system prompt'a pipe edin. Agent "kim olduğunu" minimal token'la öğrenir.

## MCP (Claude Code / Cursor)

Server'ı ekleyin; agent iki tool kazanır — kararları `remember` ile kaydeder, alakalı geçmişi `recall` ile çeker, kullanıcı müdahalesi olmadan:

```jsonc
// Claude Code mcp config
{
  "mcpServers": {
    "dolores": {
      "command": "node",
      "args": ["/abs/path/to/dolores/packages/mcp/dist/index.js"],
      "env": {
        "DOLORES_WORKSPACE_ID": "00000000-0000-0000-0000-000000000001",
        "DOLORES_DAEMON_PORT": "4505"
      }
    }
  }
}
```

Artık bellek pasif bir depo değil — agent'ın oturumlar boyunca aktif kullandığı bir araçtır.

## Nasıl Çalışır

| | Yapısal (`facts`) | Anlamsal (`memories`) |
|---|---|---|
| **Saklanışı** | anahtar/değer | serbest metin + 384d embedding + tsvector |
| **Getirilişi** | kesin SQL, embedding yok | pgvector cosine + full-text (RRF) |
| **Çelişki çözümü** | `ON CONFLICT` upsert (son yazan kazanır) | >0.9 cosine benzerlikte süpersede |
| **Örnek** | `stack/db = Postgres + pgvector` | "geçen deploy'da migration sırası bug'ı çözüldü" |

**İzolasyon.** Her satır `workspace_id` (+ opsiyonel `user_id`) taşır ve Postgres Row-Level Security ile korunur. Daemon non-superuser olarak bağlanır ve kiracıyı her transaction'da set eder; böylece kiracılar arası okuma imkânsızdır — yalnızca tavsiye edilmemiş değil.

**Decay.** Günlük bir `pg_cron` işi, eski ve geri çağrılmayan anıların önemini yumuşatır — insan belleği gibi. Silme **varsayılan kapalıdır** (`DOLORES_DECAY_MODE=conservative`); agresif silme politikası opt-in'dir.

## Nereye Oturur

Mem0, Letta (eski MemGPT) ve Zep'in hepsi Postgres/vektör tabanlı agent belleği yapar — kavram kanıtlanmıştır. dolores'in niş'i: **self-hosted, ücretsiz yerel embedding, MCP-native, ham transkript saklamaz, KVKK/GDPR-temiz.** Aboneliğiniz, veritabanınız, başka hiçbir şey.

## Tech Stack

TypeScript (strict) · Node ESM · pnpm monorepo · pgvector için Prisma + raw SQL · `fastembed` · `fastify` · `commander` · `@modelcontextprotocol/sdk` · `zod` · Docker Compose.

| Paket | Sorumluluk |
|---|---|
| `@dolores/db` | Prisma şema, raw-SQL migration (pgvector + pg_cron), Dockerfile, RLS, `withTenant` |
| `@dolores/core` | embedder soyutlaması · hibrit retrieval · extraction (paylaşılan kontratların sahibi) |
| `@dolores/daemon` | embedder'ı bir kez yükler, pool'u tutar, localhost HTTP sunar |
| `@dolores/cli` | `commander` tabanlı ince istemci |
| `@dolores/mcp` | MCP server (`remember` / `recall`) |

## Örnekler

Çalıştırılabilir entegrasyon örnekleri (MCP bağlama, bağlam enjeksiyonu, Node.js SDK): **[`examples/`](./examples/README.md)**

## Geliştirme

```bash
pnpm install
pnpm build         # tüm paketleri derle
pnpm test          # tüm paket testlerini koş
pnpm lint          # biome
pnpm db:up         # Postgres'i yerelde başlat
```

Mimari kararlar ve *nedenleri* [`MEMORY.md`](./MEMORY.md)'de; repo çalışma kuralları [`CLAUDE.md`](./CLAUDE.md)'de.

→ Backup / restore, decay modları, daemon env değişkenleri ve production sertleştirme: [`docs/OPERATIONS.md`](./docs/OPERATIONS.md).

## Katkı

Issue ve PR'lar memnuniyetle karşılanır. Mimari değişmezleri koruyun: ham transkript yok, embedding'ler `Embedder` arayüzü arkasında, LLM kritik yoldan uzak ve tek gerçek kaynağı Postgres. Bkz. [`CLAUDE.md`](./CLAUDE.md).

## Lisans

[MIT](./LICENSE) © 2026 Yener Yiğit Çelik
