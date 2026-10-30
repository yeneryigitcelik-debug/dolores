import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyMigrations,
  attachPoolErrorListener,
  describeDbError,
  disableAggressiveDecay,
  getPool,
  withTenant,
} from "./index.js";
import { INIT_SQL } from "./migration.js";

// Pure tests: no database connection is ever opened. Pool construction in pg is
// lazy, and the synthetic URL points at an unroutable port.
const SYNTHETIC_URL = "postgresql://test_user:TEST_SECRET_pw@127.0.0.1:1/dolores_test_synthetic";

type FakeResult = { rows: unknown[] };
type Responder = (sql: string, params: readonly unknown[]) => FakeResult | Error;

interface FakeHandle {
  pool: Pool;
  queries: string[];
  params: Array<readonly unknown[]>;
  releases: Array<boolean | Error | undefined>;
}

function fakePool(respond: Responder): FakeHandle {
  const queries: string[] = [];
  const params: Array<readonly unknown[]> = [];
  const releases: Array<boolean | Error | undefined> = [];
  const client = {
    query: async (sql: string, values: readonly unknown[] = []): Promise<FakeResult> => {
      queries.push(sql);
      params.push(values);
      const r = respond(sql, values);
      if (r instanceof Error) throw r;
      return r;
    },
    release: (arg?: boolean | Error): void => {
      releases.push(arg);
    },
    escapeLiteral: (s: string): string => `'${s.replace(/'/g, "''")}'`,
  };
  const pool = { connect: async () => client };
  return { pool: pool as unknown as Pool, queries, params, releases };
}

function pgError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("describeDbError", () => {
  it("keeps only name + code, never the message", () => {
    const out = describeDbError(pgError(`connect ${SYNTHETIC_URL} failed`, "ECONNREFUSED"));
    expect(out).toBe("Error code=ECONNREFUSED");
    expect(out).not.toContain("TEST_SECRET_pw");
  });

  it("drops codes that are not simple identifiers", () => {
    expect(describeDbError(pgError("x", "bad code; DROP"))).toBe("Error");
    expect(describeDbError("plain string")).toBe("non-error value");
  });
});

describe("idle pool error listener", () => {
  it("attaches once, survives an idle 'error' event and logs a sanitized diagnostic", async () => {
    const pool = new Pool({ connectionString: SYNTHETIC_URL });
    const lines: string[] = [];
    attachPoolErrorListener(pool, (m) => lines.push(m));
    attachPoolErrorListener(pool, (m) => lines.push(m));
    expect(pool.listenerCount("error")).toBe(1);

    const err = pgError(`connection to ${SYNTHETIC_URL} lost during SELECT secret_column`, "57P01");
    expect(() => pool.emit("error", err)).not.toThrow();
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? "";
    expect(line).toContain("57P01");
    expect(line).not.toContain("TEST_SECRET_pw");
    expect(line).not.toContain("127.0.0.1");
    expect(line).not.toContain("secret_column");
    await pool.end();
  });

  it("getPool() returns a singleton with exactly one error listener", async () => {
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = SYNTHETIC_URL;
    try {
      const p1 = getPool();
      const p2 = getPool();
      expect(p2).toBe(p1);
      expect(p1.listenerCount("error")).toBe(1);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      expect(() => p1.emit("error", pgError(SYNTHETIC_URL, "57P01"))).not.toThrow();
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(String(errSpy.mock.calls[0]?.[0])).not.toContain("TEST_SECRET_pw");
      await p1.end();
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, "DATABASE_URL");
      else process.env.DATABASE_URL = saved;
    }
  });
});

describe("rollback is best-effort and preserves the original error", () => {
  it("withTenant rethrows the callback error when ROLLBACK also fails, and discards the client", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const original = new Error("original cause");
    const h = fakePool((sql) =>
      sql === "ROLLBACK" ? pgError(`rollback broke ${SYNTHETIC_URL}`, "08006") : { rows: [] },
    );
    await expect(
      withTenant(h.pool, { workspaceId: "00000000-0000-0000-0000-000000000001" }, async () => {
        throw original;
      }),
    ).rejects.toBe(original);
    expect(h.queries).toContain("ROLLBACK");
    expect(h.releases).toEqual([true]);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0]?.[0]);
    expect(msg).toContain("08006");
    expect(msg).not.toContain("TEST_SECRET_pw");
  });

  it("withTenant returns the client to the pool after a successful ROLLBACK", async () => {
    const original = new Error("callback failed");
    const h = fakePool(() => ({ rows: [] }));
    await expect(
      withTenant(h.pool, { workspaceId: "00000000-0000-0000-0000-000000000001" }, async () => {
        throw original;
      }),
    ).rejects.toBe(original);
    expect(h.releases).toEqual([false]);
  });

  it("applyMigrations rethrows the migration error when ROLLBACK fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const original = pgError("migration statement failed", "42P01");
    const h = fakePool((sql) => {
      if (sql === "BEGIN") return { rows: [] };
      if (sql === "ROLLBACK") return pgError("connection gone", "08006");
      return original;
    });
    await expect(applyMigrations(h.pool)).rejects.toBe(original);
    expect(h.releases).toEqual([true]);
  });
});

describe("disableAggressiveDecay (fake client)", () => {
  it("is a no-op without errors when no memory-decay job exists", async () => {
    const h = fakePool(() => ({ rows: [] }));
    await expect(disableAggressiveDecay(h.pool)).resolves.toBe(0);
    expect(h.queries.some((q) => q.includes("cron.unschedule"))).toBe(false);
    expect(h.queries[0]).toBe("BEGIN");
    expect(h.queries[h.queries.length - 1]).toBe("COMMIT");
    expect(h.releases).toEqual([false]);
  });

  it("unschedules exactly the job ids found by name", async () => {
    const h = fakePool((sql) => {
      if (sql.includes("FROM cron.job")) return { rows: [{ jobid: "7" }, { jobid: "9" }] };
      if (sql.includes("cron.unschedule")) return { rows: [{ removed: true }] };
      return { rows: [] };
    });
    await expect(disableAggressiveDecay(h.pool)).resolves.toBe(2);
    const lookupIdx = h.queries.findIndex((q) => q.includes("FROM cron.job"));
    expect(h.params[lookupIdx]).toEqual(["memory-decay"]);
    const unscheduleParams = h.queries
      .map((q, i) => (q.includes("cron.unschedule") ? h.params[i] : undefined))
      .filter((p): p is readonly unknown[] => p !== undefined);
    expect(unscheduleParams).toEqual([["7"], ["9"]]);
  });
});

describe("migration SQL copies stay consistent", () => {
  const PROTECTED_DELETE =
    /DELETE FROM memories m[\s\S]*?NOT EXISTS \(\s*SELECT 1 FROM memories predecessor\s+WHERE predecessor\.superseded_by = m\.id\s*\)/;
  const staticSql = readFileSync(new URL("./sql/aggressive_decay.sql", import.meta.url), "utf8");
  const prismaSql = readFileSync(
    new URL("../prisma/migrations/20240620000000_init/migration.sql", import.meta.url),
    "utf8",
  );

  it("every aggressive DELETE form protects referenced memories", () => {
    expect(INIT_SQL).toMatch(PROTECTED_DELETE);
    expect(staticSql).toMatch(PROTECTED_DELETE);
    expect(prismaSql).toMatch(PROTECTED_DELETE);
  });

  it("CONNECT is granted on current_database(), not a hard-coded name", () => {
    const dynamicGrant =
      "format('GRANT CONNECT ON DATABASE %I TO dolores_app', current_database())";
    for (const sql of [INIT_SQL, prismaSql]) {
      expect(sql).toContain(dynamicGrant);
      expect(sql).not.toMatch(/GRANT CONNECT ON DATABASE dolores\b/);
    }
  });
});
