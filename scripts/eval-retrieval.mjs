#!/usr/bin/env node
/**
 * D-27 — measure the ranker instead of asserting it.
 *
 *   npm run build && node scripts/eval-retrieval.mjs
 *
 * For every question in docs/eval/probe-gold.json (the 30 registry entries x their
 * probeQueries), fetch that library's document through the real fetcher, rank its
 * sections with BOTH the legacy overlap ranker (copied verbatim below, so the
 * comparison survives the legacy code being deleted from src/) and the current BM25
 * ranker, and report:
 *
 *   - the top-1 section each ranker chose, and whether it matches the gold regexes
 *   - hit rate over all 60 questions and over the answerable subset
 *   - average rendered response size, in approximate tokens (chars / 4)
 *
 * The gold set is labelled from the documents, not from either ranker's output; a
 * question the corpus cannot answer has `expect: []` and can never be a hit.
 *
 * Network: the fetcher walks each entry's candidate URLs in order. In a sandbox that
 * cannot reach docs sites, every entry resolves to its raw.githubusercontent.com
 * README fallback — the report records which URL was actually used, per library.
 *
 * The cache lives in a fixed directory under the OS temp dir so a second run is
 * offline and identical; delete it (or set VIBECTX_CACHE_DIR yourself) to refetch.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = process.env.VIBECTX_CACHE_DIR ?? join(tmpdir(), "vibectx-eval-cache");
mkdirSync(cacheDir, { recursive: true });
process.env.VIBECTX_CACHE_DIR = cacheDir;

const { DEFAULT_REGISTRY } = await import(join(repoRoot, "dist/registry.js"));
const { getLibraryDoc } = await import(join(repoRoot, "dist/fetcher.js"));
const current = await import(join(repoRoot, "dist/retrieval.js"));

const BUDGET_TOKENS = 4000;

/* ------------------------------------------------------------------ *
 * The legacy ranker, copied verbatim from src/retrieval.ts at
 * 5b31f33 (the commit this branch is stacked on). Kept here and only
 * here so the baseline cannot drift with src/.
 * ------------------------------------------------------------------ */

function legacyTokenize(text) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

function legacySplitSections(markdown) {
  const lines = markdown.split("\n");
  const sections = [];
  let current = { heading: "(intro)", body: [] };
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.+)/.exec(line);
    if (m) {
      if (current.body.some((l) => l.trim()) || current.heading !== "(intro)") {
        sections.push(current);
      }
      current = { heading: m[2].trim(), body: [] };
    } else {
      current.body.push(line);
    }
  }
  sections.push(current);
  return sections
    .map((s) => ({ heading: s.heading, body: s.body.join("\n").trim() }))
    .filter((s) => s.body.length > 0 || s.heading !== "(intro)");
}

function legacyRank(markdown, query) {
  const terms = [...new Set(legacyTokenize(query))];
  if (terms.length === 0) return [];
  return legacySplitSections(markdown)
    .map((s) => {
      const headingTokens = new Set(legacyTokenize(s.heading));
      const bodyTokens = legacyTokenize(s.body);
      const bodyCounts = new Map();
      for (const t of bodyTokens) bodyCounts.set(t, (bodyCounts.get(t) ?? 0) + 1);
      let score = 0;
      for (const term of terms) {
        if (headingTokens.has(term)) score += 3;
        const c = bodyCounts.get(term) ?? 0;
        if (c > 0) score += 1 + Math.min(c, 5) / (1 + Math.log(1 + bodyTokens.length));
      }
      return { heading: s.heading, body: s.body, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
}

const legacyRenderSection = (s) => `## ${s.heading}\n\n${s.body}`;

function legacyAssemble(sections, maxTokens) {
  const budget = maxTokens * 4;
  const chosen = [];
  let used = 0;
  for (const s of sections) {
    const chunk = legacyRenderSection(s);
    if (used + chunk.length > budget && chosen.length > 0) break;
    chosen.push(s);
    used += chunk.length;
  }
  return chosen
    .map((s) => {
      const chunk = legacyRenderSection(s);
      return chunk.length > budget ? chunk.slice(0, budget) : chunk;
    })
    .join("\n\n---\n\n");
}

/* ------------------------------------------------------------------ */

/**
 * D-32 — the gold set is a versioned data contract, not a convenient blob. This script
 * is the only reader, so it is the only place the shape can be checked: it validates
 * before it measures and fails loudly, because a silently half-read gold set produces
 * numbers that look exactly like real ones.
 *
 * Version 1 (retired 2026-09-20, PAR-827): `{ schemaVersion: 1, provenance: string,
 * gold: [...] }`, labelled against the GitHub-README-fallback corpus a network-less
 * sandbox was stuck with.
 *
 * Version 2 (PAR-827) adds ONE required top-level key, `sources`: a map from library
 * name to `{ url: string, corpusKind: string }` — the EXACT URL (and a short label for
 * what kind of document it is: `docs-site-full-text`, `index-only`,
 * `github-readme-fallback`, `docs-repo-page-fallback`) the labeller actually fetched and
 * read when writing that library's `expect` values. This is what closes the exact gap
 * PAR-827 itself found: a label file whose `provenance` note claims one corpus while a
 * run actually resolves a DIFFERENT one (the sandbox silently falling back to a README
 * when the docs site is unreachable, or a docs site discontinuing an endpoint between
 * labelling and a later run — see PAR-839's own live finding for tailwindcss) used to
 * print a score with no signal that the labels no longer describe what was measured.
 * `checkSourcesMatch` below is what acts on it, after every document is fetched.
 */
const GOLD_SCHEMA_VERSION = 2;

function validateGold(g) {
  const fail = (why) => {
    throw new Error(`docs/eval/probe-gold.json: ${why} — refusing to report numbers from a gold set this script cannot read`);
  };
  if (g === null || typeof g !== "object" || Array.isArray(g)) fail("not a JSON object");
  if (g.schemaVersion !== GOLD_SCHEMA_VERSION) {
    fail(`schemaVersion is ${JSON.stringify(g.schemaVersion)}, this script reads ${GOLD_SCHEMA_VERSION}`);
  }
  if (typeof g.provenance !== "string" || g.provenance.trim() === "") fail("provenance must be a non-empty string");
  if (!Array.isArray(g.gold) || g.gold.length === 0) fail("gold must be a non-empty array");
  if (g.sources === null || typeof g.sources !== "object" || Array.isArray(g.sources)) {
    fail("sources must be an object mapping library name -> { url, corpusKind }");
  }
  g.gold.forEach((q, i) => {
    const at = `gold[${i}]`;
    if (q === null || typeof q !== "object" || Array.isArray(q)) fail(`${at} is not an object`);
    for (const key of ["library", "query"]) {
      if (typeof q[key] !== "string" || q[key].trim() === "") fail(`${at}.${key} must be a non-empty string`);
    }
    if (!Array.isArray(q.expect) || q.expect.some((r) => typeof r !== "string" || r === "")) {
      fail(`${at}.expect must be an array of non-empty strings`);
    }
    for (const r of q.expect) {
      try {
        new RegExp(r, "i");
      } catch (e) {
        fail(`${at}.expect contains an invalid regex ${JSON.stringify(r)}: ${e.message}`);
      }
    }
    if (q.unanswerable !== undefined && q.unanswerable !== true) fail(`${at}.unanswerable, when present, must be true`);
    if ((q.unanswerable === true) !== (q.expect.length === 0)) {
      fail(`${at} ("${q.library}" / "${q.query}"): unanswerable=${q.unanswerable} disagrees with expect.length=${q.expect.length}`);
    }
    if (q.note !== undefined && typeof q.note !== "string") fail(`${at}.note must be a string`);
    // PAR-827 — every library a question names must have a declared source: an entry with
    // no source at all is exactly the "labels describe a corpus nobody can verify" gap.
    const src = g.sources[q.library];
    if (src === undefined || typeof src !== "object" || src === null) {
      fail(`${at}: "${q.library}" has no entry in sources — cannot verify what corpus this label was written against`);
    }
    if (typeof src.url !== "string" || src.url.trim() === "") fail(`sources["${q.library}"].url must be a non-empty string`);
    if (typeof src.corpusKind !== "string" || src.corpusKind.trim() === "") fail(`sources["${q.library}"].corpusKind must be a non-empty string`);
  });
  if (typeof g.questions === "number" && g.questions !== g.gold.length) {
    fail(`questions says ${g.questions} but gold has ${g.gold.length} entries`);
  }
  return g;
}

const gold = validateGold(JSON.parse(readFileSync(join(repoRoot, "docs/eval/probe-gold.json"), "utf8")));
const entries = new Map(DEFAULT_REGISTRY.map((e) => [e.name, e]));

/**
 * PAR-827 — the whole point of `sources`: a run that resolves a DIFFERENT document than
 * the one the gold set's labels were written against is not measuring what it claims to.
 * Collected here, acted on once every library has been attempted (below the fetch loop) —
 * one loud report naming every mismatch, not a failure on the first one, since a caller
 * debugging a corpus drift needs to see the whole extent of it in one run.
 */
const corpusMismatches = [];

/** Fetch each library's document once. */
const docs = new Map();
for (const name of new Set(gold.gold.map((q) => q.library))) {
  const entry = entries.get(name);
  if (!entry) throw new Error(`gold names a library that is not in the registry: ${name}`);
  const doc = await getLibraryDoc(entry, {});
  if (!doc) {
    console.error(`! ${name}: no candidate URL reachable and nothing cached — its questions are skipped`);
    continue;
  }
  docs.set(name, doc);
  process.stderr.write(`fetched ${name} <- ${doc.url} (${doc.content.length} chars)\n`);
  const declared = gold.sources[name];
  if (declared.url !== doc.url) {
    corpusMismatches.push({ library: name, declaredUrl: declared.url, resolvedUrl: doc.url });
  }
}

if (corpusMismatches.length > 0) {
  console.error(`\n! REFUSING TO SCORE (PAR-827): ${corpusMismatches.length} librar${corpusMismatches.length === 1 ? "y" : "ies"} resolved to a document different from the one docs/eval/probe-gold.json's labels were written against:`);
  for (const m of corpusMismatches) {
    console.error(`    ${m.library}: labels are for ${m.declaredUrl}, this run resolved ${m.resolvedUrl}`);
  }
  console.error(
    "  The corpus has moved since these labels were written (a site's llms.txt/llms-full.txt " +
      "candidate list changed, or the fetcher's fallback order picked a different candidate this " +
      "time). Re-label the affected libraries (see docs/eval/probe-gold.json's own `sources` map) " +
      "before trusting a score from this run — a stale label describes a document that is not the " +
      "one this run actually read.\n",
  );
  process.exitCode = 1;
  process.exit(1);
}

/** heading+body -> rendered heading path, so a legacy pick can be named the same way. */
function pathIndex(markdown) {
  const index = new Map();
  for (const s of current.splitSections(markdown)) {
    index.set(`${s.heading}\n${s.body}`, current.headingPath(s));
  }
  return index;
}

const isHit = (label, expect) =>
  expect.length > 0 && expect.some((re) => new RegExp(re, "i").test(label));

const rows = [];
let skipped = 0;
for (const q of gold.gold) {
  const doc = docs.get(q.library);
  if (!doc) {
    skipped += 1;
    continue;
  }
  const paths = pathIndex(doc.content);

  const legacyRanked = legacyRank(doc.content, q.query);
  const legacyTop = legacyRanked[0];
  const legacyLabel = legacyTop
    ? (paths.get(`${legacyTop.heading}\n${legacyTop.body}`) ?? legacyTop.heading)
    : "(no sections matched)";
  const legacyChars = legacyAssemble(legacyRanked, BUDGET_TOKENS).length;

  const bm25Ranked = current.rankSections(doc.content, q.query);
  const bm25Top = bm25Ranked[0];
  const bm25Label = bm25Top ? current.headingPath(bm25Top) : "(no sections matched)";
  const bm25Chars = current.assemble(bm25Ranked, BUDGET_TOKENS).length;

  const snippets = current.rankSnippets(doc.content, q.query);

  rows.push({
    library: q.library,
    query: q.query,
    url: doc.url,
    answerable: q.expect.length > 0,
    legacyLabel,
    legacyHit: isHit(legacyLabel, q.expect),
    legacyTokens: legacyChars / 4,
    bm25Label,
    bm25Hit: isHit(bm25Label, q.expect),
    bm25Tokens: bm25Chars / 4,
    snippets: snippets.length,
  });
}

const cut = (s, n) => (s.length <= n ? s.padEnd(n) : `${s.slice(0, n - 1)}…`);
const mark = (hit, answerable) => (hit ? "HIT " : answerable ? "miss" : "n/a ");

console.log(`\nvibectx retrieval eval — ${new Date().toISOString()}`);
console.log(`cache: ${cacheDir}`);
console.log(`gold:  docs/eval/probe-gold.json (${gold.provenance})\n`);

console.log(
  `${cut("library", 15)} ${cut("query", 26)} ${cut("legacy top-1", 44)} L    ${cut("BM25 top-1", 44)} B`,
);
console.log("-".repeat(15 + 26 + 44 + 44 + 14));
for (const r of rows) {
  console.log(
    `${cut(r.library, 15)} ${cut(r.query, 26)} ${cut(r.legacyLabel, 44)} ${mark(r.legacyHit, r.answerable)} ${cut(
      r.bm25Label,
      44,
    )} ${mark(r.bm25Hit, r.answerable)}`,
  );
}

const answerable = rows.filter((r) => r.answerable);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const avg = (xs) => (xs.length === 0 ? 0 : sum(xs) / xs.length);
const legacyHits = rows.filter((r) => r.legacyHit).length;
const bm25Hits = rows.filter((r) => r.bm25Hit).length;
const pct = (n, d) => (d === 0 ? "0.0" : ((100 * n) / d).toFixed(1));

console.log(`\nquestions:            ${rows.length}${skipped ? ` (${skipped} skipped, document unreachable)` : ""}`);
console.log(`answerable from this corpus: ${answerable.length} (the rest have no correct section — gold expect: [])`);
console.log(`top-1 hit rate  legacy: ${legacyHits}/${rows.length} (${pct(legacyHits, rows.length)}%)  ` +
  `= ${legacyHits}/${answerable.length} (${pct(legacyHits, answerable.length)}%) of answerable`);
console.log(`top-1 hit rate  BM25:   ${bm25Hits}/${rows.length} (${pct(bm25Hits, rows.length)}%)  ` +
  `= ${bm25Hits}/${answerable.length} (${pct(bm25Hits, answerable.length)}%) of answerable`);
console.log(`avg rendered response  legacy: ${avg(rows.map((r) => r.legacyTokens)).toFixed(0)} tokens (chars/4)`);
console.log(`avg rendered response  BM25:   ${avg(rows.map((r) => r.bm25Tokens)).toFixed(0)} tokens (chars/4)`);
console.log(`questions with >=1 matching code snippet (mode "snippets"): ${rows.filter((r) => r.snippets > 0).length}/${rows.length}`);
const NO_MATCH = "(no sections matched)";
console.log(`"no sections matched" responses  legacy: ${rows.filter((r) => r.legacyLabel === NO_MATCH).length}/${rows.length}  ` +
  `BM25: ${rows.filter((r) => r.bm25Label === NO_MATCH).length}/${rows.length}`);

const changed = rows.filter((r) => r.legacyLabel !== r.bm25Label).length;
const won = rows.filter((r) => r.bm25Hit && !r.legacyHit);
const lost = rows.filter((r) => r.legacyHit && !r.bm25Hit);
console.log(`top-1 changed on ${changed}/${rows.length} questions; BM25 gained ${won.length}, lost ${lost.length}`);
for (const r of won) console.log(`  + ${r.library} "${r.query}": ${r.legacyLabel}  ->  ${r.bm25Label}`);
for (const r of lost) console.log(`  - ${r.library} "${r.query}": ${r.legacyLabel}  ->  ${r.bm25Label}`);
