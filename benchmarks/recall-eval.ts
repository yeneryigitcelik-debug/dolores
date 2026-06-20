/**
 * Recall quality benchmark: measures hit@1, hit@3, hit@5 for hybrid recall
 * (pgvector + full-text, bge-small-en-v1.5) vs. full-text-only (NoOpEmbedder).
 *
 * Eval setup: 30 ground-truth memories + 170 noise memories in one isolated
 * workspace. 30 queries (10 exact, 10 paraphrase, 10 semantic) targeting the
 * ground-truth memories. A "hit" at k = expected memory ID appears in top-k.
 *
 * Run via: pnpm bench
 */

import { NoOpEmbedder, createEmbedder, recall } from "../packages/core/dist/index.js";
import type { MemoryContext } from "../packages/core/dist/index.js";
import { getPool } from "../packages/db/dist/index.js";
import type { Pool } from "../packages/db/dist/index.js";

// ---------------------------------------------------------------------------
// Ground-truth memory set
// ---------------------------------------------------------------------------

interface EvalMemory {
  label: string; // human-readable label (not stored)
  content: string;
}

const EVAL_MEMORIES: EvalMemory[] = [
  {
    label: "auth-jwt",
    content:
      "Authentication is handled via JWT tokens. Access tokens expire in 15 minutes, refresh tokens in 7 days. Both are signed with RS256.",
  },
  {
    label: "db-pool",
    content:
      "PostgreSQL connection pool uses pg-pool with max=20 connections. Connection timeout is 5 seconds. Idle connections are released after 30 seconds.",
  },
  {
    label: "redis-cache",
    content:
      "Redis is used for session caching with a 1-hour TTL. Cache keys follow the pattern user:{id}:session. Cache invalidation happens on logout.",
  },
  {
    label: "rate-limit",
    content:
      "API rate limiting is enforced at 100 requests per minute per authenticated user, 20 per minute for anonymous users. Limits are tracked in Redis with sliding window.",
  },
  {
    label: "ci-pipeline",
    content:
      "CI pipeline runs on GitHub Actions. Pull requests trigger: lint, type-check, unit tests, and integration tests. All checks must pass before merge.",
  },
  {
    label: "deployment",
    content:
      "Production deploys to AWS ECS using blue-green deployment. Rollback is automated if health checks fail within 5 minutes of deploy.",
  },
  {
    label: "rls-policy",
    content:
      "Row Level Security is enforced on all tables. Tenant isolation uses workspace_id GUC. Cross-tenant data leakage is prevented at the database layer.",
  },
  {
    label: "vector-index",
    content:
      "pgvector IVFFlat index uses lists=100 and probes=10 at query time. The index is built after 10,000 rows to ensure accuracy. Dimensions are 384 for bge-small-en-v1.5.",
  },
  {
    label: "error-handling",
    content:
      "All API errors return structured JSON: {error: string, code: string, requestId: string}. 4xx errors are user-facing, 5xx errors are logged with full stack trace.",
  },
  {
    label: "monitoring",
    content:
      "Application metrics are collected via OpenTelemetry and exported to Grafana. Alert thresholds: error rate > 1%, p99 latency > 2 seconds.",
  },
  {
    label: "secret-rotation",
    content:
      "API keys rotate every 90 days automatically via AWS Secrets Manager. Applications receive new keys 24 hours before expiry via SNS notification.",
  },
  {
    label: "gdpr-data",
    content:
      "User PII is stored only in eu-west-1 region. Data exports for GDPR requests are generated async and delivered via secure download link valid for 48 hours.",
  },
  {
    label: "webhook-retry",
    content:
      "Webhook delivery retries use exponential backoff: 1s, 5s, 30s, 2min, 10min intervals. After 5 failures the webhook endpoint is marked inactive.",
  },
  {
    label: "fulltext-search",
    content:
      "Full-text search uses Postgres tsvector with GIN index. The search configuration is 'english'. Results are ranked by ts_rank_cd with normalization.",
  },
  {
    label: "typescript-config",
    content:
      "TypeScript uses strict mode with noImplicitAny, strictNullChecks, and strictFunctionTypes. All external data is validated with Zod before use.",
  },
  {
    label: "migration-strategy",
    content:
      "Database migrations run with Prisma migrate. Breaking migrations (column drops, NOT NULL additions) require a two-phase deploy: add nullable first, then backfill, then add NOT NULL.",
  },
  {
    label: "queue-worker",
    content:
      "Background jobs use BullMQ with Redis. Job concurrency is set to 5 workers per queue. Failed jobs are retried 3 times with exponential backoff before moving to DLQ.",
  },
  {
    label: "asset-cdn",
    content:
      "Static assets are served from CloudFront CDN. Build artifacts use content-hash filenames. Cache-Control: public, max-age=31536000, immutable for hashed assets.",
  },
  {
    label: "feature-flags",
    content:
      "Feature flags are managed in LaunchDarkly. Flag evaluation happens server-side. Flag changes propagate within 30 seconds via streaming SDK.",
  },
  {
    label: "logging",
    content:
      "Structured logging uses pino. Log level is configurable via LOG_LEVEL env var. Request logs include traceId, userId, duration. Logs ship to CloudWatch.",
  },
  {
    label: "cors",
    content:
      "CORS is configured to allow requests only from *.acmepay.com and localhost:3000. Credentials are allowed. Preflight requests are cached for 86400 seconds.",
  },
  {
    label: "n-plus-one",
    content:
      "N+1 query pattern was found in the orders list endpoint. Fixed by adding a single JOIN with users table instead of a loop of individual user fetches.",
  },
  {
    label: "memory-leak",
    content:
      "Memory leak found in the WebSocket handler: event listeners were added on each reconnect but never removed. Fixed by calling socket.removeAllListeners() on disconnect.",
  },
  {
    label: "load-test",
    content:
      "Load test baseline: p50=45ms, p95=180ms, p99=450ms at 1000 RPS. Throughput degrades above 2500 RPS due to database connection pool saturation.",
  },
  {
    label: "seed-data",
    content:
      "Development database seed script creates 10 workspace accounts, 100 users, 1000 orders with randomized data. Run with: pnpm db:seed.",
  },
  {
    label: "encryption",
    content:
      "PII fields (SSN, credit card last 4) are encrypted at rest using AES-256-GCM. Encryption key is stored in AWS KMS. Key rotation happens annually.",
  },
  {
    label: "api-versioning",
    content:
      "API versioning uses URL prefix: /v1/, /v2/. Breaking changes require a new version. Deprecated versions are maintained for 6 months after successor release.",
  },
  {
    label: "pagination",
    content:
      "List endpoints use cursor-based pagination. Cursor is an encoded (id, created_at) pair. Default page size is 20, max is 100. Response includes nextCursor.",
  },
  {
    label: "health-check",
    content:
      "Health check endpoint /health returns {ok: true, db: bool, redis: bool, version: string}. Kubernetes liveness probe hits /health every 10 seconds.",
  },
  {
    label: "testing-strategy",
    content:
      "Testing pyramid: 70% unit tests (vitest), 20% integration tests (real Postgres + Redis), 10% E2E tests (Playwright). Test coverage must be above 80%.",
  },
];

// ---------------------------------------------------------------------------
// Query set (10 exact, 10 paraphrase, 10 semantic)
// ---------------------------------------------------------------------------

interface EvalCase {
  query: string;
  expectedLabel: string;
  type: "exact" | "paraphrase" | "semantic";
}

const EVAL_CASES: EvalCase[] = [
  // EXACT (query closely mirrors memory content)
  {
    query: "JWT tokens access tokens expire 15 minutes refresh tokens RS256",
    expectedLabel: "auth-jwt",
    type: "exact",
  },
  {
    query: "PostgreSQL connection pool max connections idle timeout release",
    expectedLabel: "db-pool",
    type: "exact",
  },
  {
    query: "Redis session caching TTL user id session cache invalidation logout",
    expectedLabel: "redis-cache",
    type: "exact",
  },
  {
    query: "GitHub Actions pull request lint type-check unit tests integration tests",
    expectedLabel: "ci-pipeline",
    type: "exact",
  },
  {
    query: "pgvector IVFFlat index lists probes dimensions bge-small-en-v1.5",
    expectedLabel: "vector-index",
    type: "exact",
  },
  {
    query: "Row Level Security workspace_id GUC tenant isolation cross-tenant data leakage",
    expectedLabel: "rls-policy",
    type: "exact",
  },
  {
    query: "structured logging pino LOG_LEVEL traceId userId duration CloudWatch",
    expectedLabel: "logging",
    type: "exact",
  },
  {
    query: "cursor-based pagination encoded id created_at nextCursor page size",
    expectedLabel: "pagination",
    type: "exact",
  },
  {
    query: "health check endpoint ok db redis version Kubernetes liveness probe",
    expectedLabel: "health-check",
    type: "exact",
  },
  {
    query: "BullMQ background jobs Redis concurrency workers retry exponential backoff DLQ",
    expectedLabel: "queue-worker",
    type: "exact",
  },

  // PARAPHRASE (same meaning, different words)
  {
    query: "How long do authentication tokens last before they need to be refreshed?",
    expectedLabel: "auth-jwt",
    type: "paraphrase",
  },
  {
    query: "What is the database connection limit and when do idle connections close?",
    expectedLabel: "db-pool",
    type: "paraphrase",
  },
  {
    query: "Where are user sessions stored and how long do they last?",
    expectedLabel: "redis-cache",
    type: "paraphrase",
  },
  {
    query: "What tests run automatically when a developer opens a pull request?",
    expectedLabel: "ci-pipeline",
    type: "paraphrase",
  },
  {
    query: "How does the application deploy to production and what happens if it fails?",
    expectedLabel: "deployment",
    type: "paraphrase",
  },
  {
    query: "What format do API errors use and how are server-side errors handled?",
    expectedLabel: "error-handling",
    type: "paraphrase",
  },
  {
    query: "How are application performance and error rate alerts configured?",
    expectedLabel: "monitoring",
    type: "paraphrase",
  },
  {
    query: "When do API credentials expire and how is renewal automated?",
    expectedLabel: "secret-rotation",
    type: "paraphrase",
  },
  {
    query: "Where is personally identifiable information stored to meet EU data regulations?",
    expectedLabel: "gdpr-data",
    type: "paraphrase",
  },
  {
    query: "How does the system re-attempt webhook delivery after an initial failure?",
    expectedLabel: "webhook-retry",
    type: "paraphrase",
  },

  // SEMANTIC (different vocabulary, conceptually related)
  {
    query: "What is our strategy for securing API access and preventing unauthorized requests?",
    expectedLabel: "auth-jwt",
    type: "semantic",
  },
  {
    query: "How do we prevent the database from being overwhelmed during traffic spikes?",
    expectedLabel: "db-pool",
    type: "semantic",
  },
  {
    query: "What caching strategy do we use to speed up repeated user data lookups?",
    expectedLabel: "redis-cache",
    type: "semantic",
  },
  {
    query: "How do we protect our API from being abused by excessive client requests?",
    expectedLabel: "rate-limit",
    type: "semantic",
  },
  {
    query: "What TypeScript settings enforce code quality and type safety?",
    expectedLabel: "typescript-config",
    type: "semantic",
  },
  {
    query: "How do we safely add a required column to a production database table?",
    expectedLabel: "migration-strategy",
    type: "semantic",
  },
  {
    query: "How do we distribute static files globally for fast user downloads?",
    expectedLabel: "asset-cdn",
    type: "semantic",
  },
  {
    query: "How do we gradually roll out new functionality without breaking existing users?",
    expectedLabel: "feature-flags",
    type: "semantic",
  },
  {
    query: "What was the cause and fix for the performance problem in the orders list?",
    expectedLabel: "n-plus-one",
    type: "semantic",
  },
  {
    query: "What testing approach do we use and what is the required code coverage threshold?",
    expectedLabel: "testing-strategy",
    type: "semantic",
  },
];

// ---------------------------------------------------------------------------
// Noise memory generator (unrelated content to make retrieval harder)
// ---------------------------------------------------------------------------

function generateNoise(n: number): string[] {
  const noiseTemplates = [
    (i: number) =>
      `Sprint ${i} planning meeting notes: discussed ${i * 3} story points for the next two weeks. Team velocity is ${20 + (i % 15)} points.`,
    (i: number) =>
      `Onboarding checklist item ${i}: set up local development environment with Docker Compose.`,
    (i: number) =>
      `Design review feedback for mockup ${i}: increase font size in navigation, adjust spacing in card component.`,
    (i: number) =>
      `Customer support ticket #${10000 + i}: user reports slow loading on dashboard page in Safari browser.`,
    (i: number) =>
      `Dependency update: bumped ${["axios", "lodash", "zod", "vitest", "esbuild"][i % 5]} from ${i}.${i % 10}.0 to ${i}.${(i % 10) + 1}.0.`,
    (i: number) =>
      `Office closure notice: building ${["A", "B", "C"][i % 3]} will be closed on ${["Monday", "Tuesday", "Friday"][i % 3]} for maintenance.`,
    (i: number) =>
      `Weekly standup ${i}: Alice working on auth refactor, Bob fixing pagination bug, Carol reviewing PR #${200 + i}.`,
    (i: number) =>
      `Budget approval for Q${(i % 4) + 1}: $${(i + 1) * 5000} approved for cloud infrastructure. Contact finance for PO number.`,
    (i: number) =>
      `Interview feedback for candidate ${i}: strong TypeScript skills, weak on system design. Recommend second round with technical focus.`,
    (i: number) =>
      `Conference talk submission ${i}: "Scaling Postgres at 10 million users" accepted for ${["PGConf", "NodeConf", "JSConf", "KubeCon"][i % 4]}.`,
  ];
  return Array.from({ length: n }, (_, i) => noiseTemplates[i % noiseTemplates.length](i + 100));
}

// ---------------------------------------------------------------------------
// Batch DB helpers
// ---------------------------------------------------------------------------

async function batchInsertRaw(
  pool: Pool,
  workspaceId: string,
  contents: string[],
  vectors: Array<number[] | null>,
): Promise<void> {
  const CHUNK = 200;
  for (let start = 0; start < contents.length; start += CHUNK) {
    const cBatch = contents.slice(start, start + CHUNK);
    const vBatch = vectors.slice(start, start + CHUNK);
    const vecLiterals = vBatch.map((v) => (v ? `[${v.join(",")}]` : null));

    await pool.query(
      `INSERT INTO memories (workspace_id, user_id, scope, content, importance, source, embedding)
       SELECT $1::uuid, NULL, 'personal', c, 5, NULL,
              CASE WHEN v IS NOT NULL THEN v::vector ELSE NULL END
       FROM unnest($2::text[], $3::text[]) AS u(c, v)`,
      [workspaceId, cBatch, vecLiterals],
    );
  }
}

// ---------------------------------------------------------------------------
// Recall metric helpers
// ---------------------------------------------------------------------------

function hitAtK(hits: { id: string }[], expectedId: string, k: number): boolean {
  return hits.slice(0, k).some((h) => h.id === expectedId);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export interface RecallEvalRow {
  type: "exact" | "paraphrase" | "semantic" | "ALL";
  hitAt1: number;
  hitAt3: number;
  hitAt5: number;
  n: number;
}

export interface RecallEvalResult {
  hybrid: RecallEvalRow[];
  fullTextOnly: RecallEvalRow[];
}

export async function runRecallEval(
  verbose = true,
  poolArg?: Pool,
  embedderArg?: ReturnType<typeof createEmbedder>,
): Promise<RecallEvalResult> {
  const pool = poolArg ?? getPool();
  const hybridEmbedder = embedderArg ?? createEmbedder("local", "bge-small-en-v1.5");
  const noopEmbedder = new NoOpEmbedder();

  if (!embedderArg) {
    if (verbose) console.log("  Loading local embedder (bge-small-en-v1.5)…");
    await hybridEmbedder.ready();
    if (verbose) console.log("  Embedder ready.\n");
  }

  const workspaceId = crypto.randomUUID();
  const ctx: MemoryContext = { workspaceId, userId: null };

  try {
    // 1. Embed ground-truth memories
    const gtContents = EVAL_MEMORIES.map((m) => m.content);
    if (verbose) process.stdout.write(`  Embedding ${gtContents.length} eval memories… `);
    const gtVectors = await hybridEmbedder.embed(gtContents);
    if (verbose) console.log("done.");

    // 2. Insert ground-truth memories, capture their IDs
    const gtIds: Map<string, string> = new Map(); // label → db id

    for (let i = 0; i < EVAL_MEMORIES.length; i++) {
      const label = EVAL_MEMORIES[i]?.label;
      const content = EVAL_MEMORIES[i]?.content;
      const vec = gtVectors[i];
      if (!vec) continue;
      const vecLiteral = `[${vec.join(",")}]`;
      const r = await pool.query<{ id: string }>(
        `INSERT INTO memories (workspace_id, user_id, scope, content, importance, source, embedding)
         VALUES ($1::uuid, NULL, 'personal', $2, 7, NULL, $3::vector)
         RETURNING id`,
        [workspaceId, content, vecLiteral],
      );
      const id = r.rows[0]?.id;
      if (id) gtIds.set(label, id);
    }

    if (verbose) console.log(`  Inserted ${gtIds.size} ground-truth memories.`);

    // 3. Insert noise memories (170 unrelated)
    const noiseContents = generateNoise(170);
    if (verbose) process.stdout.write(`  Embedding ${noiseContents.length} noise memories… `);
    const noiseVectors = await hybridEmbedder.embed(noiseContents);
    if (verbose) console.log("done.");
    await batchInsertRaw(pool, workspaceId, noiseContents, noiseVectors);
    if (verbose) console.log(`  Inserted ${noiseContents.length} noise memories.`);

    const total = await pool.query<{ cnt: string }>(
      "SELECT count(*) AS cnt FROM memories WHERE workspace_id = $1",
      [workspaceId],
    );
    if (verbose) console.log(`  Total memories in workspace: ${total.rows[0]?.cnt ?? "?"}.\n`);

    // 4. Run hybrid recall eval
    const hybridRaw: Record<
      "exact" | "paraphrase" | "semantic",
      { h1: number; h3: number; h5: number; n: number }
    > = {
      exact: { h1: 0, h3: 0, h5: 0, n: 0 },
      paraphrase: { h1: 0, h3: 0, h5: 0, n: 0 },
      semantic: { h1: 0, h3: 0, h5: 0, n: 0 },
    };

    for (const ec of EVAL_CASES) {
      const expectedId = gtIds.get(ec.expectedLabel);
      if (!expectedId) continue;

      const res = await recall(pool, ctx, hybridEmbedder, {
        query: ec.query,
        limit: 5,
      });
      const bucket = hybridRaw[ec.type];
      bucket.n++;
      if (hitAtK(res.hits, expectedId, 1)) bucket.h1++;
      if (hitAtK(res.hits, expectedId, 3)) bucket.h3++;
      if (hitAtK(res.hits, expectedId, 5)) bucket.h5++;
    }

    // 5. Run full-text-only recall eval
    const noopRaw: typeof hybridRaw = {
      exact: { h1: 0, h3: 0, h5: 0, n: 0 },
      paraphrase: { h1: 0, h3: 0, h5: 0, n: 0 },
      semantic: { h1: 0, h3: 0, h5: 0, n: 0 },
    };

    for (const ec of EVAL_CASES) {
      const expectedId = gtIds.get(ec.expectedLabel);
      if (!expectedId) continue;

      const res = await recall(pool, ctx, noopEmbedder, {
        query: ec.query,
        limit: 5,
      });
      const bucket = noopRaw[ec.type];
      bucket.n++;
      if (hitAtK(res.hits, expectedId, 1)) bucket.h1++;
      if (hitAtK(res.hits, expectedId, 3)) bucket.h3++;
      if (hitAtK(res.hits, expectedId, 5)) bucket.h5++;
    }

    // 6. Build result rows
    function buildRows(raw: typeof hybridRaw): RecallEvalRow[] {
      const types: Array<"exact" | "paraphrase" | "semantic"> = ["exact", "paraphrase", "semantic"];
      const rows: RecallEvalRow[] = types.map((t) => ({
        type: t,
        hitAt1: raw[t].n > 0 ? Math.round((raw[t].h1 / raw[t].n) * 100) : 0,
        hitAt3: raw[t].n > 0 ? Math.round((raw[t].h3 / raw[t].n) * 100) : 0,
        hitAt5: raw[t].n > 0 ? Math.round((raw[t].h5 / raw[t].n) * 100) : 0,
        n: raw[t].n,
      }));
      const totN = rows.reduce((s, r) => s + r.n, 0);
      const totH1 = types.reduce((s, t) => s + raw[t].h1, 0);
      const totH3 = types.reduce((s, t) => s + raw[t].h3, 0);
      const totH5 = types.reduce((s, t) => s + raw[t].h5, 0);
      rows.push({
        type: "ALL",
        hitAt1: totN > 0 ? Math.round((totH1 / totN) * 100) : 0,
        hitAt3: totN > 0 ? Math.round((totH3 / totN) * 100) : 0,
        hitAt5: totN > 0 ? Math.round((totH5 / totN) * 100) : 0,
        n: totN,
      });
      return rows;
    }

    const hybridResult = buildRows(hybridRaw);
    const noopResult = buildRows(noopRaw);

    if (verbose) {
      console.log("  ── Hybrid Recall (pgvector + full-text, bge-small-en-v1.5) ──────────");
      printRecallTable(hybridResult);
      console.log();
      console.log("  ── Full-text Only Recall (NoOpEmbedder baseline) ────────────────────");
      printRecallTable(noopResult);
    }

    return { hybrid: hybridResult, fullTextOnly: noopResult };
  } finally {
    await pool.query("DELETE FROM memories WHERE workspace_id = $1", [workspaceId]).catch(() => {
      /* ignore cleanup error */
    });
  }
}

function printRecallTable(rows: RecallEvalRow[]): void {
  console.log("  | Type        | N  | hit@1 | hit@3 | hit@5 |");
  console.log("  |-------------|----|---------|---------|---------| ");
  for (const r of rows) {
    const label = r.type === "ALL" ? "**ALL**    " : r.type.padEnd(11);
    console.log(
      `  | ${label} | ${r.n.toString().padStart(2)} | ${(`${r.hitAt1}%`).padStart(5)}   | ${(`${r.hitAt3}%`).padStart(5)}   | ${(`${r.hitAt5}%`).padStart(5)}   |`,
    );
  }
}
