/**
 * In-memory request metrics (EPIC K). Dependency-free: a fixed-size ring buffer
 * of recent latencies per route → p50/p95/p99, plus all-time counts, error
 * tallies, and the dedup rate. No external egress (KVKK-clean); scraped locally
 * via /metrics (JSON) or /metrics/prometheus (Prometheus text).
 */

/** Recent-latency window size per route (for percentiles). */
export const SAMPLE_CAP = 1024;

/** Nearest-rank percentile of an ASCENDING-sorted array. */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[idx] ?? 0;
}

interface RouteStats {
  count: number;
  sumMs: number;
  errors4xx: number;
  errors5xx: number;
  /** ring buffer of recent latencies (ms). */
  samples: number[];
  sampleCount: number;
  sampleIdx: number;
}

export interface RouteMetricView {
  count: number;
  errors4xx: number;
  errors5xx: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export class MetricsCollector {
  total = 0;
  private remembers = 0;
  private dedupes = 0;
  private routes = new Map<string, RouteStats>();

  /** Record one completed request: route key, latency (ms), HTTP status. */
  record(routeKey: string, ms: number, statusCode: number): void {
    this.total++;
    let s = this.routes.get(routeKey);
    if (!s) {
      s = {
        count: 0,
        sumMs: 0,
        errors4xx: 0,
        errors5xx: 0,
        samples: new Array<number>(SAMPLE_CAP),
        sampleCount: 0,
        sampleIdx: 0,
      };
      this.routes.set(routeKey, s);
    }
    s.count++;
    s.sumMs += ms;
    if (statusCode >= 500) s.errors5xx++;
    else if (statusCode >= 400) s.errors4xx++;
    s.samples[s.sampleIdx] = ms;
    s.sampleIdx = (s.sampleIdx + 1) % SAMPLE_CAP;
    if (s.sampleCount < SAMPLE_CAP) s.sampleCount++;
  }

  /** Track a /remember outcome so we can report the dedup rate. */
  recordRemember(deduped: boolean): void {
    this.remembers++;
    if (deduped) this.dedupes++;
  }

  /** Dedup rate over all /remember calls (0..1); 0 when none yet. */
  dedupRate(): number {
    return this.remembers > 0 ? this.dedupes / this.remembers : 0;
  }

  /** Per-route view with percentiles computed from the recent window. */
  routeViews(): Record<string, RouteMetricView> {
    const out: Record<string, RouteMetricView> = {};
    for (const [route, s] of this.routes) {
      const valid =
        s.sampleCount < SAMPLE_CAP ? s.samples.slice(0, s.sampleCount) : s.samples.slice();
      valid.sort((a, b) => a - b);
      out[route] = {
        count: s.count,
        errors4xx: s.errors4xx,
        errors5xx: s.errors5xx,
        avgMs: s.count > 0 ? Math.round(s.sumMs / s.count) : 0,
        p50Ms: Math.round(percentile(valid, 50)),
        p95Ms: Math.round(percentile(valid, 95)),
        p99Ms: Math.round(percentile(valid, 99)),
      };
    }
    return out;
  }
}
