import { describe, expect, it } from "vitest";
import { MetricsCollector, percentile } from "./metrics.js";

describe("percentile", () => {
  it("nearest-rank on a sorted array", () => {
    const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(s, 50)).toBe(5);
    expect(percentile(s, 95)).toBe(10);
    expect(percentile(s, 99)).toBe(10);
    expect(percentile(s, 100)).toBe(10);
  });
  it("empty → 0", () => {
    expect(percentile([], 95)).toBe(0);
  });
});

describe("MetricsCollector", () => {
  it("aggregates count, errors, and percentiles per route", () => {
    const m = new MetricsCollector();
    for (let i = 1; i <= 100; i++) m.record("POST /recall", i, 200);
    m.record("POST /recall", 999, 500);
    m.record("POST /recall", 5, 400);
    const v = m.routeViews()["POST /recall"];
    expect(v?.count).toBe(102);
    expect(v?.errors5xx).toBe(1);
    expect(v?.errors4xx).toBe(1);
    expect(v?.p50Ms).toBeGreaterThan(0);
    expect(v?.p95Ms ?? 0).toBeGreaterThanOrEqual(v?.p50Ms ?? 0);
    expect(v?.p99Ms ?? 0).toBeGreaterThanOrEqual(v?.p95Ms ?? 0);
    expect(m.total).toBe(102);
  });

  it("tracks the dedup rate", () => {
    const m = new MetricsCollector();
    expect(m.dedupRate()).toBe(0);
    m.recordRemember(true);
    m.recordRemember(false);
    m.recordRemember(true);
    m.recordRemember(true);
    expect(m.dedupRate()).toBeCloseTo(0.75, 5);
  });

  it("keeps percentiles over a bounded recent window after the cap", () => {
    const m = new MetricsCollector();
    for (let i = 0; i < 2000; i++) m.record("GET /x", i, 200);
    const v = m.routeViews()["GET /x"];
    expect(v?.count).toBe(2000); // all-time count is exact
    // p50 reflects the RECENT window (~last 1024 values), not the all-time median.
    expect(v?.p50Ms ?? 0).toBeGreaterThan(900);
  });
});
