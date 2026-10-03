import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IndexedDocument } from "../src/search-index.js";

/**
 * PAR-659 · R2 — ONE RUN, ONE READ.
 *
 * `warm` and the startup autowarm write thirty primary documents in a row. The first cut called
 * `indexCachedDocument` per library, and each call parsed the WHOLE index file to find out
 * whether it had anything to do — MEASURED by the review gate: 7,529 ms added to an
 * already-fresh 30-library / 150 MB warm for zero index change.
 *
 * Counting reads is the only honest way to pin that, because the cost is invisible in the
 * result: the index is byte-identical either way. `node:fs` is wrapped here with a counter that
 * delegates to the real implementation, so every module in the run — search-index, atomic-store,
 * cache — reads through it and nothing else changes.
 */

const reads = vi.hoisted(() => ({ index: 0 }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readFileSync = (path: unknown, ...rest: unknown[]) => {
    if (typeof path === "string" && path.endsWith("index.json")) reads.index += 1;
    return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
  };
  return { ...actual, default: { ...actual, readFileSync }, readFileSync };
});

const { writeCache } = await import("../src/cache.js");
const {
  openIndexSession,
  readIndex,
  resetSearchIndexMemo,
  searchIndexPath,
  writeIndex,
  indexDocument,
  documentHash,
  MAX_INDEX_FILE_BYTES,
  SEARCH_INDEX_SCHEMA_VERSION,
} = await import("../src/search-index.js");
const { RETRIEVAL_VERSION } = await import("../src/tokenize.js");
const { runWarm } = await import("../src/warm.js");
type Registry = import("../src/registry.js").Registry;

let cache: string;
let project: string;

beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), "vibectx-session-cache-"));
  project = mkdtempSync(join(tmpdir(), "vibectx-session-proj-"));
  process.env.VIBECTX_CACHE_DIR = cache;
  resetSearchIndexMemo();
  reads.index = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("this run is offline");
    }),
  );
});

afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  rmSync(cache, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

const LIBRARIES = 12;

/** A project whose dependencies are all cached already — the shape R2's measurement was taken on. */
function cachedProject(): Registry {
  const entries = new Map<string, { name: string; urls: string[] }>();
  const deps: Record<string, string> = {};
  for (let i = 0; i < LIBRARIES; i++) {
    const name = `lib-${i}`;
    const url = `https://lib${i}.example.com/llms.txt`;
    writeCache(name, url, `# ${name}\n\n## Streaming\n\nStream server-sent events to the client from ${name}.`);
    entries.set(name, { name, urls: [url] });
    deps[name] = "1";
  }
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "app", dependencies: deps }), "utf8");
  return { entries };
}

describe("R2 · one index read per run, not one per library (PAR-659)", () => {
  it("a 12-library warm reads the index a handful of times, not once per library", async () => {
    const registry = cachedProject();
    const report = await runWarm(registry, { dir: project, offline: true });
    expect(report.cached).toBe(LIBRARIES);

    // Session: one lazy read on the first library, one read at flush, one inside the write's
    // newer-schemaVersion check. Per-library it was three times TWELVE.
    expect(reads.index).toBeLessThanOrEqual(4);
    expect(readIndex().libraries.size).toBe(LIBRARIES);
  });

  it("an ALREADY-FRESH second warm reads the index once and writes nothing — the case that cost 7.5 s", async () => {
    const registry = cachedProject();
    await runWarm(registry, { dir: project, offline: true });
    resetSearchIndexMemo(); // a new process: the memo cannot short-circuit anything
    const before = readIndex().libraries.size;
    reads.index = 0;

    await runWarm(registry, { dir: project, offline: true });
    expect(reads.index).toBeLessThanOrEqual(2); // the lazy read, and nothing more to do
    expect(readIndex().libraries.size).toBe(before);
  });

  it("the flush MERGES rather than clobbers: an entry written by another process survives", () => {
    writeCache("mine", "https://mine.example.com/llms.txt", "# Mine\n\n## Streaming\n\nStream events.");
    const session = openIndexSession(() => {});
    session.add("mine", "https://mine.example.com/llms.txt", "# Mine\n\n## Streaming\n\nStream events.");

    // …and now "another process" writes an entry this session has never heard of, AFTER the
    // session took its snapshot.
    const theirs = indexDocument("https://theirs.example.com/llms.txt", "# Theirs\n\n## Caching\n\nCache it.", "2026-09-06T00:00:00.000Z")!;
    const merged = readIndex().libraries;
    merged.set("theirs", theirs);
    writeIndex(merged, () => {});

    expect(session.flush()).toBe(true);
    const after = readIndex().libraries;
    expect([...after.keys()].sort()).toEqual(["mine", "theirs"]);
    expect(after.get("theirs")!.hash).toBe(documentHash("# Theirs\n\n## Caching\n\nCache it."));
  });

  it("flushing twice writes once; flushing an empty session writes nothing", () => {
    const session = openIndexSession(() => {});
    expect(session.flush()).toBe(false);
    session.add("solo", "https://solo.example.com/llms.txt", "# Solo\n\n## Streaming\n\nStream events.");
    expect(session.flush()).toBe(true);
    expect(session.flush()).toBe(false);
    expect([...readIndex().libraries.keys()]).toEqual(["solo"]);
    expect(searchIndexPath().endsWith("index.json")).toBe(true);
  });

  /** A3 (PAR-716), round 2 (test-auditor, F5) — `remove()` mirrors `add()`'s `validLibraryKey`
   *  guard, but no caller in this codebase ever offers `remove()` an invalid key (`refresh.ts`
   *  only ever passes a Registry-resolved `entry.name`), so the guard is unreachable through
   *  integration tests. Direct unit test instead. */
  it("remove() ignores an invalid key rather than forcing a read+write for a delete that could never match anything", () => {
    const session = openIndexSession(() => {});
    session.remove(""); // empty after trim: not a valid library key
    session.remove("   ");
    expect(session.flush()).toBe(false); // nothing pending — the invalid removals never landed
    expect(readIndex().libraries.size).toBe(0);
  });

  it("remove() supersedes a PRIOR add() in the same session — the last call for a library wins", () => {
    const session = openIndexSession(() => {});
    session.add("solo", "https://solo.example.com/llms.txt", "# Solo\n\n## Streaming\n\nStream events.");
    session.remove("solo");
    expect(session.flush()).toBe(true); // the removal still needs a write, even though nothing survives it
    expect(readIndex().libraries.has("solo")).toBe(false);
  });
});

describe("PAR-803 — the in-process memo is keyed by (hash, url), not hash alone", () => {
  const TEXT = "# Solo\n\n## Streaming\n\nStream events.";
  const OLD_URL = "https://old.example.com/llms.txt";
  const NEW_URL = "https://new.example.com/llms.txt";

  it("a library whose URL changes with BYTE-IDENTICAL content is re-offered to the index, not permanently memo-blocked", () => {
    const first = openIndexSession(() => {});
    first.add("solo", OLD_URL, TEXT);
    expect(first.flush()).toBe(true);
    expect(readIndex().libraries.get("solo")?.url).toBe(OLD_URL);

    // Same process, same memo (no resetSearchIndexMemo): a later add() for the SAME library,
    // SAME content, but a DIFFERENT url. Before PAR-803 this short-circuited on the hash match
    // alone (memo.get("solo") === hash) and never reached the index at all.
    const second = openIndexSession(() => {});
    second.add("solo", NEW_URL, TEXT);
    expect(second.flush()).toBe(true); // a real write happened — it was NOT memo-blocked
    expect(readIndex().libraries.get("solo")?.url).toBe(NEW_URL);
  });

  it("the SAME (hash, url) pair still short-circuits — the memo's fast path is not simply disabled", () => {
    const first = openIndexSession(() => {});
    first.add("solo", OLD_URL, TEXT);
    expect(first.flush()).toBe(true);

    const second = openIndexSession(() => {});
    second.add("solo", OLD_URL, TEXT); // identical hash AND url
    expect(second.flush()).toBe(false); // memo answered "nothing to do" — no write needed
  });
});

describe("PAR-802 — a session's stale snapshot is invalidated after its own successful flush", () => {
  it("add(match) -> remove() -> flush() -> add(match) again on the SAME session re-reads fresh — it is not incorrectly re-memoized against the stale pre-flush snapshot", () => {
    const url = "https://reused.example.com/llms.txt";
    const text = "# Reused\n\n## Streaming\n\nStream events.";
    // Pre-seed the index with "reused" already on disk, so the session's own add() below is a
    // "match" (the fast, confirmed path — the exact shape the issue names) rather than a fresh
    // build.
    const seed = openIndexSession(() => {});
    seed.add("reused", url, text);
    expect(seed.flush()).toBe(true);
    // Clear the process-wide memo the seed's own flush just primed — the sequence below is
    // about the SESSION's `snapshot` (its own one-time read of the file), not the separate,
    // coarser process-wide `memo` short-circuit; without this, step 1 below would short-circuit
    // at the memo level and never even consult `snapshot`, testing nothing about PAR-802.
    resetSearchIndexMemo();

    const session = openIndexSession(() => {}); // ONE session for the whole sequence
    session.add("reused", url, text); // 1: add(match) — matches the pre-seeded entry (confirmed fast path); this is also where `snapshot` is first taken
    session.remove("reused"); // 2: remove() — clears the confirmed entry, pending = {reused: "remove"}
    expect(session.flush()).toBe(true); // 3: flush() — a real delete write (pending was non-empty)
    expect(readIndex().libraries.has("reused")).toBe(false); // confirmed gone from disk

    session.add("reused", url, text); // 4: add(match) again, SAME session
    // WITHOUT the PAR-802 fix, step 4 reuses the STALE pre-removal `snapshot` (never invalidated
    // by step 3's flush), still sees "reused" there matching, and wrongly takes the confirmed
    // fast path again — touching neither `pending` nor the real file. The flush below would then
    // be a no-op (`pending.size === 0`), yet `confirmed` gets committed straight to `memo` with
    // NO re-verification against disk (that branch does not re-read) — `memo` ends up claiming
    // "reused" is indexed with this content when the file does not hold it at all.
    // WITH the fix (`if (written) snapshot = undefined` after step 3's successful flush), step 4
    // re-reads fresh, correctly sees the entry is gone, and rebuilds it for real.
    expect(session.flush()).toBe(true); // 5: a genuine write happened
    expect(readIndex().libraries.has("reused")).toBe(true); // rebuilt for real — memo now matches reality
  });

  it("re-adding a library that a successful flush just WROTE, on the SAME session, is offered a fresh read — not the pre-flush snapshot", () => {
    const url = "https://live.example.com/llms.txt";
    const textA = "# Live\n\n## Streaming\n\nStream events A.";
    const textB = "# Live\n\n## Streaming\n\nStream events B, materially different from A.";
    const session = openIndexSession(() => {});
    session.add("live", url, textA);
    expect(session.flush()).toBe(true); // writes textA's posting list; snapshot is now stale
    // Another writer (a different process/session) changes the on-disk entry between this
    // session's flush and its next add() — this session's own (now-invalidated) snapshot must
    // not be consulted for the decision below.
    const external = openIndexSession(() => {});
    external.add("live", url, textB);
    expect(external.flush()).toBe(true);
    // Re-add textA on the ORIGINAL session: if it still trusted its stale (pre-flush) snapshot,
    // it might wrongly believe "live" already holds this content on disk. It must re-read.
    session.add("live", url, textA);
    expect(session.flush()).toBe(true);
    expect(readIndex().libraries.get("live")?.hash).toBe(documentHash(textA));
  });
});

/**
 * PAR-659 · D-42 — THE MEMO RECORDS WHAT WAS WRITTEN, NOT WHAT WAS OFFERED.
 *
 * `flush()` set the in-process memo for every pending entry whenever `writeIndex` returned
 * true — and `writeIndex` returns true when it SHED entries to stay inside the read limit, so a
 * library that never reached the file was recorded as though it had. The next session in that
 * process then short-circuited on the memo, put nothing in `pending`, and `flush()` returned
 * false: a warm or a get_docs reporting "nothing to do" about a library the index does not
 * hold. Whether a payload sheds depends on what else is in the file, so the honest behaviour is
 * to offer it again — the per-process shed memo (D-42, search-index.ts) is what stops the
 * SEARCH path paying for it on every call.
 */
describe("D-42 · the session memo records only entries that were written (PAR-659)", () => {
  const AT = "2026-09-06T00:00:00.000Z";
  const URL_ = "https://shed.example.com/llms-full.txt";

  /** A document with globally unique vocabulary: its posting list is the file's largest entry. */
  function uniqueDoc(sections: number): string {
    const lines = ["# shed", ""];
    for (let s = 0; s < sections; s++) {
      lines.push(`## shedding heading ${s}`, "");
      for (let p = 0; p < 4; p++) {
        const words: string[] = [];
        for (let k = 0; k < 30; k++) words.push(`shedword${s}x${p}y${k}`);
        lines.push(words.join(" "), "");
      }
    }
    return lines.join("\n");
  }

  /** An index file just under the read limit, in entries each far smaller than `entryBytes`, so
   *  the entry the session offers is the largest and therefore the one D-40 sheds. */
  function plantNearlyFull(entryBytes: number): void {
    const SECTIONS = 1000;
    const lengths = new Array(SECTIONS).fill(1).join(",");
    const chunk = Array.from({ length: SECTIONS }, (_, i) => `${i},1`).join(",");
    const head = `{"url":"https://planted.example.com/llms.txt","fetchedAt":"${AT}","hash":"0123456789abcdef","lengths":[${lengths}],"postings":{"t":[`;
    const parts: string[] = [];
    let bytes = head.length + 3;
    while (bytes < Math.floor(entryBytes / 10)) {
      parts.push(chunk);
      bytes += chunk.length + 1;
    }
    const entry = `${head}${parts.join(",")}]}}`;
    const count = Math.floor((MAX_INDEX_FILE_BYTES - Math.floor(entryBytes / 2)) / (entry.length + 8));
    const libraries = Array.from({ length: count }, (_, i) => `"p${i}":${entry}`).join(",");
    writeFileSync(
      searchIndexPath(),
      `{"schemaVersion":${SEARCH_INDEX_SCHEMA_VERSION},"retrievalVersion":${RETRIEVAL_VERSION},"libraries":{${libraries}}}`,
      "utf8",
    );
  }

  it("a SHED library is offered again by the next session, not reported as already written", () => {
    const doc = uniqueDoc(400);
    const built = indexDocument(URL_, doc, AT)!;
    const postings: Record<string, number[]> = {};
    for (const [term, list] of built.postings) postings[term] = list;
    plantNearlyFull(
      Buffer.byteLength(
        JSON.stringify({ url: built.url, fetchedAt: built.fetchedAt, hash: built.hash, lengths: built.lengths, postings }),
        "utf8",
      ) + 8,
    );
    expect(readIndex().problem).toBeUndefined(); // the fixture is a file this build reads

    const notes: string[] = [];
    const first = openIndexSession((m) => notes.push(m));
    first.add("shed", URL_, doc, AT);
    expect(first.flush()).toBe(true); // the file WAS written — without this entry
    expect(notes.join("")).toMatch(/would exceed the \d+-byte limit/);
    expect(readIndex().libraries.has("shed")).toBe(false);

    // The claim: the memo did not record it, so this session has work to do. Before the fix
    // `flush()` returned false here — "nothing to do" about a library the file does not hold.
    const second = openIndexSession(() => {});
    second.add("shed", URL_, doc, AT);
    expect(second.flush()).toBe(true);
    // …and a library that WAS written is still short-circuited: the memo keeps its purpose.
    const third = openIndexSession(() => {});
    third.add("mine", "https://mine.example.com/llms.txt", "# Mine\n\n## Streaming\n\nStream events.");
    expect(third.flush()).toBe(true);
    const fourth = openIndexSession(() => {});
    fourth.add("mine", "https://mine.example.com/llms.txt", "# Mine\n\n## Streaming\n\nStream events.");
    expect(fourth.flush()).toBe(false);
  }, 300_000);
});

/**
 * PAR-746 (F-9, SF-3) — THE MEMO MUST ALSO BE CORRECTED FOR AN ENTRY THAT NEVER TOUCHED
 * `pending`.
 *
 * The D-42 fix above corrects `memo` for entries `flush()` actually WROTE (via `pending`). It
 * missed a second route into `memo`: `add()`'s matching-`existing` fast path (the on-disk entry
 * already matches what's offered, so nothing is rebuilt) used to call `memo.set` immediately,
 * before this session's OWN `flush()` even ran — so if that same flush's write sheds the entry
 * (D-40, evaluated over the WHOLE re-read map, not just `pending`), nothing ever corrects the
 * memo it already set. The next session short-circuits on it and reports "nothing to do" about
 * a library the file does not actually hold — the identical D-42 failure mode, reached by a
 * second door.
 *
 * Two variants, both explicitly in the issue's Done-when: the plain fast path (no `remove()`
 * involved — every caller of `indexCachedDocument`/`openIndexSession` can hit this), and the
 * `remove()`-cancelled variant A3 introduced.
 */
describe("PAR-746 (F-9, SF-3) · a fast-pathed (unchanged) entry that sheds in its OWN flush is offered again", () => {
  const AT = "2026-09-06T00:00:00.000Z";
  const SHED_URL = "https://shed746.example.com/llms-full.txt";
  const MINE_URL = "https://mine746.example.com/llms.txt";

  /** A document with globally unique vocabulary: its posting list is far the file's largest
   *  entry, the same technique the D-42 fixture above uses. `sections` controls the size —
   *  `shed746` uses many; `mine746` uses few, so it stays comfortably smaller. */
  function uniqueDoc(label: string, sections: number): string {
    const lines = [`# ${label}`, ""];
    for (let s = 0; s < sections; s++) {
      lines.push(`## ${label} heading ${s}`, "");
      for (let p = 0; p < 4; p++) {
        const words: string[] = [];
        for (let k = 0; k < 30; k++) words.push(`${label}word${s}x${p}y${k}`);
        lines.push(words.join(" "), "");
      }
    }
    return lines.join("\n");
  }

  /** The exact JSON `serialiseIndex` would write for this document, and its exact contribution
   *  to the file's total byte count — `serialiseIndex`'s own `bytes` formula (key + colon +
   *  value + comma). Used to size the fixture's GENEROUS margin below, not to hit an exact
   *  byte target: round 2 (code-reviewer, S1) found the original version of this fixture
   *  claimed "exact" while actually missing the envelope's own byte cost, leaving a real margin
   *  of 27 bytes out of 64 MiB — technically deterministic, not flaky, but one unlucky constant
   *  change away from silently no longer tripping the cap at all. This version leaves headroom
   *  measured in tens of kilobytes instead, so it does not need to be exact to be reliable. */
  function entrySize(name: string, doc: IndexedDocument): { json: string; totalBytes: number } {
    const postings: Record<string, number[]> = {};
    for (const [term, list] of doc.postings) postings[term] = list;
    const json = JSON.stringify({ url: doc.url, fetchedAt: doc.fetchedAt, hash: doc.hash, lengths: doc.lengths, postings });
    const keyBytes = Buffer.byteLength(JSON.stringify(name), "utf8");
    return { json, totalBytes: keyBytes + 1 + Buffer.byteLength(json, "utf8") + 1 };
  }

  /** A near-cap index file with `shedKey`'s entry (`shedJson`) ALREADY on disk, byte-identical
   *  to what the session will re-offer — so `add()` takes the matching-existing FAST PATH, not
   *  the "build a new pending entry" path. Filler entries are a FIXED, modest size (independent
   *  of `shedBytes`, unlike round 2's first draft, which tied filler size to `shedBytes/10` and
   *  produced ~140 KB fillers that swamped a ~23 KB headroom margin, undershooting the cap by
   *  more than `headroom` and never actually triggering a shed at all) — small enough relative
   *  to `headroom` that the per-entry accounting below cannot itself exceed the margin the
   *  caller asked for. Still tens of thousands of entries at this size against a 64 MiB budget
   *  (round 1's ~400,000-tiny-filler version, tuned for byte-exactness rather than headroom
   *  margin, was worse — round 2, S4 — but this is not "a few hundred" either; MEASURED at
   *  ~5-8s per test in this describe block, most of which is `readIndex()` parsing the planted
   *  file several times per test, not the planting itself). */
  function plantJustUnderCap(shedKey: string, shedJson: string, shedBytes: number, headroom: number): void {
    const FILLER_SECTIONS = 40; // a few hundred bytes per filler entry — small relative to `headroom`
    const lengths = new Array(FILLER_SECTIONS).fill(1).join(",");
    const chunk = Array.from({ length: FILLER_SECTIONS }, (_, i) => `${i},1`).join(",");
    const filler = `{"url":"https://planted746.example.com/llms.txt","fetchedAt":"${AT}","hash":"0123456789abcdef","lengths":[${lengths}],"postings":{"t":[${chunk}]}}`;
    const fillerBytes = Buffer.byteLength(filler, "utf8");
    const envelope = `{"schemaVersion":${SEARCH_INDEX_SCHEMA_VERSION},"retrievalVersion":${RETRIEVAL_VERSION},"libraries":{}}`.length;
    const budget = MAX_INDEX_FILE_BYTES - envelope - shedBytes - headroom;
    // Measured per entry, not estimated by a fixed-width formula: with ~170,000 fillers needed
    // to fill a 64 MiB budget with a few-hundred-byte entry, the key `"p<i>"` grows from 1 to 6
    // digits across the range, and a constant "+N bytes of key overhead" guess undercounts the
    // later, wider keys — round 2 of this fixture (code-reviewer, S1) overshot the cap by
    // ~243 KB this way, on a file this same review flagged for NOT actually earning the word
    // "exact" the first time either. Accumulating the REAL byte cost of each key as it grows is
    // what a size-exact fixture actually requires.
    const parts: string[] = [];
    let used = 0;
    let i = 0;
    for (;;) {
      const key = JSON.stringify(`p${i}`);
      const entryBytes = Buffer.byteLength(key, "utf8") + 1 + fillerBytes + 1; // serialiseIndex's own bytes formula
      if (used + entryBytes > budget) break;
      parts.push(`${key}:${filler}`);
      used += entryBytes;
      i += 1;
    }
    writeFileSync(
      searchIndexPath(),
      `{"schemaVersion":${SEARCH_INDEX_SCHEMA_VERSION},"retrievalVersion":${RETRIEVAL_VERSION},"libraries":{${JSON.stringify(shedKey)}:${shedJson}${parts.length ? "," + parts.join(",") : ""}}}`,
      "utf8",
    );
  }

  /** Builds the fixture: `shed746` (huge) planted on disk already; `mine746` sized to a
   *  comfortable fraction of `shed746` — far smaller (so `shed746` stays the one entry D-40
   *  picks to evict), but far larger than one filler entry or the envelope's own byte cost (so
   *  neither can eat into the margin meant for `mine746` alone to trigger). Headroom is a third
   *  of `mine746`'s own size: generous margin, not a razor edge. Returns both raw doc texts so
   *  the test can re-offer them byte-identical. */
  function buildFixture(): { shedDoc: string; mineDoc: string } {
    const shedDoc = uniqueDoc("shed746", 400);
    const shedIndexed = indexDocument(SHED_URL, shedDoc, AT)!;
    const { json: shedJson, totalBytes: shedBytes } = entrySize("shed746", shedIndexed);
    const mineDoc = uniqueDoc("mine746", 100); // a quarter of shed746's sections: comfortably mid-sized
    const mineIndexed = indexDocument(MINE_URL, mineDoc, AT)!;
    const { totalBytes: mineBytes } = entrySize("mine746", mineIndexed);
    plantJustUnderCap("shed746", shedJson, shedBytes, Math.floor(mineBytes / 3));
    return { shedDoc, mineDoc };
  }

  it("the plain add() fast path — no remove() involved — is corrected when its own flush sheds it", () => {
    const { shedDoc, mineDoc } = buildFixture();
    expect(readIndex().problem).toBeUndefined(); // the fixture is a file this build reads
    expect(readIndex().libraries.has("shed746")).toBe(true); // planted, present before the session touches it

    const notes: string[] = [];
    const session = openIndexSession((m) => notes.push(m));
    session.add("shed746", SHED_URL, shedDoc, AT); // byte-identical to what's on disk: the fast path, never pending
    session.add("mine746", MINE_URL, mineDoc, AT); // the only NEW content — tips the file over the cap
    expect(session.flush()).toBe(true);
    expect(notes.join("")).toMatch(/would exceed the \d+-byte limit/); // N3: pins WHY it's gone, not merely that it is
    expect(readIndex().libraries.has("shed746")).toBe(false); // shed, despite taking the fast path
    expect(readIndex().libraries.has("mine746")).toBe(true); // survives — far smaller than shed746's entry

    // `mine746` is removed in the SAME session to free the space it took (it stays in the file
    // otherwise — the file's total is invariant under "shed X, then add X back" while `mine746`
    // still occupies the room that tipped it over the first time, which would force a SECOND,
    // unrelated eviction and prove nothing about the memo).
    const next = openIndexSession(() => {});
    next.remove("mine746");
    next.add("shed746", SHED_URL, shedDoc, AT);
    expect(next.flush()).toBe(true);
    // The claim, and the assertion that actually discriminates it (round 2, code-reviewer, N1 —
    // `flush()` above returns `true` regardless, because `remove("mine746")` alone guarantees a
    // write; a stale memo would not change that return value, only THIS line): before the fix,
    // add()'s fast path had already set `memo` for "shed746" the moment it matched — regardless
    // of what this SAME flush's write went on to do — so the next session's `add()` would have
    // short-circuited, put nothing in `pending`, and never actually offered "shed746" again.
    expect(readIndex().libraries.has("shed746")).toBe(true); // offered again, not short-circuited
    expect(readIndex().libraries.has("mine746")).toBe(false); // removed, by this session's own design
  }, 300_000);

  it("the remove()-cancelled variant (A3) — a pending removal cancelled by a matching add() — is corrected the same way", () => {
    const { shedDoc, mineDoc } = buildFixture();
    expect(readIndex().problem).toBeUndefined();

    const notes: string[] = [];
    const session = openIndexSession((m) => notes.push(m));
    session.remove("shed746"); // marks it for deletion first…
    session.add("shed746", SHED_URL, shedDoc, AT); // …then the SAME session re-offers it unchanged, cancelling the removal
    session.add("mine746", MINE_URL, mineDoc, AT); // tips the file over the cap
    expect(session.flush()).toBe(true);
    expect(notes.join("")).toMatch(/would exceed the \d+-byte limit/);
    expect(readIndex().libraries.has("shed746")).toBe(false); // shed — the cancelled removal doesn't change that
    expect(readIndex().libraries.has("mine746")).toBe(true);

    // mine746 removed in the same session for the same reason as the sibling test above: its
    // bytes must not still occupy the room shed746 needs, or a second, unrelated eviction would
    // prove nothing about the memo.
    const next = openIndexSession(() => {});
    next.remove("mine746");
    next.add("shed746", SHED_URL, shedDoc, AT);
    expect(next.flush()).toBe(true);
    expect(readIndex().libraries.has("shed746")).toBe(true); // offered again, not short-circuited
    expect(readIndex().libraries.has("mine746")).toBe(false);
  }, 300_000);

  /**
   * Round 2 (code-reviewer, S2) — the three defensive additions the fix makes (clearing
   * `confirmed` on `remove()`, clearing it when a real content change supersedes a fast-path
   * confirmation, and committing it to `memo` even when `flush()` writes nothing) were each
   * verified by mutation testing during review but were not directly pinned by any test — only
   * indirectly, through the two expensive 64 MiB-fixture tests above. These three are cheap
   * (no large fixture) and pin each one directly.
   */
  describe("the three defensive additions, pinned directly (no large fixture needed)", () => {
    it("add(match) then remove() then flush: a later session re-offers it, not short-circuited by a stale confirmation", () => {
      const doc = "# solo746\n\n## Streaming\n\nStream events.";
      const url = "https://solo746.example.com/llms.txt";
      const seed = openIndexSession(() => {});
      seed.add("solo746", url, doc, AT);
      expect(seed.flush()).toBe(true);
      resetSearchIndexMemo(); // a later process: nothing already believes this is indexed

      const session = openIndexSession(() => {});
      session.add("solo746", url, doc, AT); // matches on-disk: the fast path, into `confirmed`
      session.remove("solo746"); // …then removed in the SAME session
      expect(session.flush()).toBe(true);
      expect(readIndex().libraries.has("solo746")).toBe(false);

      const next = openIndexSession(() => {});
      next.add("solo746", url, doc, AT);
      expect(next.flush()).toBe(true); // offered again — `confirmed` did not survive the remove()
      expect(readIndex().libraries.has("solo746")).toBe(true);
    });

    it("add(match) then add(DIFFERENT content) then flush: memo ends on the NEW hash, not the stale confirmed one", () => {
      const url = "https://solo746b.example.com/llms.txt";
      const original = "# solo746b\n\n## Streaming\n\nStream events, original.";
      const changed = "# solo746b\n\n## Streaming\n\nStream events, CHANGED.";
      const seed = openIndexSession(() => {});
      seed.add("solo746b", url, original, AT);
      expect(seed.flush()).toBe(true);
      resetSearchIndexMemo();

      const session = openIndexSession(() => {});
      session.add("solo746b", url, original, AT); // matches on-disk: the fast path, into `confirmed`
      session.add("solo746b", url, changed, AT); // …then superseded by REAL new content in the SAME session
      expect(session.flush()).toBe(true);
      expect(readIndex().libraries.get("solo746b")?.hash).toBe(documentHash(changed));

      // If the stale `confirmed` entry (the ORIGINAL text's hash) had won in `memo`, a session
      // re-offering the ORIGINAL text would short-circuit as "already indexed" even though the
      // file now holds `changed`.
      const next = openIndexSession(() => {});
      next.add("solo746b", url, original, AT);
      expect(next.flush()).toBe(true); // offered again — memo holds `changed`'s hash, not `original`'s
      expect(readIndex().libraries.get("solo746b")?.hash).toBe(documentHash(original));
    });

    /**
     * Round 2 (code-reviewer, B1, blocking) — the MIRROR ordering of the test above, and the
     * one that actually exercises the bug B1 fixed: a real content change lands in `pending`
     * FIRST, then a LATER `add()` in the same session offers content that matches what's still
     * on disk (the fast path, into `confirmed`). Before B1's fix, `pending` was cleared only
     * when it held `"remove"` — a prior real `pending` BUILD for the same key was left in
     * place, so `flush()` would still WRITE that superseded, stale content to disk (not merely
     * mis-set `memo`; the guard on the `confirmed` commit loop added alongside B1 prevents the
     * memo error, but does nothing to stop the wrong bytes from landing in the file). The
     * test above cannot catch this: it exercises the opposite order, which the "build" branch's
     * own `confirmed.delete(key)` already guarded before this round.
     */
    it("add(DIFFERENT content) then add(match) in the SAME session: the file is not clobbered with the superseded content", () => {
      const url = "https://solo746d.example.com/llms.txt";
      const original = "# solo746d\n\n## Streaming\n\nStream events, original.";
      const superseded = "# solo746d\n\n## Streaming\n\nStream events, SHOULD NOT SURVIVE.";
      const seed = openIndexSession(() => {});
      seed.add("solo746d", url, original, AT);
      expect(seed.flush()).toBe(true);
      resetSearchIndexMemo();

      const session = openIndexSession(() => {});
      session.add("solo746d", url, superseded, AT); // does not match on-disk: the build path, into `pending`
      session.add("solo746d", url, original, AT); // …then matches on-disk after all: the fast path, superseding it
      session.flush();
      // The file must still hold `original` (what it already held, and what the session's OWN
      // last call for this key confirmed) — never `superseded`, which the session itself moved
      // away from before flushing.
      expect(readIndex().libraries.get("solo746d")?.hash).toBe(documentHash(original));
    });

    it("an all-fast-path session (nothing to write) still memoizes every confirmed entry, not just the ones that triggered a write", () => {
      const url = "https://solo746c.example.com/llms.txt";
      const doc = "# solo746c\n\n## Streaming\n\nStream events.";
      const seed = openIndexSession(() => {});
      seed.add("solo746c", url, doc, AT);
      expect(seed.flush()).toBe(true);
      resetSearchIndexMemo();

      const confirmOnly = openIndexSession(() => {});
      confirmOnly.add("solo746c", url, doc, AT); // matches on-disk: fast path, `pending` stays empty
      expect(confirmOnly.flush()).toBe(false); // nothing to write — the case this guard is for

      reads.index = 0;
      const next = openIndexSession(() => {});
      next.add("solo746c", url, doc, AT);
      expect(next.flush()).toBe(false); // short-circuited on memo: correctly "nothing to do" this time
      expect(reads.index).toBe(0); // memo answered without even the one lazy read
    });
  });
});
