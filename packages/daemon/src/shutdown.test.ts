import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Regression test for the native shutdown crash.
 *
 * BUG: on SIGTERM/SIGINT the daemon ran graceful shutdown correctly but then
 * called `process.exit(0)`, which force-ran onnxruntime-node's native static
 * destructors while its thread pool was in an invalid state — aborting with
 * "libc++abi: terminating … mutex lock failed: Invalid argument" (SIGABRT,
 * exit 134). Process managers count exit != 0 as a crash → restart loops.
 *
 * FIX: drain the event loop naturally instead of force-exiting, so the local
 * (fastembed/onnxruntime) embedder is never torn down by process.exit().
 *
 * This only reproduces with the LOCAL embedder (NoOp can't crash), so the test
 * spawns the BUILT daemon with DOLORES_EMBEDDER=local. It needs the model cached
 * offline + a current dist build; it self-skips otherwise so CI without the
 * model never flakes. No DB is required: the daemon boots/listens lazily and
 * neither /health nor shutdown touch Postgres.
 */

const DIST_ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const MODEL_CACHE = fileURLToPath(new URL("../.dolores-models", import.meta.url));

const CAN_RUN = existsSync(DIST_ENTRY) && existsSync(MODEL_CACHE);

interface ShutdownOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
}

/** Boot the built daemon, wait for /health, send `signal`, resolve its exit. */
async function bootThenSignal(signal: "SIGTERM" | "SIGINT"): Promise<ShutdownOutcome> {
  const port = 4520 + (signal === "SIGTERM" ? 0 : 1);
  const child = spawn(process.execPath, [DIST_ENTRY], {
    env: {
      ...process.env,
      // Force the native embedder — the only kind that can trigger the crash.
      DOLORES_EMBEDDER: "local",
      DOLORES_EMBED_MODEL: "bge-small-en-v1.5",
      DOLORES_DAEMON_PORT: String(port),
      DOLORES_DAEMON_HOST: "127.0.0.1",
      // Pool is lazy; a dummy URL is enough since nothing queries during the test.
      DATABASE_URL:
        process.env.DOLORES_APP_DATABASE_URL ??
        process.env.DATABASE_URL ??
        "postgresql://noop:noop@127.0.0.1:5432/noop",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (b: Buffer) => {
    output += b.toString();
  });
  child.stderr.on("data", (b: Buffer) => {
    output += b.toString();
  });

  const exited = new Promise<ShutdownOutcome>((resolve) => {
    child.on("exit", (code, sig) => resolve({ code, signal: sig, output }));
  });

  // Wait for the daemon to be listening, then signal it.
  const deadline = Date.now() + 40_000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (output.includes("listening on")) {
      healthy = true;
      break;
    }
    if (child.exitCode !== null) break; // died early
    await new Promise((r) => setTimeout(r, 200));
  }
  expect(healthy, `daemon never became ready. output:\n${output}`).toBe(true);

  child.kill(signal);
  return exited;
}

describe.skipIf(!CAN_RUN)("daemon native shutdown (local embedder)", () => {
  it("exits 0 with no libc++abi crash on SIGTERM", async () => {
    const { code, signal, output } = await bootThenSignal("SIGTERM");
    expect(output).toContain("shutdown complete");
    expect(output).not.toMatch(/libc\+\+abi|mutex lock failed|terminating due to uncaught/);
    expect(signal).toBeNull();
    expect(code).toBe(0);
  }, 60_000);

  it("exits 0 with no libc++abi crash on SIGINT", async () => {
    const { code, signal, output } = await bootThenSignal("SIGINT");
    expect(output).toContain("shutdown complete");
    expect(output).not.toMatch(/libc\+\+abi|mutex lock failed|terminating due to uncaught/);
    expect(signal).toBeNull();
    expect(code).toBe(0);
  }, 60_000);
});
