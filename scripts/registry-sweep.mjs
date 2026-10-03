#!/usr/bin/env node
/**
 * PAR-837 — a manual, re-runnable sweep of the curated registry's own first candidate URL.
 *
 *   npm run build && node scripts/registry-sweep.mjs
 *
 * For every entry in `DEFAULT_REGISTRY` (`src/registry.ts`), GETs the FIRST candidate URL
 * (`entry.urls[0]` — the one `resolveLibrary`'s own fetch order tries first) with real network
 * access and reports:
 *
 *   - the HTTP status code
 *   - the response body's byte count
 *   - a flag when the body is under SMALL_BODY_THRESHOLD_BYTES — a real, full-content docs
 *     dump (an `llms.txt`/`llms-full.txt` or a substantial README) is never that small; a tiny
 *     response usually means the entry's own URL moved, now 404s to a stub page, or redirects
 *     somewhere thin. Flagged for a HUMAN to look at, not auto-corrected.
 *
 * NOT run in CI and NOT wired into `npm test` — this makes real, uncached network requests to
 * 30 external hosts, which would violate this project's own offline/deterministic test-suite
 * rule. It is a manual maintenance tool, run by a person before a release or when a
 * registry entry is suspected stale, the same category `scripts/eval-retrieval.mjs` already is.
 *
 * Imports from `dist/`, not `src/`, matching `scripts/eval-retrieval.mjs`'s own convention —
 * this sweeps the BUILT registry a real install actually ships, not a TypeScript source tree a
 * plain `node` cannot run directly.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { DEFAULT_REGISTRY } = await import(join(repoRoot, "dist", "registry.js"));

/** A real llms.txt/llms-full.txt or README dump is never this small. Below this, the entry's
 *  own first candidate is worth a human look — not proof of a problem, a prompt to check one. */
const SMALL_BODY_THRESHOLD_BYTES = 5 * 1024;

/** Bounded, like every other network read in this codebase (`limits.ts`'s own reasoning) — a
 *  sweep script has no business holding an unbounded response in memory either. Generous: this
 *  only needs the byte COUNT, not the content, but a byte count still requires reading the body
 *  to completion (or its `content-length` header, when the server sends one honestly).
 *  ACTUALLY ENFORCED (security review, round 3): an earlier version of this bound called
 *  `res.arrayBuffer()` first and checked the size only AFTER the whole body was already
 *  buffered — a label, not a real bound, and the "truncated" wording was false (nothing was
 *  truncated; everything had already been read). This version streams via
 *  `res.body.getReader()` and cancels the stream the moment the running total passes this
 *  constant, so memory use is actually capped regardless of how large the real body is. */
const MAX_SWEEP_BODY_BYTES = 64 * 1024 * 1024; // 64 MiB

/** Per-request timeout (security review, round 3: a prior version had none, so a slow or
 *  never-terminating response could hang the whole sweep forever despite a comment claiming
 *  otherwise). 30 s is generous for a docs page over a normal connection while still bounding
 *  the worst case to "one dead host costs 30 s", not "forever". */
const SWEEP_TIMEOUT_MS = 30_000;

/** GET `url`, return `{ status, bytes }` or `{ error }` — never throws. `content-length`, when
 *  present and numeric, is trusted directly (skips reading the body at all — cheaper, and this
 *  script never needs the bytes themselves); otherwise the body is streamed and measured
 *  incrementally, with the stream actually cancelled (not merely re-labelled after the fact)
 *  once the running total passes `MAX_SWEEP_BODY_BYTES`. `AbortSignal.timeout` bounds the whole
 *  request, connection included, to `SWEEP_TIMEOUT_MS`. */
async function sweepOne(url) {
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(SWEEP_TIMEOUT_MS) });
    const declared = res.headers.get("content-length");
    if (declared !== null && /^\d+$/.test(declared)) {
      // Drain the body so the connection is released cleanly, but trust the declared length.
      await res.body?.cancel();
      return { status: res.status, bytes: Number(declared) };
    }
    if (!res.body) return { status: res.status, bytes: 0 };
    const reader = res.body.getReader();
    let bytes = 0;
    let stoppedEarly = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_SWEEP_BODY_BYTES) {
        stoppedEarly = true;
        await reader.cancel();
        break;
      }
    }
    return stoppedEarly
      ? { status: res.status, bytes, note: `over ${MAX_SWEEP_BODY_BYTES} bytes — read stopped early, exact size unknown` }
      : { status: res.status, bytes };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

async function main() {
  console.log(`Registry sweep — ${DEFAULT_REGISTRY.length} entries, first candidate URL each\n`);
  const flagged = [];
  const rows = [];
  for (const entry of DEFAULT_REGISTRY) {
    const url = entry.urls[0];
    const result = await sweepOne(url);
    if ("error" in result) {
      rows.push({ library: entry.name, url, status: "ERROR", bytes: "—", flag: result.error });
      flagged.push(entry.name);
      continue;
    }
    const small = result.bytes < SMALL_BODY_THRESHOLD_BYTES;
    const isError = result.status >= 400;
    if (small || isError) flagged.push(entry.name);
    const flagParts = [];
    if (isError) flagParts.push("HTTP error");
    if (small) flagParts.push("SMALL — review");
    if (result.note) flagParts.push(result.note);
    rows.push({
      library: entry.name,
      url,
      status: String(result.status),
      bytes: formatBytes(result.bytes),
      flag: flagParts.join(", "),
    });
  }

  const widths = ["library", "url", "status", "bytes", "flag"].map((k) => Math.max(k.length, ...rows.map((r) => String(r[k]).length)));
  const render = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");
  console.log(render(["library", "url", "status", "bytes", "flag"]));
  for (const r of rows) console.log(render([r.library, r.url, r.status, r.bytes, r.flag]));

  console.log(`\n${flagged.length} of ${DEFAULT_REGISTRY.length} entries flagged for manual review${flagged.length > 0 ? ": " + flagged.join(", ") : ""}`);
}

await main();
