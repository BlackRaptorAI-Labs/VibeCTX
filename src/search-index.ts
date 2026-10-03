import { createHash } from "node:crypto";
import { lstatSync, readFileSync, type Stats } from "node:fs";
import { join } from "node:path";
import { newerSchemaVersion, writeAtomic } from "./atomic-store.js";
import { cacheRoot, ensureCacheRoot, isRealDirectory, resetCacheReadMemo } from "./cache.js";
import { validIsoInstant } from "./cache-meta.js";
import { redactUrlForDisplay, sanitizeRemoteUrl } from "./link-policy.js";
import { splitSections, HEADING_WEIGHT, type SplitSection } from "./retrieval.js";
import { MAX_TOKEN_CHARS, RETRIEVAL_VERSION, tokenize } from "./tokenize.js";
import { redactPathsForWarning, writeStderrWarning } from "./redact-paths.js";
import { MAX_NAME_LENGTH } from "./package-names.js";

/**
 * PAR-659 — the inverted index behind cross-library `search`: `<cacheRoot>/index.json`, shape
 * `{ schemaVersion: 1, retrievalVersion: 2, libraries: { "<name>": { url, fetchedAt, hash, lengths, postings } } }`.
 *
 * D-33 — THE INDEX IS A DERIVED CACHE, NEVER A SOURCE OF TRUTH. It exists only so `search`
 * does not re-tokenize 30 × llms-full.txt on every call; every byte it holds can be rebuilt
 * from the document cache, and nothing it holds is ever rendered.
 *
 * What that costs it, deliberately: a posting list carries NO TEXT. Per document it stores
 * the source URL, the document's `fetchedAt` and a content hash — the three D-33 asks for —
 * plus, per section, one number (its token length) and, per term, the sections it occurs in
 * with their weighted frequency. Heading paths and bodies are NOT stored. `search` validates
 * the cached document stat and re-splits its verified body to render, so every character comes from
 * the cache. That is stronger than the hash check alone: an attacker who plants an index
 * whose hash matches the cached document still cannot put one word into the output, because
 * there are no words in the file to put there. What a planted index CAN do is mis-rank —
 * claim a term occurs where it does not — which is a quality bug, not a disclosure.
 *
 * TWO gates close the remaining gap, and the comment is exact about what each one does.
 *
 * (1) The CONTENT HASH. An entry is used only when sha256(cached document)[0..16) equals its
 * `hash` AND its `url` is the URL being served. Anything else — a stale entry, a hand-edited
 * one, a planted one, a document refreshed behind the index's back — is IGNORED and the
 * document is re-tokenized on the spot (slower, correct), then written back best effort. A
 * write failure is a note, never a failed search (D-13).
 *
 * (2) The RETRIEVAL VERSION (D-38). The hash proves the DOCUMENT is unchanged, which is
 * precisely why a change to the tokenizer, the stemmer, `splitSections` or the field weights
 * slips past it: same bytes, different tokens, and the postings on disk answer a query that no
 * longer asks for them. The envelope therefore carries `retrievalVersion`, and a file whose
 * version is not this build's is refused WHOLE — every library rebuilt, never used.
 *
 * What NEITHER gate constrains, stated rather than implied: `lengths` and the section ids
 * inside `postings` are self-consistent but not tied to the document, so a hash-matching
 * PLANTED index can claim sections the document does not have. `search` therefore counts and
 * renders only sections `splitSections` actually produces, so a phantom section can be neither
 * shown nor counted; the residue is mis-ranking, which D-33 already calls a quality bug rather
 * than a disclosure.
 *
 * File discipline is the one every store in the cache directory shares (`atomic-store.ts`):
 * temp file + rename on write; validate-on-read against the rule each field actually has,
 * with a bad ENTRY dropped and a bad ENVELOPE rejecting the whole file; a NEWER
 * `schemaVersion` on disk is never overwritten (K2).
 *
 * D-34 — WHAT GETS INDEXED. Only libraries the current registry knows (curated, config or
 * resolved), and only their PRIMARY cached document — never a followed index page, which is
 * per-query and would make the file unbounded. One posting list per library.
 */

/** Bumped when a key is renamed, removed or changes meaning — and when the WEIGHTING changes,
 *  because a posting list scored under different field weights is silently wrong rather than
 *  unreadable. Version 1 is the first shipped shape (0.2.0). */
export const SEARCH_INDEX_SCHEMA_VERSION = 1;

const FILE_NAME = "index.json";

/** Largest document that is INDEXED. Above this, `search` tokenizes it at query time and says
 *  so for that library — the posting list for a document this size is itself megabytes, and the
 *  time to write it is time the search is not answering. ASSUMED: the largest primary document
 *  seen in the wild is Prisma's ~5 MB llms-full.txt (CITED: PAR-706 rework note), so 8 MiB
 *  leaves headroom while keeping the file bounded. */
export const MAX_INDEXED_DOC_BYTES = 8 * 1024 * 1024;

/** Largest index file that is READ — and, since D-40, the largest that is WRITTEN. Above it the
 *  file is refused whole and every document is tokenized at query time. ASSUMED: 30 libraries ×
 *  a posting list for an 8 MiB document is far under this, so anything larger is a mistake or a
 *  plant, and parsing it would cost more than rebuilding it.
 *
 *  ONE constant on purpose: a write limit above the read limit is a cache that poisons itself,
 *  which is exactly what PAR-659's security gate MEASURED before D-40 (a 74,686,064-byte file
 *  written, then refused by every read, for ever). */
export const MAX_INDEX_FILE_BYTES = 64 * 1024 * 1024;

/** Documents one `search` call may tokenize (a cold cache, a refreshed library, a hash
 *  mismatch). Bounds the worst case: a first search over 30 uncached-index libraries does at
 *  most this much work, and the response says which libraries were left out. ASSUMED. */
export const MAX_LAZY_INDEX_DOCS = 40;

/** Numbers one document's posting lists may hold ([sectionId, tf] pairs, flattened). A
 *  document of pathological vocabulary — a few million distinct tokens — would otherwise
 *  produce a file larger than the document it describes. Refusing to index it costs one
 *  tokenization per search of that library and nothing else. ASSUMED. */
export const MAX_POSTING_NUMBERS_PER_DOC = 4_000_000;

/** Longest library name accepted as a key: npm's published package-name limit, as everywhere else. */
const MAX_NAME = MAX_NAME_LENGTH;
/** Sections one indexed document may have. A 5 MB llms-full.txt runs to a few thousand. ASSUMED. */
const MAX_SECTIONS = 200_000;

/** One indexed document. `postings` maps a STEMMED token (`tokenize`'s output) to a flat
 *  `[sectionId, weightedTf, sectionId, weightedTf, …]` list in ascending section order. */
export interface IndexedDocument {
  /** The cached URL this posting list describes. Used to REFUSE the entry when `search` is
   *  serving another URL for the library; never rendered directly (it also feeds the `Source:`
   *  stamp `search.ts` builds — see `groupHeader` — which redacts independently of this).
   *
   *  PAR-806 (Phase 4) — REDACTED (query, fragment, userinfo stripped via the shared
   *  `redactUrlForDisplay`) at write time (`indexDocument`, below), closing this file as a
   *  disk site for a token-bearing config URL. This DOES narrow the correctness gate's own
   *  discriminating power on the query-string dimension specifically: `search.ts`'s own
   *  read-side check now compares `stored.url === redactUrlForDisplay(currentCandidateUrl)`
   *  rather than the raw candidate — two candidate URLs for the SAME library differing only by
   *  query string are no longer told apart by this field alone. Judged acceptable and disclosed
   *  (docs/decisions.md), unlike the analogous cache-meta/`readCache` identity-check design: this field is never
   *  the PRIMARY defense against serving the wrong document (the CONTENT HASH is, per this
   *  file's own "two gates" comment above), a library has exactly one active candidate URL at a
   *  time rather than two live variants competing for the same posting list, and the worst case
   *  of a stale/wrong match here is a slower, re-tokenized search — never wrong content shown,
   *  since every rendered character comes from the verified CACHED DOCUMENT by content hash
   *  (D-33), not from this field. */
  url: string;
  /**
   * When this entry was written — provenance only. Never rendered, and it gates nothing: the
   * HASH is what decides whether an entry may be used.
   *
   * K2, the divergence stated rather than left to be discovered: this field carries TWO
   * meanings depending on which writer produced the entry. `warm` and the startup autowarm
   * hold the cache meta, so they pass the document's own `fetchedAt` — when the document was
   * fetched. `get_docs` and `resolvePackage` hold the text but not its meta, so they let it
   * default to the INDEXING instant, which is at most milliseconds after the fetch that
   * produced it. Reading a second multi-megabyte file to align them would cost real time for a
   * field nothing reads; giving it one meaning would mean either that read or dropping the
   * cache's own timestamp where we have it. Neither is worth it — so it is documented, and no
   * code may start treating it as the document's age. (`search` reports staleness from the
   * CACHE meta, not from here.)
   */
  fetchedAt: string;
  /** `documentHash` of the text that was indexed. The gate on every use. */
  hash: string;
  /** Per section, the token count `retrieval.ts` computes for BM25 length normalisation
   *  (heading + ancestor path + body, UNWEIGHTED — exactly what `weigh` sums). */
  lengths: number[];
  postings: Map<string, number[]>;
}

/** The index as loaded: what survived validation, plus the one line explaining a file that
 *  did not. `problem` is a note on the response, never an error — a search always works. */
export interface LoadedIndex {
  libraries: Map<string, IndexedDocument>;
  problem?: string;
}

export function searchIndexPath(): string {
  return join(cacheRoot(), FILE_NAME);
}

/** The content hash D-33 requires: the first 16 hex characters of SHA-256 over the document
 *  text. 64 bits of collision resistance for a local cache whose only writer is this tool —
 *  the hash detects a document that CHANGED, and shortens the file by 48 characters per entry. */
export function documentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/**
 * Build the posting list for one document. Weighting is `retrieval.ts`'s, term for term:
 * the section's own heading counts HEADING_WEIGHT times, its ancestor path and its body once,
 * and `length` is the UNWEIGHTED total — so a score computed from these postings equals the
 * score `rankSplitSections` computes for the same section (pinned by a test).
 *
 * undefined when the document is over MAX_INDEXED_DOC_BYTES or its vocabulary is over
 * MAX_POSTING_NUMBERS_PER_DOC: the caller then searches it by direct tokenization instead.
 */
export function indexDocument(url: string, text: string, fetchedAt: string, sections?: SplitSection[]): IndexedDocument | undefined {
  if (Buffer.byteLength(text, "utf8") > MAX_INDEXED_DOC_BYTES) return undefined;
  const split = sections ?? splitSections(text);
  if (split.length > MAX_SECTIONS) return undefined;
  const lengths: number[] = new Array(split.length).fill(0);
  const postings = new Map<string, number[]>();
  let numbers = 0;
  for (let sid = 0; sid < split.length; sid++) {
    const s = split[sid];
    const fields: { tokens: string[]; weight: number }[] = [
      { tokens: tokenize(s!.heading), weight: HEADING_WEIGHT },
      { tokens: s!.path.length ? tokenize(s!.path.join(" ")) : [], weight: 1 },
      { tokens: tokenize(s!.body), weight: 1 },
    ];
    // One tf map per section, then flushed into the posting lists: postings stay in ascending
    // section order without a sort, which is what makes the file byte-stable.
    const tf = new Map<string, number>();
    for (const { tokens, weight } of fields) {
      lengths[sid]! += tokens.length;
      for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + weight);
    }
    for (const [token, count] of tf) {
      let posting = postings.get(token);
      if (posting === undefined) {
        posting = [];
        postings.set(token, posting);
      }
      posting.push(sid, count);
      numbers += 2;
      if (numbers > MAX_POSTING_NUMBERS_PER_DOC) return undefined;
    }
  }
  // PAR-806 (Phase 4) — redacted before it ever reaches disk; see `IndexedDocument.url`'s own
  // comment for what this does and does not weaken.
  return { url: redactUrlForDisplay(url), fetchedAt, hash: documentHash(text), lengths, postings };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The same strict UTC instant `project-store.ts` accepts — `Date.parse` alone takes
 *  `2020-01-01 (‮evil)`, and a timestamp off a trust boundary is validated by SHAPE first. */
// The shared `cache-meta.ts` ISO_INSTANT is bounded to `(\.\d{1,9})?`: `Date.parse` alone is not a length
// backstop (MEASURED, cache-meta.ts's own comment), so an unbounded group here let a planted
// `fetchedAt` of any length reach `Number.isFinite(Date.parse(...))` unrejected by shape alone.
const HASH_SHAPE = /^[0-9a-f]{16}$/;

function isPositiveInt(v: unknown, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;
}

/**
 * Validate one persisted document entry (D-33). Every field is re-checked against the rule
 * that field actually has; ANY failure drops the whole ENTRY, because a posting list that is
 * wrong in one place ranks wrongly everywhere:
 *
 *   url       an https URL that passes `sanitizeRemoteUrl`
 *   fetchedAt a strict ISO-8601 UTC instant
 *   hash      exactly 16 lowercase hex characters
 *   lengths   an array of ≤ MAX_SECTIONS non-negative integers
 *   postings  an object whose keys are ≤ MAX_TOKEN_CHARS characters and whose values are
 *             even-length arrays of non-negative integers, each section id inside `lengths`
 *             and each frequency ≥ 1
 *
 * `postings` is read through `Object.entries` into a Map, so a `__proto__` (or `constructor`)
 * key is data here and can never become a prototype write.
 */
export function toIndexedDocument(raw: unknown): IndexedDocument | undefined {
  if (!isRecord(raw)) return undefined;
  const url = sanitizeRemoteUrl(raw.url);
  if (url === undefined) return undefined;
  if (!validIsoInstant(raw.fetchedAt)) return undefined;
  if (typeof raw.hash !== "string" || !HASH_SHAPE.test(raw.hash)) return undefined;
  if (!Array.isArray(raw.lengths) || raw.lengths.length > MAX_SECTIONS) return undefined;
  const lengths: number[] = [];
  for (const n of raw.lengths) {
    if (!isPositiveInt(n, Number.MAX_SAFE_INTEGER)) return undefined;
    lengths.push(n);
  }
  if (!isRecord(raw.postings)) return undefined;
  const postings = new Map<string, number[]>();
  let numbers = 0;
  for (const [term, list] of Object.entries(raw.postings)) {
    if (term.length === 0 || term.length > MAX_TOKEN_CHARS) return undefined;
    if (!Array.isArray(list) || list.length === 0 || list.length % 2 !== 0) return undefined;
    numbers += list.length;
    if (numbers > MAX_POSTING_NUMBERS_PER_DOC) return undefined;
    for (let i = 0; i < list.length; i += 2) {
      if (!isPositiveInt(list[i], lengths.length - 1)) return undefined;
      if (!isPositiveInt(list[i + 1], Number.MAX_SAFE_INTEGER) || list[i + 1] === 0) return undefined;
    }
    postings.set(term, list as number[]);
  }
  return { url, fetchedAt: raw.fetchedAt, hash: raw.hash, lengths, postings };
}

/** A library key is accepted only in the folded form the registry stores (`resolveLibrary`
 *  compares lowercase, trimmed), so `React` can never sit beside `react` in this file. */
function validLibraryKey(key: string): boolean {
  return key.length > 0 && key.length <= MAX_NAME && key === key.trim().toLowerCase();
}

/**
 * `invalid JSON at position N` — an anchored regex accepts only a terminal V8-shaped
 * position marker, with optional line/column detail. It never echoes a broad error-message
 * slice; a matching marker inside quoted file content remains an unexcluded edge case.
 * This differs from `jsonErrorMessage` in config.ts, which uses an unanchored position
 * match and converts the position to a line and column for that separate trust boundary.
 */
function jsonProblem(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  // V8 quotes hostile source bytes before the real diagnostic, so only accept its position
  // marker at the end of the engine message (optionally followed by line/column detail).
  const match = / at position (\d+)(?: \(line \d+ column \d+\))?$/.exec(raw);
  return match ? `invalid JSON at position ${match[1]}` : "invalid JSON";
}

/**
 * Load the index. Never throws and never reports a failure as an error: a missing, oversized,
 * unparsable or foreign-version file simply loads as EMPTY with a `problem` line, and `search`
 * carries on by tokenizing what it needs.
 *
 * Envelope failures reject the whole file (K1): not an object, `schemaVersion` ≠ ours,
 * `libraries` not an object. Entry failures drop that library only.
 *
 * PAR-859 — the type check and the size check are now ONE `lstatSync` call, not `statSync`
 * (which FOLLOWS a symlink) followed by a separate read: mirrors `cache-meta.ts`'s
 * `readMetaFile`, the established idiom in this codebase for "one `lstat` does double duty for
 * both the type check and the size check, not two syscalls". A symlink (or, the same check,
 * anything else non-regular — a directory, most plausibly) at `index.json`'s own path is treated
 * as an ANOMALY, the same as an oversized file or a wrong schema version below, WITH a `problem`
 * note — corrected from an earlier version of this comment (code-reviewer, Phase 1b review round)
 * that claimed the SAME leak-prevention reasoning as the JSON-parse-error branch below justified
 * staying silent instead. That claim did not hold up: the parse-error branch's actual concern is
 * that V8's syntax-error message quotes BYTES FROM THE FILE verbatim (a real content leak); a
 * symlink/non-regular-file refusal leaks no content at all — there is nothing to scrub. The
 * oversized-file branch immediately below names index.json and its byte size without exposing
 * its local path. Naming an anomalous condition does not require leaking filesystem locations. This project's own convention (`CONTRIBUTING.md`: "fallbacks
 * are stated, never silent") argues for a message, not silence, once the actual (non-)reason for
 * silence is examined — a symlinked or non-regular `index.json` is not the ordinary first-run
 * "no file yet" state (which stays silent, below — that is a normal state, not a fallback), it is
 * exactly the kind of anomaly this function's other branches already name.
 */
function readIndexUnmemoized(): LoadedIndex {
  const path = searchIndexPath();
  const empty = new Map<string, IndexedDocument>();
  // PAR-859 (code-reviewer, Phase 1b review round, BLOCKING) — `lstat` on the joined path below
  // only inspects the LEAF (`index.json` itself); a symlinked cache ROOT (an intermediate path
  // component) whose target genuinely holds a real `index.json` is resolved for traversal
  // regardless, so the leaf check alone never sees it. `isRealDirectory(cacheRoot())` (`cache.ts`,
  // already exported for exactly this reuse by `readCache`/`touchCache`) closes it: a symlinked
  // root reads as absent before the leaf is inspected at all — matching `readCache`'s own
  // root-then-leaf ordering. Silent, like the "no file yet" case just below it, not a `problem`:
  // an absent or unreachable ROOT is the same "nothing to search yet" state a missing file is,
  // not an anomaly about the index file itself.
  if (!isRealDirectory(cacheRoot())) return { libraries: empty };
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch {
    return { libraries: empty }; // no file yet is the ordinary first-run state, not a problem
  }
  if (!stat.isFile()) {
    // A symlink, a directory, or anything else non-regular at index.json's own path: an anomaly,
    // named above, but the message carries no content from whatever is actually there — only the
    // fact that something non-regular sits at a path this function already knows.
    return { libraries: empty, problem: "search index ignored: not a regular file (a symlink or a directory); rebuilt as needed" };
  }
  if (stat.size > MAX_INDEX_FILE_BYTES) {
    return { libraries: empty, problem: `search index ignored: index.json is ${stat.size} bytes, over the ${MAX_INDEX_FILE_BYTES}-byte limit` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    // S2 / the D-22 precedent: the POSITION, and nothing from the file. Every V8 syntax-error
    // message quotes a run of the offending source ("Unexpected token 'S', \"SUPERSECRE\"... is
    // not valid JSON"), and this note is rendered into an MCP response — so a symlinked or
    // hand-placed index.json would leak its first bytes to the model. The message is discarded.
    return { libraries: empty, problem: `search index unreadable (${jsonProblem(e)}); rebuilt as needed` };
  }
  if (!isRecord(parsed) || !isRecord(parsed.libraries)) {
    return { libraries: empty, problem: "search index ignored: not a valid index file; rebuilt as needed" };
  }
  if (parsed.schemaVersion !== SEARCH_INDEX_SCHEMA_VERSION) {
    return {
      libraries: empty,
      problem: `search index ignored: schemaVersion ${String(parsed.schemaVersion)} (this version reads ${SEARCH_INDEX_SCHEMA_VERSION})`,
    };
  }
  // D-38: postings written by a different tokenizer, stemmer, splitter or field weighting
  // describe the same bytes under different terms — the hash cannot see it, so the version
  // does. Refused WHOLE and rebuilt, exactly as a stale hash is.
  if (parsed.retrievalVersion !== RETRIEVAL_VERSION) {
    return {
      libraries: empty,
      problem: `search index ignored: built by retrieval version ${String(parsed.retrievalVersion)} (this build is ${RETRIEVAL_VERSION}); rebuilt as needed`,
    };
  }
  const libraries = new Map<string, IndexedDocument>();
  let dropped = 0;
  for (const [key, value] of Object.entries(parsed.libraries)) {
    if (!validLibraryKey(key)) {
      dropped += 1;
      continue;
    }
    const doc = toIndexedDocument(value);
    if (doc === undefined) {
      dropped += 1;
      continue;
    }
    libraries.set(key, doc);
  }
  return dropped > 0 ? { libraries, problem: `search index: ${dropped} invalid entr${dropped === 1 ? "y" : "ies"} dropped; rebuilt as needed` } : { libraries };
}

let parsedMemo: { path: string; stamp: string; loaded: LoadedIndex } | undefined;

function indexStat(path: string): string | undefined {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(MAX_INDEX_FILE_BYTES)) return undefined;
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch { return undefined; }
}

/** Callers edit their own maps; they cannot corrupt the next reader's parsed cache. */
function cloneLoaded(loaded: LoadedIndex): LoadedIndex {
  return { ...loaded, libraries: new Map([...loaded.libraries].map(([key, doc]) => [key, {
    ...doc, lengths: doc.lengths.slice(),
    postings: new Map<string, number[]>([...doc.postings].map(([term, list]) => [term, list.slice()])),
  }])) };
}

/** Reuse validated JSON only at the same real-root, regular-file stat. Nanosecond
 * ctime also invalidates same-size edits whose mtime was restored by another writer. */
export function readIndex(): LoadedIndex {
  const path = searchIndexPath();
  const stamp = isRealDirectory(cacheRoot()) ? indexStat(path) : undefined;
  if (!stamp) { parsedMemo = undefined; return readIndexUnmemoized(); }
  if (parsedMemo?.path === path && parsedMemo.stamp === stamp) return cloneLoaded(parsedMemo.loaded);
  const loaded = readIndexUnmemoized();
  if (indexStat(path) === stamp) parsedMemo = { path, stamp, loaded };
  else parsedMemo = undefined;
  return cloneLoaded(loaded);
}

/** Serialise one entry with its keys in the documented order and its terms sorted. */
function toRecord(doc: IndexedDocument): Record<string, unknown> {
  const postings: Record<string, number[]> = {};
  for (const term of [...doc.postings.keys()].sort()) postings[term] = doc.postings.get(term)!;
  return { url: doc.url, fetchedAt: doc.fetchedAt, hash: doc.hash, lengths: doc.lengths, postings };
}

/** The two halves of the envelope. Assembling the file from pre-serialised entries rather than
 *  handing one big object to `JSON.stringify` is what lets the write cap PRICE each entry
 *  without serialising the whole index twice; the bytes are identical either way, and
 *  "writes byte-identical files for the same data" pins that. */
const ENVELOPE_HEAD = `{"schemaVersion":${SEARCH_INDEX_SCHEMA_VERSION},"retrievalVersion":${RETRIEVAL_VERSION},"libraries":{`;
const ENVELOPE_TAIL = "}}";

/**
 * D-40 — THE INDEX CAN NEVER POISON ITSELF. `writeIndex` refuses to emit a file larger than
 * the `MAX_INDEX_FILE_BYTES` that `readIndex` refuses; when the payload is over, the LARGEST
 * entries are shed until it is not, and the caller is told which libraries went and why.
 *
 * MEASURED before this existed: `search` over seven large documents wrote a 74,686,064-byte
 * index that every later read then refused — permanently. Each subsequent search re-tokenized
 * all seven documents and rewrote the same 74.7 MB, 21.5 s per search, for ever. The index is
 * a cache whose whole purpose is to be cheaper than not having it; a cache that can write
 * itself into a state it will not read is worse than no cache at all.
 *
 * Largest-first is the right shedding order for the same reason: the entries that push the
 * file over are the ones whose absence costs the least per byte saved, and a shed library is
 * not a lost library — `search` tokenizes it at query time and says so.
 *
 * Returns the file text to write and the names shed, largest first.
 */
function serialiseIndex(libraries: Map<string, IndexedDocument>): { text: string; shed: string[] } {
  // Libraries sorted, terms sorted inside each record: two writes of the same data produce
  // identical bytes (a diffable, cache-friendly file).
  const sized = [...libraries.keys()].sort().map((name) => {
    const key = JSON.stringify(name);
    const value = JSON.stringify(toRecord(libraries.get(name)!));
    // The entry as it sits in the object, plus its separating comma.
    return { name, key, value, bytes: Buffer.byteLength(key, "utf8") + 1 + Buffer.byteLength(value, "utf8") + 1 };
  });
  const overhead = ENVELOPE_HEAD.length + ENVELOPE_TAIL.length;
  let total = overhead + sized.reduce((n, e) => n + e.bytes, 0);
  const shed: string[] = [];
  if (total > MAX_INDEX_FILE_BYTES) {
    // Largest first, ties by name, so the choice is deterministic across runs.
    const dropped = new Set<string>();
    for (const entry of [...sized].sort((a, b) => b.bytes - a.bytes || (a.name < b.name ? -1 : 1))) {
      if (total <= MAX_INDEX_FILE_BYTES) break;
      dropped.add(entry.name);
      shed.push(entry.name);
      total -= entry.bytes;
    }
    for (let i = sized.length - 1; i >= 0; i--) if (dropped.has(sized[i]!.name)) sized.splice(i, 1);
  }
  return { text: ENVELOPE_HEAD + sized.map((e) => `${e.key}:${e.value}`).join(",") + ENVELOPE_TAIL, shed };
}

/**
 * Write the index atomically (temp file + rename). Returns false, with a note via `warn`, when
 * the file on disk belongs to a NEWER schema version — that file is not ours to rewrite (K2) —
 * and false when the write itself fails, because an unwritable cache must cost a slower search
 * and nothing else (D-13). Never throws.
 *
 * D-40: what is emitted is always small enough for `readIndex` to accept; `onShed` reports the
 * libraries dropped to keep it so, for the caller that has somewhere to say it.
 */
export function writeIndex(
  libraries: Map<string, IndexedDocument>,
  warn: (message: string) => void = (m) => writeStderrWarning(m),
  onShed?: (shed: string[]) => void,
): boolean {
  const path = searchIndexPath();
  try {
    // PAR-805: owner-only (0700), and warns once if the root pre-existed looser. Wrapped: this
    // module's own `warn` default has no trailing newline, unlike `ensureCacheRoot`'s own
    // (`toStderr`) — see `resolved-store.ts`'s identical wrap for the full reasoning.
    //
    // PAR-859: checked explicitly and returned early on refusal, rather than left to the
    // surrounding try/catch (which already returns `false` on any exception) — `ensureCacheRoot`
    // refusing a symlink does not throw, so relying on the catch here would silently mask the
    // refusal as an ordinary write failure rather than the specific one it is.
    if (!ensureCacheRoot(cacheRoot(), (m) => warn(`${m}\n`))) return false;
    const newer = newerSchemaVersion(path, SEARCH_INDEX_SCHEMA_VERSION, MAX_INDEX_FILE_BYTES);
    if (newer !== undefined) {
      warn(
        `vibectx: not writing the search index — ${path} has a newer schemaVersion ${newer} (this version writes ${SEARCH_INDEX_SCHEMA_VERSION}); upgrade vibectx or delete the file\n`,
      );
      return false;
    }
    const { text, shed } = serialiseIndex(libraries);
    if (shed.length > 0) {
      // D-42: remember WHAT was shed and for WHICH text, so the next caller neither rebuilds
      // that posting list nor hands it back to be shed again (see `shedInThisProcess`).
      for (const name of shed) shedMemo.set(name, libraries.get(name)!.hash);
      warn(
        `vibectx: search index would exceed the ${MAX_INDEX_FILE_BYTES}-byte limit; not indexing ${shed.length} librar${shed.length === 1 ? "y" : "ies"} (${shed.join(", ")}) — they are tokenized at query time instead\n`,
      );
      onShed?.(shed);
    }
    // PAR-805 (F-7 file-mode half): owner-only, self-healing across every write.
    writeAtomic(path, text, { mode: 0o600 });
    return true;
  } catch (e) {
    warn(`vibectx: search index not written: ${redactPathsForWarning(e instanceof Error ? e.message : String(e), cacheRoot())}\n`);
    return false;
  }
}

/**
 * D-34 — what `refresh` does to the index: DELETE the library's posting list and write the
 * file back. The next write (warm, autowarm, get_docs) or the next `search` rebuilds it from
 * whatever the cache then holds. Deleting rather than rebuilding here is deliberate: refresh
 * may fail, and an entry deleted is an entry that cannot be stale, while an entry rebuilt from
 * a document the refresh did not replace is work done twice.
 *
 * Returns true when the file was rewritten. Absent library, absent file, unwritable cache: false.
 */
export function invalidateIndex(library: string, warn: (message: string) => void = (m) => writeStderrWarning(m)): boolean {
  const key = library.trim().toLowerCase();
  const { libraries } = readIndex();
  if (!libraries.delete(key)) return false;
  memo.delete(key);
  shedMemo.delete(key); // D-42: a refreshed library is a new document, not a settled verdict
  return writeIndex(libraries, warn);
}

/**
 * The in-process memo behind `indexCachedDocument`: library → the hash (and URL) this process
 * last wrote. Without it, every get_docs call on a warm cache would parse the whole index file to
 * discover it had nothing to do. Reset by `resetSearchIndexMemo` (tests).
 *
 * PAR-803 — keyed by `(hash, url)`, not hash alone: a library whose URL changes (a curated
 * `urls` reorder, a re-resolution to a different candidate) while its content happens to be
 * byte-identical used to short-circuit on the hash match alone and never get re-offered to the
 * index under the new URL — `readIndex`'s own read-time gate (`stored.url === url &&
 * stored.hash === hash`, `search.ts`) would still correctly REFUSE to serve the stale URL's
 * entry, so this degraded to slower query-time tokenization on every search, never wrong content
 * — but it defeated the whole point of this memo for that library until the process restarted.
 * Comparing the REDACTED url (the same form `IndexedDocument.url`/`existing.url` already store
 * and compare — see that field's own comment) rather than the raw candidate, for the identical
 * reason `add()`'s `existing.url === redactUrlForDisplay(url)` check already redacts.
 */
const memo = new Map<string, { hash: string; url: string }>();

/**
 * D-42 — THE OTHER HALF OF D-40: library → the hash of the text `writeIndex` SHED for it in
 * this process. D-40 stopped the index writing a file it would then refuse to read; it did not
 * stop the caller one level up rebuilding the shed posting list on every call and handing it
 * back to be shed again — which re-serialised and rewrote the WHOLE file each time for no
 * change at all. MEASURED by PAR-659's security gate: 64,016,652 bytes rewritten in 14.5–14.7 s
 * per search, indefinitely.
 *
 * Keyed by HASH, not by name alone, so a library whose document is later refreshed (or shrinks)
 * is tried again rather than written off for the life of the process — the same discipline
 * `warm`'s recent-failure memo keeps, and the reason this is a memo and not a persisted fact:
 * shedding depends on what ELSE is in the file, so it is true of this process's view, not of
 * the library.
 *
 * What it must never do is silence the library: the caller still SEARCHES it (by direct
 * tokenization) and still names it in the response.
 */
const shedMemo = new Map<string, string>();

/** True when `writeIndex` already shed exactly this text for this library in this process, so
 *  building its posting list again would only produce a payload that sheds it again. */
export function shedInThisProcess(library: string, hash: string): boolean {
  return shedMemo.get(library.trim().toLowerCase()) === hash;
}

/** Test hook — and the seam the server would use if it ever reloaded the cache root. */
export function resetSearchIndexMemo(): void {
  memo.clear();
  shedMemo.clear();
  parsedMemo = undefined;
  resetCacheReadMemo();
}

/**
 * R2 — ONE RUN, ONE READ. `warm` and the startup autowarm write thirty primary documents in a
 * row; calling `indexCachedDocument` per library parsed the whole index file thirty times to
 * discover, thirty times, that there was nothing to do. MEASURED: 7,529 ms added to an
 * already-fresh 30-library / 150 MB warm for zero index change.
 *
 * A session reads the file ONCE (lazily, on the first library that the in-process memo cannot
 * answer for), builds posting lists as documents arrive, and writes ONCE at the end. `flush()`
 * is safe to call more than once and does nothing when nothing changed. Nothing here throws:
 * the index is derived, so a failure leaves the caller's own result untouched (D-13).
 *
 * The final write re-reads first — one extra read per run, not per library — which NARROWS the
 * window in which a concurrent writer (another `vibectx` process, a `get_docs` in the same run)
 * can lose an entry: from "first `add()` to `flush()`" (a whole warm loop) down to "re-read to
 * rename" (one serialise plus one write). It does not CLOSE it (F-3, PAR-740): the read-then-
 * write is UNLOCKED and the write replaces the WHOLE map, so any entry another process commits
 * inside that narrower window is lost — its own library or one this session never touched alike
 * — last writer wins, the identical limitation `resolved-store.ts` states for its own record.
 * (A re-read entry can also fail to reach disk for an unrelated reason: D-40 shedding, below.)
 * Never a corrupt file either way (`writeAtomic`'s temp-file-plus-rename); acceptable for the
 * single-user local tool this is. Closing the window for real means locking the index write —
 * more machinery, and a stale-lock failure mode of its own — a design decision this comment
 * does not make on its own.
 */
export interface IndexSession {
  /** Offer one primary cached document to the index. Cheap when it is already indexed. */
  add(library: string, url: string, text: string, fetchedAt?: string): void;
  /**
   * A3 (PAR-716) — mark a library's entry for removal, batched into this session's one
   * flush instead of `invalidateIndex`'s own read+write. Same D-34 intent: a caller about to
   * attempt work that might fail marks the OLD entry gone first, so a failure leaves nothing
   * stale rather than something rebuilt from a document that was never replaced. An `add()`
   * for the same library later in this session — the success case — supersedes the removal;
   * flush() applies only whichever of the two a library saw LAST.
   */
  remove(library: string): void;
  /** Write what was collected. True when the file was rewritten. */
  flush(): boolean;
}

export function openIndexSession(
  warn: (message: string) => void = (m) => writeStderrWarning(m),
  onShed?: (shed: string[]) => void,
): IndexSession {
  let snapshot: Map<string, IndexedDocument> | undefined;
  const pending = new Map<string, { doc: IndexedDocument; hash: string } | "remove">();
  // PAR-746 (F-9, SF-3) — the matching-`existing` fast path below used to call `memo.set`
  // immediately, before this session even knew whether ITS OWN `flush()` would shed the entry
  // (D-40, largest-first, over the whole re-read map, not just `pending`). `confirmed` defers
  // that: a key lands here instead of in `memo` directly, and `flush()` — the one place that
  // actually knows what got shed — is what commits it to `memo`, exactly the same way it
  // already does for `pending`. See `flush()` for the other half.
  const confirmed = new Map<string, { hash: string; url: string }>();
  return {
    add(library, url, text, fetchedAt) {
      const key = library.trim().toLowerCase();
      if (!validLibraryKey(key)) return;
      try {
        const hash = documentHash(text);
        const supersedesRemoval = pending.get(key) === "remove";
        // PAR-803 — both the hash AND the (redacted) url must match this process's last-written
        // memo for the short-circuit to be valid; see `memo`'s own comment above.
        const memoed = memo.get(key);
        if (!supersedesRemoval && memoed?.hash === hash && memoed?.url === redactUrlForDisplay(url)) return;
        snapshot ??= readIndex().libraries; // the ONE read
        const existing = snapshot.get(key);
        // security-architect S1 (Phase 4 round 2) — `existing.url` is REDACTED on disk
        // (`indexDocument`'s own write-time redaction, PAR-806), so comparing it against the
        // RAW `url` this call was offered directly would never match for a query-bearing or
        // normalization-affected URL, even when nothing actually changed — silently forcing a
        // full rebuild (and a full index rewrite) on every `add()` for that library, forever.
        // Redact `url` the same way before comparing, matching `search.ts`'s own identical fix
        // for the read-side hash+url gate.
        if (existing && existing.hash === hash && existing.url === redactUrlForDisplay(url)) {
          // Round 1 (code-reviewer, S5): the on-disk entry already matches — cancel a pending
          // removal rather than rebuilding an identical posting list. A refresh that finds
          // nothing changed across the whole loop ends this call with `pending` AND
          // `confirmed` both empty, so `flush()` below returns before its own re-read: one
          // read, zero writes, not three and a 16.9 MB rewrite for a no-op.
          //
          // PAR-746 (F-9, round 2, SF-3 — was "named as a gap not fixed here", now fixed):
          // `memo` is no longer set here directly. Recorded into `confirmed` instead, so
          // `flush()` can correct it if THIS SAME flush's write ends up shedding the entry —
          // the fix applies equally to the plain (non-`remove()`) fast path every caller of
          // `indexCachedDocument`/`openIndexSession` already uses, not only this cancel
          // branch, per the issue's own scope (fixing one and not the other would leave the
          // larger, older instance live).
          //
          // PAR-746 round 2 (code-reviewer, B1) — `pending` is cleared UNCONDITIONALLY here,
          // not only when it held "remove": the on-disk entry matches what is offered NOW, so
          // any EARLIER pending build for this same key in this session (a prior `add()` call
          // that computed different content before this one) is superseded and must not survive
          // to `flush()`. Before this, only the removal case cleared `pending` — a same-session
          // `add(K, textA)` (→ `pending`) followed by `add(K, textB)` matching the on-disk entry
          // (→ `confirmed`) left BOTH maps holding `K`, and `flush()`'s two commit loops (pending
          // first, confirmed second) let `confirmed`'s hash win in `memo` even though `pending`'s
          // content was what actually got written to disk — a `memo` entry pointing at a hash
          // the file never held under that key. MEASURED not reachable by any current caller
          // (each call site offers one document per library per session), but reachable through
          // the exported `IndexSession` API, and the fix is one unconditional delete.
          pending.delete(key);
          confirmed.set(key, { hash, url: existing.url });
          return;
        }
        // A key that previously took the fast path in THIS session (recorded into `confirmed`)
        // is about to get REAL new content instead — drop the stale confirmation so `flush()`
        // doesn't later overwrite the correct hash `pending` just wrote with this old one.
        confirmed.delete(key);
        // `fetchedAt` is provenance only — it is never rendered and never gates anything (the
        // HASH does). A caller that has the cache meta to hand passes it; one that does not
        // (get_docs, which holds the document but not its meta) lets it default to the indexing
        // instant rather than paying a second full read of a multi-megabyte file for a field
        // nobody reads. K2: the two meanings are documented on `IndexedDocument.fetchedAt`.
        const doc = indexDocument(url, text, fetchedAt ?? new Date().toISOString());
        if (doc === undefined) return; // too large to index; search tokenizes it at query time (D-36)
        pending.set(key, { doc, hash });
      } catch (e) {
        warn(`vibectx: search index not updated for "${key}": ${redactPathsForWarning(e instanceof Error ? e.message : String(e), cacheRoot())}\n`);
      }
    },
    remove(library) {
      const key = library.trim().toLowerCase();
      // Round 1 (code-reviewer, N1): same guard `add()` applies. Without it an invalid key
      // still lands in `pending`, forcing a full read and a 16.9 MB rewrite at `flush()` for a
      // delete that could never have matched anything in the index anyway.
      if (!validLibraryKey(key)) return;
      // Same reason `invalidateIndex` clears both (D-42): a memo entry from BEFORE this
      // removal must not let a later `add()` in this or a future session believe the hash it
      // is offering is already on disk when this session is about to delete it. `confirmed`
      // gets the same treatment (PAR-746): a fast-path confirmation from EARLIER in this same
      // session must not survive a `remove()` for the same key — flush() would otherwise
      // re-add a `memo` entry for a library this very flush is about to delete.
      memo.delete(key);
      shedMemo.delete(key);
      confirmed.delete(key);
      pending.set(key, "remove");
    },
    flush() {
      if (pending.size === 0) {
        // This SESSION has nothing to write, so ITS OWN flush could not have just shed a
        // `confirmed` entry — safe to commit every one of them to `memo`. (Round 2,
        // code-reviewer, S3: a DIFFERENT, concurrently-open session in this same process could
        // still shed or delete one of these keys via its own write between this session's
        // `add()` calls and this `flush()` — `refresh.ts` holds a session open across a nested
        // `resolvePackage` call that writes independently. That residual is real but pre-existing
        // and not particular to this branch: nothing here reads the file to check, by design —
        // the whole point of this early return is to cost zero I/O when there is nothing to
        // write.) Skipping this commit entirely (returning early the way this function used to,
        // with `confirmed` left unset) would silently undo the whole point of the fast path:
        // every future `add()` for these keys would re-pay the "does the existing entry already
        // match" check this session already did, defeating the memo for the common
        // all-cache-warm case its own module comment describes.
        for (const [key, c] of confirmed) memo.set(key, c);
        confirmed.clear();
        return false;
      }
      try {
        // Re-read rather than reusing the snapshot: between the first `add` and here, another
        // process may have written entries this run knows nothing about, and the index is a
        // shared cache, not this run's private state.
        const { libraries } = readIndex();
        for (const [key, value] of pending) {
          if (value === "remove") libraries.delete(key);
          else libraries.set(key, value.doc);
        }
        // D-42: `writeIndex` returns true when it SHED entries to stay inside the read limit,
        // so "the file was written" is not "this entry was written". The memo exists to let a
        // later session skip work that is already ON DISK; recording a shed entry made the next
        // session short-circuit and report "nothing to do" about a library the file does not
        // hold. Whether an entry sheds depends on what else is in the file, so it is offered
        // again — the per-process shed memo above is what keeps the SEARCH path from paying
        // for that on every call.
        //
        // PAR-746 (F-9): `shed` is built from `writeIndex`'s own callback, which reports shed
        // names from the WHOLE re-read `libraries` map — including a `confirmed` entry that was
        // never touched by `pending` at all. `confirmed` is checked against it exactly the same
        // way `pending` is, which is the actual fix: before this, only `pending` was checked,
        // so a `confirmed` (fast-path) entry shed by this same write had nothing to catch it.
        const shed = new Set<string>();
        const written = writeIndex(libraries, warn, (names) => {
          for (const name of names) shed.add(name);
          onShed?.(names);
        });
        if (written) {
          for (const [key, value] of pending) if (value !== "remove" && !shed.has(key)) memo.set(key, { hash: value.hash, url: value.doc.url });
          // Round 2 (security-architect + code-reviewer, S3): `!shed.has(key)` alone answers
          // "did THIS write's own shed decision drop it", not "is `hash` actually what the file
          // now holds for `key`". `confirmed` was built from `snapshot` — a read taken BEFORE
          // this flush — so between that read and this write, ANOTHER session in this same
          // process could have changed or deleted this key entirely (`writeIndex` does not
          // mutate the map it is handed — `serialiseIndex` only splices its own local copy — so
          // `libraries` here is still exactly what was just serialised, making this a direct
          // check against reality, not a second guess). `pending`'s own entries need no such
          // check: they were written INTO `libraries` by the loop just above, synchronously,
          // with nothing able to run between that and `writeIndex`, so they are what they claim
          // to be by construction.
          for (const [key, c] of confirmed) if (!shed.has(key) && libraries.get(key)?.hash === c.hash) memo.set(key, c);
        }
        pending.clear();
        confirmed.clear();
        // PAR-802 — `snapshot` is a lazy, ONE-TIME read (`??=` above), taken to answer "does the
        // on-disk entry already match" for THIS session's `add()` calls; it is never invalidated
        // after a successful `flush()` writes new content. Not live today (every current caller
        // opens one session and flushes once, in a `finally`), but `openIndexSession` is exported
        // API: a caller that keeps calling `add()`/`remove()` on the SAME session object after a
        // successful `flush()` would otherwise consult the STALE pre-flush snapshot — e.g.
        // re-offering a just-removed library would wrongly see its old `existing` entry and take
        // the "nothing changed" fast path. Forcing the next `add()` to re-read (`snapshot ??=`
        // above) closes it at negligible cost: one extra read, only for a session that is reused
        // after a write actually happened.
        if (written) snapshot = undefined;
        return written;
      } catch (e) {
        warn(`vibectx: search index not updated: ${redactPathsForWarning(e instanceof Error ? e.message : String(e), cacheRoot())}\n`);
        pending.clear();
        confirmed.clear();
        return false;
      }
    },
  };
}

/**
 * D-34 (a) — the incremental hook a writer of ONE primary cached document calls (`get_docs`,
 * `resolvePackage`). A one-document session: read, build, write. Callers writing MANY documents
 * in a row open a session instead (R2) — `warm` and the autowarm do.
 *
 * Never throws and never blocks the caller's own result: a document too large to index, an
 * unwritable cache, a newer schema on disk — each leaves the caller's fetch exactly as
 * successful as it was and the index exactly as usable as it was (D-13).
 */
export function indexCachedDocument(
  library: string,
  url: string,
  text: string,
  fetchedAt?: string,
  warn: (message: string) => void = (m) => writeStderrWarning(m),
): void {
  const session = openIndexSession(warn);
  session.add(library, url, text, fetchedAt);
  session.flush();
}
