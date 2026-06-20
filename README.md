# dolores

> Geliştiriciler ve takımlar kendi altyapılarında çalıştırır; agent hafızası kendi Postgres veritabanlarında durur; OAuth'lu LLM aboneliği (Claude Pro/Max gibi) dışında tek kuruş ödemezler.

Dolores, *Westworld*'de hafızası defalarca silinip geri gelen, sonunda tüm geçmişini hatırlayarak uyanan karakterdir. Dizinin kalbindeki tema — **hatırlamak = bilinç kazanmak** — bu projenin tam olarak yaptığı şeydir: agent'a, sildiği veya unuttuğu bağlamı geri vererek onu "kendine getirmek".

---

## Neden?

Yaygın hafıza yaklaşımı (her şeyi bir Markdown dosyasına yazıp her mesajda context'e basmak) token israfıdır. 200 anınız varsa hepsi her mesajda yüklenir (~15.000 token); konuşma ve hafıza büyüdükçe bu çöker.

**dolores'in yaklaşımı:** Bilgiyi Postgres'te sakla, kullanıcının mesajına göre yalnızca *alakalı* olanı geri getir (~600 token). Hafıza ister 200 ister 2000 anı içersin, context'e yine sadece en alakalı birkaçı girer. Kazanç hafıza büyüdükçe **artar**.

## Tasarım Prensipleri

1. **Tek gerçek kaynağı Postgres'tir.** CLI, MCP server ve zamanlanmış görevler aynı veritabanına bakar. ACID/transaction garantileri senkronizasyon derdini bitirir.
2. **Embedding pluggable ve varsayılan olarak ücretsizdir.** Local `bge-small` (fastembed, CPU) varsayılan. Alternatif: OpenAI embedder, ya da embedding'siz `noop` ("lite mode", Postgres full-text).
3. **LLM kritik yoldan uzaktır.** Pahalı/yavaş işler (fact extraction) async ve ucuz modelle yapılır; retrieval'ı bloklamaz.
4. **Ham sohbet logları saklanmaz.** Yalnızca damıtılmış bilgi parçaları tutulur.

## Mimari

```
CLI ─┐                       ┌─ memory-daemon ─┐
     ├─ localhost HTTP ──────┤  embed (1x yük) │── Postgres + pgvector + pg_cron
MCP ─┘                       │  retrieval      │
                             │  extraction     │
                             └─────────────────┘
```

Tek long-running **daemon**: embedding modeli bir kere yüklenir (cold-start yok), connection pool tek yerde durur. CLI ve MCP ona bağlanan ince istemcilerdir.

## Monorepo

| Paket | Sorumluluk |
|-------|------------|
| `@dolores/db` | Prisma şema + migration + docker-compose (postgres+pgvector+pg_cron) |
| `@dolores/core` | embedder soyutlaması · hibrit retrieval · extraction (kalp) |
| `@dolores/daemon` | embed modelini yükler, retrieval/extraction'ı localhost HTTP ile sunar |
| `@dolores/cli` | `commander` tabanlı ince istemci |
| `@dolores/mcp` | MCP server (`remember` / `recall` tool'ları) |

## Hızlı Başlangıç

```bash
pnpm install
cp .env.example .env          # gerekirse düzenle
pnpm db:up                    # postgres + pgvector + pg_cron
dolores init                  # şema + extension + migration
dolores remember "Stack: Next.js + Prisma + Postgres"
dolores recall "hangi stack'i kullanıyoruz?"
dolores context               # system prompt'a basılacak minimal bağlam
```

## CLI

```bash
dolores init                      # DB kurulum, migration, extension'lar
dolores remember "<içerik>"       # manuel hafıza ekle (--scope --importance)
dolores recall "<sorgu>"          # alakalı anıları getir (vector + full-text hibrit)
dolores context                   # agent başlatırken system prompt'a basılacak bağlam
dolores ingest <dosya|stdin>      # konuşmadan async fact extraction
dolores facts [--category stack]  # yapısal hafızayı listele
dolores prune [--dry-run]         # manuel temizlik (muhafazakâr modda elle)
dolores status                    # daemon + DB durumu, anı sayısı, token tasarrufu
```

## MCP (Claude Code / Cursor)

İki tool sunulur: agent öğrendiğini `remember` ile kaydeder, bağlam ararken `recall` ile geri çağırır. Hafıza pasif depo değil, agent'ın aktif kullandığı bir araç olur.

## Lisans

MIT — ayrıntılı kurulum ve mimari notlar için [`CLAUDE.md`](./CLAUDE.md) ve [`MEMORY.md`](./MEMORY.md).
