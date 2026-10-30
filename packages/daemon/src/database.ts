/**
 * Database safety helpers for the daemon.
 *
 * D1 - Pool error handling: node-postgres emits `error` on a Pool when an IDLE
 * client's connection dies (PostgreSQL restart, pg_terminate_backend, network
 * drop). Without a listener that event becomes an uncaught exception and kills
 * the daemon. We attach a sanitized listener at construction time (before any
 * query). The pool discards the broken client and the next query reconnects.
 *
 * D2 - App-role preflight: the retrieval pool MUST run as a role that is subject
 * to Row Level Security. A SUPERUSER or BYPASSRLS role silently ignores RLS
 * (even FORCE), which collapses tenant isolation. The preflight only READS the
 * catalog. It never alters roles, schema, or data.
 */
import { Pool, type PoolClient, type PoolConfig } from "pg";

export type PoolLabel = "app" | "admin";

/** Minimal structured logger surface (satisfied by Fastify's pino logger). */
export interface PoolErrorLogger {
  warn(obj: object, msg: string): void;
}

/** What gets reported for a pool error. Deliberately NO message/URL/query/credentials. */
export interface PoolErrorEvent {
  pool: PoolLabel;
  /** SQLSTATE / errno code only (e.g. "57P01", "ECONNRESET"); null if absent. */
  code: string | null;
}

export const POOL_ERROR_MESSAGE =
  "postgres client connection error; broken client discarded, next query reconnects";

const SAFE_ERROR_CODE = /^[A-Z0-9_]{1,32}$/;

/** Extract a short, credential-free error code. Never returns the error message. */
export function sanitizeErrorCode(err: unknown): string | null {
  if (typeof err !== "object" || err === null || !("code" in err)) return null;
  const code = err.code;
  return typeof code === "string" && SAFE_ERROR_CODE.test(code) ? code : null;
}

/**
 * Routes pool errors to the Fastify logger once it exists. Before that (early
 * startup, preflight) it writes one sanitized JSON line to stderr, so an error
 * that fires before createApp() is still handled and visible.
 */
export class PoolErrorSink {
  #logger: PoolErrorLogger | undefined;
  readonly #fallback: (line: string) => void;

  constructor(fallback?: (line: string) => void) {
    this.#fallback =
      fallback ??
      ((line: string): void => {
        process.stderr.write(`${line}\n`);
      });
  }

  useLogger(logger: PoolErrorLogger): void {
    this.#logger = logger;
  }

  report(event: PoolErrorEvent): void {
    try {
      if (this.#logger) {
        this.#logger.warn({ pool: event.pool, code: event.code }, POOL_ERROR_MESSAGE);
        return;
      }
      this.#fallback(
        JSON.stringify({
          level: "warn",
          pool: event.pool,
          code: event.code,
          msg: POOL_ERROR_MESSAGE,
        }),
      );
    } catch {
      // Reporting must never throw out of an 'error' listener.
    }
  }
}

const guardedPools = new WeakSet<Pool>();

/**
 * Register the sanitized error listeners exactly once per pool. Idempotent:
 * startDaemon and createApp may both call it for the same pool.
 */
export function attachPoolErrorHandler(pool: Pool, label: PoolLabel, sink: PoolErrorSink): void {
  if (guardedPools.has(pool)) return;
  guardedPools.add(pool);
  // Idle-client failures: pg-pool re-emits them here and discards the client.
  pool.on("error", (err: Error) => {
    sink.report({ pool: label, code: sanitizeErrorCode(err) });
  });
  // A checked-out client whose socket dies between queries emits 'error' on the
  // client itself. Swallow it here: the failure surfaces as a rejection of the
  // next query, and pg-pool destroys non-queryable clients on release.
  pool.on("connect", (client: PoolClient) => {
    client.on("error", () => {
      // intentionally empty, see above
    });
  });
}

/** Construct a pool with the error listeners attached before any query can run. */
export function createDaemonPool(config: PoolConfig, label: PoolLabel, sink: PoolErrorSink): Pool {
  const pool = new Pool(config);
  attachPoolErrorHandler(pool, label, sink);
  return pool;
}

// ---------------------------------------------------------------------------
// App-role / RLS preflight
// ---------------------------------------------------------------------------

/** Tables whose tenant isolation depends on RLS (must be ENABLE + FORCE). */
export const RLS_PROTECTED_TABLES = ["memories", "facts", "ingest_jobs"] as const;

export type PreflightFailureCode = "PREFLIGHT_UNREADABLE" | "PREFLIGHT_UNSAFE";

export const APP_DATABASE_URL_HINT =
  "Set DOLORES_APP_DATABASE_URL to a connection for the non-superuser 'dolores_app' role " +
  "(NOSUPERUSER NOBYPASSRLS) created by the migrations, and make sure migrations have been " +
  "applied. The DATABASE_URL fallback usually points at the admin/superuser, which silently " +
  "bypasses Row Level Security. Nothing was changed in the database.";

export class DatabasePreflightError extends Error {
  readonly code: PreflightFailureCode;
  readonly problems: readonly string[];

  constructor(code: PreflightFailureCode, problems: readonly string[]) {
    super(
      `[dolores-daemon] database preflight failed: ${problems.join("; ")}. ${APP_DATABASE_URL_HINT}`,
    );
    this.name = "DatabasePreflightError";
    this.code = code;
    this.problems = problems;
  }
}

/** Structural query surface satisfied by both pg Pool and PoolClient. */
export interface PreflightQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

const ROLE_SQL =
  "SELECT rolsuper, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user";

// to_regclass resolves each name through the role's search_path, i.e. exactly
// the relation the daemon's unqualified queries will hit.
const TABLE_SQL = `SELECT t.name,
       c.oid IS NOT NULL AS resolved,
       c.relrowsecurity AS rls,
       c.relforcerowsecurity AS forced
  FROM unnest($1::text[]) AS t(name)
  LEFT JOIN pg_catalog.pg_class c ON c.oid = pg_catalog.to_regclass(t.name)`;

interface RoleRow {
  rolsuper: boolean;
  rolbypassrls: boolean;
}

interface TableRow {
  name: string;
  resolved: boolean;
  rls: boolean | null;
  forced: boolean | null;
}

function isRoleRow(v: unknown): v is RoleRow {
  return (
    typeof v === "object" &&
    v !== null &&
    "rolsuper" in v &&
    "rolbypassrls" in v &&
    typeof v.rolsuper === "boolean" &&
    typeof v.rolbypassrls === "boolean"
  );
}

function isTableRow(v: unknown): v is TableRow {
  return (
    typeof v === "object" &&
    v !== null &&
    "name" in v &&
    "resolved" in v &&
    typeof v.name === "string" &&
    typeof v.resolved === "boolean"
  );
}

/**
 * Fail fast unless the connection runs as a role that RLS actually applies to,
 * and memories/facts/ingest_jobs (as resolved on its search_path) have RLS
 * ENABLED and FORCED. Read-only. Error messages never contain the URI.
 */
export async function assertAppDatabaseIsolation(db: PreflightQueryable): Promise<void> {
  let roleRows: unknown[];
  let tableRows: unknown[];
  try {
    roleRows = (await db.query(ROLE_SQL)).rows;
    tableRows = (await db.query(TABLE_SQL, [[...RLS_PROTECTED_TABLES]])).rows;
  } catch (err) {
    const code = sanitizeErrorCode(err);
    throw new DatabasePreflightError("PREFLIGHT_UNREADABLE", [
      `could not read role/RLS state from the app database (${code ?? "connection or query failed"})`,
    ]);
  }

  const role = roleRows[0];
  if (!isRoleRow(role)) {
    throw new DatabasePreflightError("PREFLIGHT_UNREADABLE", [
      "could not read the connected role's attributes from pg_roles",
    ]);
  }

  const problems: string[] = [];
  if (role.rolsuper) {
    problems.push(
      "the connected role is a SUPERUSER (superusers bypass Row Level Security even with FORCE)",
    );
  }
  if (role.rolbypassrls) {
    problems.push("the connected role has BYPASSRLS (it ignores Row Level Security)");
  }
  for (const name of RLS_PROTECTED_TABLES) {
    const row = tableRows.find((r) => isTableRow(r) && r.name === name);
    if (!isTableRow(row)) {
      problems.push(`could not read RLS state for table '${name}'`);
      continue;
    }
    if (!row.resolved) {
      problems.push(`table '${name}' is not visible on the role's search_path (missing schema?)`);
      continue;
    }
    if (row.rls !== true) problems.push(`table '${name}' does not have ROW LEVEL SECURITY enabled`);
    if (row.forced !== true) problems.push(`table '${name}' does not FORCE ROW LEVEL SECURITY`);
  }

  if (problems.length > 0) throw new DatabasePreflightError("PREFLIGHT_UNSAFE", problems);
}
