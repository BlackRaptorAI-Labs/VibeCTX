import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { entryForVersion, installResolvedEntry, type LibraryEntry, type Registry } from "./registry.js";
import { lookupLibrary, resolvePackage, MAX_RESOLUTIONS_PER_HOUR } from "./resolve.js";
import { getLibraryDoc, type DocumentFetchFailure } from "./fetcher.js";
import { cacheUpdateAdvice, documentUpdateAdvice } from "./update-guidance.js";
import type { AddressLookup } from "./address-policy.js";
import { readCache, cacheRoot, inspectCacheRoot, sweepCacheRootTempFiles, type CacheHit } from "./cache.js";
import { openIndexSession, type IndexSession } from "./search-index.js";
import { mapLimit } from "./concurrency.js";
import { discoverProjectDependencies, isDeniedDependency, MANIFEST_FILES, type DependencyEcosystem, type ProjectDependency } from "./project-deps.js";
import { cleanText } from "./text.js";
import { bugFailureOffer } from "./bug-report.js";
import { VERSION } from "./version.js";
import { CACHED_STATUSES, makeWarmRow, normaliseProjectDir, PROJECT_RECORD_SCHEMA_VERSION, readProjectRecord, writeProjectRecord, type WarmRow, type WarmStatus } from "./project-store.js";
import { writeStderrWarning } from "./redact-paths.js";

export type { WarmRow, WarmStatus } from "./project-store.js";

/**
 * `vibectx warm` (PAR-656) — read the project's dependency manifests and put every
 * dependency's primary document in the cache, so `get_docs` answers for the whole stack
 * offline. Transport-free: the CLI, the MCP `warm_project` tool and the tests all render
 * `runWarm`'s report.
 *
 * Per dependency, in order:
 *   1. on DEPENDENCY_DENYLIST → `denied (noise list)`; nothing fetched.
 *   2. a registry hit (`lookupLibrary`: curated name, alias, config, PEP 503 form, or a
 *      persisted resolution) with a FRESH cached document → `already fresh`; no network.
 *   3. a registry hit otherwise → `getLibraryDoc(entry)` — etag revalidation when stale,
 *      full fetch when uncached → `cached`; a stale copy kept because the network failed,
 *      or nothing at all → `unreachable`.
 *   4. no registry hit → `resolvePackage(name, { ecosystem })`, the ecosystem being the one
 *      the manifest implies (package.json → npm, pyproject / requirements → PyPI), which
 *      halves the metadata fetches and removes the same-name-on-both-registries ambiguity
 *      → `resolved+cached` (the entry joins the live registry and resolved.json, and the
 *      chosen document is already cached); the per-hour resolution cap is NOT bypassed —
 *      once it is hit the remaining unknown names are `skipped (rate cap)` and the run goes
 *      on; anything else → `unresolved` with the resolver's attempt summary and a
 *      `failedAt` clock.
 *   5. negative memo (R3): a name the project record shows `unresolved` with `failedAt` in
 *      the last RECENT_FAILURE_HOURS is `unresolved (recent)` — no resolution slot spent, the
 *      original `failedAt` carried over so the window never slides — unless `force`. The
 *      memo never applies to a name the registry now knows.
 *
 * D-11 (2026-09-06): registry entries match by name regardless of ecosystem.
 * When the manifest's ecosystem differs from the entry's evident one — a default entry's is
 * its `ecosystem` field (set by the NAMING RULE); a resolved entry's is `resolved.source`; a
 * config entry has none — the row carries `curated entry is the <npm|pypi> package` (or
 * `resolved entry is …`), so a Python project asking for `stripe` sees it got stripe-node.
 *
 * D-10 (2026-09-06, amended): the MCP tool (`warmToolText`) accepts only the
 * server's working directory or a directory beneath it, decided on REAL paths — a symlink
 * inside the working directory that points elsewhere is refused (S-A). The CLI is
 * unrestricted (the user typed it).
 *
 * Every table cell passes through `cleanText` before rendering (S3).
 *
 * Only the PRIMARY document is cached: index links are not followed during warm (get_docs
 * follows them on demand, per topic). A resolved entry already in the registry is warmed
 * like any entry, never re-resolved (that is `refresh`'s job).
 *
 * Concurrency: WARM_CONCURRENCY names at once through the shared `mapLimit`; no per-host
 * serialisation (a scaffold's names spread over npm, GitHub and a few docs hosts). Names
 * that map to the same registry entry (`react` + `react-dom`) share one fetch per run.
 *
 * `offline`: a cache-only report — fresh → `already fresh`, stale → `cached` (noted),
 * uncached → `unreachable`, unknown → `unresolved`; no network, no project record.
 *
 * Exit code (warmExitCode): 0 when every attempted (non-denied) name is `cached`,
 * `already fresh` or `resolved+cached`; 1 otherwise — `skipped (rate cap)` counts as not
 * cached, because the promise is "your stack's docs are on disk" and they are not yet.
 */

/** Names warmed at once. Bounds fan-out to remote hosts (same reasoning as DOCTOR_CONCURRENCY). */
export const WARM_CONCURRENCY = 4;

/** The `--json` report's schema version. K2: ONE constant governs both the report and the
 *  on-disk project record, because they carry the same rows — this is a re-export of
 *  PROJECT_RECORD_SCHEMA_VERSION, so the two can never drift. Bumped when a key is renamed,
 *  removed or changes meaning, and when a WarmStatus value is added or removed (K3: readers
 *  drop rows with an unknown status). New keys may be appended. */
export const WARM_SCHEMA_VERSION = PROJECT_RECORD_SCHEMA_VERSION;

/** How long an `unresolved` outcome in the project record short-circuits the next run (R3). ASSUMED. */
export const RECENT_FAILURE_HOURS = 24;

export interface WarmReport {
  schemaVersion: typeof WARM_SCHEMA_VERSION;
  generatedAt: string;
  /** Absolute, normalised project directory. */
  dir: string;
  offline: boolean;
  /** Manifests read, relative to `dir`, in read order. */
  manifests: string[];
  /** Discovery notes: files not read, includes skipped, parse failures. */
  notes: string[];
  dependencies: WarmRow[];
  /** Rows whose status is cached / already fresh / resolved+cached. */
  cached: number;
  /** Rows not denied (the denominator of the summary line). */
  attempted: number;
  denied: number;
  /** Every discovered dependency, denied ones included. */
  total: number;
}

export interface WarmOptions {
  /** Project directory (default: the process's working directory). */
  dir?: string;
  /** Cache-only report; the network is never attempted and no record is written. */
  offline?: boolean;
  /** Clock for the resolver's sliding-hour cap (tests). */
  now?: () => Date;
  /** Names in flight at once (default WARM_CONCURRENCY). */
  concurrency?: number;
  /** Where the resolver's save notes go (default stderr). */
  warn?: (message: string) => void;
  /** Retry names the project record marks `unresolved` within RECENT_FAILURE_HOURS (R3). */
  force?: boolean;
  /** Test seam (PAR-851, threaded here at CI-hardening round 3): overrides the DNS lookup
   *  `checkResolvedAddress` uses. Without it, `runWarm`'s concurrency test raced a real
   *  `dns.lookup()` (Node's 4-slot libuv threadpool) against its own tight mocked-fetch timing
   *  window — the exact bug class round 2 fixed in `fetcher.test.ts`/`server.test.ts`/
   *  `autowarm.test.ts`, reproduced live on CI (all three Node bands) for this file specifically.
   *  Production code never sets this. */
  lookup?: AddressLookup;
}

const DEFAULT_TTL_HOURS = 168;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** First fresh cached candidate, else the first stale one, for an entry — without touching the
 *  network. The HIT is carried out with it (PAR-659): warm is the one place that has both the
 *  document text and its cache meta in hand, so it is where the search index is kept current
 *  without a second read. */
function cachedState(entry: LibraryEntry): { fresh?: { url: string; hit: CacheHit }; stale?: { url: string; hit: CacheHit } } {
  const ttl = entry.ttlHours ?? DEFAULT_TTL_HOURS;
  let stale: { url: string; hit: CacheHit } | undefined;
  for (const url of entry.urls) {
    const hit = readCache(entry.name, url, ttl);
    if (!hit) continue;
    if (!hit.stale) return { fresh: { url, hit } };
    stale ??= { url, hit };
  }
  return { stale };
}

/**
 * D-34 (PAR-659): keep the cross-library search index current for the document this run put
 * (or found) in the cache, so `warm` leaves a USABLE index behind and the first `search` after
 * it is the fast path rather than a full re-tokenization of the whole stack.
 *
 * Only the PRIMARY document, never a followed index page. Best effort throughout: the index is
 * a derived cache, so a failure here changes the warm row not at all (D-13).
 *
 * R2: the whole run shares ONE session, so the index file is read once and written once
 * instead of once per library. MEASURED before that: 7,529 ms added to an already-fresh
 * 30-library / 150 MB warm for zero index change.
 */
function indexWarmed(session: IndexSession, entry: LibraryEntry, url: string, content: string, fetchedAt?: string): void {
  session.add(entry.name, url, content, fetchedAt);
}

type Outcome = Pick<WarmRow, "status" | "url" | "note"> & { failureKind?: DocumentFetchFailure["kind"]; retainedStale?: boolean };
type ModelWarmDiagnostic = { kind?: DocumentFetchFailure["kind"] | "cache"; retainedStale?: boolean; failureWhere?: "network" | "cache" };
const modelWarmDiagnostics = new WeakMap<WarmRow, ModelWarmDiagnostic>();

function withModelDiagnostic(row: WarmRow, diagnostic: ModelWarmDiagnostic): WarmRow {
  modelWarmDiagnostics.set(row, diagnostic);
  return row;
}

/** One run's state: the per-entry memo (names sharing an entry share one fetch) and the
 *  recent-failure memo read from the previous project record. */
type RunState = { entryJobs: Map<string, Promise<Outcome>>; recent: Map<string, WarmRow>; nowMs: number; index: IndexSession };

const memoKey = (ecosystem: DependencyEcosystem, name: string) => `${ecosystem}:${name}`;

/** D-11: the ecosystem an entry evidently belongs to, when that can be known. A resolved
 *  entry's `resolved.source` wins; otherwise the entry's own `ecosystem` field — set on shipped
 *  defaults by the NAMING RULE — is used. A config entry has neither UNLESS its author declared
 *  one. (PAR-783: `resolved` is now checked FIRST, so this matches `ecosystemNote`'s own
 *  wording-source below, which already branches on `entry.resolved` first — by construction,
 *  not by an unenforced doc-comment invariant the two could otherwise silently drift apart
 *  from. No registry entry carries both fields today (round-3 review: all three facts that make
 *  this true, verified independently, not just the first) — `DEFAULT_REGISTRY` entries never set
 *  `resolved`; `registry.ts`'s `normaliseLayer` deletes `resolved` from every config-layer entry
 *  (`delete normalised.resolved`); and `resolved-store.ts`'s own `toResolvedEntry` never sets
 *  `ecosystem` on the entries it builds — so flipping the order is a no-op in practice, not a
 *  behavior change; verified by the full `warm.test.ts` suite passing unchanged.)
 *
 *  PAR-854/D-90 (security-architect round 2, S5) — D-63 ("ecosystem is never config-settable")
 *  is REVERSED by that item: a config author can now declare `ecosystem: "pypi"` on their own
 *  entry (`config.ts`'s `EntrySchema`), and `registry.ts`'s `normaliseLayer` no longer strips
 *  it. This function is therefore a FOURTH live consumer of the config-declared value — beyond
 *  `registry.ts`'s cross-layer merge, `resolveLibrary`'s lookup, and the resolved-store/
 *  curated-keys install guard already named in D-90a — not accounted for in that item's
 *  original enumeration of every site the reversal affects. Its use here is read-only and
 *  display-only (an advisory mismatch note, `ecosystemNote` below — no lookup, no fetch, no
 *  cache key, no exit code), so it carries none of the identity-substitution risk the OTHER
 *  three sites do; recorded here, and in D-90a, so the list of affected sites is accurate. */
function evidentEcosystem(entry: LibraryEntry): DependencyEcosystem | undefined {
  return entry.resolved?.source ?? entry.ecosystem;
}

function ecosystemNote(entry: LibraryEntry, dep: ProjectDependency): string | undefined {
  const evident = evidentEcosystem(entry);
  if (evident === undefined || evident === dep.ecosystem) return undefined;
  return entry.resolved
    ? `resolved entry is the ${evident} package (resolve it again with --${dep.ecosystem} to switch)`
    : `curated entry is the ${evident} package`;
}

/** PAR-821: retain the explicit unchecked-pin note when a registered entry has no usable
 * exact mapping. PAR-1031 checks registered versionedDocuments and keys warm reuse by version;
 * those checked paths omit this fallback note. The earlier unqualified fast-path limitation
 * in D-90i is historical and is superseded by the PAR-1031 D-100 entry. */
function versionNotCheckedNote(entry: LibraryEntry, dep: ProjectDependency): string | undefined {
  if (dep.version === undefined) return undefined;
  return `version ${dep.version} pinned, but not checked — "${entry.name}" is already registered; warm's fast path does not re-verify a version pin against an existing entry`;
}

/** Warm one registry entry: fresh cache → no network; else getLibraryDoc (etag-first).
 *
 *  PAR-836 (D-90) — `opts.force` (when NOT also `offline`) skips the "already fresh, no
 *  network" fast path above and passes `forceRefresh: true` to `getLibraryDoc`, so a curated
 *  `urls` reorder (fixing a broken candidate ordering — the `clerk` case) that a caller applies
 *  AFTER an entry is already cached under the OLD winning URL can actually be picked up by
 *  `warm --force`: without this, `--force` only ever bypassed the recent-resolution-failure
 *  memo (`warmOneUnguarded`, below) and never touched a document already sitting fresh in the
 *  cache — the exact operator expectation a `--force` flag exists to meet.
 *
 *  `offline` still wins over `force` (D-13: a forced refresh is a network operation, and
 *  `--offline --force` together must not silently touch the network) — `fresh` still takes its
 *  ordinary fast path when `offline` is set, `force` or not: skipping it would otherwise route
 *  a perfectly good FRESH entry into the offline branch below, which only has an answer for the
 *  STALE case (`stale`) and would wrongly report a fresh, present document "unreachable". */
async function warmEntry(entry: LibraryEntry, opts: WarmOptions, session: IndexSession): Promise<Outcome> {
  const { fresh, stale } = cachedState(entry);
  if (fresh && (!opts.force || opts.offline)) {
    indexWarmed(session, entry, fresh.url, fresh.hit.content, fresh.hit.meta.fetchedAt);
    return { status: "already fresh", url: fresh.url };
  }
  if (opts.offline) {
    if (!stale) return { status: "unreachable", note: "not cached; offline" };
    indexWarmed(session, entry, stale.url, stale.hit.content, stale.hit.meta.fetchedAt);
    return { status: "cached", url: stale.url, note: `stale copy from ${stale.hit.meta.fetchedAt}; offline` };
  }
  let failure: DocumentFetchFailure | undefined;
  const doc = await getLibraryDoc(entry, { lookup: opts.lookup, forceRefresh: opts.force, onFailure: (value) => { failure = value; } });
  if (!doc) return { status: "unreachable", note: documentUpdateAdvice(failure, "run vibectx warm --force again"), failureKind: failure?.kind };
  if (doc.staleNote) {
    indexWarmed(session, entry, doc.url, doc.content, stale?.hit.meta.fetchedAt);
    return { status: "unreachable", url: doc.url, note: `stale copy from ${stale?.hit.meta.fetchedAt ?? "earlier"} kept; ${documentUpdateAdvice(failure, "run vibectx warm --force again")}`, failureKind: failure?.kind, retainedStale: true };
  }
  indexWarmed(session, entry, doc.url, doc.content, undefined);
  return { status: "cached", url: doc.url };
}

async function warmOneUnguarded(registry: Registry, dep: ProjectDependency, opts: WarmOptions, run: RunState): Promise<WarmRow> {
  const base = { name: dep.name, ecosystem: dep.ecosystem, source: dep.source };
  if (isDeniedDependency(dep.name, dep.ecosystem)) return makeWarmRow({ ...base, status: "denied (noise list)" });

  const entry = lookupLibrary(registry, dep.name);
  if (entry) {
    // A persisted tag document is only selected for the exact project pin. Its own memo key
    // prevents a dependency on another version from reusing this version's cache result.
    const versionedEntry = dep.version === undefined ? undefined : entryForVersion(entry, dep.version);
    const entryToWarm = versionedEntry ?? entry;
    const jobKey = versionedEntry ? `${entry.name}\u0000${dep.version}` : entry.name;
    let job = run.entryJobs.get(jobKey);
    if (!job) {
      job = warmEntry(entryToWarm, opts, run.index);
      run.entryJobs.set(jobKey, job);
    }
    const outcome = await job;
    const notes = [outcome.note, ecosystemNote(entry, dep), versionedEntry ? undefined : versionNotCheckedNote(entry, dep)].filter((n): n is string => n !== undefined);
    return withModelDiagnostic(makeWarmRow({ ...base, library: entry.name, status: outcome.status, url: outcome.url, note: notes.length > 0 ? notes.join("; ") : undefined }), { kind: outcome.failureKind, retainedStale: outcome.retainedStale });
  }

  if (opts.offline) return makeWarmRow({ ...base, status: "unresolved", note: "not in the registry; offline, not resolved" });

  // R3: a recent failure is reported, not retried, unless forced.
  const previous = run.recent.get(memoKey(dep.ecosystem, dep.name));
  if (previous?.failedAt !== undefined && !opts.force) {
    const ageHours = (run.nowMs - Date.parse(previous.failedAt)) / 3600_000;
    const why = previous.note ? ` (${previous.note})` : "";
    return makeWarmRow({
      ...base,
      status: "unresolved (recent)",
      note: `unresolved ${ageHours.toFixed(1)} h ago${why}; retried after ${RECENT_FAILURE_HOURS} h, or now with --force`,
      failedAt: previous.failedAt,
    });
  }

  // A11/PAR-724 — pass the manifest-pinned version, when one was captured, so a resolution
  // through `warm` gets the same version-matched chain `get_docs` does; `dep.version` is
  // absent whenever only a range was declared (see `ProjectDependency.version`'s own comment),
  // in which case this is identical to the pre-A11 call.
  const out = await resolvePackage(dep.name, {
    ecosystem: dep.ecosystem,
    version: dep.version,
    strictDns: registry.strictDns,
    now: opts.now,
    warn: opts.warn,
  });
  if (out.ok && out.entry) {
    // S2: a resolved entry never displaces a curated one; the lookup above missed, so this installs.
    installResolvedEntry(registry, out.persistedEntry ?? out.entry);
    // A11/PAR-724 (D-50): a version was requested but no versioned document was found — the
    // fallback-to-latest must be stated here too, not just in get_docs' own stamp, since this
    // row is the one place a `warm` run's own text ever reports it.
    const versionNote = out.requestedVersion && !out.versionMatched ? `no versioned document found for ${out.requestedVersion}; latest cached instead` : undefined;
    return makeWarmRow({ ...base, library: out.entry.name, status: "resolved+cached", url: out.chosen, note: versionNote });
  }
  if (out.limited) {
    return makeWarmRow({ ...base, status: "skipped (rate cap)", note: `resolution limit reached (${MAX_RESOLUTIONS_PER_HOUR} per hour per process); start a new vibectx warm process or restart the MCP server to clear its counter, or wait for the window to pass` });
  }
  // A16/PAR-725 — `out.notFound` is the structured existence signal `resolvePackage` computed
  // (both npm and PyPI genuinely 404'd): a distinct status, not folded into the general
  // `unresolved` bucket, so the difference is visible in the table's status COLUMN, not just
  // buried in the free-text note.
  return withModelDiagnostic(makeWarmRow({
    ...base,
    status: out.notFound ? "not found" : "unresolved",
    note: `${out.attempts.join("; ")}; ${out.notFound ? "check the package name and ecosystem, then run vibectx warm --force again" : "check connectivity and the package's published docs URL, then run vibectx warm --force again"}`,
    failedAt: new Date(run.nowMs).toISOString(),
  }), { failureWhere: out.operationalFailure });
}

/** One dependency's row. Never throws: an unexpected error (EACCES on the cache, a corrupt
 *  meta.json) becomes an `unreachable` row carrying the message, so one bad name cannot
 *  take down the run. */
async function warmOne(registry: Registry, dep: ProjectDependency, opts: WarmOptions, run: RunState): Promise<WarmRow> {
  try {
    return await warmOneUnguarded(registry, dep, opts, run);
  } catch (e) {
    const cacheAdvice = cacheUpdateAdvice(e, "run vibectx warm --force again");
    return withModelDiagnostic(makeWarmRow({ name: dep.name, ecosystem: dep.ecosystem, source: dep.source, status: "unreachable", note: cacheAdvice ?? `error: ${errorMessage(e)}; check the dependency's docs configuration and run vibectx warm --force again` }), { kind: cacheAdvice ? "cache" : undefined });
  }
}

/** Rows of the previous record that count as a recent failure (R3), keyed by ecosystem:name. */
function recentFailures(dir: string, nowMs: number): Map<string, WarmRow> {
  const memo = new Map<string, WarmRow>();
  const record = readProjectRecord(dir);
  if (!record) return memo;
  for (const row of record.dependencies) {
    // A16/PAR-725: "not found" is a resolution failure too (both registries genuinely 404'd) —
    // memoized the same way "unresolved" already is, so a confirmed-nonexistent name does not
    // spend a fresh resolution slot on every run. The short-circuited row still reports
    // "unresolved (recent)" below (R3's existing memo grammar), not a distinct "not found
    // (recent)" — a deliberately scoped simplification, noted rather than silently accepted.
    if (row.status !== "unresolved" && row.status !== "unresolved (recent)" && row.status !== "not found") continue;
    if (row.failedAt === undefined) continue;
    const age = nowMs - Date.parse(row.failedAt);
    if (age >= 0 && age < RECENT_FAILURE_HOURS * 3600_000) memo.set(memoKey(row.ecosystem, row.name), row);
  }
  return memo;
}

/**
 * D-19 (PAR-657): the discovered config files the registry could not load, as report notes.
 * A warm run that quietly fell back to the shipped defaults — because the project's committed
 * `vibectx.config.json` was skipped — otherwise reads as a clean run, and a `--json` consumer
 * never sees the stderr line the loader wrote. Appended to the existing `notes[]`, which is
 * an additive change: no `schemaVersion` bump (README: new keys may be appended, and this
 * adds no key at all).
 */
function configNotes(registry: Registry): string[] {
  const notes: string[] = [];
  for (const file of registry.config?.files ?? []) {
    if (file.error === undefined) continue;
    notes.push(`config: ${file.display ?? file.path} (${file.scope}) not loaded: ${file.error}`);
  }
  return notes;
}

/**
 * Warm a project. Throws (→ CLI exit 2) when `dir` is not a directory or holds no manifest
 * discovery can read; every per-name problem is a row, never an exception. Writes the
 * project record unless `offline`.
 */
export async function runWarm(registry: Registry, opts: WarmOptions = {}): Promise<WarmReport> {
  sweepCacheRootTempFiles(); // S-C: clear temp files a killed run left behind
  const dir = normaliseProjectDir(opts.dir ?? process.cwd());
  const discovery = discoverProjectDependencies(dir);
  if (discovery.manifests.length === 0) {
    const why = discovery.notes.length > 0 ? ` (${discovery.notes.join("; ")})` : "";
    throw new Error(`no dependency manifest in ${dir}${why}; looked for ${MANIFEST_FILES.join(", ")}`);
  }
  const nowMs = (opts.now ?? (() => new Date()))().getTime();
  const warn = opts.warn ?? ((m: string) => writeStderrWarning(m));
  const run: RunState = {
    entryJobs: new Map(),
    recent: opts.offline ? new Map() : recentFailures(dir, nowMs),
    nowMs,
    index: openIndexSession(warn),
  };
  let rows: WarmRow[];
  try {
    rows = await mapLimit(discovery.dependencies, opts.concurrency ?? WARM_CONCURRENCY, (dep) => warmOne(registry, dep, opts, run));
  } finally {
    // R2: one write for the whole run, and it happens even when the run threw — a half-warmed
    // cache with an index describing it is strictly better than one with no index at all.
    run.index.flush();
  }
  const cached = rows.filter((r) => CACHED_STATUSES.has(r.status)).length;
  const denied = rows.filter((r) => r.status === "denied (noise list)").length;
  const report: WarmReport = {
    schemaVersion: WARM_SCHEMA_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    dir,
    offline: opts.offline === true,
    manifests: discovery.manifests,
    notes: [...discovery.notes, ...configNotes(registry)],
    dependencies: rows,
    cached,
    attempted: rows.length - denied,
    denied,
    total: rows.length,
  };
  if (!report.offline) {
    // D-13 (2026-09-06): the record is a memo, not the product. An unwritable
    // cache costs the next run one resolution retry — it must never cost the user the report
    // they asked for, so a failure is a warn line plus a note, and the exit code is unchanged.
    try {
      // A refused cache root or a newer-schema record returns false. State the actual root
      // refusal in the JSON report too; a file root is not evidence of a newer schema.
      let refusal: "cache-root" | "projects-directory" | "newer-schema" | undefined;
      const written = writeProjectRecord({ schemaVersion: PROJECT_RECORD_SCHEMA_VERSION, dir, manifests: report.manifests, dependencies: rows, warmedAt: report.generatedAt }, opts.warn, (reason) => { refusal = reason; });
      if (!written) {
        const root = inspectCacheRoot();
        report.notes.push(refusal === "cache-root" && root.status === "refused"
          ? `project record not written: cache root refused (${root.reason})`
          : refusal === "projects-directory" ? "project record not written: projects directory refused"
          : refusal === "newer-schema" ? "project record not written: newer schema on disk"
          : "project record not written: persistence refused");
      }
    } catch (e) {
      const reason = cleanText(errorMessage(e));
      report.notes.push(`project record not written: ${reason}`);
      (opts.warn ?? ((m: string) => writeStderrWarning(m)))(`vibectx: project record not written: ${reason}\n`);
    }
  }
  return report;
}

/** 0 when every attempted name is cached (fresh, fetched or resolved), else 1. */
export function warmExitCode(report: WarmReport): 0 | 1 {
  return report.cached === report.attempted ? 0 : 1;
}

/** Render only fixed, path-free recovery text in the MCP channel; free-form notes stay local. */
function modelVisibleWarmNote(row: WarmRow): string {
  const diagnostic = modelWarmDiagnostics.get(row);
  if (row.status === "unreachable") {
    const prefix = diagnostic?.retainedStale ? "update failed; stale cached copy retained; " : "";
    if (diagnostic?.kind === "cache") return `${prefix}local cache write failed; check cache permissions and free disk space, then run vibectx warm --force in a terminal`;
    if (diagnostic?.kind) return prefix + documentUpdateAdvice({ kind: diagnostic.kind, candidates: 1 }, "run vibectx warm --force in a terminal");
    return `${prefix}could not update this library; check connectivity and its configured docs URL, then run vibectx warm --force in a terminal`;
  }
  if (row.status === "not found") return "package not found; check the name and ecosystem, then run vibectx warm --force in a terminal";
  if (row.status === "unresolved") return "could not resolve this package; check connectivity and its published docs URL, then run vibectx warm --force in a terminal";
  if (row.status === "unresolved (recent)") return "recent resolution failure was not retried; run vibectx warm --force in a terminal";
  if (row.status === "skipped (rate cap)") return "resolution cap reached in this process; restart the MCP server or wait for the window to pass";
  return "see vibectx warm in a terminal for details";
}

/** Human-readable table; MCP keeps only fixed, path-free guidance from failure notes. */
export function formatWarmTable(report: WarmReport, opts: { modelVisible?: boolean } = {}): string {
  const header = ["dependency", "library", "status", "url"];
  const rows = report.dependencies.map((d) => [d.name, d.library ?? "—", d.status, d.url ?? "—"].map(cleanText)); // S3
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const render = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join("  ");
  const summary = `${report.cached}/${report.attempted} dependencies cached${report.denied > 0 ? ` · ${report.denied} denied (noise list)` : ""}`;
  const lines = [
    `vibectx warm · ${opts.modelVisible ? "[project]" : report.dir}${report.offline ? " · offline" : ""} · cache ${opts.modelVisible ? "[cache]" : cacheRoot()}`,
    `manifests: ${report.manifests.join(", ")}`,
    "",
    render(header),
    ...rows.map(render),
    "",
    summary,
  ];
  for (const d of report.dependencies) {
    if (!d.note) continue;
    const mark = CACHED_STATUSES.has(d.status) ? "·" : "✗"; // a cached row can still carry the D-11 note
    if (d.status !== "denied (noise list)") lines.push(cleanText(`${mark} ${d.name}: ${opts.modelVisible ? modelVisibleWarmNote(d) : d.note}`));
  }
  for (const n of report.notes) lines.push(cleanText(`note: ${opts.modelVisible ? "see vibectx warm in a terminal for details" : n}`));
  return lines.join("\n");
}

/** `target` is `base` or beneath it, comparing whole path components (so `/a/proj-evil` is
 *  NOT beneath `/a/proj`). */
function beneath(target: string, base: string): boolean {
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
}

/**
 * The real path of `path` when it exists; otherwise the real path of its nearest EXISTING
 * ancestor with the remaining components appended. A path that does not exist yet still gets
 * a real answer, because every symlink on the part of it that does exist has been resolved:
 * `cwd/link/nope` with `link -> /elsewhere` answers `/elsewhere/nope`, not `cwd/link/nope`.
 *
 * undefined only when nothing on the chain up to the filesystem root can be resolved — a
 * broken filesystem, not a path question. Callers must refuse on undefined rather than guess.
 */
function realWithNonExistentTail(path: string): string | undefined {
  const tail: string[] = [];
  let current = path;
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length === 0 ? real : join(real, ...tail);
    } catch {
      const parent = dirname(current);
      if (parent === current) return undefined; // reached the root and even it did not resolve
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * D-10 (amended 2026-09-06): is `dir` the working directory or beneath it,
 * decided on REAL paths? The target's real path must be the working directory's real path or
 * beneath it, compared component-wise, so a symlink inside the working directory pointing
 * anywhere else on the filesystem is refused (S-A) and a sibling that merely shares the prefix
 * (`/a/proj-evil` against `/a/proj`) is refused too. The working directory may itself be
 * reached through a symlink: both sides are resolved.
 *
 * A target that does not exist is decided on the SAME real basis, never lexically: the nearest
 * existing ancestor is resolved and the missing tail appended (S-A). A lexical fallback would
 * have made `cwd/link/nope` — a path whose every existing component says "outside" — read as
 * contained, and handed the whole subtree behind the link to discovery. So `cwd/link/nope` is
 * refused, while `cwd/sub/nope` under a real subdirectory is still allowed through to
 * discovery's honest "not a directory" / "no dependency manifest".
 */
export function isWithinCwd(dir: string, cwd = process.cwd()): boolean {
  const base = realWithNonExistentTail(resolve(cwd));
  const real = realWithNonExistentTail(resolve(dir));
  if (base === undefined || real === undefined) return false; // undecidable: refuse
  return beneath(real, base);
}

/** The MCP `warm_project` tool body: the table for `dir` (default: the server's working
 *  directory, and only that directory or one beneath it — D-10), or the one-line reason it
 *  could not run. Never throws. No `force`: D-12 makes retrying a recent resolution failure
 *  a CLI flag (`vibectx warm --force`), so a model cannot spend the resolution budget on
 *  names the last run already proved unresolvable. */
export async function warmToolText(registry: Registry, dir?: string, offline = false): Promise<string> {
  return (await warmToolResult(registry, dir, offline)).text;
}

/** `warmToolText` plus whether the run failed outright, so the server can mark that failure
 *  `isError` (PAR-1044 L-29). Expected project diagnostics and a report with unreachable rows
 *  are results, not failures. Never throws. */
export async function warmToolResult(registry: Registry, dir?: string, offline = false): Promise<{ text: string; failed: boolean }> {
  const text = (value: string) => ({ text: value, failed: false });
  const cwd = process.cwd();
  const target = dir ?? cwd;
  if (!isWithinCwd(target, cwd)) {
    return text("requested directory is outside the project directory; warm_project only reads the server's working directory or a directory beneath it");
  }
  try {
    const report = await runWarm(registry, { dir: target, offline });
    const rendered = formatWarmTable(report, { modelVisible: true });
    if (offline) return text(rendered);
    const failed = report.dependencies.find((row) => row.status === "unreachable" || (row.status === "unresolved" && modelWarmDiagnostics.get(row)?.failureWhere));
    if (!failed) return text(rendered);
    const where = modelWarmDiagnostics.get(failed)?.failureWhere ?? (modelWarmDiagnostics.get(failed)?.kind === "cache" ? "cache" : "network");
    return text(`${rendered}\n\n${bugFailureOffer({ operation: "warm_project", where, errorClass: where === "cache" ? "CacheError" : "NetworkError", version: VERSION, platform: process.platform, nodeVersion: process.version })}`);
  } catch (e) {
    const detail = errorMessage(e);
    if (detail.includes("is not a directory")) return text("requested project path is not a directory");
    if (detail.startsWith("no dependency manifest in ")) return text(`no dependency manifest in [project]; looked for ${MANIFEST_FILES.join(", ")}`);
    return { failed: true, text: `warm_project could not complete; run vibectx warm in a terminal for local details.\n\n${bugFailureOffer({ operation: "warm_project", where: "retrieval", errorClass: "UnknownError", version: VERSION, platform: process.platform, nodeVersion: process.version })}` };
  }
}
