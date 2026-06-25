import type { Fact, Scope } from "../types.js";

/** Render a JS number[] as a pgvector literal: `[0.1,0.2,...]`. */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

/** Normalise a Postgres timestamptz (Date or string) to an ISO string. */
export function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return typeof v === "string" ? v : String(v);
}

/** Clamp importance into the documented 1..10 range, defaulting when absent. */
export function clampImportance(n: number | undefined, fallback = 5): number {
  const x = Math.round(n ?? fallback);
  if (Number.isNaN(x)) return fallback;
  return Math.min(10, Math.max(1, x));
}

// --- Row shapes returned by raw queries (snake_case, as Postgres emits) -------

export interface MemoryRow {
  id: string;
  workspace_id: string;
  user_id: string | null;
  scope: string;
  content: string;
  importance: number;
  source: string | null;
  created_at: Date;
  last_accessed: Date;
  // --- Temporal evolution (EPIC F). Optional: not every SELECT projects them. ---
  superseded_by?: string | null;
  valid_from?: Date;
  valid_to?: Date | null;
}

export interface FactRow {
  id: string;
  workspace_id: string;
  user_id: string | null;
  scope: string;
  category: string;
  key: string;
  value: string;
  created_at: Date;
  updated_at: Date;
}

/** Return the first row or throw — for queries that always RETURN exactly one. */
export function requireRow<T>(rows: T[], context: string): T {
  const row = rows[0];
  if (!row) throw new Error(`${context}: expected a row but got none`);
  return row;
}

export function rowToFact(r: FactRow): Fact {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    userId: r.user_id,
    scope: r.scope as Scope,
    category: r.category,
    key: r.key,
    value: r.value,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}
