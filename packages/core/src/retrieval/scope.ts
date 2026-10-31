import type { MemoryContext, Scope } from "../types.js";

/** Physical owner of a write: the scope label plus the exact user_id to store. */
export interface WriteOwner {
  scope: Scope;
  /** user_id to persist. Always null for workspace writes. */
  userId: string | null;
}

function ctxUser(ctx: MemoryContext): string | null {
  const u = ctx.userId;
  return typeof u === "string" && u.trim() !== "" ? u : null;
}

/**
 * Resolve who physically owns a new write.
 *
 *  - workspace -> user_id NULL (shared), even when ctx carries a user.
 *  - personal  -> user_id = ctx user; throws when there is no user, so a
 *                 "private" write is never silently stored as shared.
 *  - omitted   -> personal when ctx has a user, workspace otherwise
 *                 (keeps the workspace-only quickstart working).
 *
 * Pure and synchronous: call it before any embedding or DB work.
 */
export function resolveWriteOwner(ctx: MemoryContext, scope?: Scope): WriteOwner {
  const user = ctxUser(ctx);
  const resolved: Scope = scope ?? (user ? "personal" : "workspace");
  if (resolved === "workspace") return { scope: "workspace", userId: null };
  if (resolved === "personal") {
    if (!user) {
      throw new Error("dolores: scope 'personal' requires a userId in the memory context");
    }
    return { scope: "personal", userId: user };
  }
  throw new Error(`dolores: invalid scope ${JSON.stringify(resolved)}`);
}
