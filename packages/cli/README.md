# @dolores/cli

Command-line interface for the dolores agent memory system. Provides `dolores init`, `dolores remember`, `dolores recall`, `dolores context`, and `dolores ingest` commands that talk to the dolores daemon over localhost HTTP.

Install globally and use from any terminal once the daemon is running.

```bash
npm i -g @dolores/cli
dolores init       # set up Postgres schema
dolores remember "We deploy on Hetzner."
dolores recall "where is production?"
```

## Korumalı daemon bağlantısı

Daemon'da `DOLORES_AUTH_TOKEN` tanımlıysa CLI sürecine de aynı değeri ver. CLI hem okuma hem yazma isteklerinde Bearer başlığını gönderir. Token tanımlanmamış yerel kurulumlar aynı şekilde çalışır.

Bearer token daemon bağlantısına erişimi sınırlar. `DOLORES_WORKSPACE_ID` ve `DOLORES_USER_ID` güvenilen istemcinin seçtiği hafıza bağlamıdır; token bu kimlikleri kullanıcı hesabına bağlamaz.

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `DOLORES_DAEMON_HOST` | `127.0.0.1` | Yalnız hostname veya IP; `::1` ve `[::1]` desteklenir. URL/protokol/kimlik bilgisi verilmez. |
| `DOLORES_DAEMON_PORT` | `4505` | Daemon portu |
| `DOLORES_AUTH_TOKEN` | (boş) | Daemon ile aynı Bearer token |
| `DOLORES_REQUEST_TIMEOUT_MS` | `60000` | İstek ve yanıt gövdesi için toplam süre sınırı; 1–3600000 ms |

Örnek IPv6 bağlantısı: `DOLORES_DAEMON_HOST=::1 dolores status`.

Uzun süren `consolidate` gibi işler için süre sınırı artırılabilir. Zaman aşımında CLI isteği kendiliğinden tekrarlamaz; daemon işlemi tamamlamış olabileceğinden bir yazma isteğini yeniden göndermeden önce sonucu kontrol et. Token hata mesajlarından gizlenir ve URL'ye eklenmez.

→ See the [root README](https://github.com/yeneryigitcelik-debug/dolores#readme) for full documentation and quick start.
