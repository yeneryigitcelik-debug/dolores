/**
 * dolores benchmark runner — token savings + recall quality.
 *
 * Required env vars:
 *   DATABASE_URL='postgresql://dolores:dolores@localhost:5544/dolores'
 *   DOLORES_MODEL_CACHE='packages/core/.dolores-models'   (pre-set in package.json bench script)
 *
 * Usage:
 *   pnpm bench
 *   # or with explicit env:
 *   DATABASE_URL='postgresql://dolores:dolores@localhost:5544/dolores' pnpm bench
 */

import { createEmbedder } from "../packages/core/dist/index.js";
import { getPool } from "../packages/db/dist/index.js";
import { runRecallEval } from "./recall-eval.js";
import { runTokenSavings } from "./token-savings.js";

function hr(char = "─", width = 70): string {
  return char.repeat(width);
}

// Create shared pool and embedder for both benchmarks.
const pool = getPool();
const embedder = createEmbedder("local", "bge-small-en-v1.5");

console.log();
console.log(hr("═"));
console.log("  dolores benchmarks");
console.log(hr("═"));
console.log();
console.log("  Loading local embedder (bge-small-en-v1.5)…");
await embedder.ready();
console.log("  Embedder ready.");
// Label the active vector index so ivfflat-vs-hnsw runs are comparable (EPIC I):
// re-run `pnpm bench` with DOLORES_VECTOR_INDEX=hnsw to diff recall@k + latency.
console.log(`  Vector index: ${process.env.DOLORES_VECTOR_INDEX ?? "ivfflat"}\n`);

// ── 1. Token Savings ─────────────────────────────────────────────────────────
console.log("  [1/2] Token Savings Benchmark");
console.log(hr());
const savingsRows = await runTokenSavings(true, pool, embedder);

// ── 2. Recall Quality ────────────────────────────────────────────────────────
console.log();
console.log("  [2/2] Recall Quality Benchmark (30 eval memories + 170 noise)");
console.log(hr());
const recallResult = await runRecallEval(true, pool, embedder);

// ── Teardown ─────────────────────────────────────────────────────────────────
await embedder.dispose?.();
await pool.end();

// ── Summary ──────────────────────────────────────────────────────────────────
console.log();
console.log(hr("═"));
console.log("  SUMMARY");
console.log(hr("═"));

console.log();
console.log("  Token Savings:");
for (const r of savingsRows) {
  console.log(
    `    N=${r.n.toString().padEnd(5)} → naive=${r.naiveTokens.toLocaleString().padStart(8)} tok, dolores=${r.doloresTokens.toString().padStart(4)} tok, savings=${r.savingsPct}%`,
  );
}

const hybridAll = recallResult.hybrid.find((r) => r.type === "ALL");
const noopAll = recallResult.fullTextOnly.find((r) => r.type === "ALL");

console.log();
console.log("  Recall Quality (30 queries, 200-memory corpus):");
if (hybridAll) {
  console.log(
    `    Hybrid (pgvector+FT) hit@1=${hybridAll.hitAt1}%  hit@3=${hybridAll.hitAt3}%  hit@5=${hybridAll.hitAt5}%`,
  );
}
if (noopAll) {
  console.log(
    `    Full-text only       hit@1=${noopAll.hitAt1}%  hit@3=${noopAll.hitAt3}%  hit@5=${noopAll.hitAt5}%`,
  );
}
console.log();
console.log("  See benchmarks/RESULTS.md for detailed analysis.");
console.log();
