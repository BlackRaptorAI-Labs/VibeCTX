import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stubPublicDns } from "./helpers/public-dns.js";

/**
 * A3 (PAR-716) · one index session for the whole refresh loop, not one read-then-write per
 * library — the same R2 fix `warm` and `autowarm` already carry (`IndexSession`'s own doc
 * comment in search-index.ts).
 *
 * Counted at the `node:fs` boundary, the same technique `search-index-session.test.ts` uses
 * for the identical claim about `warm`, and for the identical reason: the win is invisible in
 * the RESULT (the index file ends up byte-identical either way), so only counting the raw
 * reads and writes of `index.json` proves the session was actually shared across the loop
 * rather than opened and closed per library.
 *
 * WHAT "one session" ACTUALLY COSTS, measured here rather than assumed: when at least one
 * library's content CHANGED, `add()`'s lazy snapshot reads once; `flush()` re-reads once more
 * before writing, by design — NARROWING, not closing, the window in which a concurrent writer
 * could lose an entry (F-3, PAR-740 — wording only; the read/write counts this test asserts are
 * unchanged; `IndexSession`'s own doc comment in search-index.ts carries the corrected claim);
 * `writeIndex()` itself reads once more through `newerSchemaVersion`'s own guard
 * (atomic-store.ts:136-144, unchanged by this item).
 * That is THREE reads and ONE write for the whole loop — not the "exactly one read, exactly
 * one write" the go-card's done-when states verbatim. Round 1 (code-reviewer, S5) found the
 * FIRST of those three elidable: when nothing in the whole loop actually changed, `add()` now
 * cancels a pending `remove()` instead of rebuilding an identical entry, so `pending` ends the
 * loop empty and `flush()` returns before its own re-read — ONE read, ZERO writes, also
 * measured below. The claim this test actually proves, and the one that matters, is that the
 * count is CONSTANT in the number of libraries refreshed, not the literal "1" — a 3-library
 * and a 30-library refresh cost the same reads and writes either way. The instrumentation below measures this reduction;
 * see the phase report for the full disposition of this done-when.
 */

const counts = vi.hoisted(() => ({ indexReads: 0, indexWrites: 0 }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readFileSync = (path: unknown, ...rest: unknown[]) => {
    if (typeof path === "string" && path.endsWith("index.json")) counts.indexReads += 1;
    return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
  };
  const renameSync = (from: unknown, to: unknown, ...rest: unknown[]) => {
    if (typeof to === "string" && to.endsWith("index.json")) counts.indexWrites += 1;
    return (actual.renameSync as (...a: unknown[]) => unknown)(from, to, ...rest);
  };
  return { ...actual, default: { ...actual, readFileSync, renameSync }, readFileSync, renameSync };
});

const { documentHash, readIndex, resetSearchIndexMemo, indexDocument, writeIndex } = await import("../src/search-index.js");
const { refreshToolText, resetFullRefreshWindow } = await import("../src/refresh.js");
type Registry = import("../src/registry.js").Registry;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-refresh-session-"));
  process.env.VIBECTX_CACHE_DIR = dir;
  resetSearchIndexMemo();
  resetFullRefreshWindow();
  counts.indexReads = 0;
  counts.indexWrites = 0;
  stubPublicDns();
});

afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(pages: Record<string, string>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const body = pages[String(url)];
      if (body === undefined) return new Response("not found", { status: 404 });
      return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
    }),
  );
}

/** A registry of `n` curated (non-resolved) libraries, each with a distinct URL — the class
 *  A3's session actually batches (a resolved entry re-indexes through `resolvePackage`, its
 *  own single-document write, out of this session's scope — see refresh.ts). */
function curatedRegistry(n: number): { registry: Registry; pages: Record<string, string> } {
  const entries = new Map<string, { name: string; urls: string[] }>();
  const pages: Record<string, string> = {};
  for (let i = 0; i < n; i++) {
    const name = `lib-${i}`;
    const url = `https://lib${i}.example.com/llms.txt`;
    entries.set(name, { name, urls: [url] });
    pages[url] = `# ${name}\n\nRefreshed content for ${name}, section ${i}.`;
  }
  return { registry: { entries }, pages };
}

/** Seed index.json with an entry for every library, under OLD content, so this run's `add()`
 *  calls do real replacement work rather than short-circuiting on an empty file — and so the
 *  read count means something (an absent file answers `statSync`, never `readFileSync`). */
function seedIndex(n: number): void {
  const libraries = new Map<string, ReturnType<typeof indexDocument>>();
  for (let i = 0; i < n; i++) {
    const name = `lib-${i}`;
    const doc = indexDocument(`https://lib${i}.example.com/llms.txt`, `# ${name}\n\nOld content ${i}.`, "2026-09-01T00:00:00.000Z");
    if (doc) libraries.set(name, doc);
  }
  writeIndex(libraries as Map<string, NonNullable<ReturnType<typeof indexDocument>>>, () => {});
}

describe("A3 (PAR-716) · one index session per refresh, not one per library", () => {
  it("[MEASURED] a 30-library refresh reads index.json a CONSTANT number of times, not once per library", async () => {
    const SIZE = 30;
    seedIndex(SIZE);
    resetSearchIndexMemo(); // a fresh process: the in-memory memo cannot short-circuit anything
    const { registry, pages } = curatedRegistry(SIZE);
    stubFetch(pages);
    counts.indexReads = 0;
    counts.indexWrites = 0;

    await refreshToolText(registry);
    const after = { reads: counts.indexReads, writes: counts.indexWrites };

    // Round 2 (test-auditor, F3): the "after" figure is a real, observed count from this run.
    // The "before" figure is NOT — it is arithmetic from the audit's own per-library estimate
    // (src/refresh.ts's OLD invalidateIndex-then-indexCachedDocument shape: ~3 reads + ~2
    // writes per library), never independently re-measured against the pre-A3 code by this
    // test. Labelled ESTIMATED, not folded into the same MEASURED line, so the two registers
    // are never confused with each other.
    // eslint-disable-next-line no-console
    console.log(`[A3 MEASURED] ${SIZE}-library refresh: ${after.reads} index.json read(s), ${after.writes} write(s)`);
    // eslint-disable-next-line no-console
    console.log(`[A3 ESTIMATED, pre-fix] ~${SIZE * 3} reads, ~${SIZE * 2} writes — one invalidate + one reindex per library, never independently re-measured here`);

    expect(after.writes).toBe(1); // ONE writeIndex for the whole loop, exactly as the done-when states
    expect(after.reads).toBeLessThanOrEqual(3); // one lazy read, one flush re-read, one writeIndex schema check
    expect(after.reads).toBeGreaterThan(0); // and it is not zero — the fix is real, not a no-op

    const rebuilt = readIndex().libraries;
    for (let i = 0; i < SIZE; i++) expect(rebuilt.get(`lib-${i}`)!.hash).toBe(documentHash(pages[`https://lib${i}.example.com/llms.txt`]));
  });

  it("the read count is CONSTANT in library count — 3 libraries cost the same reads as 30 (proves one session, not the literal number)", async () => {
    const SMALL = 3;
    seedIndex(SMALL);
    resetSearchIndexMemo();
    const { registry, pages } = curatedRegistry(SMALL);
    stubFetch(pages);
    counts.indexReads = 0;

    await refreshToolText(registry);
    const smallReads = counts.indexReads;

    // Reset the cache root entirely for a clean 30-library run.
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), "vibectx-refresh-session-"));
    process.env.VIBECTX_CACHE_DIR = dir;
    resetSearchIndexMemo();
    resetFullRefreshWindow();

    const LARGE = 30;
    seedIndex(LARGE);
    resetSearchIndexMemo();
    const big = curatedRegistry(LARGE);
    stubFetch(big.pages);
    counts.indexReads = 0;

    await refreshToolText(big.registry);
    const largeReads = counts.indexReads;

    expect(largeReads).toBe(smallReads); // O(1) in library count, not O(n) — the actual claim behind the done-when
  });

  it("[MEASURED] round 1 (S5): when nothing changed, a 30-library refresh reads index.json ONCE and writes NOTHING", async () => {
    const SIZE = 30;
    seedIndex(SIZE);
    resetSearchIndexMemo();
    const { registry } = curatedRegistry(SIZE);
    // The seeded index and the fetched pages must describe the SAME content for this to be a
    // true no-op refresh — seedIndex writes "Old content <i>.", so fetch the same text back.
    const unchangedPages: Record<string, string> = {};
    for (let i = 0; i < SIZE; i++) unchangedPages[`https://lib${i}.example.com/llms.txt`] = `# lib-${i}\n\nOld content ${i}.`;
    stubFetch(unchangedPages);
    counts.indexReads = 0;
    counts.indexWrites = 0;

    await refreshToolText(registry);

    // eslint-disable-next-line no-console
    console.log(`[A3 MEASURED] ${SIZE}-library refresh, nothing changed: ${counts.indexReads} index.json read(s), ${counts.indexWrites} write(s)`);

    expect(counts.indexReads).toBe(1); // the lazy snapshot read — nothing left to re-read or write for
    expect(counts.indexWrites).toBe(0);

    const untouched = readIndex().libraries;
    for (let i = 0; i < SIZE; i++) expect(untouched.get(`lib-${i}`)!.hash).toBe(documentHash(`# lib-${i}\n\nOld content ${i}.`));
  });
});
