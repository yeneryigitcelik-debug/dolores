# @dolores/mcp

dolores hafıza sistemine bağlanan stdio MCP server — Claude Code ve Cursor için.

Daemon'u bir proxy olarak kullanır; kendi DB veya embedder tutmaz.

## Kurulum

Daemon çalışıyor olmalı:
```bash
pnpm db:up        # Postgres + pgvector başlat
pnpm --filter @dolores/daemon start
```

MCP server'ı derle:
```bash
pnpm --filter @dolores/mcp build
```

## Claude Code Bağlantısı

`~/.claude/mcp_settings.json` (veya proje `.claude/mcp_settings.json`) dosyasına ekle:

```json
{
  "mcpServers": {
    "dolores": {
      "command": "node",
      "args": ["/MUTLAK_YOL/packages/mcp/dist/index.js"],
      "env": {
        "DOLORES_WORKSPACE_ID": "00000000-0000-0000-0000-000000000001",
        "DOLORES_USER_ID": "11111111-1111-1111-1111-111111111111",
        "DOLORES_DAEMON_HOST": "127.0.0.1",
        "DOLORES_DAEMON_PORT": "4505"
      }
    }
  }
}
```

> `DOLORES_WORKSPACE_ID` yoksa `00000000-0000-0000-0000-000000000001` varsayılanı kullanılır.  
> `DOLORES_USER_ID` boş bırakılabilir (workspace-level hafıza).

## Araçlar

### `remember`
```
content: string      – kaydedilecek bilgi (zorunlu)
scope?: "personal" | "workspace"   – kullanıcı belirtilmişse personal, aksi halde workspace
importance?: 1-10   – varsayılan: 5
```
Çıktı: `Kaydedildi (id: <id>)`, dedup durumunda ise sonuna `(mevcut hafıza güncellendi)` eklenir. `<id>` boş olmayan herhangi bir string olabilir ve değiştirilmeden gösterilir. Daemon yanıtında boş olmayan bir kimlik ya da boolean `deduped` yoksa araç `isError: true` döner. Bu durumda istek tekrarlanmaz ve işlemin gerçekleşmediği de iddia edilmez; yeniden göndermeden önce hafızayı kontrol et.

### `recall`
```
query: string        – arama sorgusu (zorunlu)
limit?: 1-20        – maksimum sonuç, varsayılan: 5
```
Çıktı: önem skoru ve içerik içeren numaralı liste; token-minimal format.

## Killer Feature

Claude, konuşma sırasında **kendi başına** `remember` ve `recall` çağırır:
- Önemli bir karar aldığında → `remember` ile yazar
- Bağlam aradığında → `recall` ile geçmişten okur
- Böylece oturumlar arası hafıza oluşur — kullanıcının hatırlatmasına gerek kalmaz

## Çevre Değişkenleri

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `DOLORES_WORKSPACE_ID` | `00000000-0000-0000-0000-000000000001` | RLS izolasyon anahtarı |
| `DOLORES_USER_ID` | (boş) | Kişisel hafıza kapsamı |
| `DOLORES_DAEMON_HOST` | `127.0.0.1` | Daemon adresi |
| `DOLORES_DAEMON_PORT` | `4505` | Daemon portu |
| `DOLORES_AUTH_TOKEN` | (boş) | Korumalı daemon ile aynı Bearer token |
| `DOLORES_REQUEST_TIMEOUT_MS` | `60000` | İstek ve yanıt gövdesi için toplam süre sınırı; 1–3600000 ms |

Daemon'da token tanımlıysa MCP server sürecine de aynı token verilmelidir. Token tanımlanmamış yerel bağlantılar desteklenir. `DOLORES_DAEMON_HOST` hostname veya IP alır; IPv6 `::1` / `[::1]` kabul edilir, protokol ya da URL verilmez. Yapılandırma server oluşturulurken doğrulanır ve o server'ın istekleri boyunca sabit kalır.

Bearer token daemon bağlantısına erişimi sınırlar. Workspace ve user kimlikleri güvenilen MCP istemcisinin sağladığı hafıza bağlamıdır; token bu kimlikleri kullanıcı hesabına bağlamaz.

## Hata Durumları

Daemon çalışmıyorsa tool `isError: true` döner, server çökmez:
```
dolores daemon erişilemiyor: connect ECONNREFUSED 127.0.0.1:4505
```

Zaman aşımı veya bozuk daemon JSON yanıtı da kontrollü `isError: true` sonucudur. İstek otomatik tekrarlanmaz; yazma işlemi daemon tarafında tamamlanmış olabileceği için yeniden göndermeden önce sonucu kontrol et. Hata mesajlarında token gizlenir.
