import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { Embedder, FactInput, MemoryContext, Scope } from "../types.js";
import { batchUpsertFacts, upsertFact } from "./facts.js";
import { _rememberPreembedded, remember } from "./remember.js";
import { resolveWriteOwner } from "./scope.js";

const WS = "11111111-1111-1111-1111-111111111111";
const ALICE = "22222222-2222-2222-2222-222222222222";

// Gerçek bir kullanıcı içermeyen bağlamlar: yok / null / boş / sadece boşluk.
const noUserContexts: ReadonlyArray<[string, MemoryContext]> = [
  ["userId yok", { workspaceId: WS }],
  ["userId null", { workspaceId: WS, userId: null }],
  ["userId boş", { workspaceId: WS, userId: "" }],
  ["userId boşluk", { workspaceId: WS, userId: "   " }],
];

const aliceCtx = (): MemoryContext => ({ workspaceId: WS, userId: ALICE });

// Dokunulursa fırlatan sahte Pool: connect/query çağrılmamalı.
function makeFakePool(): {
  pool: Pool;
  connect: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
} {
  const connect = vi.fn((): never => {
    throw new Error("pool.connect çağrılmamalıydı");
  });
  const query = vi.fn((): never => {
    throw new Error("pool.query çağrılmamalıydı");
  });
  const fake: unknown = { connect, query };
  return { pool: fake as Pool, connect, query };
}

// Dokunulursa fırlatan sahte embedder: embed/ready çağrılmamalı.
function makeFakeEmbedder(): {
  embedder: Embedder;
  embed: ReturnType<typeof vi.fn>;
  ready: ReturnType<typeof vi.fn>;
} {
  const embed = vi.fn(async (_texts: string[]): Promise<number[][]> => {
    throw new Error("embed çağrılmamalıydı");
  });
  const ready = vi.fn(async (): Promise<void> => {
    throw new Error("ready çağrılmamalıydı");
  });
  const embedder: Embedder = { id: "test:fake", dim: 3, embed, ready };
  return { embedder, embed, ready };
}

describe("resolveWriteOwner (saf politika)", () => {
  it("açık workspace her zaman userId null döner (Alice bağlamında bile)", () => {
    expect(resolveWriteOwner(aliceCtx(), "workspace")).toEqual({
      scope: "workspace",
      userId: null,
    });
    for (const [, ctx] of noUserContexts) {
      expect(resolveWriteOwner(ctx, "workspace")).toEqual({ scope: "workspace", userId: null });
    }
  });

  it("scope verilmezse Alice için personal Alice döner", () => {
    expect(resolveWriteOwner(aliceCtx())).toEqual({ scope: "personal", userId: ALICE });
  });

  it.each(noUserContexts)("scope verilmezse ve %s ise workspace null döner", (_name, ctx) => {
    expect(resolveWriteOwner(ctx)).toEqual({ scope: "workspace", userId: null });
  });

  it("açık personal Alice için personal Alice döner", () => {
    expect(resolveWriteOwner(aliceCtx(), "personal")).toEqual({ scope: "personal", userId: ALICE });
  });

  it.each(noUserContexts)("açık personal ve %s ise fırlatır", (_name, ctx) => {
    expect(() => resolveWriteOwner(ctx, "personal")).toThrow(/personal/);
  });

  it("bilinmeyen çalışma zamanı scope değerini reddeder", () => {
    const bogus: unknown = "team";
    expect(() => resolveWriteOwner(aliceCtx(), bogus as Scope)).toThrow(/invalid scope/);
    expect(() => resolveWriteOwner({ workspaceId: WS }, bogus as Scope)).toThrow(/invalid scope/);
  });

  it("bağlamı değiştirmez", () => {
    const ctx: MemoryContext = { workspaceId: WS, userId: "  " };
    const snapshot = structuredClone(ctx);
    resolveWriteOwner(ctx);
    resolveWriteOwner(ctx, "workspace");
    expect(() => resolveWriteOwner(ctx, "personal")).toThrow();
    expect(ctx).toEqual(snapshot);

    const alice = aliceCtx();
    resolveWriteOwner(alice, "workspace");
    resolveWriteOwner(alice, "personal");
    expect(alice).toEqual(aliceCtx());
  });
});

describe("yazma doğrulaması I/O öncesinde yapılır", () => {
  it.each(noUserContexts)(
    "remember: kullanıcısız personal (%s) embed ve connect öncesi reddedilir",
    async (_name, ctx) => {
      const { pool, connect, query } = makeFakePool();
      const { embedder, embed, ready } = makeFakeEmbedder();
      await expect(
        remember(pool, ctx, embedder, { content: "gizli not", scope: "personal" }),
      ).rejects.toThrow(/personal/);
      expect(embed).not.toHaveBeenCalled();
      expect(ready).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each(noUserContexts)(
    "_rememberPreembedded: kullanıcısız personal (%s) connect öncesi reddedilir",
    async (_name, ctx) => {
      const { pool, connect, query } = makeFakePool();
      await expect(
        _rememberPreembedded(
          pool,
          ctx,
          { content: "gizli not", scope: "personal" },
          [0.1, 0.2, 0.3],
        ),
      ).rejects.toThrow(/personal/);
      expect(connect).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each(noUserContexts)(
    "upsertFact: kullanıcısız personal (%s) connect öncesi reddedilir",
    async (_name, ctx) => {
      const { pool, connect, query } = makeFakePool();
      await expect(
        upsertFact(pool, ctx, {
          category: "preference",
          key: "editor",
          value: "vim",
          scope: "personal",
        }),
      ).rejects.toThrow(/personal/);
      expect(connect).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    },
  );

  it("batchUpsertFacts: geçerli workspace + geçersiz personal karışık toplu iş DB öncesi reddedilir", async () => {
    const { pool, connect, query } = makeFakePool();
    const inputs: FactInput[] = [
      { category: "stack", key: "db", value: "postgres", scope: "workspace" },
      { category: "preference", key: "editor", value: "vim", scope: "personal" },
    ];
    await expect(batchUpsertFacts(pool, { workspaceId: WS, userId: null }, inputs)).rejects.toThrow(
      /personal/,
    );
    expect(connect).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("batchUpsertFacts: boş toplu iş DB'ye dokunmaz", async () => {
    const { pool, connect, query } = makeFakePool();
    await expect(batchUpsertFacts(pool, aliceCtx(), [])).resolves.toBeUndefined();
    expect(connect).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});
