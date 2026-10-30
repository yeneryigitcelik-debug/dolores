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
  /** Actual stored owner (may differ from ctx user, incl. legacy rows). */
  userId: string | null;
  embedding: number[];
  // Yeniden kontrol için ham, kararlı anlık görüntü alanları (vektör yeniden üretilmez).
  rawEmbedding: string;
  source: string | null;
}

// Kilit altında yeniden okunan satırın ham alanları.
interface SnapshotRow {
  id: string;
  content: string;
  importance: number;
  scope: string;
  user_id: string | null;
  emb: string | null;
  source: string | null;
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
      if (!other || other.scope !== seed.scope || other.userId !== seed.userId) continue;
      if (cosine(seed.embedding, other.embedding) >= threshold) {
        group.push(other);
        visited.add(j);
      }
    }
    if (group.length >= minSize) clusters.push(group);
  }
  return clusters;
}

// Anlık görüntü ile kilitli satırı birebir karşılaştırır (metin/sayı/null tam eşitlik).
function snapshotMatches(original: Candidate, row: SnapshotRow): boolean {
  return (
    row.content === original.content &&
    Number(row.importance) === Number(original.importance) &&
    row.scope === original.scope &&
    (row.user_id ?? null) === original.userId &&
    row.emb !== null &&
    row.emb === original.rawEmbedding &&
    (row.source ?? null) === original.source
  );
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
    let sql = `SELECT id, content, importance, scope, user_id::text AS user_id, embedding::text AS emb, source
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
      user_id: string | null;
      emb: string;
      source: string | null;
    }>(sql, params);
    return res.rows.map(
      (r): Candidate => ({
        id: r.id,
        content: r.content,
        importance: r.importance,
        scope: r.scope,
        userId: r.user_id ?? null,
        embedding: parseVectorLiteral(r.emb),
        rawEmbedding: r.emb,
        source: r.source ?? null,
      }),
    );
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
    const first = members[0];
    if (!first) continue;
    // Owner comes from the members (same physical owner/scope), never from ctx.
    const memberScope = first.scope as Scope;
    const memberUserId = first.userId;
    const memberIds = members.map((m) => m.id);

    // 4. Lock + recheck members (they may have changed during the slow LLM call),
    //    then insert the consolidation + supersede members (short transaction).
    const applied = await withTenant(pool, ctx, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1 || ':' || coalesce($2::text, '') || ':' || $3))",
        [ctx.workspaceId, memberUserId, memberScope],
      );
      // Kararlı alanların tamamını kilitleyerek yeniden oku; inplace remember
      // güncellemelerini (içerik/önem/gömme/kaynak değişimi) yakalamak için.
      const locked = await client.query<SnapshotRow>(
        `SELECT id, content, importance, scope, user_id::text AS user_id,
                embedding::text AS emb, source
           FROM memories
          WHERE id = ANY($1::uuid[]) AND workspace_id = $2 AND scope = $3
            AND user_id IS NOT DISTINCT FROM $4::uuid AND superseded_by IS NULL
          FOR UPDATE`,
        [memberIds, ctx.workspaceId, memberScope, memberUserId],
      );
      if (locked.rows.length !== new Set(memberIds).size) return false;

      // Kimliğe göre eşleştir; herhangi bir üye eksik veya değişmişse hiçbir yazma yapma.
      const byId = new Map<string, SnapshotRow>();
      for (const row of locked.rows) byId.set(row.id, row);
      for (const m of members) {
        const row = byId.get(m.id);
        if (!row || !snapshotMatches(m, row)) return false;
      }

      const ins = await client.query<{ id: string }>(
        `INSERT INTO memories (workspace_id, user_id, scope, content, importance, source, embedding)
         VALUES ($1, $2, $3, $4, $5, 'consolidation', ${vector ? "$6::vector" : "NULL"})
         RETURNING id`,
        vector
          ? [
              ctx.workspaceId,
              memberUserId,
              memberScope,
              consolidated,
              importance,
              toVectorLiteral(vector),
            ]
          : [ctx.workspaceId, memberUserId, memberScope, consolidated, importance],
      );
      const newId = ins.rows[0]?.id;
      if (!newId) return false;
      const res = await client.query(
        `UPDATE memories SET superseded_by = $1, valid_to = now()
          WHERE id = ANY($2::uuid[]) AND superseded_by IS NULL`,
        [newId, members.map((m) => m.id)],
      );
      summary.superseded += res.rowCount ?? 0;
      return true;
    });
    if (!applied) continue;
    summary.consolidated += 1;
    processed += 1;
  }

  return summary;
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
