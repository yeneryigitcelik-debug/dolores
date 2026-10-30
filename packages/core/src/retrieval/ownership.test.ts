import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { consolidateMemories } from "../consolidation/consolidate.js";
import type { LlmProvider } from "../extraction/provider.js";
import type { Embedder, MemoryContext, Scope } from "../types.js";
import { batchUpsertFacts, listFacts, upsertFact } from "./facts.js";
import { remember } from "./remember.js";
import { toVectorLiteral } from "./sql.js";
import { withTenant } from "./tenant.js";

// ---------------------------------------------------------------------------
// Sahiplik / kapsam regresyonları (canlı DB). Her iki URL de yoksa atlanır.
// ---------------------------------------------------------------------------

const APP_URL = process.env.DOLORES_APP_DATABASE_URL ?? "";
const ADMIN_URL = process.env.DATABASE_URL ?? "";
const liveDescribe = APP_URL && ADMIN_URL ? describe : describe.skip;

// Her çalıştırma için taze kimlikler — paylaşılan fixture yok.
const MAIN_WS = randomUUID();
const OTHER_WS = randomUUID();
const ALICE = randomUUID();
const BOB = randomUUID();

const DIM = 384;
// Sabit, sıfır olmayan vektör: [1,0,...] → kosinüs benzerliği her zaman 1.0.
const UNIT: number[] = Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0));

const fixedEmbedder: Embedder = {
  id: "fixed-unit",
  dim: DIM,
  ready: async () => {},
  embed: async (texts: string[]) => texts.map(() => [...UNIT]),
};

const noopEmbedder: Embedder = {
  id: "noop",
  dim: 0,
  ready: async () => {},
  embed: async () => [],
};

const asAlice: MemoryContext = { workspaceId: MAIN_WS, userId: ALICE };
const asBob: MemoryContext = { workspaceId: MAIN_WS, userId: BOB };
const asAnon: MemoryContext = { workspaceId: MAIN_WS, userId: null };
const asOther: MemoryContext = { workspaceId: OTHER_WS, userId: ALICE };

interface VisibleRow {
  id: string;
  content: string;
  user_id: string | null;
  scope: string;
}

interface StoredRow extends VisibleRow {
  superseded_by: string | null;
  source: string | null;
}

interface FactRowLite {
  user_id: string | null;
  scope: string;
  value: string;
}

interface Fixture {
  content: string;
  scope: Scope;
  userId: string | null;
  source?: string;
}

liveDescribe("scope / physical owner regressions (live DB)", () => {
  let pool: pg.Pool;
  let admin: pg.Pool;

  // Yardımcı: admin ile parametre bağlamalı fixture satırları ekler.
  async function insertMany(rows: Fixture[]): Promise<string[]> {
    const ids: string[] = [];
    for (const r of rows) {
      const res = await admin.query<{ id: string }>(
        `INSERT INTO memories (workspace_id, user_id, scope, content, importance, source, embedding)
         VALUES ($1, $2, $3, $4, 5, $5, $6::vector)
         RETURNING id`,
        [MAIN_WS, r.userId, r.scope, r.content, r.source ?? null, toVectorLiteral(UNIT)],
      );
      const id = res.rows[0]?.id;
      if (!id) throw new Error("fixture insert failed");
      ids.push(id);
    }
    return ids;
  }

  // Yardımcı: aynı sahip/kapsam için n adet işaretli satırdan oluşan grup.
  function group(marker: string, scope: Scope, userId: string | null, n = 3): Fixture[] {
    return Array.from({ length: n }, (_, i) => ({ content: `${marker} item ${i}`, scope, userId }));
  }

  // Yardımcı: RLS altında (uygulama kullanıcısı) görünen aktif belleği okur.
  async function visible(ctx: MemoryContext, activeOnly = true): Promise<VisibleRow[]> {
    return withTenant(pool, ctx, async (client) => {
      const res = await client.query<VisibleRow>(
        `SELECT id, content, user_id::text AS user_id, scope FROM memories
          ${activeOnly ? "WHERE superseded_by IS NULL" : ""}
          ORDER BY content`,
      );
      return res.rows;
    });
  }

  const contents = (rows: VisibleRow[]): string[] => rows.map((r) => r.content).sort();

  // Yardımcı: admin ile kendi çalışma alanındaki tüm satırların anlık görüntüsü.
  async function snapshotRows(ws = MAIN_WS): Promise<StoredRow[]> {
    const res = await admin.query<StoredRow>(
      `SELECT id, content, user_id::text AS user_id, scope, superseded_by::text AS superseded_by, source
         FROM memories WHERE workspace_id = $1 ORDER BY content`,
      [ws],
    );
    return res.rows;
  }

  async function storedFacts(ws = MAIN_WS): Promise<FactRowLite[]> {
    const res = await admin.query<FactRowLite>(
      `SELECT user_id::text AS user_id, scope, value FROM facts
        WHERE workspace_id = $1 ORDER BY scope`,
      [ws],
    );
    return res.rows;
  }

  // Yardımcı: yalnızca kendi çalışma alanlarımızı temizler (önce self-FK).
  async function cleanup(): Promise<void> {
    for (const ws of [MAIN_WS, OTHER_WS]) {
      await admin.query("UPDATE memories SET superseded_by = NULL WHERE workspace_id = $1", [ws]);
      await admin.query("DELETE FROM memories WHERE workspace_id = $1", [ws]);
      await admin.query("DELETE FROM facts WHERE workspace_id = $1", [ws]);
    }
  }

  // Yardımcı: çağrı numarası ekleyen ve istemleri yakalayan sağlayıcı.
  function capturingProvider(prompts: string[]): LlmProvider {
    return {
      id: "stub-capture",
      complete: async ({ prompt }: { system?: string; prompt: string }) => {
        prompts.push(prompt);
        return `merged ${prompts.length}`;
      },
    };
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: APP_URL, max: 5 });
    admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
    // Uygulama bağlantısı RLS'yi atlayamamalı; yoksa testler anlamsız geçer.
    const role = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toHaveLength(1);
    expect(role.rows[0]?.rolsuper).toBe(false);
    expect(role.rows[0]?.rolbypassrls).toBe(false);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await cleanup();
  });

  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  it("remember: açık workspace paylaşılır, kapsam verilmezse kişisel/çalışma alanı çözülür", async () => {
    vi.stubEnv("DOLORES_EVOLUTION_MODE", "inplace");
    const shared = await remember(pool, asAlice, noopEmbedder, {
      content: "shared note",
      scope: "workspace",
    });
    const priv = await remember(pool, asAlice, noopEmbedder, { content: "alice private note" });
    const anon = await remember(pool, asAnon, noopEmbedder, { content: "anon default note" });

    const stored = await snapshotRows();
    const byId = (id: string) => stored.find((r) => r.id === id);
    expect(byId(shared.id)).toMatchObject({ user_id: null, scope: "workspace" });
    expect(byId(priv.id)).toMatchObject({ user_id: ALICE, scope: "personal" });
    expect(byId(anon.id)).toMatchObject({ user_id: null, scope: "workspace" });

    expect(contents(await visible(asAlice))).toEqual([
      "alice private note",
      "anon default note",
      "shared note",
    ]);
    const sharedOnly = ["anon default note", "shared note"];
    expect(contents(await visible(asBob))).toEqual(sharedOnly);
    expect(contents(await visible(asAnon))).toEqual(sharedOnly);
    expect(await visible(asOther)).toHaveLength(0);
  });

  it("legacy workspace+Alice satırı özel kalır; yeni paylaşılan yazı onu çalmaz", async () => {
    vi.stubEnv("DOLORES_EVOLUTION_MODE", "inplace");
    const [legacyId] = await insertMany([
      { content: "legacy alice row", scope: "workspace", userId: ALICE },
    ]);

    const res = await remember(pool, asAlice, fixedEmbedder, {
      content: "fresh shared row",
      scope: "workspace",
    });
    expect(res.deduped).toBe(false);
    expect(res.id).not.toBe(legacyId);

    const stored = await snapshotRows();
    expect(stored).toHaveLength(2);
    const legacy = stored.find((r) => r.id === legacyId);
    expect(legacy).toMatchObject({
      content: "legacy alice row",
      user_id: ALICE,
      scope: "workspace",
      superseded_by: null,
    });
    expect(stored.find((r) => r.id === res.id)).toMatchObject({
      user_id: null,
      scope: "workspace",
    });

    expect(contents(await visible(asAlice))).toEqual(["fresh shared row", "legacy alice row"]);
    expect(contents(await visible(asBob))).toEqual(["fresh shared row"]);
    expect(contents(await visible(asAnon))).toEqual(["fresh shared row"]);
  });

  it("batchUpsertFacts: kapsam başına son girdi kazanır, sahiplik ayrı tutulur", async () => {
    await batchUpsertFacts(pool, asAlice, [
      { category: "stack", key: "db", value: "ws-1", scope: "workspace" },
      { category: "stack", key: "db", value: "me-1", scope: "personal" },
      { category: "stack", key: "db", value: "ws-2", scope: "workspace" },
      { category: "stack", key: "db", value: "me-2", scope: "personal" },
    ]);

    const rows = await storedFacts();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.scope === "workspace")).toMatchObject({
      user_id: null,
      value: "ws-2",
    });
    expect(rows.find((r) => r.scope === "personal")).toMatchObject({
      user_id: ALICE,
      value: "me-2",
    });

    const values = async (ctx: MemoryContext) =>
      (await listFacts(pool, ctx, "stack")).map((f) => f.value).sort();
    expect(await values(asAlice)).toEqual(["me-2", "ws-2"]);
    expect(await values(asBob)).toEqual(["ws-2"]);
    expect(await values(asAnon)).toEqual(["ws-2"]);
    expect(await values(asOther)).toEqual([]);

    // Tekil açık workspace upsert paylaşılan satırı günceller, sahipliğini almaz.
    const updated = await upsertFact(pool, asAlice, {
      category: "stack",
      key: "db",
      value: "ws-3",
      scope: "workspace",
    });
    expect(updated.userId).toBeNull();
    expect(updated.scope).toBe("workspace");
    const after = await storedFacts();
    expect(after).toHaveLength(2);
    expect(after.find((r) => r.scope === "workspace")).toMatchObject({
      user_id: null,
      value: "ws-3",
    });

    // Kapsam verilmezse kişisel (Alice) olarak yazılır.
    const def = await upsertFact(pool, asAlice, { category: "pref", key: "editor", value: "vim" });
    expect(def).toMatchObject({ userId: ALICE, scope: "personal" });
    expect(await listFacts(pool, asBob, "pref")).toHaveLength(0);
  });

  it("batchUpsertFacts: kimliksiz geçersiz personal tüm toplu yazımı reddeder (kısmi yazım yok)", async () => {
    await expect(
      batchUpsertFacts(pool, asAnon, [
        { category: "stack", key: "ok", value: "fine", scope: "workspace" },
        { category: "stack", key: "bad", value: "nope", scope: "personal" },
      ]),
    ).rejects.toThrow(/personal/);
    const count = await admin.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM facts WHERE workspace_id = $1",
      [MAIN_WS],
    );
    expect(count.rows[0]?.n).toBe("0");
  });

  it("consolidation fiziksel sahip VE kapsama göre gruplar", async () => {
    vi.stubEnv("DOLORES_EVOLUTION_MODE", "inplace");
    await insertMany([
      ...group("SHAREDGRP", "workspace", null),
      ...group("LEGACYGRP", "workspace", ALICE),
      ...group("PERSONALGRP", "personal", ALICE),
    ]);
    expect(await visible(asAlice)).toHaveLength(9);

    const prompts: string[] = [];
    const summary = await consolidateMemories(pool, asAlice, fixedEmbedder, {
      provider: capturingProvider(prompts),
      minClusterSize: 3,
      similarityThreshold: 0.82,
    });
    expect(summary.consolidated).toBe(3);
    expect(summary.superseded).toBe(9);

    // Her istem yalnızca kendi grubunun işaretini içermeli.
    const markers = ["SHAREDGRP", "LEGACYGRP", "PERSONALGRP"];
    expect(prompts).toHaveLength(3);
    for (const p of prompts) {
      const present = markers.filter((m) => p.includes(m));
      expect(present).toHaveLength(1);
    }

    const stored = await snapshotRows();
    const merged = stored.filter((r) => r.source === "consolidation");
    expect(merged).toHaveLength(3);
    const expectOwner: Record<string, { scope: string; user_id: string | null }> = {
      SHAREDGRP: { scope: "workspace", user_id: null },
      LEGACYGRP: { scope: "workspace", user_id: ALICE },
      PERSONALGRP: { scope: "personal", user_id: ALICE },
    };
    for (const [i, p] of prompts.entries()) {
      const marker = markers.find((m) => p.includes(m)) ?? "";
      const note = merged.find((r) => r.content === `merged ${i + 1}`);
      expect(note).toMatchObject({ ...expectOwner[marker], superseded_by: null });
      const members = stored.filter((r) => r.content.startsWith(marker));
      expect(members).toHaveLength(3);
      for (const m of members) expect(m.superseded_by).toBe(note?.id);
    }

    const sharedIdx = prompts.findIndex((p) => p.includes("SHAREDGRP"));
    const sharedNote = [`merged ${sharedIdx + 1}`];
    expect(contents(await visible(asBob))).toEqual(sharedNote);
    expect(contents(await visible(asAnon))).toEqual(sharedNote);
    expect(await visible(asAlice)).toHaveLength(3);
  });

  it.each(["content", "importance", "embedding"] as const)(
    "consolidation: LLM sırasında üyenin %s alanı değişirse eski sentez yazılmaz",
    async (mutation) => {
      vi.stubEnv("DOLORES_EVOLUTION_MODE", "inplace");
      const ids = await insertMany(group("STALEGRP", "workspace", null));
      const target = ids[0];
      if (!target) throw new Error("fixture missing");

      const provider: LlmProvider = {
        id: "stub-stale",
        complete: async () => {
          // Yavaş LLM çağrısı sırasında eşzamanlı yerinde güncelleme.
          if (mutation === "content") {
            await admin.query("UPDATE memories SET content = $1 WHERE id = $2", [
              "STALEGRP changed meanwhile",
              target,
            ]);
          } else if (mutation === "importance") {
            await admin.query("UPDATE memories SET importance = $1 WHERE id = $2", [9, target]);
          } else {
            const changedVector = Array.from({ length: DIM }, (_, i) => (i === 1 ? 1 : 0));
            await admin.query("UPDATE memories SET embedding = $1::vector WHERE id = $2", [
              toVectorLiteral(changedVector),
              target,
            ]);
          }
          return "stale synthesis";
        },
      };

      const summary = await consolidateMemories(pool, asAnon, fixedEmbedder, {
        provider,
        minClusterSize: 3,
        similarityThreshold: 0.82,
      });
      expect(summary.consolidated).toBe(0);
      expect(summary.superseded).toBe(0);

      const stored = await snapshotRows();
      expect(stored.some((r) => r.content === "stale synthesis")).toBe(false);
      expect(stored.filter((r) => r.source === "consolidation")).toHaveLength(0);
      const changed = stored.find((r) => r.id === target);
      expect(changed).toMatchObject({
        content: mutation === "content" ? "STALEGRP changed meanwhile" : "STALEGRP item 0",
        superseded_by: null,
      });
      for (const r of stored) expect(r.superseded_by).toBeNull();
    },
  );
});
