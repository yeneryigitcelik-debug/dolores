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
