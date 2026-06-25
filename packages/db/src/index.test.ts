import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, withTenant } from "./index.js";

// Admin (superuser) pool — used only for migration and schema verification.
// Superusers bypass RLS, so DO NOT use this pool in isolation tests.
const ADMIN_URL = process.env.DATABASE_URL ?? "postgresql://dolores:dolores@localhost:5433/dolores";

// Application pool — non-superuser; subject to RLS policies.
// Password is taken from DOLORES_APP_PASSWORD (or 'dolores' default) to match
// whatever applyMigrations() sets on the dolores_app role.
const APP_PWD = process.env.DOLORES_APP_PASSWORD ?? "dolores";
const APP_URL = ADMIN_URL.replace(/\/\/[^:]+:[^@]+@/, `//dolores_app:${APP_PWD}@`);

let adminPool: Pool;
let appPool: Pool;
let dbAvailable = false;

beforeAll(async () => {
  adminPool = new Pool({
    connectionString: ADMIN_URL,
    connectionTimeoutMillis: 3000,
  });
  try {
    const client = await adminPool.connect();
    client.release();
    dbAvailable = true;
    // Apply migration via superuser (creates schema, roles, RLS)
    await applyMigrations(adminPool);
    // App pool for RLS tests (non-superuser)
    appPool = new Pool({
      connectionString: APP_URL,
      connectionTimeoutMillis: 3000,
    });
  } catch (err) {
    // DB not reachable — all tests will be skipped
  }
});

afterAll(async () => {
  await adminPool?.end();
  await appPool?.end();
});

function skipIfNoDb() {
  if (!dbAvailable) {
    console.warn("Skipping DB test — no database connection");
    return true;
  }
  return false;
}

describe("applyMigrations", () => {
  it("creates memories and facts tables", async () => {
    if (skipIfNoDb()) return;

    const { rows } = await adminPool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public' AND tablename IN ('memories','facts')
       ORDER BY tablename`,
    );
    expect(rows.map((r) => r.tablename)).toEqual(["facts", "memories"]);
  });

  it("memories has embedding and content_tsv columns", async () => {
    if (skipIfNoDb()) return;

    const { rows } = await adminPool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'memories'
         AND column_name IN ('embedding', 'content_tsv')
       ORDER BY column_name`,
    );
    expect(rows.map((r) => r.column_name)).toEqual(["content_tsv", "embedding"]);
  });

  it("RLS is enabled on both tables", async () => {
    if (skipIfNoDb()) return;

    const { rows } = await adminPool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relname IN ('memories','facts') AND relkind = 'r'
       ORDER BY relname`,
    );
    for (const row of rows) {
      expect(row.relrowsecurity, `RLS on ${row.relname}`).toBe(true);
      expect(row.relforcerowsecurity, `FORCE RLS on ${row.relname}`).toBe(true);
    }
  });

  it("is idempotent (can be applied twice)", async () => {
    if (skipIfNoDb()) return;
    await expect(applyMigrations(adminPool)).resolves.toBeUndefined();
  });

  it("vector index follows DOLORES_VECTOR_INDEX (hnsw opt-in, idempotent, drops the other)", async () => {
    if (skipIfNoDb()) return;
    const KEY = "DOLORES_VECTOR_INDEX";
    const saved = process.env[KEY];

    const vectorMethods = async (): Promise<string[]> => {
      const { rows } = await adminPool.query<{ method: string }>(
        `SELECT am.amname AS method
           FROM pg_class i
           JOIN pg_index ix ON ix.indexrelid = i.oid
           JOIN pg_class t  ON t.oid = ix.indrelid
           JOIN pg_am am    ON am.oid = i.relam
          WHERE t.relname = 'memories' AND am.amname IN ('ivfflat','hnsw')
          ORDER BY am.amname`,
      );
      return rows.map((r) => r.method);
    };

    try {
      // Default (ivfflat): the ivfflat index is present, hnsw absent.
      process.env[KEY] = "ivfflat";
      await applyMigrations(adminPool);
      expect(await vectorMethods()).toEqual(["ivfflat"]);

      // Switch to hnsw: hnsw built, ivfflat dropped.
      process.env[KEY] = "hnsw";
      await applyMigrations(adminPool);
      expect(await vectorMethods()).toEqual(["hnsw"]);

      // Re-apply with the same kind is a no-op (no rebuild, still just hnsw).
      await applyMigrations(adminPool);
      expect(await vectorMethods()).toEqual(["hnsw"]);
    } finally {
      // Restore the shared DB to the default ivfflat index.
      process.env[KEY] = "ivfflat";
      await applyMigrations(adminPool);
      if (saved === undefined) delete process.env[KEY];
      else process.env[KEY] = saved;
    }
  });

  it("dolores_app role exists", async () => {
    if (skipIfNoDb()) return;
    const { rows } = await adminPool.query<{ rolname: string }>(
      `SELECT rolname FROM pg_roles WHERE rolname = 'dolores_app'`,
    );
    expect(rows).toHaveLength(1);
  });
});

describe("withTenant RLS isolation (app pool — non-superuser)", () => {
  const wsA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const wsB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const userA = "cccccccc-cccc-cccc-cccc-cccccccccccc";

  beforeAll(async () => {
    if (!dbAvailable) return;
    // Clean slate for isolation tests (superuser bypasses RLS — safe to use here)
    await adminPool.query("DELETE FROM memories WHERE workspace_id IN ($1, $2)", [wsA, wsB]);
    // Seed via app pool (respects RLS)
    await withTenant(appPool, { workspaceId: wsA }, async (c) => {
      await c.query(
        `INSERT INTO memories (workspace_id, user_id, content, scope)
         VALUES ($1, NULL, 'ws-A workspace memory', 'workspace')`,
        [wsA],
      );
    });
    await withTenant(appPool, { workspaceId: wsA, userId: userA }, async (c) => {
      await c.query(
        `INSERT INTO memories (workspace_id, user_id, content, scope)
         VALUES ($1, $2, 'ws-A personal memory', 'personal')`,
        [wsA, userA],
      );
    });
    await withTenant(appPool, { workspaceId: wsB }, async (c) => {
      await c.query(
        `INSERT INTO memories (workspace_id, user_id, content, scope)
         VALUES ($1, NULL, 'ws-B workspace memory', 'workspace')`,
        [wsB],
      );
    });
  });

  it("workspace A cannot see workspace B rows", async () => {
    if (skipIfNoDb()) return;

    const { rows } = await withTenant(appPool, { workspaceId: wsA }, (c) =>
      c.query<{ content: string }>("SELECT content FROM memories"),
    );
    const contents = rows.map((r) => r.content);
    expect(contents.some((c) => c.includes("ws-B"))).toBe(false);
    expect(contents.some((c) => c.includes("ws-A"))).toBe(true);
  });

  it("workspace-only context hides personal rows", async () => {
    if (skipIfNoDb()) return;

    // No userId → workspace-level: only user_id IS NULL rows visible
    const { rows } = await withTenant(appPool, { workspaceId: wsA }, (c) =>
      c.query<{ content: string }>("SELECT content FROM memories"),
    );
    const contents = rows.map((r) => r.content);
    expect(contents.some((c) => c.includes("personal"))).toBe(false);
    expect(contents.some((c) => c.includes("workspace"))).toBe(true);
  });

  it("user context sees both personal and workspace-level rows", async () => {
    if (skipIfNoDb()) return;

    const { rows } = await withTenant(appPool, { workspaceId: wsA, userId: userA }, (c) =>
      c.query<{ content: string }>("SELECT content FROM memories"),
    );
    const contents = rows.map((r) => r.content);
    expect(contents.some((c) => c.includes("ws-A workspace"))).toBe(true);
    expect(contents.some((c) => c.includes("ws-A personal"))).toBe(true);
  });

  it("no GUC set → zero rows visible (app pool)", async () => {
    if (skipIfNoDb()) return;

    // Direct query without withTenant — GUCs unset → workspace_id = NULL → no rows
    const client = await appPool.connect();
    try {
      const { rows } = await client.query("SELECT id FROM memories");
      expect(rows).toHaveLength(0);
    } finally {
      client.release();
    }
  });
});

describe("decay functions (SECURITY DEFINER — bypasses FORCE RLS)", () => {
  // Isolated workspace UUID used only by these tests; cleaned up after.
  const wsDecay = "f0000000-deca-deca-deca-000000000000";

  afterAll(async () => {
    if (!dbAvailable) return;
    await adminPool.query("DELETE FROM memories WHERE workspace_id = $1", [wsDecay]);
  });

  it("dolores_soften_memories() reduces importance of stale rows (no GUC needed)", async () => {
    if (skipIfNoDb()) return;

    // Insert a stale memory directly via superuser (bypasses RLS for test setup)
    const {
      rows: [inserted],
    } = await adminPool.query<{ id: string }>(
      `INSERT INTO memories (workspace_id, content, importance, last_accessed)
       VALUES ($1, 'decay-test stale memory', 5, now() - INTERVAL '60 days')
       RETURNING id`,
      [wsDecay],
    );

    // Call SECURITY DEFINER function — runs as owning superuser, bypasses FORCE RLS.
    // No dolores.workspace_id GUC is set, which is exactly the pg_cron scenario.
    await adminPool.query("SELECT dolores_soften_memories()");

    const {
      rows: [updated],
    } = await adminPool.query<{ importance: number }>(
      "SELECT importance FROM memories WHERE id = $1",
      [inserted.id],
    );
    // importance must have dropped from 5 → 4
    expect(updated.importance).toBe(4);
  });

  it("dolores_app connects with password from DOLORES_APP_PASSWORD (or default)", async () => {
    if (skipIfNoDb()) return;
    // If appPool connects successfully, applyMigrations set the correct password.
    const client = await appPool.connect();
    try {
      const { rows } = await client.query<{ current_user: string }>("SELECT current_user");
      expect(rows[0]?.current_user).toBe("dolores_app");
    } finally {
      client.release();
    }
  });
});
