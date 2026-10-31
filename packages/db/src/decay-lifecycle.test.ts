import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AGGRESSIVE_DECAY_JOB_NAME,
  applyMigrations,
  disableAggressiveDecay,
  enableAggressiveDecay,
  withTenant,
} from "./index.js";

/**
 * Disposable PG17 integration tests. They run ONLY when DOLORES_TEST_PG_URL is
 * set explicitly to a superuser URL of a throwaway Docker PG17 (pgvector +
 * pg_cron). There is intentionally NO default URL — nothing connects implicitly.
 *
 * For the alternate-database-name check point the URL at a database NOT named
 * "dolores" and start the server with `-c cron.database_name=<that db>`
 * (pg_cron can only be installed into its configured database).
 */
const TEST_URL = process.env.DOLORES_TEST_PG_URL ?? "";
const ENABLED = TEST_URL.length > 0;
const DB_NAME = ENABLED ? decodeURIComponent(new URL(TEST_URL).pathname.replace(/^\//, "")) : "";
const APP_PWD = process.env.DOLORES_APP_PASSWORD ?? "dolores";

function appUrl(): string {
  const u = new URL(TEST_URL);
  u.username = "dolores_app";
  u.password = APP_PWD;
  return u.toString();
}

interface SeedRow {
  ws: string;
  content: string;
  importance: number;
  ageDays: number;
  supersededBy?: string;
  validToAgeDays?: number;
}

interface RowDigest {
  id: string;
  digest: string;
}

interface CronRow {
  jobid: string;
  jobname: string | null;
  schedule: string;
  command: string;
  active: boolean;
}

interface ChainIds {
  terminal: string;
  predecessor: string;
  leaf: string;
}

describe.skipIf(!ENABLED)("db lifecycle on disposable PG (DOLORES_TEST_PG_URL)", () => {
  let admin: Pool;
  const wsChain = randomUUID();
  const wsOther = randomUUID();
  const wsCron = randomUUID();
  const wsRlsA = randomUUID();
  const wsRlsB = randomUUID();
  const allWs = [wsChain, wsOther, wsCron, wsRlsA, wsRlsB];

  async function insertMemory(r: SeedRow): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO memories (workspace_id, content, importance, last_accessed, superseded_by, valid_to)
       VALUES ($1, $2, $3, now() - make_interval(days => $4::int), $5::uuid,
               CASE WHEN $6::int IS NULL THEN NULL ELSE now() - make_interval(days => $6::int) END)
       RETURNING id::text AS id`,
      [r.ws, r.content, r.importance, r.ageDays, r.supersededBy ?? null, r.validToAgeDays ?? null],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("seed insert returned no id");
    return id;
  }

  async function snapshot(ws: string[]): Promise<RowDigest[]> {
    const { rows } = await admin.query<RowDigest>(
      `SELECT m.id::text AS id, md5(m::text) AS digest
         FROM memories m
        WHERE m.workspace_id = ANY($1::uuid[])
        ORDER BY m.id`,
      [ws],
    );
    return rows;
  }

  async function cronJobs(): Promise<CronRow[]> {
    const { rows } = await admin.query<CronRow>(
      `SELECT jobid::text AS jobid, jobname, schedule, command, active
         FROM cron.job
        WHERE database = current_database()
        ORDER BY jobid`,
    );
    return rows;
  }

  async function seedChain(): Promise<ChainIds> {
    // B: newest version of a chain, stale + low importance (old criteria match).
    const terminal = await insertMemory({
      ws: wsChain,
      content: "chain terminal B (stale, referenced)",
      importance: 1,
      ageDays: 120,
    });
    // A: superseded by B, valid_to set.
    const predecessor = await insertMemory({
      ws: wsChain,
      content: "chain predecessor A",
      importance: 5,
      ageDays: 0,
      supersededBy: terminal,
      validToAgeDays: 100,
    });
    // C: unreferenced expired leaf — must still be deleted.
    const leaf = await insertMemory({
      ws: wsChain,
      content: "expired unreferenced leaf C",
      importance: 1,
      ageDays: 120,
    });
    await insertMemory({ ws: wsOther, content: "other tenant recent", importance: 5, ageDays: 0 });
    await insertMemory({
      ws: wsOther,
      content: "other tenant low but fresh",
      importance: 2,
      ageDays: 10,
    });
    return { terminal, predecessor, leaf };
  }

  async function expectChainOutcome(ids: ChainIds, otherBefore: RowDigest[]): Promise<void> {
    const { rows } = await admin.query<{
      id: string;
      superseded_by: string | null;
      has_valid_to: boolean;
    }>(
      `SELECT id::text AS id, superseded_by::text AS superseded_by, valid_to IS NOT NULL AS has_valid_to
         FROM memories
        WHERE id = ANY($1::uuid[])`,
      [[ids.terminal, ids.predecessor, ids.leaf]],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.has(ids.leaf)).toBe(false);
    expect(byId.has(ids.terminal)).toBe(true);
    expect(byId.get(ids.predecessor)).toEqual({
      id: ids.predecessor,
      superseded_by: ids.terminal,
      has_valid_to: true,
    });
    expect(await snapshot([wsOther])).toEqual(otherBefore);
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: TEST_URL, connectionTimeoutMillis: 5000 });
    await applyMigrations(admin);
  });

  afterAll(async () => {
    await admin.query("DELETE FROM memories WHERE workspace_id = ANY($1::uuid[])", [allWs]);
    await disableAggressiveDecay(admin);
    await admin.end();
  });

  it.skipIf(DB_NAME === "dolores" || DB_NAME === "")(
    "migrates a database with an alternate name and grants CONNECT on it",
    async () => {
      const { rows } = await admin.query<{ db: string; granted: boolean }>(
        `SELECT current_database() AS db,
                EXISTS (
                  SELECT 1
                    FROM pg_database d, aclexplode(d.datacl) a
                   WHERE d.datname = current_database()
                     AND a.grantee = 'dolores_app'::regrole
                     AND a.privilege_type = 'CONNECT'
                ) AS granted`,
      );
      expect(rows[0]?.db).toBe(DB_NAME);
      expect(rows[0]?.granted).toBe(true);
      // Re-run stays idempotent on the alternate name.
      await expect(applyMigrations(admin)).resolves.toBeUndefined();
    },
  );

  it("dolores_app gets RLS-isolated access on the migrated database", async () => {
    const app = new Pool({ connectionString: appUrl(), connectionTimeoutMillis: 5000 });
    try {
      await withTenant(app, { workspaceId: wsRlsA }, (c) =>
        c.query(
          "INSERT INTO memories (workspace_id, content, scope) VALUES ($1, 'rls-a', 'workspace')",
          [wsRlsA],
        ),
      );
      await withTenant(app, { workspaceId: wsRlsB }, (c) =>
        c.query(
          "INSERT INTO memories (workspace_id, content, scope) VALUES ($1, 'rls-b', 'workspace')",
          [wsRlsB],
        ),
      );
      const seenByA = await withTenant(app, { workspaceId: wsRlsA }, async (c) => {
        const res = await c.query<{ workspace_id: string }>(
          "SELECT workspace_id::text AS workspace_id FROM memories WHERE workspace_id = ANY($1::uuid[])",
          [[wsRlsA, wsRlsB]],
        );
        return res.rows.map((r) => r.workspace_id);
      });
      expect(seenByA).toEqual([wsRlsA]);
      await expect(
        withTenant(app, { workspaceId: wsRlsA }, (c) =>
          c.query(
            "INSERT INTO memories (workspace_id, content, scope) VALUES ($1, 'x', 'workspace')",
            [wsRlsB],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    } finally {
      await app.end();
    }
  });

  it("enable twice keeps one memory-decay job; disable twice removes only it; rows untouched", async () => {
    await insertMemory({ ws: wsCron, content: "cron eligible", importance: 1, ageDays: 200 });
    await insertMemory({ ws: wsCron, content: "cron recent", importance: 5, ageDays: 0 });
    const rowsBefore = await snapshot([wsCron]);

    await enableAggressiveDecay(admin);
    await enableAggressiveDecay(admin);
    const afterEnable = await cronJobs();
    expect(afterEnable.filter((j) => j.jobname === AGGRESSIVE_DECAY_JOB_NAME)).toHaveLength(1);
    const others = afterEnable.filter((j) => j.jobname !== AGGRESSIVE_DECAY_JOB_NAME);
    expect(others.map((j) => j.jobname)).toEqual(
      expect.arrayContaining(["memory-soften", "ingest-jobs-purge"]),
    );

    expect(await disableAggressiveDecay(admin)).toBe(1);
    expect(await disableAggressiveDecay(admin)).toBe(0);
    const afterDisable = await cronJobs();
    expect(afterDisable.filter((j) => j.jobname === AGGRESSIVE_DECAY_JOB_NAME)).toHaveLength(0);
    expect(afterDisable).toEqual(others);
    expect(await snapshot([wsCron])).toEqual(rowsBefore);
  });

  it("dolores_decay_memories() keeps a referenced terminal version but deletes an unreferenced expired leaf", async () => {
    const ids = await seedChain();
    const otherBefore = await snapshot([wsOther]);
    await admin.query("SELECT dolores_decay_memories()");
    await expectChainOutcome(ids, otherBefore);
  });

  it("static aggressive_decay.sql DELETE is valid SQL with the same protection", async () => {
    const sql = readFileSync(new URL("./sql/aggressive_decay.sql", import.meta.url), "utf8");
    const match = /\$\$([\s\S]*?)\$\$/.exec(sql);
    expect(match).not.toBeNull();
    const body = match?.[1] ?? "";
    expect(body).toContain("DELETE FROM memories m");
    const ids = await seedChain();
    const otherBefore = await snapshot([wsOther]);
    await admin.query(body);
    await expectChainOutcome(ids, otherBefore);
  });
});
