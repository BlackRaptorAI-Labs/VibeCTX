import { lstatSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { debugField } from "./debug.js";
import { readMetaFile } from "./cache-meta.js";
import { writeStderrWarning } from "./redact-paths.js";

/**
 * PAR-652 item 7a — a total size cap on the cache, with least-recently-used eviction.
 *
 * Nothing bounded the cache before this. `vibectx warm` on a large project caches one
 * primary document per dependency, each up to the 25 MiB `PRIMARY_DOC_MAX_BYTES`, and
 * nothing ever removed one — a cache is not supposed to be able to fill a laptop.
 *
 * WHAT COUNTS AND WHAT IS EVICTED ARE DIFFERENT SETS, deliberately.
 *   Counted toward the cap: every regular file under the cache root, including
 *   `index.json`, `resolved.json`, `activity.json` (PAR-799: missing from this list before —
 *   `scanCache`'s own generic top-level loop already counted it, this comment just hadn't kept
 *   up), `doctor.json` and `projects/*.json` — because the cap is a promise about disk, and a
 *   promise that ignores half the directory is not one.
 *   Evictable: only library DOCUMENTS — a `<slug>.md` with its `<slug>.meta.json`, inside a
 *   per-library directory. Those are re-fetchable from the network; a resolution record or
 *   a project record is not, and the index rebuilds itself from documents anyway.
 *
 * RECENCY is `meta.fetchedAt`, which `touchCache` already refreshes on every 304
 * revalidation — so a document that is still being used keeps moving to the back of the
 * queue even when its bytes never change. A meta file that fails `toCacheMeta` validation
 * (D-71, PAR-749 — shared with `cache.ts` via `./cache-meta.js`; before D-71 this file parsed
 * `.meta.json` itself, ad hoc and more laxly than `readCache`) sorts as oldest: post-A4,
 * `readCache` treats the same failure as fully UNCACHED rather than "stale but served" (N-6 is
 * superseded), and a document whose meta this process cannot trust is exactly the one to drop
 * first here too — "oldest" for eviction purposes, not a claim that it is still being served.
 *
 * WHAT "THIS RUN" MEANS is one sweep, not one process (R3, PAR-652c). `writtenThisRun` holds
 * the documents written since the last sweep, and the sweep clears it down to the write that
 * triggered it. It used to hold everything the process had ever written, which in a server is
 * everything, full stop — so the cap applied to a fresh process and to nothing else. The
 * protection's job is narrow: stop a single write being undone by the sweep it triggers. Once
 * a document has survived one sweep it has been returned to its caller and is re-fetchable,
 * so it takes its turn like any other.
 *
 * KNOWN LIMIT — two vibectx processes on one cache. `writtenThisRun` is per-process, so
 * this process can evict a document the other one fetched seconds ago. That is a wasted
 * refetch, not a correctness problem: the other process already returned the content it
 * fetched, and every reader re-reads from disk and treats a missing file as a miss
 * (`readCache` requires both files to exist; `search` skips a group whose body it cannot
 * re-read). Sharing the protected set would need a file two processes agree on — the
 * mutable-shared-state bug class this cache is built to avoid — so it is not shared.
 *
 * SYMLINKS are never followed and never removed — `lstat` decides what is a directory and
 * what is a regular file, the same rule the temp sweep in `atomic-store.ts` applies. The
 * cache directory is a trust boundary: a link planted in it must not be able to aim a
 * delete anywhere else.
 *
 * THE ROOT ITSELF is checked the same way (D-46, PAR-652b). It was the one position where
 * nothing did: the walk refused to descend a symlinked LIBRARY directory but `readdirSync`
 * followed a symlinked ROOT without a word, and the security gate measured the consequence —
 * a link planted in the root position made this function delete `Documents/project/thesis.md`,
 * a file it had never written. The root must now be PROVEN a real directory before a single
 * `rmSync` runs; a symlink there is refused once on stderr and the sweep is skipped, never
 * followed.
 */

/** Default cap. ASSUMED: 512 MB is roughly 20 documents at the 25 MiB primary cap, which is
 *  a warmed medium project, and small enough that no one notices it on a modern disk.
 *  There is no measurement behind the number — challenge it. */
export const DEFAULT_CACHE_MAX_MB = 512;

/**
 * Ceiling on how many bytes may be written between full sweeps. ASSUMED — see below.
 *
 * The alternative designs were: stat the whole cache on every write (a warm run writes
 * hundreds of documents, so that is hundreds of full directory walks — the "stat the world"
 * the brief rules out), or keep a running total in a sidecar file (a second piece of
 * mutable state that two concurrent vibectx processes would have to agree on, which is the
 * bug class `atomic-store.ts` exists to avoid).
 *
 * What is here instead: accumulate the bytes THIS process has written and sweep when they
 * exceed `sweepThresholdBytes()` — plus once on the first write, so a process that starts
 * against an already-oversized cache fixes it immediately rather than after a threshold of
 * new work. The price is the overshoot: between sweeps the cache may exceed the cap by up to
 * the threshold plus one document.
 *
 * WHERE THIS NUMBER COMES FROM (Q2, PAR-652c) — nowhere. 16 MiB is a chosen constant, not a
 * figure derived from a cost measurement, and no measurement would produce it: it is the
 * ratio between two costs (a sweep's `lstat` walk against the writes it is amortised over)
 * and any value spanning an order of magnitude either way would be defensible. What IS
 * measured is the cost it trades against, so the trade can be judged rather than taken on
 * faith — MEASURED 2026-09-07 (Node 22.22.2, tmpfs, warm page cache, median of 5) by
 * `enforceCacheSizeCap` over a synthetic under-cap cache: 1,000 documents (2,000 files) swept
 * in 10.1 ms and 10,000 documents (20,000 files) in 82.5 ms — 4-5 microseconds per file,
 * linear, and no meta file parsed because the cache is under the cap. So even a
 * 10,000-document cache costs ~83 ms of sweep per 16 MiB written, about 5 ms per megabyte.
 * That is the number to argue with; the constant itself is a judgement about how much
 * overshoot is acceptable, not a result. Note also that the threshold actually in force is
 * `sweepThresholdBytes()`, which lowers this ceiling for a small cap.
 */
export const EVICTION_SWEEP_BYTES = 16 * 1024 * 1024;

/** A file inside the cache that is never evicted, whatever its age. */
const NEVER_EVICT_DIRS = new Set(["projects"]);

export interface EvictedDocument {
  library: string;
  /** The document file's name inside the library directory (the URL slug), not the URL. */
  document: string;
  bytes: number;
  /** `meta.fetchedAt`, or `undefined` when the meta was missing or unreadable. */
  fetchedAt?: string;
}

export interface EvictionSummary {
  sweptAt: string;
  capBytes: number;
  totalBytesBefore: number;
  totalBytesAfter: number;
  evicted: EvictedDocument[];
  /** Documents that were older than the ones evicted but were written by THIS run. */
  protectedFromEviction: number;
  /** True when the cache is still over the cap after evicting everything it was allowed to. */
  stillOverCap: boolean;
}

interface CandidateDocument {
  library: string;
  document: string;
  contentPath: string;
  metaPath: string;
  bytes: number;
  /** Both are filled in by `resolveRecency`, and only when the cache is over the cap. */
  fetchedAtMs: number;
  fetchedAt?: string;
}

let writtenThisRun = new Set<string>();
let bytesSinceSweep = 0;
let sweeps = 0;
let sweptEver = false;
let lastSummary: EvictionSummary | undefined;
/** Roots already refused under D-46 — the note is said once per root, not once per sweep. */
let refusedRoots = new Set<string>();

/** Test seam and per-process reset: forget which documents this run wrote and what it swept. */
export function resetCacheEvictionState(): void {
  writtenThisRun = new Set<string>();
  bytesSinceSweep = 0;
  sweeps = 0;
  sweptEver = false;
  lastSummary = undefined;
  refusedRoots = new Set<string>();
  badCapNoted = false;
}

/** How much sweeping this process has actually done — for tests and for the debug log. */
export function cacheEvictionStats(): { sweeps: number; bytesSinceSweep: number } {
  return { sweeps, bytesSinceSweep };
}

/** The last sweep that evicted something, or `undefined` if none has. `doctor` reports it. */
export function lastEvictionSummary(): EvictionSummary | undefined {
  return lastSummary;
}

/**
 * The cap in bytes, or `undefined` when it is switched off. `VIBECTX_CACHE_MAX_MB` accepts
 * a fractional value (a cap in the kilobytes is only useful to a test, but refusing it
 * would be arbitrary); `0` turns the cap off entirely; anything unparsable or negative
 * falls back to the default rather than silently disabling the cap — a typo must not be a
 * way to lose the bound.
 *
 * AND IT SAYS SO (K3, PAR-652c). Falling back silently made a typo indistinguishable from a
 * setting that worked: `VIBECTX_CACHE_MAX_MB=2GB` or `=-1` produced a 512 MB cache and no
 * clue why, which is the worst of both — the bound is kept, and the user's intent is thrown
 * away without a word. One line per process, on the first substitution, naming the value that
 * was refused. An absent or empty variable is not a typo and says nothing.
 *
 * NOTE THE UNITS: the variable says MB and the arithmetic is MiB (×1024×1024), matching the
 * `formatBytes` labels on the stderr and `doctor` lines. Documented at README "Size cap".
 */
let badCapNoted = false;

export function cacheCapBytes(env: NodeJS.ProcessEnv = process.env, warn?: (message: string) => void): number | undefined {
  const fallback = DEFAULT_CACHE_MAX_MB * 1024 * 1024;
  const raw = env.VIBECTX_CACHE_MAX_MB;
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    if (!badCapNoted) {
      badCapNoted = true;
      (warn ?? ((m: string) => writeStderrWarning(m)))(
        `vibectx: VIBECTX_CACHE_MAX_MB=${debugField(raw)} is not a size — using the default ` +
          `${DEFAULT_CACHE_MAX_MB} MB cap. Set a non-negative number of megabytes (0 turns the cap off).`,
      );
    }
    return fallback;
  }
  if (parsed === 0) return undefined;
  return Math.floor(parsed * 1024 * 1024);
}

/**
 * Bytes this process may write between sweeps: the smaller of `EVICTION_SWEEP_BYTES` and half
 * the cap, and never zero.
 *
 * A flat 16 MiB was chosen against the 512 MB default, where it is 3 % of the cap and the
 * overshoot is invisible. Against a small cap it was the whole story: 12 MiB of writes against
 * a 2 MB cap never reached the threshold, so after the first write NO sweep ran and the cache
 * finished 6× over its cap with nothing said (MEASURED by the review gate, PAR-652c R3).
 * Tying the threshold to the cap makes the overshoot a property of the cap the user set rather
 * than of a constant sized for a different one: at most half the cap of accumulated writes,
 * plus the document that triggered the sweep.
 *
 * With the cap off there is nothing to overshoot, so the ceiling stands.
 */
export function sweepThresholdBytes(env: NodeJS.ProcessEnv = process.env): number {
  const cap = cacheCapBytes(env);
  if (cap === undefined) return EVICTION_SWEEP_BYTES;
  return Math.max(1, Math.min(EVICTION_SWEEP_BYTES, Math.floor(cap / 2)));
}

/** A REGULAR file's size, or `undefined` for a symlink, a directory or anything unreadable. */
function regularFileBytes(path: string): number | undefined {
  try {
    const st = lstatSync(path);
    return st.isFile() ? st.size : undefined;
  } catch {
    return undefined;
  }
}

function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * D-46: may this root be swept at all?
 *
 * `true` only when the root is a real directory, or does not exist yet — a cache that has
 * not been created is not an attack and has nothing to evict, so it is walked (and found
 * empty) exactly as before, silently.
 *
 * `false`, with one stderr line per root per process, when something IS there and it is a
 * symlink or not a directory. Refusing is the whole point: `readdirSync`, `rmSync` and every
 * other call in this file follow a link, so the only safe moment to notice one is before any
 * of them run.
 */
function rootIsSweepable(root: string, warn: (message: string) => void): boolean {
  let stats;
  try {
    stats = lstatSync(root);
  } catch {
    return true; // no such root: nothing exists to be aimed anywhere
  }
  if (stats.isDirectory()) return true;
  if (!refusedRoots.has(root)) {
    refusedRoots.add(root);
    warn(
      stats.isSymbolicLink()
        ? `vibectx: refusing to manage the cache at ${root} — it is a symlink, not a directory. ` +
            `Nothing was evicted and the link was not followed. Remove it, or point VIBECTX_CACHE_DIR at a real directory.`
        : `vibectx: refusing to manage the cache at ${root} — it exists but is not a directory. ` +
            `Nothing was evicted. Remove it, or point VIBECTX_CACHE_DIR at a real directory.`,
    );
  }
  return false;
}

/**
 * Read `meta.fetchedAt` for candidates that are actually about to be sorted for eviction.
 *
 * Deliberately NOT done during the walk. The walk runs on every sweep, and the overwhelming
 * majority of sweeps find the cache under the cap and evict nothing — parsing every meta file
 * to reach that answer was 103 ms of JSON for 10,000 documents that needed no work at all.
 * The size total needs only `lstat`; recency is needed only once the cap is exceeded.
 *
 * D-71 (PAR-749, Root 2) — `readMetaFile` (`./cache-meta.js`), the SAME strict, per-field
 * validator `readCache` and `dropFollowedPageCache` use, not an ad hoc `typeof`/`isFinite`
 * parse of `fetchedAt` alone. Before this, this was the laxest of the four `.meta.json`
 * readers in the codebase — it accepted a `fetchedAt` of any length with no shape check,
 * the exact gap A4 closed for `readCache` (an unbounded fractional-seconds group is not a
 * length backstop, see `cache-meta.ts`'s `ISO_INSTANT` comment). A meta that fails validation
 * (bad `fetchedAt`, but also now a missing/invalid `url` or an oversized `etag`) keeps
 * `fetchedAtMs` at 0 and sorts as oldest — eviction's own judgement that a document whose
 * meta this process cannot trust is the one to drop first, not a claim that `readCache` would
 * still serve it as merely "stale" (N-6 is superseded there too; see this file's own top
 * comment).
 */
function resolveRecency(candidates: CandidateDocument[]): void {
  for (const doc of candidates) {
    const meta = readMetaFile(doc.metaPath);
    if (meta === undefined) continue; // oldest
    doc.fetchedAt = meta.fetchedAt;
    doc.fetchedAtMs = new Date(meta.fetchedAt).getTime();
  }
}

/** Walk the cache root one level deep: its own files, then each real library directory. */
function scanCache(root: string): { totalBytes: number; candidates: CandidateDocument[] } {
  let totalBytes = 0;
  const candidates: CandidateDocument[] = [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return { totalBytes: 0, candidates: [] };
  }
  for (const name of names) {
    const path = join(root, name);
    const fileBytes = regularFileBytes(path);
    if (fileBytes !== undefined) {
      totalBytes += fileBytes; // index.json, resolved.json: counted, never evicted
      continue;
    }
    if (!isRealDirectory(path)) continue; // a symlinked child is not descended
    let children: string[];
    try {
      children = readdirSync(path);
    } catch {
      continue;
    }
    const sizes = new Map<string, number>();
    for (const child of children) {
      const bytes = regularFileBytes(join(path, child));
      if (bytes === undefined) continue;
      totalBytes += bytes;
      sizes.set(child, bytes);
    }
    if (NEVER_EVICT_DIRS.has(name)) continue;
    for (const [child, bytes] of sizes) {
      if (!child.endsWith(".md")) continue;
      const slug = child.slice(0, -".md".length);
      const metaName = `${slug}.meta.json`;
      const metaBytes = sizes.get(metaName);
      if (metaBytes === undefined) continue; // a document without its meta is not one readCache serves
      candidates.push({
        library: name,
        document: slug,
        contentPath: join(path, child),
        metaPath: join(path, metaName),
        bytes: bytes + metaBytes,
        fetchedAtMs: 0, // recency is read later, and only if the cap is actually exceeded
        fetchedAt: undefined,
      });
    }
  }
  return { totalBytes, candidates };
}

/**
 * Bring the cache under the cap, evicting least-recently-fetched documents first and never
 * one this run wrote. Returns the summary, or `undefined` when the cap is off.
 *
 * D-71 (PAR-749, Root 2) — the recency this sorts by is now read at the same trust level as
 * every other `.meta.json` reader (`resolveRecency`, above). The DELETE decision itself still
 * does not require `dropFollowedPageCache`'s `metaMatchesSlug` provenance proof, and that is
 * deliberate, not the "no trust check" gap Root 2 named: this function frees space from
 * candidates `scanCache` already proved are real `<slug>.md`/`<slug>.meta.json` pairs under a
 * root D-46 already proved is this tool's own real cache directory, and it does not need to
 * tell one URL's document apart from another's the way a KEEP-these/DROP-the-rest call does —
 * every candidate is equally eligible for space regardless of what its meta claims. This is
 * also the mechanism by which eviction can reach old-format (pre-D-71, non-hash-suffixed)
 * cache files: `scanCache` discovers whatever `<slug>.md`/`<slug>.meta.json` pairs actually
 * exist on disk rather than deriving the slug it expects from a URL, so a document orphaned
 * under its old name is just another candidate. That reach is CONDITIONAL, not automatic,
 * stated plainly because D-71's own migration note oversold it: this function does nothing at
 * all below the cap (the `totalBytes <= capBytes` return just below), so under a typical cache
 * that never exceeds `VIBECTX_CACHE_MAX_MB` (512 MB default), orphaned old-format files are
 * never evicted by this path — they simply sit on disk, wasted space rather than a hazard,
 * until the cache is either swept for real or the user clears it by hand.
 *
 * Never throws: a cache that cannot be swept must not fail the write that triggered it.
 */
export function enforceCacheSizeCap(
  root: string,
  opts: { env?: NodeJS.ProcessEnv; warn?: (message: string) => void } = {},
): EvictionSummary | undefined {
  const env = opts.env ?? process.env;
  const warn = opts.warn ?? ((m: string) => writeStderrWarning(m));
  const capBytes = cacheCapBytes(env, warn); // may say once that a bad value fell back (K3)
  sweeps += 1;
  bytesSinceSweep = 0;
  sweptEver = true;
  if (capBytes === undefined) return undefined;
  // D-46: prove the root before anything below can delete through it.
  if (!rootIsSweepable(root, warn)) return undefined;
  const { totalBytes, candidates } = scanCache(root);
  const summary: EvictionSummary = {
    sweptAt: new Date().toISOString(),
    capBytes,
    totalBytesBefore: totalBytes,
    totalBytesAfter: totalBytes,
    evicted: [],
    protectedFromEviction: 0,
    stillOverCap: false,
  };
  if (totalBytes <= capBytes) return summary; // the common case: no meta file was parsed to get here

  resolveRecency(candidates);
  candidates.sort((a, b) => a.fetchedAtMs - b.fetchedAtMs || a.contentPath.localeCompare(b.contentPath));
  let running = totalBytes;
  let recountedAfterFailure = false;
  const deletionFailures = new Map<string, number>();
  for (const doc of candidates) {
    if (running <= capBytes) break;
    if (writtenThisRun.has(doc.contentPath)) {
      // Evicting what triggered this sweep would make a warm loop fetch, evict, and fetch
      // again for ever, and would make `get_docs` able to return a document it had already
      // deleted. The cap gives way instead; `stillOverCap` says so. The set is cleared to the
      // triggering write at the end of every sweep (see `noteCacheWrite`), so this protection
      // lasts one sweep, not the life of the process.
      summary.protectedFromEviction += 1;
      continue;
    }
    try {
      rmSync(doc.contentPath, { force: true });
      rmSync(doc.metaPath, { force: true });
    } catch (error) {
      const raw = (error as NodeJS.ErrnoException)?.code;
      const code = typeof raw === "string" && /^[A-Z0-9_]{1,32}$/.test(raw) ? raw : "unknown error";
      deletionFailures.set(code, (deletionFailures.get(code) ?? 0) + 1);
      // The body may already be gone when metadata deletion fails. Recount the real files
      // on this uncommon failure path instead of retaining bytes that no longer exist.
      running = scanCache(root).totalBytes;
      recountedAfterFailure = true;
      continue;
    }
    // A failure recount may already have excluded a peer-deleted queued candidate.
    // Keep that uncommon suffix based on real files instead of subtracting its old size twice.
    running = recountedAfterFailure ? scanCache(root).totalBytes : running - doc.bytes;
    summary.evicted.push({ library: doc.library, document: doc.document, bytes: doc.bytes, fetchedAt: doc.fetchedAt });
    // Nonrecursive removal succeeds only when this evicted directory is empty.
    // A new file, symlink, or concurrent writer makes it fail without deleting content.
    try { rmdirSync(dirname(doc.contentPath)); } catch { /* nonempty or already removed */ }
  }
  summary.totalBytesAfter = running;
  summary.stillOverCap = running > capBytes;
  if (deletionFailures.size > 0) {
    warn(`vibectx: Could not delete ${[...deletionFailures].map(([code, count]) => `${count} document(s) (${code})`).join(", ")}; check filesystem permissions or storage errors.`);
  }
  if (summary.evicted.length > 0) {
    lastSummary = summary;
    warn(
      `vibectx: cache over ${formatBytes(capBytes)} — evicted ${summary.evicted.length} least-recently-fetched ` +
        `document${summary.evicted.length === 1 ? "" : "s"} (${formatBytes(totalBytes - running)} freed, ` +
        `now ${formatBytes(running)}).`,
    );
  }
  if (summary.stillOverCap) {
    warn(
      `vibectx: cache is still ${formatBytes(running)} against a ${formatBytes(capBytes)} cap — ` +
        `${summary.protectedFromEviction} document(s) fetched by this run are not evictable. ` +
        (deletionFailures.size > 0
          ? "Some deletions failed; check the filesystem error above."
          : "Raise VIBECTX_CACHE_MAX_MB."),
    );
  }
  return summary;
}

/** Human-sized bytes for the one stderr line and the doctor row. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * Called by `writeCache` after both renames land: record the document as this run's, and
 * sweep only when enough has been written since the last sweep (or this is the first write
 * of the process). Best effort — never throws into the write path.
 *
 * THE PROTECTED SET IS CLEARED AT EVERY SWEEP (R3, PAR-652c), leaving only the write that
 * triggered it. It used to accumulate for the life of the process, which in a server — one
 * process for days — meant every document it had ever fetched was permanently unevictable and
 * the cap silently stopped applying: MEASURED, twelve 1 MiB documents against a 2 MB cap left
 * 12,583,948 bytes, zero evictions, no note. That is not what the protection was for. It
 * exists so a single write cannot be undone by the sweep that same write triggers (a warm loop
 * that fetched, evicted and refetched for ever; `get_docs` returning a document it had already
 * deleted) — a within-one-write problem, which one write's worth of protection solves. A
 * document fetched before the previous sweep has already been returned to its caller and is
 * re-fetchable; keeping it pinned buys nothing and costs the bound.
 */
export function noteCacheWrite(root: string, contentPath: string, bytes: number): EvictionSummary | undefined {
  writtenThisRun.add(contentPath);
  bytesSinceSweep += bytes;
  if (sweptEver && bytesSinceSweep < sweepThresholdBytes()) return undefined;
  try {
    return enforceCacheSizeCap(root);
  } catch {
    return undefined;
  } finally {
    // Emptied, not reduced to `contentPath`: this write has survived the only sweep that could
    // have deleted it before `writeCache` returned, and holding it any longer is what made the
    // steady state two protected documents rather than one. Done in `finally` so it happens
    // even when the sweep threw or the cap is off — an unbounded protected set is also an
    // unbounded `Set` in a process that runs for days.
    writtenThisRun = new Set();
  }
}
