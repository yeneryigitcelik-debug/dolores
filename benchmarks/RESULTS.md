# dolores Benchmark Results

> **Real numbers** — produced by `pnpm bench` against a local Postgres instance
> (localhost:5544) with bge-small-en-v1.5 embeddings (384 dims, IVFFlat index).
> Run date: 2026-06-20.

---

## 1. Token Savings

**Setup:**
- Synthetic memories: 20 templates × N (diverse tech/project notes, ~82 chars avg).
- NAIVE: every memory's `tokenEstimate(content)` summed — what an agent pays when it dumps the full memory store into the prompt.
- DOLORES: `buildContext(pool, ctx, maxTokens=600, query, embedder)` — hybrid recall selects the most relevant ~6 memories and renders them within a 600-token budget.
- Query used: _"API authentication, JWT tokens, and security configuration best practices"_.
- Embedder: bge-small-en-v1.5 (local CPU).
- Scale: 100 / 500 / 1000 / 1500 memories in isolated workspaces; full cleanup after each run.

### Table

| N    | Naive (tokens) | Dolores (tokens) | Savings |
|------|---------------|-----------------|---------|
| 100  | 2,049         | 582             | **72%** |
| 500  | 10,251        | 591             | **94%** |
| 1,000 | 20,502       | 591             | **97%** |
| 1,500 | 30,768       | 591             | **98%** |

### ASCII Bar Chart (relative to N=1500 naive)

```
N=100   NAIVE   ██░░░░░░░░░░░░░░░░░░░░░░░░░░░░  2,049 tok
        DOLORES █░░░░░░░░░░░░░░░░░░░░░░░░░░░░░    582 tok

N=500   NAIVE   ██████████░░░░░░░░░░░░░░░░░░░░ 10,251 tok
        DOLORES █░░░░░░░░░░░░░░░░░░░░░░░░░░░░░    591 tok

N=1000  NAIVE   ████████████████████░░░░░░░░░░ 20,502 tok
        DOLORES █░░░░░░░░░░░░░░░░░░░░░░░░░░░░░    591 tok

N=1500  NAIVE   ██████████████████████████████ 30,768 tok
        DOLORES █░░░░░░░░░░░░░░░░░░░░░░░░░░░░░    591 tok
```

**Key insight:** dolores context stays flat (~591 tokens) regardless of memory store size, while naive cost scales linearly. The saving grows from 72% at 100 memories to 98% at 1,500.

---

## 2. Recall Quality

**Setup:**
- 30 ground-truth memories about a fictional SaaS project (auth, infra, CI, etc.).
- 170 noise memories (sprint notes, HR items, unrelated topics) → **200 total**.
- 30 eval queries: 10 exact, 10 paraphrase, 10 semantic.
- Embedder: bge-small-en-v1.5 (hybrid arm) vs. NoOpEmbedder (full-text only baseline).
- Limit: top-5 recall.
- Metric: hit@k = expected memory ID appears in top k results.

### Hybrid (pgvector + full-text, bge-small-en-v1.5)

| Query type  | N  | hit@1  | hit@3  | hit@5  |
|-------------|-----|--------|--------|--------|
| exact       | 10  | 100%   | 100%   | 100%   |
| paraphrase  | 10  | 100%   | 100%   | 100%   |
| semantic    | 10  |  60%   |  60%   |  60%   |
| **ALL**     | **30** | **87%** | **87%** | **87%** |

### Full-text Only (NoOpEmbedder baseline)

| Query type  | N  | hit@1  | hit@3  | hit@5  |
|-------------|-----|--------|--------|--------|
| exact       | 10  | 100%   | 100%   | 100%   |
| paraphrase  | 10  |   0%   |   0%   |   0%   |
| semantic    | 10  |   0%   |   0%   |   0%   |
| **ALL**     | **30** | **33%** | **33%** | **33%** |

**Key insight:** Hybrid recall is **2.6× better than full-text alone** on this eval set (87% vs 33% hit@1). Full-text completely fails on paraphrase and semantic queries — exactly the use cases dolores is designed for. Hybrid success on paraphrase is 100% (vector search bridges vocabulary gaps); semantic reaches 60% even with a generic 84MB model running on CPU.

The hit@k scores are equal across k=1,2,3 because when hybrid scoring ranks the target memory, it scores it strongly enough to land at position 1. When it misses (semantic category), the target falls below position 5.

---

## Method Notes

- **Tokenizer:** `tokenEstimate(text) = ceil(text.length / 4)` — the same cheap estimator dolores uses for budgeting. Real tiktoken counts would be 5–10% different but the ratio is identical.
- **Pool:** Admin role (`dolores`, BYPASSRLS) used throughout for benchmarks; explicit `workspace_id` filters in the retrieval SQL ensure isolation identical to the app role.
- **Cleanup:** Each scale uses a unique UUID workspace. `DELETE FROM memories WHERE workspace_id = $1` runs in `finally` blocks. DB row count before and after is unchanged (10 pre-existing rows).
- **Model cache:** `packages/core/.dolores-models/fast-bge-small-en-v1.5` — model loaded once and shared across both benchmarks.
- **IVFFlat probes:** Default 10 at query time (`DOLORES_IVFFLAT_PROBES`).

---

## Reproducing

```bash
# From repo root, with DB running (pnpm db:up):
DATABASE_URL='postgresql://dolores:dolores@localhost:5544/dolores' pnpm bench
```

The `bench` script pre-sets `DOLORES_MODEL_CACHE=packages/core/.dolores-models` so the ONNX model is found without downloading.
