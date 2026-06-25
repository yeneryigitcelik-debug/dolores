import type { Pool } from "pg";
import { type LlmProvider, createLlmProviderFromEnv } from "../extraction/provider.js";
import { cosine } from "../retrieval/mmr.js";
import { clampImportance, parseVectorLiteral, toVectorLiteral } from "../retrieval/sql.js";
import { withTenant } from "../retrieval/tenant.js";
import type { ConsolidationSummary, Embedder, MemoryContext, Scope } from "../types.js";

/**
 * Memory consolidation (EPIC L). Periodically collapses CLUSTERS of related
 * active memories into one higher-order note, superseding the members (EPIC F
 * chain — never deletes). Shrinks the corpus and sharpens recall.
 *
 * The cheap LLM stays OFF the critical path: this is a manual/scheduled
 * background op, never invoked from recall/context. No provider (or no API key)
 * → graceful no-op. Conservative by design: supersede, not delete.
 */

export interface ConsolidationOptions {
  /** Inject a provider (tests / alt vendors). If omitted, resolved from env. */
  provider?: LlmProvider | null;
  model?: string;
  /** Restrict to one scope; omit to consolidate within each scope separately. */
  scope?: Scope;
  /** Cosine floor to group two memories. Below the 0.9 dedup line by design. */
  similarityThreshold?: number;
  /** Minimum members for a cluster to be worth consolidating. */
  minClusterSize?: number;
  /** Cap consolidations (= LLM calls) per run. */
  maxClusters?: number;
  /** Cap active memories scanned per run. */
  maxCandidates?: number;
}

interface Candidate {
  id: string;
  content: string;
  importance: number;
  scope: string;
  embedding: number[];
}

const SYNTH_SYSTEM = `You merge several related memory notes into ONE concise note for an AI assistant.
Preserve every durable fact; remove redundancy and chit-chat. Return ONLY the
merged note text — no preamble, no bullet list, no quotes.`;

async function synthesize(provider: LlmProvider, contents: string[]): Promise<string> {
  const prompt = `Notes to merge:\n${contents.map((c) => `- ${c}`).join("\n")}`;
  return provider.complete({ system: SYNTH_SYSTEM, prompt });
}

/** Greedy star clustering: group same-scope memories within `threshold` of a seed. */
function cluster(items: Candidate[], threshold: number, minSize: number): Candidate[][] {
  const visited = new Set<number>();
  const clusters: Candidate[][] = [];
  for (let i = 0; i < items.length; i++) {
    if (visited.has(i)) continue;
    const seed = items[i];
    if (!seed) continue;
    visited.add(i);
    const group: Candidate[] = [seed];
    for (let j = i + 1; j < items.length; j++) {
      if (visited.has(j)) continue;
      const other = items[j];
      if (!other || other.scope !== seed.scope) continue;
      if (cosine(seed.embedding, other.embedding) >= threshold) {
        group.push(other);
        visited.add(j);
      }
    }
    if (group.length >= minSize) clusters.push(group);
  }
  return clusters;
}

export async function consolidateMemories(
  pool: Pool,
  ctx: MemoryContext,
  embedder: Embedder,
  opts: ConsolidationOptions = {},
): Promise<ConsolidationSummary> {
  const provider =
    opts.provider !== undefined ? opts.provider : createLlmProviderFromEnv({ model: opts.model });
  const threshold = opts.similarityThreshold ?? 0.82;
  const minClusterSize = opts.minClusterSize ?? 3;
  const maxClusters = opts.maxClusters ?? 10;
  const maxCandidates = opts.maxCandidates ?? 500;

  // 1. Pull active, embedded candidates (RLS-scoped).
  const items = await withTenant(pool, ctx, async (client) => {
    const params: unknown[] = [ctx.workspaceId];
    let sql = `SELECT id, content, importance, scope, embedding::text AS emb
                 FROM memories
                WHERE superseded_by IS NULL AND embedding IS NOT NULL AND workspace_id = $1`;
    if (opts.scope) {
      params.push(opts.scope);
      sql += ` AND scope = $${params.length}`;
    }
    params.push(maxCandidates);
    sql += ` ORDER BY created_at LIMIT $${params.length}`;
    const res = await client.query<{
      id: string;
      content: string;
      importance: number;
      scope: string;
      emb: string;
    }>(sql, params);
    return res.rows.map((r) => ({
      id: r.id,
      content: r.content,
      importance: r.importance,
      scope: r.scope,
      embedding: parseVectorLiteral(r.emb),
    }));
  });

  const summary: ConsolidationSummary = {
    candidates: items.length,
    clusters: 0,
    consolidated: 0,
    superseded: 0,
  };
  if (!provider || items.length < minClusterSize) return summary;

  const clusters = cluster(items, threshold, minClusterSize);
  summary.clusters = clusters.length;

  let processed = 0;
  for (const members of clusters) {
    if (processed >= maxClusters) break;

    // 2. Synthesize OUTSIDE any transaction (the LLM call is slow).
    let consolidated: string;
    try {
      consolidated = (
        await synthesize(
          provider,
          members.map((m) => m.content),
        )
      ).trim();
    } catch (err) {
      console.warn(`[dolores] consolidation synth failed: ${asMessage(err)}`);
      continue;
    }
    if (!consolidated) continue;

    // 3. Embed the consolidated note (graceful: NULL embedding without a vector).
    let vector: number[] | null = null;
    if (embedder.dim > 0) {
      try {
        const [v] = await embedder.embed([consolidated]);
        vector = v ?? null;
      } catch {
        /* full-text only */
      }
    }

    const importance = clampImportance(Math.max(...members.map((m) => m.importance)));
    const memberScope = (members[0]?.scope ?? "personal") as Scope;

    // 4. Insert the consolidation (active) + supersede members (short transaction).
    await withTenant(pool, ctx, async (client) => {
      const ins = await client.query<{ id: string }>(
        `INSERT INTO memories (workspace_id, user_id, scope, content, importance, source, embedding)
         VALUES ($1, $2, $3, $4, $5, 'consolidation', ${vector ? "$6::vector" : "NULL"})
         RETURNING id`,
        vector
          ? [
              ctx.workspaceId,
              ctx.userId ?? null,
              memberScope,
              consolidated,
              importance,
              toVectorLiteral(vector),
            ]
          : [ctx.workspaceId, ctx.userId ?? null, memberScope, consolidated, importance],
      );
      const newId = ins.rows[0]?.id;
      if (!newId) return;
      const res = await client.query(
        `UPDATE memories SET superseded_by = $1, valid_to = now()
          WHERE id = ANY($2::uuid[]) AND superseded_by IS NULL`,
        [newId, members.map((m) => m.id)],
      );
      summary.superseded += res.rowCount ?? 0;
    });
    summary.consolidated += 1;
    processed += 1;
  }

  return summary;
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
