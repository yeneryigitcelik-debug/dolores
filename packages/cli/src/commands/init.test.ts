import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";

const db = vi.hoisted(() => ({
  applyMigrations: vi.fn(async (_pool: unknown) => undefined),
  enableAggressiveDecay: vi.fn(async (_pool: unknown) => undefined),
  disableAggressiveDecay: vi.fn(async (_pool: unknown) => 0),
  end: vi.fn(async () => undefined),
}));

vi.mock("@dolores/db", () => ({
  applyMigrations: db.applyMigrations,
  enableAggressiveDecay: db.enableAggressiveDecay,
  disableAggressiveDecay: db.disableAggressiveDecay,
  getPool: () => ({ end: db.end }),
}));

import { runInit } from "./init.js";

const SYNTHETIC_URL = "postgresql://test_user:test_pw@127.0.0.1:1/dolores_test_synthetic";

describe("runInit decay mode handling (mocked @dolores/db, no database)", () => {
  const savedUrl = process.env.DATABASE_URL;
  const savedMode = process.env.DOLORES_DECAY_MODE;
  let logs: string[] = [];
  let logSpy: MockInstance | undefined;

  beforeEach(() => {
    db.applyMigrations.mockClear();
    db.enableAggressiveDecay.mockClear();
    db.disableAggressiveDecay.mockClear();
    db.end.mockClear();
    logs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(" "));
    });
    process.env.DATABASE_URL = SYNTHETIC_URL;
  });

  afterEach(() => {
    logSpy?.mockRestore();
    if (savedUrl === undefined) Reflect.deleteProperty(process.env, "DATABASE_URL");
    else process.env.DATABASE_URL = savedUrl;
    if (savedMode === undefined) Reflect.deleteProperty(process.env, "DOLORES_DECAY_MODE");
    else process.env.DOLORES_DECAY_MODE = savedMode;
  });

  it("default (unset) mode disables a leftover aggressive job and reports none found truthfully", async () => {
    Reflect.deleteProperty(process.env, "DOLORES_DECAY_MODE");
    db.disableAggressiveDecay.mockResolvedValueOnce(0);
    await runInit({ noDocker: true });
    expect(db.applyMigrations).toHaveBeenCalledTimes(1);
    expect(db.disableAggressiveDecay).toHaveBeenCalledTimes(1);
    expect(db.enableAggressiveDecay).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("agresif decay cron işi zaten yok"))).toBe(true);
    expect(logs.some((l) => l.includes("kaldırıldı"))).toBe(false);
    expect(db.end).toHaveBeenCalledTimes(1);
  });

  it("conservative mode reports removal when an old memory-decay job existed", async () => {
    process.env.DOLORES_DECAY_MODE = "conservative";
    db.disableAggressiveDecay.mockResolvedValueOnce(1);
    await runInit({ noDocker: true });
    expect(db.disableAggressiveDecay).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.includes("memory-decay") && l.includes("kaldırıldı"))).toBe(true);
  });

  it("aggressive mode enables the DELETE job and does not disable it", async () => {
    process.env.DOLORES_DECAY_MODE = "aggressive";
    await runInit({ noDocker: true });
    expect(db.enableAggressiveDecay).toHaveBeenCalledTimes(1);
    expect(db.disableAggressiveDecay).not.toHaveBeenCalled();
  });

  it("unrecognized mode keeps the existing behaviour (treated as conservative)", async () => {
    process.env.DOLORES_DECAY_MODE = "something-else";
    await runInit({ noDocker: true });
    expect(db.enableAggressiveDecay).not.toHaveBeenCalled();
    expect(db.disableAggressiveDecay).toHaveBeenCalledTimes(1);
  });
});
