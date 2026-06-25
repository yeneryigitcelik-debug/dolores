/**
 * Maximal Marginal Relevance (MMR) — re-select a diverse top-N from a ranked
 * candidate list. PURE MATH over already-computed embeddings (cosine); no model,
 * no LLM, so it stays safe on the recall path. Balances relevance against
 * redundancy so the context isn't filled with near-duplicate memories:
 *
 *   mmr(c) = λ · relevance(c) − (1 − λ) · max_{s ∈ selected} cos(c, s)
 *
 * λ = 1 → pure relevance (identity, MMR off). λ → 0 → maximise diversity.
 */

export interface MmrCandidate {
  id: string;
  /** Relevance score (0..1), e.g. the boosted RRF score. */
  score: number;
  /** Candidate embedding; null = no vector (treated as max-diverse). */
  embedding: number[] | null;
}

/** Cosine similarity; tolerant of non-normalised vectors and zero norms. */
export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Greedy MMR selection. Returns up to `k` candidates ordered by selection.
 * With λ ≥ 1 (or ≤ 1 candidate) it is a pure relevance slice — identical to the
 * pre-MMR behaviour, so MMR is opt-in and zero-impact when disabled.
 */
export function mmrSelect(candidates: MmrCandidate[], lambda: number, k: number): MmrCandidate[] {
  if (lambda >= 1 || candidates.length <= 1) return candidates.slice(0, Math.max(0, k));

  const selected: MmrCandidate[] = [];
  const pool = candidates.slice();

  while (selected.length < k && pool.length > 0) {
    let bestIdx = 0;
    let best = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i];
      if (!c) continue;
      let maxSim = 0;
      if (c.embedding) {
        for (const s of selected) {
          if (s.embedding) maxSim = Math.max(maxSim, cosine(c.embedding, s.embedding));
        }
      }
      const mmr = lambda * c.score - (1 - lambda) * maxSim;
      if (mmr > best) {
        best = mmr;
        bestIdx = i;
      }
    }
    const [picked] = pool.splice(bestIdx, 1);
    if (picked) selected.push(picked);
  }
  return selected;
}
