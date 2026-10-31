import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { NoOpEmbedder } from "@dolores/core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DaemonRuntimeConfig } from "./config.js";
import { PoolErrorSink, assertAppDatabaseIsolation, createDaemonPool } from "./database.js";
import { createApp } from "./server.js";

// No localhost fallback. Both flags must explicitly identify a disposable PG.
const ADMIN_URL = process.env.DOLORES_TEST_PG_URL ?? "";
const ENABLED = ADMIN_URL.length > 0 && process.env.DOLORES_TEST_PG_DISPOSABLE === "1";
const WORKSPACE = randomUUID();
const OTHER_WORKSPACE = randomUUID();
const USER = randomUUID();
const OTHER_USER = randomUUID();

function appUrl(): string {
  const url = new URL(ADMIN_URL);
  url.username = "dolores_app";
  url.password = process.env.DOLORES_APP_PASSWORD ?? "dolores";
  return url.toString();
}

function config(databaseUrl: string): DaemonRuntimeConfig {
  return {
    host: "127.0.0.1",
    port: 65436,
    databaseUrl,
    embedder: "noop",
    embedModel: "fixture-no-model",
    decayMode: "aggressive",
    extractionEnabled: false,
  };
}

describe.skipIf(!ENABLED)("disposable PostgreSQL daemon safety", () => {
  let admin: Pool;
  let application: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3000 });
    application = new Pool({ connectionString: appUrl(), connectionTimeoutMillis: 3000 });
    // Schema/roles must be installed explicitly by the disposable fixture owner.
    await assertAppDatabaseIsolation(application);
  });

  afterAll(async () => {
    await admin?.query("DELETE FROM memories WHERE workspace_id=ANY($1::uuid[])", [
      [WORKSPACE, OTHER_WORKSPACE],
    ]);
    await application?.end();
    await admin?.end();
  });

  it("accepts the application role and rejects a real superuser", async () => {
    await expect(assertAppDatabaseIsolation(application)).resolves.toBeUndefined();
    await expect(assertAppDatabaseIsolation(admin)).rejects.toMatchObject({
      code: "PREFLIGHT_UNSAFE",
    });
  });

  it("unsafe runtime startup exits promptly, leaks no connections and prints no URL", async () => {
    const applicationName = `dolores_preflight_${randomUUID().replaceAll("-", "")}`;
    const url = new URL(ADMIN_URL);
    url.searchParams.set("application_name", applicationName);
    const moduleUrl = new URL("../dist/server.js", import.meta.url).href;
    const code = `import {startDaemon} from ${JSON.stringify(moduleUrl)};
      startDaemon(${JSON.stringify(config(url.toString()))}).then(() => {
        console.error('UNEXPECTED_START'); process.exitCode = 2;
      }).catch((error) => { console.error(error.message); process.exitCode = 1; });`;
    // Isolated child: a regression must not leave a daemon/worker in Vitest.
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", DOLORES_LOG_LEVEL: "silent" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const result = await new Promise<{ code: number | null; signal: string | null }>(
      (resolve, reject) => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 7000);
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("close", (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
      },
    );
    expect(result).toEqual({ code: 1, signal: null });
    expect(output).toContain("database preflight failed");
    expect(output).toContain("SUPERUSER");
    expect(output).toContain("DOLORES_APP_DATABASE_URL");
    expect(output).not.toContain("postgresql://");
    expect(output).not.toContain("UNEXPECTED_START");
    const connections = await admin.query<{ count: string }>(
      "SELECT count(*)::text FROM pg_stat_activity WHERE application_name=$1",
      [applicationName],
    );
    expect(connections.rows[0]?.count).toBe("0");
  }, 10_000);

  for (const label of ["app", "admin"] as const) {
    it(`recovers an actual terminated idle ${label} connection with sanitized diagnostics`, async () => {
      const messages: string[] = [];
      const sink = new PoolErrorSink((line) => messages.push(line));
      const pool = createDaemonPool(
        { connectionString: label === "app" ? appUrl() : ADMIN_URL, max: 1 },
        label,
        sink,
      );
      try {
        const client = await pool.connect();
        const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
          ?.pid;
        expect(pid).toBeTypeOf("number");
        client.release();
        await admin.query("SELECT pg_terminate_backend($1)", [pid]);
        for (let n = 0; n < 50 && messages.length === 0; n++) await delay(20);
        expect(messages).toHaveLength(1);
        expect(JSON.parse(messages[0] ?? "{}")).toMatchObject({ pool: label, code: "57P01" });
        expect(messages[0]).not.toContain("postgresql://");
        expect(messages[0]).not.toContain("terminating connection");
        expect((await pool.query<{ answer: number }>("SELECT 42 AS answer")).rows[0]?.answer).toBe(
          42,
        );
      } finally {
        await pool.end();
      }
    });
  }

  for (const privileged of [false, true]) {
    it(`prune preview matches actual soften/delete and isolates tenants (privileged=${privileged})`, async () => {
      await admin.query("DELETE FROM memories WHERE workspace_id=ANY($1::uuid[])", [
        [WORKSPACE, OTHER_WORKSPACE],
      ]);
      async function seed(
        content: string,
        importance: number,
        age: number,
        user: string | null,
        workspace = WORKSPACE,
        replacedBy: string | null = null,
      ): Promise<string> {
        const row = await admin.query<{ id: string }>(
          `INSERT INTO memories (workspace_id,user_id,scope,content,importance,last_accessed,superseded_by,valid_to)
           VALUES ($1,$2,$3,$4,$5,now()-make_interval(days=>$6::int),$7,
             CASE WHEN $7::uuid IS NULL THEN NULL ELSE now()-interval '100 days' END) RETURNING id::text`,
          [workspace, user, user ? "personal" : "workspace", content, importance, age, replacedBy],
        );
        const id = row.rows[0]?.id;
        if (!id) throw new Error("fixture seed returned no id");
        return id;
      }
      const three = await seed("importance3 becomes2", 3, 120, USER);
      const two = await seed("unreferenced leaf", 2, 120, null);
      const target = await seed("protected terminal", 1, 120, USER);
      const predecessor = await seed("historical predecessor", 5, 0, USER, WORKSPACE, target);
      const otherUser = await seed("unrelated personal", 3, 120, OTHER_USER);
      const otherTenant = await seed("unrelated workspace", 3, 120, null, OTHER_WORKSPACE);
      const digests = async () =>
        (
          await admin.query<{ id: string; digest: string }>(
            "SELECT id::text,md5(m::text) AS digest FROM memories m WHERE workspace_id=ANY($1::uuid[]) ORDER BY id",
            [[WORKSPACE, OTHER_WORKSPACE]],
          )
        ).rows;
      const before = await digests();
      // Privileged factory injection is deliberate: proves explicit tenant SQL
      // still holds independently of RLS. Production startup refuses this role.
      const app = await createApp(
        privileged ? admin : application,
        new NoOpEmbedder(),
        config(appUrl()),
        undefined,
        null,
      );
      try {
        const preview = await app.inject({
          method: "POST",
          url: "/prune",
          payload: { workspaceId: WORKSPACE, userId: USER, dryRun: true },
        });
        expect(preview.statusCode).toBe(200);
        expect(preview.json()).toEqual({ softened: 2, deleted: 2, dryRun: true });
        expect(await digests()).toEqual(before);
        const actual = await app.inject({
          method: "POST",
          url: "/prune",
          payload: { workspaceId: WORKSPACE, userId: USER, dryRun: false },
        });
        expect(actual.statusCode).toBe(200);
        expect(actual.json()).toEqual({ softened: 2, deleted: 2, dryRun: false });
        const after = await digests();
        expect(after.some((row) => row.id === three || row.id === two)).toBe(false);
        for (const id of [otherUser, otherTenant, target, predecessor]) {
          expect(after.find((row) => row.id === id)).toEqual(before.find((row) => row.id === id));
        }
      } finally {
        await app.close();
      }
    });
  }
});
