/**
 * Token-savings benchmark: NAIVE (dump all memories) vs DOLORES (hybrid recall).
 *
 * Uses the admin DATABASE_URL (dolores role, BYPASSRLS) for all operations.
 * Cleanup is guaranteed via finally blocks keyed on isolated workspace UUIDs.
 *
 * Run via: pnpm bench  (or see benchmarks/run.ts)
 */

import { buildContext, createEmbedder, tokenEstimate } from "../packages/core/dist/index.js";
import { getPool } from "../packages/db/dist/index.js";
import type { Pool } from "../packages/db/dist/index.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SCALES = [100, 500, 1000, 1500];
const DOLORES_MAX_TOKENS = 600;
const EMBED_BATCH = 64; // memories per embed call
const INSERT_BATCH = 200; // memories per DB batch insert

// Representative query used for DOLORES context building at every scale.
const BENCH_QUERY = "API authentication, JWT tokens, and security configuration best practices";

// ---------------------------------------------------------------------------
// Synthetic memory generator
// ---------------------------------------------------------------------------

const TEMPLATES: ReadonlyArray<(i: number) => string> = [
  (i) =>
    `Authentication uses JWT tokens with ${30 + (i % 20)} minute expiry. Refresh tokens are stored in HttpOnly cookies.`,
  (i) =>
    `Database connection pool is configured with max ${10 + (i % 30)} connections. Idle timeout is ${30 + (i % 30)} seconds.`,
  (i) =>
    `The ${["payments", "orders", "inventory", "users", "notifications"][i % 5]} service uses event sourcing for audit trails.`,
  (i) =>
    `API rate limiting: ${100 + i * 2} requests per minute per IP. Exceeded requests return HTTP 429 with Retry-After header.`,
  (i) =>
    `Cache TTL for ${["user profiles", "product listings", "search results", "session data", "config"][i % 5]} is set to ${60 + i * 3} seconds.`,
  (i) =>
    `CI pipeline runs on ${["GitHub Actions", "GitLab CI", "CircleCI", "Jenkins", "Buildkite"][i % 5]}. Tests must pass before merge.`,
  (i) =>
    `Deployment target is ${["AWS ECS", "GCP Cloud Run", "Azure AKS", "Fly.io", "Railway"][i % 5]}. Blue-green strategy for zero downtime.`,
  (i) =>
    "TypeScript strict mode is enabled. No implicit any. All external API responses validated with Zod schemas.",
  (i) =>
    `Feature flag ${`FLAG_${i.toString().padStart(4, "0")}`} controls the new ${["checkout", "search", "dashboard", "analytics", "reporting"][i % 5]} flow.`,
  (i) =>
    `Memory leak detected in ${["WebSocket", "EventEmitter", "setInterval", "Promise chain", "Redux store"][i % 5]} handler. Fixed by adding cleanup in useEffect.`,
  (i) =>
    `Postgres index on (workspace_id, created_at DESC) speeds up paginated ${["memory", "order", "event", "audit", "notification"][i % 5]} queries by ~${20 + i * 2}x.`,
  (i) =>
    `GDPR compliance: user data in EU region must stay in ${["eu-west-1", "eu-central-1", "eu-north-1"][i % 3]}. Cross-region replication is disabled.`,
  (i) =>
    `Error budget: SLO is ${99 + (i % 2) * 0.9}% uptime. Remaining budget this month: ${100 - (i % 50)}%.`,
  (i) =>
    `Webhook delivery uses exponential backoff: ${[1, 5, 30, 120, 600][i % 5]} second intervals. Max ${3 + (i % 5)} retries.`,
  (i) =>
    `pgvector index type: IVFFlat with lists=${100 + (i % 5) * 10}. Probes set to ${5 + (i % 5) * 2} for recall/latency tradeoff.`,
  (i) =>
    `The ${["admin", "billing", "support", "analytics", "reporting"][i % 5]} dashboard is server-side rendered with Next.js App Router.`,
  (i) =>
    `Secret rotation: API keys expire after ${30 + (i % 60)} days. Automated rotation via ${["Vault", "AWS Secrets Manager", "GCP Secret Manager"][i % 3]}.`,
  (i) =>
    `Load test baseline: p95 latency ${50 + (i % 100)}ms at ${500 + i * 10} RPS. Throughput drops above ${2000 + i * 50} RPS.`,
  (i) =>
    `Monorepo managed with pnpm workspaces. Package ${`@acme/pkg-${i.toString().padStart(3, "0")}`} is a shared utility library.`,
  (i) =>
    `Observability stack: ${["Datadog", "Grafana+Prometheus", "New Relic", "OpenTelemetry", "Honeycomb"][i % 5]}. Alert threshold: error rate > ${0.1 + (i % 10) * 0.05}%.`,
];

function generateContents(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(TEMPLATES[i % TEMPLATES.length](i));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Batch DB helpers
// ---------------------------------------------------------------------------

async function batchInsert(
  pool: Pool,
  workspaceId: string,
  contents: string[],
  vectors: number[][],
): Promise<void> {
  // Process in INSERT_BATCH-sized chunks to stay within Postgres limits.
  for (let start = 0; start < contents.length; start += INSERT_BATCH) {
    const cBatch = contents.slice(start, start + INSERT_BATCH);
    const vBatch = vectors.slice(start, start + INSERT_BATCH);
    const vecLiterals = vBatch.map((v) => `[${v.join(",")}]`);

    await pool.query(
      `INSERT INTO memories (workspace_id, user_id, scope, content, importance, source, embedding)
       SELECT $1::uuid, NULL, 'personal', c, 5, NULL, v::vector
       FROM unnest($2::text[], $3::text[]) AS u(c, v)`,
      [workspaceId, cBatch, vecLiterals],
    );
  }
}

async function countMemories(pool: Pool, workspaceId: string): Promise<number> {
  const r = await pool.query<{ cnt: string }>(
    "SELECT count(*) AS cnt FROM memories WHERE workspace_id = $1",
    [workspaceId],
  );
  return Number(r.rows[0]?.cnt ?? 0);
}

async function cleanup(pool: Pool, workspaceId: string): Promise<void> {
  await pool.query("DELETE FROM memories WHERE workspace_id = $1", [workspaceId]);
}

// ---------------------------------------------------------------------------
// ASCII bar chart
// ---------------------------------------------------------------------------

function bar(value: number, max: number, width = 30): string {
  const filled = Math.round((value / max) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export interface TokenSavingsRow {
  n: number;
  naiveTokens: number;
  doloresTokens: number;
  savingsPct: number;
}

export async function runTokenSavings(
  verbose = true,
  poolArg?: Pool,
  embedderArg?: ReturnType<typeof createEmbedder>,
): Promise<TokenSavingsRow[]> {
  const pool = poolArg ?? getPool();
  const embedder = embedderArg ?? createEmbedder("local", "bge-small-en-v1.5");

  if (!embedderArg) {
    if (verbose) console.log("  Loading local embedder (bge-small-en-v1.5)…");
    await embedder.ready();
    if (verbose) console.log("  Embedder ready.\n");
  }

  const results: TokenSavingsRow[] = [];

  for (const N of SCALES) {
    const workspaceId = crypto.randomUUID();
    if (verbose) process.stdout.write(`  N=${N.toString().padStart(5)}: loading… `);

    try {
      const contents = generateContents(N);

      // Embed all contents in batches of EMBED_BATCH
      const allVectors: number[][] = [];
      for (let i = 0; i < contents.length; i += EMBED_BATCH) {
        const batch = contents.slice(i, i + EMBED_BATCH);
        const vecs = await embedder.embed(batch);
        allVectors.push(...vecs);
      }

      // Batch insert into isolated workspace
      await batchInsert(pool, workspaceId, contents, allVectors);
      const cnt = await countMemories(pool, workspaceId);
      if (verbose) process.stdout.write(`inserted ${cnt} → `);

      // NAIVE: sum of all content tokens (what LLM gets if you dump everything)
      const naiveTokens = contents.reduce((sum, c) => sum + tokenEstimate(c), 0);

      // DOLORES: buildContext with a representative query (default 600-token budget)
      const ctx = { workspaceId, userId: null };
      const built = await buildContext(pool, ctx, DOLORES_MAX_TOKENS, BENCH_QUERY, embedder);
      const doloresTokens = built.tokenEstimate;

      const savingsPct = Math.round(((naiveTokens - doloresTokens) / naiveTokens) * 100);
      results.push({ n: N, naiveTokens, doloresTokens, savingsPct });

      if (verbose)
        console.log(
          `naive=${naiveTokens.toLocaleString()} tok | dolores=${doloresTokens} tok | savings=${savingsPct}%`,
        );
    } finally {
      await cleanup(pool, workspaceId);
    }
  }

  if (verbose) {
    console.log("\n  ── Token Savings Table ─────────────────────────────────────");
    console.log("  | N      | Naive (tok) | Dolores (tok) | Savings % |");
    console.log("  |--------|-------------|---------------|-----------|");
    for (const r of results) {
      console.log(
        `  | ${r.n.toString().padEnd(6)} | ${r.naiveTokens.toLocaleString().padStart(11)} | ${r.doloresTokens.toString().padStart(13)} | ${r.savingsPct.toString().padStart(8)}% |`,
      );
    }

    const maxNaive = Math.max(...results.map((r) => r.naiveTokens));
    console.log("\n  ── ASCII Bar Chart: Naive vs Dolores Tokens ─────────────────");
    for (const r of results) {
      const label = `N=${r.n}`.padEnd(7);
      console.log(
        `  ${label} NAIVE   ${bar(r.naiveTokens, maxNaive)} ${r.naiveTokens.toLocaleString()} tok`,
      );
      console.log(
        `  ${"".padEnd(7)} DOLORES ${bar(r.doloresTokens, maxNaive)} ${r.doloresTokens} tok`,
      );
      console.log();
    }
  }

  return results;
}
