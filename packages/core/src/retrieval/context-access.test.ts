import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NoOpEmbedder } from "../embedder/noop.js";
import type { MemoryContext } from "../types.js";
import { buildContext } from "./context.js";
import { recall } from "./recall.js";
import { remember } from "./remember.js";

// ---------------------------------------------------------------------------
// Gerçek, geçici PostgreSQL entegrasyonu: bağlam tüketiminin recency (last_accessed) semantiği.
// DOLORES_APP_DATABASE_URL (uygulama rolü, RLS) + DATABASE_URL (admin, kurulum
// ve temizlik) gerekir. Yalnızca kendi workspace'lerimizin satırlarına dokunur.
// ---------------------------------------------------------------------------

const APP_URL = process.env.DOLORES_APP_DATABASE_URL ?? "";
const ADMIN_URL = process.env.DATABASE_URL ?? "";
const liveDescribe =
  APP_URL && ADMIN_URL && process.env.DOLORES_TEST_PG_DISPOSABLE === "1" ? describe : describe.skip;

const WS_A = "00000000-0000-0000-0000-00000000dd01";
const WS_B = "00000000-0000-0000-0000-00000000dd02";
const OTHER_USER = "00000000-0000-0000-0000-00000000dd99";
const OLD = "2001-01-01T00:00:00.000Z";
const TOUCHED_AFTER = "2001-01-02T00:00:00.000Z";
const MARKER_RE = /\[(?:MK\d{2}|OB\d{2}|PU00)\]/g;

/** Metindeki benzersiz işaretçiler (sıralı, tekrarsız). */
function markersIn(text: string): string[] {
  return [...new Set(text.match(MARKER_RE) ?? [])].sort();
}

const pad = (i: number): string => String(i).padStart(2, "0");

liveDescribe(
  "buildContext last_accessed yalnızca görünen memory'ler için (geçici gerçek PostgreSQL)",
  () => {
    let pool: pg.Pool;
    let admin: pg.Pool;
    const noop = new NoOpEmbedder();
    const ctxA: MemoryContext = { workspaceId: WS_A, userId: null };

    async function cleanup(): Promise<void> {
      for (const ws of [WS_A, WS_B]) {
        await admin.query("DELETE FROM memories WHERE workspace_id = $1", [ws]);
        await admin.query("DELETE FROM facts WHERE workspace_id = $1", [ws]);
      }
    }

    /** Eski last_accessed'tan sonra güncellenmiş işaretçiler (her iki workspace). */
    async function touched(): Promise<string[]> {
      const res = await admin.query<{ content: string }>(
        `SELECT content FROM memories
        WHERE (workspace_id = $1 OR workspace_id = $2) AND last_accessed > $3::timestamptz`,
        [WS_A, WS_B, TOUCHED_AFTER],
      );
      return markersIn(res.rows.map((r) => r.content).join("\n"));
    }

    beforeAll(async () => {
      pool = new pg.Pool({ connectionString: APP_URL, max: 5 });
      admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
      // Çalıştırıcı ayrı, atılabilir bir cluster'ı açıkça seçer; dotenv yüklenmez.
      for (const url of [APP_URL, ADMIN_URL]) {
        expect(["127.0.0.1", "localhost", "[::1]"]).toContain(new URL(url).hostname);
      }
      const role = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      );
      expect(role.rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
      const db = await admin.query<{ db: string }>("SELECT current_database() AS db");
      expect(db.rows[0]?.db ?? "").not.toMatch(/prod/i);
    });

    beforeEach(async () => {
      await cleanup();
      for (let i = 0; i < 60; i++) {
        await remember(pool, ctxA, noop, {
          content: `kumquat orchard entry [MK${pad(i)}] filler`,
          importance: 5,
        });
      }
      // Kontrol: başka workspace, aynı token, yüksek önem.
      for (let i = 0; i < 5; i++) {
        await remember(pool, { workspaceId: WS_B, userId: null }, noop, {
          content: `kumquat orchard entry [OB${pad(i)}] filler`,
          importance: 9,
        });
      }
      // Kontrol: aynı workspace, başka kullanıcının kişisel satırı.
      await remember(pool, { workspaceId: WS_A, userId: OTHER_USER }, noop, {
        content: "kumquat orchard private [PU00] filler",
        importance: 10,
        scope: "personal",
      });
      for (const ws of [WS_A, WS_B]) {
        await admin.query(
          "UPDATE memories SET last_accessed = $2::timestamptz WHERE workspace_id = $1",
          [ws, OLD],
        );
      }
      const count = await admin.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM memories WHERE workspace_id = $1",
        [WS_A],
      );
      expect(count.rows[0]?.n).toBe("61");
      expect(await touched()).toEqual([]);
    });

    afterEach(async () => {
      await cleanup();
    });

    afterAll(async () => {
      await pool.end();
      await admin.end();
    });

    it("sorgulu bağlam küçük bütçede yalnızca görünen işaretçileri günceller (50 adayı değil)", async () => {
      const built = await buildContext(pool, ctxA, 60, "kumquat");
      expect(Object.keys(built).sort()).toEqual(["text", "tokenEstimate"]);
      const visible = markersIn(built.text);
      expect(visible.length).toBeGreaterThan(0);
      expect(visible.length).toBeLessThan(50);
      expect(visible.some((m) => m.startsWith("[OB"))).toBe(false);
      expect(await touched()).toEqual(visible);
    });

    it("statik bağlam yalnızca görünen işaretçileri günceller", async () => {
      const built = await buildContext(pool, ctxA, 60);
      expect(Object.keys(built).sort()).toEqual(["text", "tokenEstimate"]);
      const visible = markersIn(built.text);
      expect(visible.length).toBeGreaterThan(0);
      expect(visible.length).toBeLessThan(50);
      expect(await touched()).toEqual(visible);
    });

    it("bütçe 0 iken iki modda da hiçbir satır güncellenmez", async () => {
      const q = await buildContext(pool, ctxA, 0, "kumquat");
      const s = await buildContext(pool, ctxA, 0);
      expect(q.text).toBe("");
      expect(s.text).toBe("");
      expect(await touched()).toEqual([]);
    });

    it("fact bütçeyi doldurursa iki modda da memory recency değişmez", async () => {
      const value = "x".repeat(100);
      await admin.query(
        "INSERT INTO facts(workspace_id, user_id, scope, category, key, value) VALUES ($1, NULL, 'workspace', 'profile', 'budget', $2)",
        [WS_A, value],
      );
      const factLine = `# Facts\n- [profile] budget: ${value}`;
      const budget = Math.ceil(factLine.length / 4);
      for (const query of [undefined, "kumquat"]) {
        const built = await buildContext(pool, ctxA, budget, query);
        expect(built.text).toBe(factLine);
        expect(await touched()).toEqual([]);
      }
    });

    it("ilk yüksek öncelikli memory sığmazsa önek sözleşmesi ve sıfır güncelleme korunur", async () => {
      await admin.query(
        "UPDATE memories SET content = $2, importance = 10 WHERE workspace_id = $1 AND content LIKE '%[MK00]%'",
        [WS_A, `kumquat [MK00] ${"x".repeat(4000)}`],
      );
      const built = await buildContext(pool, ctxA, 60);
      expect(built).toEqual({ text: "", tokenEstimate: 0 });
      expect(await touched()).toEqual([]);
    });

    it("doğrudan recall varsayılanı yalnız dönen limit kadar kaydı günceller", async () => {
      const result = await recall(pool, ctxA, noop, { query: "kumquat", limit: 3 });
      expect(result.hits).toHaveLength(3);
      const visible = markersIn(result.hits.map((hit) => hit.content).join("\n"));
      expect(await touched()).toEqual(visible);
    });

    it("dahili touch:false doğrudan recall adaylarını salt okunur bırakır", async () => {
      const result = await recall(pool, ctxA, noop, { query: "kumquat", limit: 3 }, undefined, {
        touch: false,
      });
      expect(result.hits).toHaveLength(3);
      expect(await touched()).toEqual([]);
    });

    it("tarihsel ve superseded sorgu touch:true olsa da salt okunur kalır", async () => {
      const asOf = new Date(Date.now() + 60_000).toISOString();
      for (const mode of [{ includeSuperseded: true }, { asOf }]) {
        const result = await recall(
          pool,
          ctxA,
          noop,
          { query: "kumquat", limit: 3, ...mode },
          undefined,
          { touch: true },
        );
        expect(result.hits).toHaveLength(3);
        expect(await touched()).toEqual([]);
      }
    });

    it("kullanıcılı bağlamda yalnız görünen workspace ve kendi kişisel satırları güncellenir", async () => {
      const built = await buildContext(pool, { workspaceId: WS_A, userId: OTHER_USER }, 60);
      const visible = markersIn(built.text);
      expect(visible).toContain("[PU00]");
      expect(visible.some((marker) => marker.startsWith("[OB"))).toBe(false);
      expect(await touched()).toEqual(visible);
    });
  },
);
