#!/usr/bin/env node
/**
 * D-37/D-43 — the SECOND row of the README's scale table, measured rather than remembered.
 *
 *   npm run build && node scripts/probe-search-scale.mjs
 *
 * `test/search-perf.test.ts` prints the first row (5.63 MB in 12 documents) on every run,
 * because that is the shape D-37 sets its 300 ms budget over. The second row is the shape a
 * reader wants when they ask what happens at thirty full `llms-full.txt` documents, and it is
 * too slow and too large to run inside the suite — so it lives here, as a script, and the
 * README cites the script rather than a number nobody can reproduce.
 *
 * What it prints is the row itself: corpus size and document count, the index file and what
 * fraction of the corpus it is, warm `search` time (best–worst of several runs), and the
 * one-off cost of building the index.
 *
 * The corpus is generated, never fetched: no network, deterministic, and the same prose shape
 * as the perf test's fixture (the same recurring vocabulary, so IDF has work to do and the
 * index is priced on realistic — not pathological — vocabulary). Everything is written to a
 * temporary directory and deleted on the way out.
 *
 * Tunables, all optional:
 *   PROBE_DOCS=30            documents in the corpus
 *   PROBE_SECTIONS=2230      sections per document (~4.8 MB each at this prose size)
 *   PROBE_WARM_RUNS=5        warm searches to time
 *   PROBE_KEEP=1             leave the corpus and index on disk, and print where they are
 */

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = Number(process.env.PROBE_DOCS ?? 30);
const SECTIONS_PER_DOC = Number(process.env.PROBE_SECTIONS ?? 2230);
const WARM_RUNS = Number(process.env.PROBE_WARM_RUNS ?? 5);
const KEEP = process.env.PROBE_KEEP === "1";
const QUERY = "stream server-sent events to the browser";

const dir = mkdtempSync(join(tmpdir(), "vibectx-probe-scale-"));
process.env.VIBECTX_CACHE_DIR = dir;

const { writeCache } = await import(join(repoRoot, "dist/cache.js"));
const { resetSearchIndexMemo, searchIndexPath, MAX_INDEXED_DOC_BYTES } = await import(
  join(repoRoot, "dist/search-index.js")
);
const { runSearch } = await import(join(repoRoot, "dist/search.js"));

/* The perf test's prose, kept identical so the two rows measure the same shape at two sizes. */
const TOPICS = [
  "routing middleware handlers",
  "streaming responses to the client",
  "caching and revalidation",
  "authentication sessions and tokens",
  "database queries and migrations",
  "testing and mocking",
  "configuration and environment variables",
  "deployment and edge runtimes",
];
const FILLER =
  "The framework exposes a small surface: create the handler, register it on the router, and return a response. " +
  "Values are validated before they reach the handler, and every error is reported with the same shape. " +
  "Prefer the typed helper over the raw object; it does the same work and keeps the types honest. ";

function makeDoc(library, seed) {
  const lines = [`# ${library}`, "", `Documentation for ${library}.`, ""];
  for (let s = 0; s < SECTIONS_PER_DOC; s++) {
    const topic = TOPICS[(s + seed) % TOPICS.length];
    lines.push(`## ${topic} ${s}`, "");
    for (let p = 0; p < 6; p++) lines.push(`${FILLER}Section ${s} of ${library} covers ${topic}.`, "");
    if (s % 7 === 0)
      lines.push("```ts", `const ${library.replace(/[^a-z]/g, "")}${s} = createHandler({ path: "/x" });`, "```", "");
  }
  // One library, and only one, documents the query's subject in its own words.
  if (seed === 3)
    lines.push("## Server-sent events", "", "Use the SSE helper to stream server-sent events to the browser as tokens arrive.", "");
  return lines.join("\n");
}

const MB = (bytes) => bytes / 1024 / 1024;

try {
  resetSearchIndexMemo();
  const entries = new Map();
  let corpusBytes = 0;
  let largestDoc = 0;
  const writeStart = performance.now();
  for (let i = 0; i < DOCS; i++) {
    const name = `probe-lib-${i}`;
    const url = `https://probe-lib-${i}.example.com/llms-full.txt`;
    const doc = makeDoc(name, i);
    const bytes = Buffer.byteLength(doc, "utf8");
    corpusBytes += bytes;
    largestDoc = Math.max(largestDoc, bytes);
    writeCache(name, url, doc);
    entries.set(name, { name, urls: [url] });
  }
  const writeMs = performance.now() - writeStart;
  const registry = { entries };

  // A document over MAX_INDEXED_DOC_BYTES is tokenized at query time instead of indexed, which
  // would measure something else entirely — say so rather than print a mislabelled row.
  if (largestDoc > MAX_INDEXED_DOC_BYTES) {
    console.error(
      `probe: the largest document is ${MB(largestDoc).toFixed(2)} MB, over the ` +
        `${MB(MAX_INDEXED_DOC_BYTES).toFixed(0)} MB indexing limit — lower PROBE_SECTIONS.`,
    );
    process.exitCode = 1;
  }

  // COLD: the index does not exist yet, so this call tokenizes the corpus and writes it. At
  // most MAX_LAZY_INDEX_DOCS documents are taken in per call, so the build may take more than
  // one call on a corpus larger than that bound; every call is counted.
  let coldMs = 0;
  let coldCalls = 0;
  let indexed = 0;
  let cold;
  do {
    const start = performance.now();
    cold = runSearch(registry, { query: QUERY });
    const elapsed = performance.now() - start;
    // Only a call that actually tokenized something is part of the build; the call that finds
    // nothing left to index is a warm search and belongs in the other measurement.
    if (cold.tokenized > 0) {
      coldMs += elapsed;
      coldCalls += 1;
      indexed += cold.tokenized;
    }
  } while (cold.tokenized > 0 && coldCalls < DOCS);
  const indexBytes = statSync(searchIndexPath()).size;

  // WARM: the index is on disk and nothing is tokenized but the query.
  const warm = [];
  let last;
  for (let run = 0; run < WARM_RUNS; run++) {
    resetSearchIndexMemo(); // each run pays the JSON.parse, which is what dominates at this size
    const start = performance.now();
    last = runSearch(registry, { query: QUERY });
    warm.push(performance.now() - start);
  }
  const lo = Math.min(...warm);
  const hi = Math.max(...warm);

  const correct = last.groups[0]?.library === "probe-lib-3" && last.tokenized === 0 && last.fromIndex === DOCS;

  console.log("");
  console.log(`[PROBE MEASURED] node ${process.version} · ${process.platform}/${process.arch}`);
  console.log(
    `corpus ${MB(corpusBytes).toFixed(0)} MB in ${DOCS} documents (${MB(corpusBytes / DOCS).toFixed(2)} MB each, ` +
      `generated in ${(writeMs / 1000).toFixed(1)} s)`,
  );
  console.log(
    `index file ${MB(indexBytes).toFixed(1)} MB (${((indexBytes / corpusBytes) * 100).toFixed(0)}% of the corpus) · ` +
      `built in ${(coldMs / 1000).toFixed(1)} s over ${coldCalls} cold search${coldCalls === 1 ? "" : "es"} ` +
      `(${indexed} documents indexed)`,
  );
  console.log(
    `warm search ${lo.toFixed(0)}–${hi.toFixed(0)} ms over ${WARM_RUNS} runs ` +
      `[${warm.map((m) => m.toFixed(0)).join(", ")}]`,
  );
  console.log("");
  console.log("README row: | " +
    `${MB(corpusBytes).toFixed(0)} MB, ${DOCS} documents | ${MB(indexBytes).toFixed(1)} MB ` +
    `(${((indexBytes / corpusBytes) * 100).toFixed(0)}%) | **${lo.toFixed(0)}–${hi.toFixed(0)} ms** | ` +
    `${(coldMs / 1000).toFixed(1)} s |`);
  console.log("");

  // The row is only worth printing if the search it timed actually answered.
  if (!correct) {
    console.error(
      `probe: the warm search did not answer from the index as expected ` +
        `(top library ${last.groups[0]?.library ?? "none"}, fromIndex ${last.fromIndex}, tokenized ${last.tokenized}).`,
    );
    process.exitCode = 1;
  }
} finally {
  if (KEEP) console.log(`probe: corpus and index left in ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
}
