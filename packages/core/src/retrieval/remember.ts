import type { Pool } from "pg";
import type { Embedder, MemoryContext, RememberInput, RememberResponse } from "../types.js";
import { clampImportance, requireRow, toVectorLiteral } from "./sql.js";
import { withTenant } from "./tenant.js";

/** Above this cosine similarity, a new memory is treated as a near-duplicate. */
export const SUPERSEDE_THRESHOLD = 0.9;

interface SimilarRow {
  id: string;
  similarity: number;
}

/**
 * Write a memory, deduplicating against semantically near-identical existing
 * memories (cosine similarity > 0.9). On a hit we *supersede*: overwrite the
 * stored content with the fresher text, keep the stronger importance, refresh
 * provenance + last_accessed, and re-embed. Returns the surviving id.
 *
 * With the noop embedder (or if embedding fails) there is no vector to compare,
 * so we always insert a fresh row with a NULL embedding (full-text only).
 */
export async function remember(
  pool: Pool,
  ctx: MemoryContext,
  embedder: Embedder,
  input: RememberInput,
): Promise<RememberResponse> {
  const content = input.content.trim();
  if (!content) throw new Error("remember: content must be non-empty");

  const scope = input.scope ?? "personal";
  const importance = clampImportance(input.importance);
  const source = input.source ?? null;

  let vector: number[] | null = null;
  if (embedder.dim > 0) {
    try {
      const [vec] = await embedder.embed([content]);
      vector = vec ?? null;
    } catch (err) {
      // Degrade gracefully: store without a vector rather than lose the memory.
      console.warn(
        `[dolores] remember: embedding failed, storing full-text only: ${asMessage(err)}`,
      );
    }
  }

  return withTenant(pool, ctx, async (client) => {
    if (vector) {
      const literal = toVectorLiteral(vector);
      const similar = await client.query<SimilarRow>(
        `SELECT id, 1 - (embedding <=> $1::vector) AS similarity
           FROM memories
          WHERE embedding IS NOT NULL AND scope = $2
          ORDER BY embedding <=> $1::vector
          LIMIT 1`,
        [literal, scope],
      );

      const top = similar.rows[0];
      if (top && top.similarity > SUPERSEDE_THRESHOLD) {
        const updated = await client.query<{ id: string }>(
          `UPDATE memories
              SET content = $1,
                  importance = GREATEST(importance, $2),
                  source = COALESCE($3, source),
                  embedding = $4::vector,
                  last_accessed = now()
            WHERE id = $5
            RETURNING id`,
          [content, importance, source, literal, top.id],
        );
        return { id: updated.rows[0]?.id ?? top.id, deduped: true };
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO memories (workspace_id, user_id, scope, content, importance, source, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector)
         RETURNING id`,
        [ctx.workspaceId, ctx.userId ?? null, scope, content, importance, source, literal],
      );
      return { id: requireRow(inserted.rows, "remember insert").id, deduped: false };
    }

    // No vector (noop embedder or embed failure): plain insert, NULL embedding.
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO memories (workspace_id, user_id, scope, content, importance, source, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, NULL)
       RETURNING id`,
      [ctx.workspaceId, ctx.userId ?? null, scope, content, importance, source],
    );
    return { id: requireRow(inserted.rows, "remember insert").id, deduped: false };
  });
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
