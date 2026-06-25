/**
 * Extraction quality benchmark (v0.3 EPIC G).
 *
 * Measures how well the cheap-model extractor distils labelled transcripts into
 * the facts/memories we expect — and how well it RESISTS over-extracting
 * ephemeral chit-chat. No database needed (extractFromText is pure); it only
 * needs an extraction provider, so it SKIPS gracefully without an API key.
 *
 * Metrics:
 *   - fact recall    : labelled facts covered (matched by category + value overlap,
 *                      not exact key — key naming is model-dependent).
 *   - memory recall  : labelled memories covered (all keywords present in a note).
 *   - ephemeral discipline: % of chit-chat fixtures that correctly produced 0 items.
 *
 * Run:  pnpm build && pnpm bench:extraction
 *       (needs ANTHROPIC_API_KEY or OPENAI_API_KEY)
 */

import { createLlmProviderFromEnv, extractFromText } from "../packages/core/dist/index.js";

interface Fixture {
  label: string;
  input: string;
  /** Expected facts, matched by category + value overlap (NOT exact key). */
  facts: { category: string; value: string }[];
  /** Expected memories, each a set of keywords that must all appear in one note. */
  memories: string[][];
  /** True = transcript is pure chit-chat; the extractor should emit nothing. */
  ephemeral?: boolean;
}

const FIXTURES: Fixture[] = [
  {
    label: "stack",
    input:
      "Quick note on our setup: the frontend is Next.js, we use Prisma as the ORM on top of Postgres, and everything deploys to Vercel.",
    facts: [
      { category: "stack", value: "Next.js" },
      { category: "stack", value: "Prisma" },
      { category: "stack", value: "Postgres" },
      { category: "stack", value: "Vercel" },
    ],
    memories: [],
  },
  {
    label: "preferences",
    input: "Personally I prefer dark mode, and please use two-space indentation in the codebase.",
    facts: [
      { category: "preference", value: "dark" },
      { category: "preference", value: "two-space" },
    ],
    memories: [],
  },
  {
    label: "decision+memory",
    input:
      "After last month's outage we decided to drop Redis and move the job queue to SQS. Worth remembering the outage was caused by Redis running out of memory under load.",
    facts: [{ category: "stack", value: "SQS" }],
    memories: [["outage", "redis"]],
  },
  {
    label: "ephemeral",
    input: "haha yeah that's hilarious 😂 ok brb grabbing a coffee, talk in a sec",
    facts: [],
    memories: [],
    ephemeral: true,
  },
  {
    label: "mixed-with-noise",
    input:
      "lol nice weekend. anyway — important: prod runs Postgres 17, and the primary region is eu-central-1.",
    facts: [
      { category: "stack", value: "Postgres" },
      { category: "project", value: "eu-central-1" },
    ],
    memories: [],
  },
  {
    label: "operational-memory",
    input:
      "Heads up for next time: during the August deploy the migration ordering caused a deadlock. Always run schema migrations before data backfills.",
    facts: [],
    memories: [["migration", "deploy"]],
  },
];

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Overlap = one normalized value contains the other (handles "Postgres 17" ⊇ "Postgres"). */
function valueOverlap(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  return na.includes(nb) || nb.includes(na);
}

interface ExtractedFact {
  category: string;
  value: string;
}
interface ExtractedMemory {
  content: string;
}

function factCovered(expected: { category: string; value: string }, got: ExtractedFact[]): boolean {
  return got.some(
    (g) => norm(g.category) === norm(expected.category) && valueOverlap(expected.value, g.value),
  );
}

function memoryCovered(keywords: string[], got: ExtractedMemory[]): boolean {
  return got.some((m) => {
    const c = m.content.toLowerCase();
    return keywords.every((k) => c.includes(k.toLowerCase()));
  });
}

function hr(char = "─", width = 70): string {
  return char.repeat(width);
}

const provider = createLlmProviderFromEnv();
if (!provider) {
  console.log();
  console.log("  Extraction eval SKIPPED — no extraction provider.");
  console.log("  Set ANTHROPIC_API_KEY or OPENAI_API_KEY and re-run.");
  console.log();
  process.exit(0);
}

console.log();
console.log(hr("═"));
console.log(`  dolores extraction eval — provider: ${provider.id}`);
console.log(hr("═"));
console.log();

let factsExpected = 0;
let factsCovered = 0;
let memExpected = 0;
let memCovered = 0;
let ephemeralTotal = 0;
let ephemeralClean = 0;

for (const fx of FIXTURES) {
  const res = await extractFromText(fx.input, { enabled: true, provider });
  const gotFacts = res.facts as ExtractedFact[];
  const gotMemories = res.memories as ExtractedMemory[];

  const coveredF = fx.facts.filter((f) => factCovered(f, gotFacts)).length;
  const coveredM = fx.memories.filter((m) => memoryCovered(m, gotMemories)).length;
  factsExpected += fx.facts.length;
  factsCovered += coveredF;
  memExpected += fx.memories.length;
  memCovered += coveredM;

  let note = `facts ${coveredF}/${fx.facts.length}, memories ${coveredM}/${fx.memories.length}`;
  if (fx.ephemeral) {
    ephemeralTotal++;
    const spurious = gotFacts.length + gotMemories.length;
    if (spurious === 0) ephemeralClean++;
    note = spurious === 0 ? "clean (emitted nothing ✓)" : `LEAKED ${spurious} item(s) ✗`;
  }
  console.log(`  ${fx.label.padEnd(22)} ${note}`);
}

const factRecall = factsExpected ? Math.round((factsCovered / factsExpected) * 100) : 100;
const memRecall = memExpected ? Math.round((memCovered / memExpected) * 100) : 100;
const discipline = ephemeralTotal ? Math.round((ephemeralClean / ephemeralTotal) * 100) : 100;

console.log();
console.log(hr("═"));
console.log("  SUMMARY");
console.log(hr("═"));
console.log(`    Fact recall            ${factsCovered}/${factsExpected}  (${factRecall}%)`);
console.log(`    Memory recall          ${memCovered}/${memExpected}  (${memRecall}%)`);
console.log(`    Ephemeral discipline   ${ephemeralClean}/${ephemeralTotal}  (${discipline}%)`);
console.log();
