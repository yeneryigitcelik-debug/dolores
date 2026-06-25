#!/usr/bin/env node
/**
 * Dependency-free load test for the dolores daemon (EPIC K).
 *
 * Drives /recall (and optionally /remember) at a fixed concurrency for a fixed
 * duration, then reports p50/p95/p99 latency, throughput, and error rate. Uses
 * only Node's global fetch — no external packages.
 *
 * The daemon must already be running. Usage:
 *   node scripts/loadtest.mjs
 *
 * Env:
 *   DOLORES_DAEMON_HOST / DOLORES_DAEMON_PORT  (default 127.0.0.1 / 4505)
 *   DOLORES_WORKSPACE_ID                       (default the fixed local workspace)
 *   DOLORES_AUTH_TOKEN                         (sent as Bearer if set)
 *   LOADTEST_DURATION_MS (10000)  LOADTEST_CONCURRENCY (20)
 *   LOADTEST_OP (recall | remember | mixed, default recall)
 */

const HOST = process.env.DOLORES_DAEMON_HOST ?? "127.0.0.1";
const PORT = process.env.DOLORES_DAEMON_PORT ?? "4505";
const BASE = `http://${HOST}:${PORT}`;
const WS = process.env.DOLORES_WORKSPACE_ID ?? "00000000-0000-0000-0000-000000000001";
const TOKEN = process.env.DOLORES_AUTH_TOKEN;
const DURATION = Number(process.env.LOADTEST_DURATION_MS ?? 10000);
const CONCURRENCY = Number(process.env.LOADTEST_CONCURRENCY ?? 20);
const OP = process.env.LOADTEST_OP ?? "recall";

const headers = {
  "content-type": "application/json",
  ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
};

async function post(path, body) {
  const t0 = performance.now();
  let ok = false;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    ok = res.ok || res.status === 202;
    await res.text();
  } catch {
    ok = false;
  }
  return { ms: performance.now() - t0, ok };
}

const QUERIES = [
  "deployment schedule",
  "database connection pool",
  "auth tokens expiry",
  "rate limit policy",
  "cache ttl invalidation",
];
let qi = 0;

function nextOp() {
  const op = OP === "mixed" ? (Math.random() < 0.2 ? "remember" : "recall") : OP;
  if (op === "remember") {
    return post("/remember", {
      workspaceId: WS,
      content: `load memory ${Date.now()}-${Math.random()}`,
      importance: 5,
    });
  }
  const query = QUERIES[qi++ % QUERIES.length];
  return post("/recall", { workspaceId: WS, query, limit: 5 });
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1),
  );
  return sortedAsc[idx];
}

async function main() {
  // Preflight: daemon reachable?
  try {
    const res = await fetch(`${BASE}/health`);
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch (err) {
    console.error(`Daemon not reachable at ${BASE} (${err.message}). Start it first.`);
    process.exit(1);
  }

  // Seed some memories so /recall has data to return.
  console.log("Seeding 20 memories…");
  for (let i = 0; i < 20; i++) {
    await post("/remember", {
      workspaceId: WS,
      content: `seed ${i}: deployment database auth rate cache config token schedule ttl pool policy`,
      importance: 5,
    });
  }

  console.log(`Load test: op=${OP} concurrency=${CONCURRENCY} duration=${DURATION}ms → ${BASE}\n`);
  const latencies = [];
  let errors = 0;
  const deadline = Date.now() + DURATION;

  async function worker() {
    while (Date.now() < deadline) {
      const { ms, ok } = await nextOp();
      latencies.push(ms);
      if (!ok) errors++;
    }
  }
  const started = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  const elapsedSec = (Date.now() - started) / 1000;

  latencies.sort((a, b) => a - b);
  const total = latencies.length;
  const rps = total / elapsedSec;
  const fmt = (n) => n.toFixed(1);

  console.log("─".repeat(50));
  console.log(`  requests     ${total}  (${fmt(rps)} req/s)`);
  console.log(`  errors       ${errors}  (${fmt((errors / total) * 100)}%)`);
  console.log(`  latency p50  ${fmt(percentile(latencies, 50))} ms`);
  console.log(`  latency p95  ${fmt(percentile(latencies, 95))} ms`);
  console.log(`  latency p99  ${fmt(percentile(latencies, 99))} ms`);
  console.log(`  latency max  ${fmt(latencies[total - 1] ?? 0)} ms`);
  console.log("─".repeat(50));
}

main();
