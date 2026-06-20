import pg from "pg";
/**
 * Integration test: concurrent remember() calls must not produce near-duplicate rows.
 * Requires a live DB: set DOLORES_APP_DATABASE_URL (dolores_app, RLS-enforced) and
 * DATABASE_URL (superuser) pointing to localhost:5544.
 *
 * remember() runs as dolores_app under RLS (withTenant sets the tenant GUC per tx).
 * Verification queries (count) and cleanup, however, must BYPASS RLS — they run
 * outside a tenant transaction, so dolores_app would see zero rows. We use the
 * superuser admin pool (DATABASE_URL) for those.
 *
 * Coordination note: uses an isolated workspace UUID (0000...0cc1) and cleans up
 * after each test so parallel helper agents / re-runs don't interfere.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Embedder, MemoryContext } from "../types.js";
import { remember } from "./remember.js";

// App connection (RLS-enforced) for remember(); admin (superuser) for verification.
const APP_URL = process.env.DOLORES_APP_DATABASE_URL ?? "";
const ADMIN_URL = process.env.DATABASE_URL ?? "";

// Isolated workspace: never collides with other helpers.
const TEST_WORKSPACE = "00000000-0000-0000-0000-00000000cc01";

const liveIt = APP_URL && ADMIN_URL ? it : it.skip;

describe("concurrent remember dedup", () => {
  let pool: pg.Pool;
  let admin: pg.Pool;

  beforeAll(async () => {
    if (!APP_URL || !ADMIN_URL) return;
    pool = new pg.Pool({ connectionString: APP_URL, max: 5 });
    admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
    // Clean slate — a prior failed run (or an older RLS-broken cleanup) may have
    // left rows in this workspace that would skew the similarity dedup.
    await admin.query("DELETE FROM memories WHERE workspace_id = $1", [TEST_WORKSPACE]);
  });

  afterEach(async () => {
    if (!APP_URL || !ADMIN_URL) return;
    // Cleanup via superuser (bypasses RLS) so it actually deletes the rows.
    await admin.query("DELETE FROM memories WHERE workspace_id = $1", [TEST_WORKSPACE]);
  });

  afterAll(async () => {
    if (!APP_URL || !ADMIN_URL) return;
    await pool.end();
    await admin.end();
  });

  /** Count this workspace's rows with RLS bypassed (superuser). */
  async function countRows(): Promise<number> {
    const res = await admin.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM memories WHERE workspace_id = $1",
      [TEST_WORKSPACE],
    );
    return Number(res.rows[0]?.count);
  }

  liveIt(
    "two concurrent remember() calls with the same content produce exactly one row",
    async () => {
      const ctx: MemoryContext = { workspaceId: TEST_WORKSPACE, userId: null };
      // Same fixed 384-dim vector for both → cosine similarity 1.0 → must dedup.
      const embedder: Embedder = {
        id: "fake-same",
        dim: 384,
        ready: async () => {},
        embed: async (texts: string[]) => texts.map(() => Array.from({ length: 384 }, () => 0.5)),
      };

      // Both calls hit the DB at the same time. The advisory lock serializes dedup:
      // the second waits, then finds the first's row and returns deduped=true.
      const [r1, r2] = await Promise.all([
        remember(pool, ctx, embedder, { content: "concurrent test memory alpha", importance: 5 }),
        remember(pool, ctx, embedder, { content: "concurrent test memory alpha", importance: 5 }),
      ]);

      expect(r1).toBeDefined();
      expect(r2).toBeDefined();

      // Exactly one of the two must have deduped the other.
      const dedupedCount = [r1.deduped, r2.deduped].filter(Boolean).length;
      expect(dedupedCount).toBe(1);

      // Both resolve to the same surviving row id.
      expect(r1.id).toBe(r2.id);

      expect(await countRows()).toBe(1);
    },
    15_000,
  );

  liveIt(
    "two concurrent remember() calls with distinct content produce two rows",
    async () => {
      const ctx: MemoryContext = { workspaceId: TEST_WORKSPACE, userId: null };
      // Two orthogonal 384-dim unit vectors → cosine similarity 0 → no dedup.
      let embedCallIdx = 0;
      const embedder: Embedder = {
        id: "fake-distinct",
        dim: 384,
        ready: async () => {},
        embed: async (texts: string[]) =>
          texts.map(() => {
            const vec = Array.from({ length: 384 }, () => 0.0);
            vec[embedCallIdx % 384] = 1.0;
            embedCallIdx++;
            return vec;
          }),
      };

      await Promise.all([
        remember(pool, ctx, embedder, { content: "distinct memory A", importance: 5 }),
        remember(pool, ctx, embedder, { content: "distinct memory B", importance: 5 }),
      ]);

      expect(await countRows()).toBe(2);
    },
    15_000,
  );
});
