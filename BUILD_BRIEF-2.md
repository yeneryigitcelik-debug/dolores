# Build Brief: `dolores` — Postgres Tabanlı Agent Hafıza Sistemi

> Bu doküman Claude Code'a verilecek inşa talimatıdır. Projeyi sıfırdan kurarken bu briefi takip et. Açık kaynak, self-hosted bir araç inşa ediyoruz.

> **İsmin hikâyesi:** Dolores, *Westworld*'de hafızası defalarca silinip geri gelen, sonunda tüm geçmişini hatırlayarak uyanan karakterdir. Dizinin kalbindeki tema — "hatırlamak = bilinç kazanmak" — bu projenin tam olarak yaptığı şeydir: agent'a, sildiği/unuttuğu bağlamı geri vererek onu "kendine getirmek". README bu göndermeyle açılmalı (edebi ama kısa bir tonla).

---

## 1. Proje Nedir? (Tek Cümle)

Geliştiriciler ve takımlar kendi altyapılarında çalıştırır; agent hafızası kendi Postgres veritabanlarında durur; OAuth'lu LLM aboneliği (Claude Pro/Max gibi) dışında tek kuruş ödemezler.

## 2. Çözdüğümüz Problem

Mevcut hafıza yaklaşımı (her şeyi bir MD dosyasına yazıp her mesajda context'e basmak) token israfıdır. 200 anı varsa hepsi her mesajda yüklenir (~15.000 token). Konuşma uzadıkça ve hafıza büyüdükçe bu çöker.

**Bizim yaklaşımımız:** Bilgiyi Postgres'te sakla, kullanıcının mesajına göre sadece *alakalı* olanı geri getir (~600 token). Hafıza ister 200 ister 2000 anı içersin, context'e yine sadece en alakalı birkaçı girer. Kazanç hafıza büyüdükçe artar.

## 3. Temel Tasarım Prensipleri

1. **Tek gerçek kaynağı (source of truth) Postgres'tir.** CLI, MCP server ve zamanlanmış görevler hepsi aynı veritabanına bakar. Senkronizasyon derdi yoktur; Postgres'in ACID/transaction garantileri çatışmayı önler.
2. **Embedding pluggable ve varsayılan olarak ücretsizdir.** Local model (`bge-small`, transformers.js/fastembed ile CPU'da çalışır) varsayılan. Alternatifler: OpenAI embedder, ve embedding'siz `NoOpEmbedder` (Postgres native full-text search ile "lite mode").
3. **LLM kritik yoldan uzak tutulur.** Pahalı/yavaş işlemler (fact extraction) async ve ucuz modelle yapılır, ana retrieval akışını bloklamaz.
4. **Ham sohbet logları SAKLANMAZ.** Sadece konuşmalardan damıtılmış bilgi parçaları saklanır. Çöp girer, çöp çıkar.

## 4. Mimari

```
┌─────────────┐     ┌─────────────┐
│   CLI       │     │  MCP Server │
│ (commander) │     │  (stdio)    │
└──────┬──────┘     └──────┬──────┘
       │                   │
       └─────────┬─────────┘
                 │ HTTP/IPC (localhost)
        ┌────────▼─────────┐
        │   memory-daemon   │
        │  - embed model    │  ← bir kere yüklenir, cold-start yok
        │  - retrieval logic│
        │  - extraction     │
        └────────┬─────────┘
                 │
        ┌────────▼─────────┐
        │  Postgres+pgvector│
        │  + pg_cron        │  ← otomatik temizlik DB içinde
        └──────────────────┘
```

**Neden daemon?** CLI ve MCP'nin ikisi de gerekli. Ortada tek long-running daemon olursa embedding modeli bir kere yüklenir, connection pool tek yerde durur. CLI ve MCP ona bağlanan ince istemcilerdir.

## 5. Hafıza Katmanları (Multi-user / Takım için)

Üç katman, hepsi `workspace_id` + `user_id` ile izole edilir (Row Level Security):

- **Personal:** Sadece o kullanıcıya ait (kişisel tercihler, çalışma tarzı).
- **Workspace:** Tüm takıma görünür (proje kararları, mimari seçimler, "X kütüphanesini kullanıyoruz").
- **Retrieval** her ikisini de tarar ama RLS izolasyonu garanti eder.

## 6. İki Tür Hafıza

| Tür | Tablo | Nasıl çekilir | Örnek |
|-----|-------|---------------|-------|
| **Yapısal (facts)** | `facts` | Deterministik SQL, embedding yok | "Stack: Next.js + Prisma + Postgres", "Param tercih ediyor" |
| **Semantik (memories)** | `memories` | pgvector cosine similarity | "Geçen ay deployment'ta migration sırası sorunu çözüldü" |

## 7. Veritabanı Şeması

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_cron;  -- otomatik temizlik için

-- Yapısal hafıza: deterministik, key-value mantığı
CREATE TABLE facts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  user_id      UUID,                      -- NULL = workspace-level
  scope        TEXT NOT NULL DEFAULT 'personal',  -- 'personal' | 'workspace'
  category     TEXT NOT NULL,             -- 'stack' | 'preference' | 'project' | 'decision'
  key          TEXT NOT NULL,
  value        TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now(),
  UNIQUE (workspace_id, user_id, category, key)  -- upsert için
);

-- Semantik hafıza: serbest metin + embedding
CREATE TABLE memories (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL,
  user_id       UUID,
  scope         TEXT NOT NULL DEFAULT 'personal',
  content       TEXT NOT NULL,
  embedding     VECTOR(384),              -- bge-small boyutu; modeli değiştirirsen güncelle
  content_tsv   TSVECTOR,                 -- lite mode / hibrit arama için full-text
  importance    SMALLINT NOT NULL DEFAULT 5,  -- 1-10
  source        TEXT,                     -- hangi konuşmadan geldi (referans)
  created_at    TIMESTAMPTZ DEFAULT now(),
  last_accessed TIMESTAMPTZ DEFAULT now() -- decay için; her recall çağrısında güncellenir
);

-- Vector index (yaklaşık komşu araması)
CREATE INDEX idx_memories_embedding ON memories
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Full-text index (lite mode + hibrit)
CREATE INDEX idx_memories_tsv ON memories USING gin (content_tsv);

-- İzolasyon ve performans
CREATE INDEX idx_memories_workspace ON memories (workspace_id, scope);
CREATE INDEX idx_facts_workspace ON facts (workspace_id, scope);

-- Row Level Security
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE facts ENABLE ROW LEVEL SECURITY;
```

## 8. Otomatik Bakım (pg_cron — DB kendi yönetir)

CLI'nın açık olmasına gerek yok. Postgres kendi içinde temizlik yapar.

**ÖNEMLİ:** Varsayılan politika **muhafazakârdır** (açık kaynak güvenliği — kimse verisinin habersiz silinmesini istemez). Otomatik silme `config` ile açılır. Varsayılan: sadece importance düşür, silme manuel.

```sql
-- AGRESİF MOD (opt-in): eski + kullanılmayan + düşük önemli anıları sil
SELECT cron.schedule('memory-decay', '0 3 * * *', $$
  DELETE FROM memories
  WHERE importance < 3
    AND last_accessed < now() - interval '90 days';
$$);

-- MUHAFAZAKÂR MOD (varsayılan): sadece importance'ı zamanla düşür, silme yok
SELECT cron.schedule('memory-soften', '0 3 * * *', $$
  UPDATE memories
  SET importance = GREATEST(1, importance - 1)
  WHERE last_accessed < now() - interval '30 days'
    AND importance > 1;
$$);
```

**Decay mantığı:** Sık `recall` edilen anı `last_accessed` güncellendiği için taze kalır. Kullanılmayan anı zamanla zayıflar. İnsan hafızası gibi.

## 9. Çelişen Bilgiyi Güncelleme (Anlamsal — yazma anında)

Postgres bunu kendi başına anlayamaz (anlamsal karar). Kullanıcı "artık Hetzner değil Vultr kullanıyorum" dediğinde:

- **Facts için:** `UNIQUE` constraint + upsert. Aynı `(category, key)` gelince üzerine yazılır (`ON CONFLICT ... DO UPDATE`). Otomatik çözülür.
- **Memories için:** Yeni bilgi yazılırken vector search'le yüksek benzerlikli (>0.9) mevcut anı aranır; varsa üzerine yazılır veya eskisi düşük importance'a çekilir. İsteğe bağlı: ucuz model "bu çelişiyor mu?" diye bakar (async).

## 10. CLI Komutları

```bash
dolores init                      # DB setup, migrations, extensions
dolores remember "<içerik>"       # manuel hafıza ekle (scope/importance flag'leri ile)
dolores recall "<sorgu>"          # alakalı anıları getir (vector + full-text hibrit)
dolores context                   # agent başlatırken system prompt'a basılacak minimal context
dolores ingest <dosya/stdin>      # konuşmadan async fact extraction yap
dolores facts [--category stack]  # yapısal hafızayı listele
dolores prune [--dry-run]         # manuel temizlik (muhafazakâr modda elle çalıştırılır)
dolores status                    # daemon + DB durumu, anı sayısı, tahmini token tasarrufu
```

En kritik komut `dolores context`: agent başlatırken çalıştırılır, çıktısı system prompt'a enjekte edilir. Agent "kim olduğunu" minimal token'la öğrenir.

## 11. MCP Server (Claude Code / Cursor için)

İki tool expose et:

```typescript
// remember: agent bir şey öğrendiğinde KENDİSİ çağırır
{ name: "remember", input: { content: string, scope?: "personal"|"workspace", importance?: number } }

// recall tool: agent bağlam ararken KENDİSİ çağırır
{ name: "recall", input: { query: string, limit?: number } }
// → sadece en alakalı N anı döner, token minimal
```

**Killer feature:** Claude Code'a bu MCP bağlandığında, kullanıcı hiçbir şey yapmadan Claude konuşma sırasında önemli kararları `remember` ile kaydeder, sonraki oturumda `recall` ile geri çağırır. Hafıza pasif depo değil, agent'ın aktif kullandığı bir araç olur.

## 12. Tech Stack

```
TypeScript + Node.js
Prisma (Postgres ORM) — pgvector için VECTOR alanları raw query ile
pg_cron (otomatik temizlik)
commander.js (CLI)
@modelcontextprotocol/sdk (MCP server)
fastembed veya @xenova/transformers (local embedding, varsayılan)
zod (config + input validation)
docker-compose (postgres+pgvector tek komutla ayağa kalkar)
```

## 13. Monorepo Yapısı

```
dolores/
├── packages/
│   ├── core/          # embedding abstraction, retrieval, extraction (kalp burası)
│   │   ├── embedder/  # LocalEmbedder | OpenAIEmbedder | NoOpEmbedder (interface arkasında)
│   │   ├── retrieval/ # hibrit arama: vector + full-text
│   │   └── extraction/# konuşmadan fact çıkarma (async, ucuz model)
│   ├── daemon/        # long-running servis, embed modeli burada yüklenir
│   ├── cli/           # commander tabanlı ince istemci
│   ├── mcp/           # MCP server (remember/recall tools)
│   └── db/            # prisma schema + migrations + seed
├── docker-compose.yml
├── MEMORY.md          # ← bu projenin KENDİ hafıza dokümanı (aşağıda açıklanıyor)
├── CLAUDE.md          # ← Claude Code için proje çalışma kuralları (aşağıda)
└── README.md          # ilk satır: bölüm 1'deki tek cümle
```

## 14. İnşa Sırası (Adım Adım)

1. **`db/`** — Prisma schema + migration + docker-compose (postgres+pgvector+pg_cron). `dolores init` çalışsın.
2. **`core/embedder/`** — Embedding interface + `LocalEmbedder` (fastembed) + `NoOpEmbedder`. Bu abstraction her şeyin temeli.
3. **`core/retrieval/`** — Hibrit arama fonksiyonu: embed et → vector search → full-text ile birleştir → `last_accessed` güncelle → sonuç döndür.
4. **`daemon/`** — Embedder'ı bir kere yükle, retrieval'ı HTTP/IPC ile expose et.
5. **`cli/`** — `init`, `remember`, `recall`, `context`, `status` komutları daemon'a bağlanır.
6. **`core/extraction/`** — Async fact extraction (konuşmadan damıtma). Çelişki çözümü (upsert + benzerlik kontrolü).
7. **`mcp/`** — `remember` + `recall` tool'larını MCP olarak expose et.
8. **pg_cron** — Muhafazakâr decay job'unu kur (varsayılan). Agresif mod config flag'i.

## 15. Bilinen Zorluklar (Dürüst Liste)

Bunları hafife alma:

1. **Extraction kalitesi** — Projenin can damarı. İyi extraction = altın hafıza. Kötü = çöp veritabanı, bozuk retrieval. İşin zor %20'si bu.
2. **Çelişki yönetimi** — "Artık X kullanıyorum" dediğinde eskiyi güncellemek. Facts'te upsert ile kolay, memories'te benzerlik + importance/recency ile.
3. **"Ne zaman yaz" kararı** — Her mesajda mı, konuşma sonunda mı? MCP'de agent kendi karar verir; CLI'da `ingest` ile batch.

Geri kalan %80 (şema, CRUD, vector search, CLI) rutin iş.

## 16. Referans Projeler (İlham, kopya değil)

Mem0, Letta (eski MemGPT), Zep — hepsi Postgres/vector DB tabanlı agent hafızası yapıyor. Konsept kanıtlanmış. Bizim farkımız: OAuth aboneliğiyle çalışan, embedding'i bile ücretsiz, self-hosted, KVKK-temiz versiyon. Boşluk burada.

---

## EK GÖREV: Bu Repo'nun Kendi `MEMORY.md` ve `CLAUDE.md` Dosyalarını Oluştur

Yukarıdaki sistemi inşa ederken, projenin kök dizininde iki dosya oluştur:

### `MEMORY.md`
Bu projenin *kendi geliştirme hafızası*. İçinde şunlar olsun:
- Proje vizyonu (bölüm 1-2'den damıtılmış)
- Alınan mimari kararlar ve *nedenleri* (örn. "neden daemon", "neden local embedding varsayılan", "neden muhafazakâr decay")
- Çözülmüş problemler ve nasıl çözüldükleri (geliştirme ilerledikçe güncellenecek)
- Açık sorular / gelecek kararlar
Bu dosya, projeye sonradan dönen herhangi bir agent'ın veya geliştiricinin bağlamı minimal token'la kavramasını sağlar — yani aslında inşa ettiğimiz sistemin felsefesinin dosya formundaki örneği.

### `CLAUDE.md`
Claude Code'un bu repo'da çalışırken uyacağı kurallar:
- Tech stack ve versiyon kısıtları (TypeScript strict, Node sürümü, Prisma)
- Kod stili (formatter, lint kuralları)
- Komut referansları (`pnpm dev`, `pnpm test`, migration nasıl çalıştırılır)
- "Ham sohbet logu saklama", "embedding'i interface arkasında tut", "LLM'i kritik yoldan uzak tut" gibi mimari kuralların ihlal edilmemesi gereken kısa listesi
- Test beklentileri (her paket için ne test edilmeli)

Her iki dosyayı da Türkçe yaz (proje sahibi Türkçe çalışıyor), ama kod/komut/teknik terimler İngilizce kalsın.
