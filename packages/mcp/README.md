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
        "DOLORES_WORKSPACE_ID": "senin-workspace-uuid",
        "DOLORES_USER_ID": "senin-user-uuid",
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
scope?: "personal" | "workspace"   – varsayılan: personal
importance?: 1-10   – varsayılan: 5
```
Çıktı: `Kaydedildi (id: <uuid>)` veya dedup durumunda `(mevcut hafıza güncellendi)`.

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

## Hata Durumları

Daemon çalışmıyorsa tool `isError: true` döner, server çökmez:
```
dolores daemon erişilemiyor: connect ECONNREFUSED 127.0.0.1:4505
```
