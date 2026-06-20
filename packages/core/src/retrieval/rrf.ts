/**
 * Reciprocal Rank Fusion (RRF) — combine independently-ranked arms (here:
 * pgvector cosine + Postgres full-text) into one ranking without needing the
 * raw scores to be comparable.
 *
 *   rrf(doc) = Σ_arms 1 / (k + rank_arm(doc))     (rank is 1-based)
 *
 * We normalise to 0..1 against the theoretical max for a doc that ranks #1 in
 * every ARM THAT PRODUCED RESULTS, so the scale is mode-aware: a doc that tops
 * both vector + full-text scores ~1.0, while a doc strong in only one of two
 * active arms scores ~0.5. With a single active arm (e.g. noop/full-text only)
 * the top hit is ~1.0.
 */

export interface FusedHit {
  id: string;
  score: number;
}

export interface FuseOptions {
  /** RRF dampening constant; 60 is the canonical default. */
  k?: number;
  /** Truncate to the top-N after fusion. */
  limit?: number;
}

export function fuseRrf(arms: string[][], opts: FuseOptions = {}): FusedHit[] {
  const k = opts.k ?? 60;
  const activeArms = arms.filter((arm) => arm.length > 0).length || 1;
  const maxPerDoc = activeArms * (1 / (k + 1));

  const acc = new Map<string, number>();
  for (const arm of arms) {
    arm.forEach((id, i) => {
      const rank = i + 1;
      acc.set(id, (acc.get(id) ?? 0) + 1 / (k + rank));
    });
  }

  const fused: FusedHit[] = [];
  for (const [id, raw] of acc) {
    fused.push({ id, score: Math.min(1, raw / maxPerDoc) });
  }
  fused.sort((a, b) => b.score - a.score);

  return opts.limit !== undefined ? fused.slice(0, opts.limit) : fused;
}

// ---------------------------------------------------------------------------
// Importance + recency boost (re-ranks fused hits; similarity stays dominant)
// ---------------------------------------------------------------------------

/** Default boost weights — deliberately SMALL so RRF similarity dominates. */
export const DEFAULT_BOOST_IMPORTANCE = 0.15;
export const DEFAULT_BOOST_RECENCY = 0.1;
/** Recency half-life: a memory touched this long ago contributes 0.5 recencyNorm. */
const DEFAULT_RECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface BoostableHit extends FusedHit {
  /** 1..10 importance of the underlying memory. */
  importance: number;
  /** Age of the memory's last_accessed in ms (now - last_accessed). */
  ageMs: number;
}

export interface BoostOptions {
  wImportance?: number;
  wRecency?: number;
  recencyHalfLifeMs?: number;
}

/**
 * Re-rank fused RRF hits with a LIGHT importance + recency boost. The RRF score
 * (the hybrid similarity signal) stays DOMINANT — the boost only nudges near-ties
 * so a more important / fresher memory edges out an equally-similar one.
 *
 *   recencyNorm = 0.5 ^ (ageMs / halfLife)        // 1 = just touched → 0 = stale
 *   mult        = 1 + wImp·(importance/10) + wRec·recencyNorm
 *   score       = rrfScore · mult / (1 + wImp + wRec)
 *
 * Dividing by the maximum possible multiplier renormalises into 0..1, so the
 * RecallHit.score contract (normalized score) is preserved. Returns hits sorted
 * by the boosted score, descending.
 */
export function applyBoost(hits: BoostableHit[], opts: BoostOptions = {}): FusedHit[] {
  const wImp = opts.wImportance ?? DEFAULT_BOOST_IMPORTANCE;
  const wRec = opts.wRecency ?? DEFAULT_BOOST_RECENCY;
  const halfLife = opts.recencyHalfLifeMs ?? DEFAULT_RECENCY_HALF_LIFE_MS;
  const maxMult = 1 + wImp + wRec;

  const boosted = hits.map((h) => {
    const imp = Math.min(10, Math.max(1, h.importance)) / 10;
    const recencyNorm = halfLife > 0 ? 0.5 ** (Math.max(0, h.ageMs) / halfLife) : 0;
    const mult = 1 + wImp * imp + wRec * recencyNorm;
    return { id: h.id, score: (h.score * mult) / maxMult };
  });
  boosted.sort((a, b) => b.score - a.score);
  return boosted;
}
