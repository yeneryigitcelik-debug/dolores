# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Report via [GitHub Security Advisories](https://github.com/yeneryigitcelik-debug/dolores/security/advisories/new) — click **"Report a vulnerability"** on the Security tab. You will receive a response within 5 business days. If the issue is confirmed, a fix will be coordinated before public disclosure.

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.x (current `main`) | Yes |

dolores is currently pre-1.0. Security patches are applied to the latest commit on `main`; there are no backport branches.

## Self-hosted deployment notes

dolores is designed to run entirely within your own infrastructure. A few points relevant to operators:

**Row-Level Security.** The daemon connects to Postgres as the `dolores_app` role (non-superuser). RLS policies enforce `workspace_id` isolation at the database level — cross-tenant reads are structurally prevented, not just application-enforced. Do not configure the daemon with a superuser connection string in production, as superusers bypass RLS even with `FORCE ROW LEVEL SECURITY`.

**Secrets.** `DATABASE_URL` and `DOLORES_APP_DATABASE_URL` contain credentials. Do not commit them to source control. Use environment injection (Docker secrets, a `.env` file that is `.gitignore`-d, or a secrets manager).

**Network exposure.** The daemon listens on `127.0.0.1` by default. Do not expose it to the public internet without an authenticated reverse proxy. The Postgres port should be bound to `localhost` only (`127.0.0.1:5433:5432` in compose) or kept on an isolated Docker network — not published to `0.0.0.0`.

**Embeddings.** Local embeddings (fastembed/bge-small) run entirely on-device; no data is sent to external services. If you configure an OpenAI embedder, your memory content is sent to the OpenAI API.

**No raw transcripts.** dolores stores only distilled facts and memories, never full conversation logs. This limits exposure if the database is compromised.
