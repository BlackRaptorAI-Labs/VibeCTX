import { lstatSync } from "node:fs";
import { resolveLibrary, unknownLibraryMessage, type LibraryEntry, type Registry } from "./registry.js";
import type { ConfigScope } from "./config.js";
import { MAX_TOPIC_CHARS, getDocsDetailed } from "./get-docs.js";
import type { AddressLookup } from "./address-policy.js";
import { readCache, cacheRoot, inspectCacheRoot } from "./cache.js";
import { redactUrlForDisplay } from "./link-policy.js";
import { lastEvictionSummary, formatBytes, type EvictionSummary } from "./cache-evict.js";
import { kindFromStructure, type SourceKind } from "./source-kind.js";
import { mapLimit } from "./concurrency.js";
import { saveDoctorVerdicts } from "./doctor-store.js";
import { cleanText, clipText } from "./text.js";
import { fenceEchoedIdentifier } from "./retrieval.js";
import { activityLogPath, shouldLog } from "./activity-log.js";
import { bugFailureOffer } from "./bug-report.js";
import { VERSION } from "./version.js";
import { writeStderrWarning } from "./redact-paths.js";

/**
 * `vibectx doctor` — proves retrieval works per library by running each entry's
 * probe queries through the same code path get_docs uses, and classifying what
 * came back. Transport-free: the CLI and the MCP tool both render `runDoctor`'s
 * report. It measures retrieval (did a section come back?), not correctness.
 */

/** Source-kind classification lives in source-kind.ts (shared with list_libraries and
 *  the resolver, both of which import it directly — NOT through this re-export). This line
 *  has no production consumer left after A8 / PAR-721 Move 2; it survives only because
 *  test/doctor.test.ts imports classifySourceKind from here, and that test file is out of
 *  this item's authorised scope to repoint (only test/project-deps.test.ts may change). Do
 *  not read "existing importers" as more than that one test. */
export { classifySourceKind, type SourceKind } from "./source-kind.js";

/**
 * - `answered`          — get_docs returned ≥ 1 section for the probe, from a FULL-TEXT
 *                         source (there is no index/follow step to have gone wrong here).
 * - `index-followed`    — answered, and at least one returned section came from a
 *                         followed index page (the index alone would have returned
 *                         only its link list).
 * - `index-only-match`  — PAR-844: the source is index-only and something matched, but
 *                         EVERY returned section came from the index document itself —
 *                         zero came from a followed page — AND the returned text is itself
 *                         link-list-shaped (`out.indexMatchLooksLikeToc`, `get-docs.ts`).
 *                         MEASURED (2026-09-18, reconfirmed live 2026-09-20): next.js's own
 *                         probe "server actions revalidate" matches the index's "Blog"
 *                         section — a link list, one line per post — on generic keyword
 *                         overlap and never triggers link-following into the real Server
 *                         Actions page; `doctor` used to report this `"answered"`/healthy,
 *                         indistinguishable from a genuine hit.
 *                         NOT `out.isIndex` alone (review round 2, Blocking #1): `isIndex`
 *                         is a WHOLE-DOCUMENT fact sampled from the first 200 non-empty
 *                         lines (`looksLikeIndex`'s own documented design, unchanged) — a
 *                         document that is link-dense ONLY in an early stretch (a sponsors/
 *                         users table, a large table of contents) reads `isIndex: true` while
 *                         its actual body, elsewhere in the same document, is substantive
 *                         prose a query can genuinely match. MEASURED, both real, live
 *                         regressions the first version of this classifier introduced:
 *                         hono.dev's llms-full.txt (372 KB, 805 headings — an early "who's
 *                         using Hono" link table pushes the 200-line sample over the 0.4
 *                         density threshold) and docs.convex.dev's llms-full.txt (2.54 MB,
 *                         4,526 headings, same shape) both called `index-only-match` on
 *                         probes that genuinely, substantively answered from real prose
 *                         within the SAME document — false statements about correct content,
 *                         reaching `get_docs`'s own `· doctor check failed (…)` stamp. Fixed
 *                         by checking `out.indexMatchLooksLikeToc`, computed in `get-docs.ts`
 *                         from the ACTUALLY RETURNED sections' own text, not the whole
 *                         document — see that field's own doc comment for the full account
 *                         and `test/doctor.test.ts`'s "PAR-844 Blocking #1" fixture (a
 *                         TOC-heavy header followed by a genuine full-text body) for the
 *                         regression guard. An index document is a table of contents;
 *                         matching IT, for a source that has real pages behind it, is almost
 *                         always incidental keyword overlap, not a real answer, and is never
 *                         treated as healthy — see `checkLibraryUnguarded`'s reasons
 *                         computation below. Deliberately NOT applied to `index-followed`
 *                         results even when the followed content is broader than the query
 *                         (the `supabase`/"row level security policy" case, MEASURED live
 *                         2026-09-20 — resolves genuine Supabase security content, general
 *                         platform posture rather than precise RLS policy syntax): this
 *                         control is about WHICH document answered, not how precisely it
 *                         answered — see docs/decisions.md.
 * - `no match`          — get_docs returned no sections at all.
 * - `thin match`        — PAR-804: real sections matched (`out.matched > 0`), but the token
 *                         budget left NOTHING to actually render (`out.thin`, `get-docs.ts`'s
 *                         own `thinMatch` closure) — checked BEFORE the index-vs-followed
 *                         distinction above, since a thin match answers a narrower question
 *                         ("was anything returned at all") that a real answer must pass first.
 *                         Never treated as healthy: a probe that proves only "something in the
 *                         document technically matched" is not proof retrieval actually works.
 */
export type ProbeStatus = "answered" | "index-followed" | "index-only-match" | "thin match" | "no match";

export interface ProbeResult {
  query: string;
  /** True when no probeQueries were configured and the query was derived from the description. */
  derived: boolean;
  status: ProbeStatus;
  /** Index links followed for this probe. */
  followed: number;
  /** Index links that were candidates but not followed (outside origin, too large, or unavailable). */
  dropped: number;
}

export interface LibraryReport {
  library: string;
  kind: SourceKind;
  /** Resolved primary (CANDIDATE) URL; null when unreachable. REDACTED (PAR-815, Phase 4):
   *  this is a structured, machine-consumed `--json` field — a different design call than
   *  rendered prose, decided the same way as `search --json`'s `SearchGroup.url` and for the
   *  same stated reason: the field's purpose (telling a reader WHICH host/path served the
   *  document) survives redaction fully, and only a secret would be lost by leaving it whole. */
  url: string | null;
  /** PAR-812/PAR-813 (Phase 4) — the URL this document was ACTUALLY served from, when a
   *  redirect moved it away from `url` (mirrors `GetDocsOutcome.source.finalUrl`). Redacted the
   *  same way `url` is. Null on the same terms `url` is null on. */
  finalUrl: string | null;
  /** Age of the cached primary document in hours (one decimal); null when not cached. */
  cacheAgeHours: number | null;
  /** True when the cache entry is past its TTL. */
  stale: boolean;
  ttlHours: number;
  probes: ProbeResult[];
  /** Totals across probes. */
  followed: number;
  dropped: number;
  healthy: boolean;
  /** Why the library is unhealthy; empty when healthy. */
  reasons: string[];
  /** PAR-1270: size skips observed during this run; informative, not a failed probe. */
  sizeSkipNotes?: string[];
}

/** Bumped when a key is renamed, removed or changes meaning. New keys may be
 *  appended without a bump; consumers read keys by name. */
export const DOCTOR_SCHEMA_VERSION = 1;

/** A discovered config file the loader skipped (D-19). Not a library problem, but a
 *  configuration one the user must see: the entries in that file are NOT in this report. */
export interface ConfigIssue {
  /** The file as the loader named it (cwd-relative, `~/…`, else absolute). */
  path: string;
  scope: ConfigScope;
  /** One line: why it was skipped. */
  reason: string;
}

export interface DoctorReport {
  schemaVersion: typeof DOCTOR_SCHEMA_VERSION;
  generatedAt: string;
  libraries: LibraryReport[];
  healthy: number;
  total: number;
  /** Appended in 0.2.0 (PAR-657); absent on a report built before it. */
  configIssues?: ConfigIssue[];
  /** A19/PAR-728, CR-20260907-par-652-governance (doctor-json-eviction) — the same summary
   *  `formatDoctorTable` has always rendered in its text output, now also on the JSON report;
   *  a new optional key needs no schemaVersion bump (see DOCTOR_SCHEMA_VERSION above). Present
   *  only when the LAST eviction in this process (`lastEvictionSummary()`, process-wide state —
   *  not necessarily triggered by anything this specific run did; code-reviewer round 1, S2)
   *  actually evicted something, matching the same condition the text table already used
   *  before this. */
  eviction?: EvictionSummary;
  /** D-13 — a best-effort side effect (persisting this run's verdicts, see `runDoctor`) that
   *  did not happen, stated here rather than left to a stderr line a `--json` caller never
   *  sees (code-reviewer/security-architect round 1, B2/S-2). Omitted when nothing went wrong. */
  notes?: string[];
  /** PAR-799 — `activity.json`'s own status: whether logging is on (`VIBECTX_NO_LOG`), whether
   *  the file exists yet, and its size when it does. `doctor` proves retrieval works; this is
   *  the one line that answers "is vibectx even keeping the record it says it keeps" without a
   *  separate command. Always present (unlike `eviction`/`notes`, which report only an anomaly)
   *  — a new key, appended, needs no schemaVersion bump (see DOCTOR_SCHEMA_VERSION above). */
  activityLog: ActivityLogStatus;
  /** Presentation-safe cache-root status; only the explicit CLI JSON opt-in reveals its path. */
  cacheRoot?: { status: "ready" | "refused"; reason?: "symlink" | "not-directory" | "inaccessible"; path: string };
}

export interface ActivityLogStatus {
  /** `shouldLog()` — false when `VIBECTX_NO_LOG` is an on-word or unrecognized (`envFlag`). */
  enabled: boolean;
  exists: boolean;
  /** `null` when `exists` is false. */
  sizeBytes: number | null;
}

/** PAR-799 — `lstatSync`, not `statSync`: consistent with every other cache-directory reader in
 *  this codebase (a symlink at `activity.json`'s own path reports as present-but-unreadable
 *  content to `activity-log.ts`'s own reader; this status line only asks whether SOMETHING sits
 *  at that path and how large it is, not whether it is a well-formed log — `vibectx log` is the
 *  place that already answers that, PAR-793). Never throws: a missing file is the ordinary,
 *  common case, not an error. */
function activityLogStatus(): ActivityLogStatus {
  const path = activityLogPath();
  try {
    const stat = lstatSync(path);
    return { enabled: shouldLog(), exists: true, sizeBytes: stat.size };
  } catch {
    return { enabled: shouldLog(), exists: false, sizeBytes: null };
  }
}

export interface DoctorOptions {
  /** Check only this library. */
  library?: string;
  /** Cache-only: the network is never touched; not-cached libraries are reported unreachable. */
  offline?: boolean;
  /** Where a best-effort failure (saving this run's verdicts) is reported; default stderr. */
  warn?: (message: string) => void;
  /** Test seam (PAR-851, threaded here at CI-hardening round 3): overrides the DNS lookup
   *  `checkResolvedAddress` uses, via `getDocsDetailed`'s own seam. Without it, `runDoctor`'s
   *  concurrency test raced a real `dns.lookup()` (Node's 4-slot libuv threadpool) against its
   *  own tight mocked-fetch timing window — the same bug class round 2 fixed in
   *  `fetcher.test.ts`/`server.test.ts`/`autowarm.test.ts`/`warm.test.ts`. Production code never
   *  sets this. */
  lookup?: AddressLookup;
  /** Test seam (review round 2, code-reviewer S5): overrides the token budget every probe is
   *  run at — `get_docs`'s own default (`DEFAULT_BUDGET_TOKENS`, 4000) otherwise, unchanged
   *  from every `doctor` run before this option existed. Exists so `"thin match"` (PAR-804) —
   *  real content matched, but the budget left nothing to render — can be reached through
   *  `doctor`'s REAL pipeline with a real fixture, not only via a `get-docs.ts`-level mock: at
   *  the production default, no realistic document's header is anywhere near 4000 tokens, so
   *  without a way to shrink the budget this status was correct but practically unreachable
   *  through `doctor` specifically (see `test/doctor.test.ts`'s "PAR-804 (round 2)" fixture,
   *  which replaces the file-scoped `vi.mock` `test/doctor-thin.test.ts` used before this).
   *  Production code (the CLI, the MCP `doctor` tool) never sets this — `vibectx doctor` has no
   *  `--max-tokens` flag; exposing one is a separate product decision this item does not make. */
  maxTokens?: number;
}

const DEFAULT_TTL_HOURS = 168;
/** A cache entry older than this many TTLs marks the library unhealthy (boundary inclusive:
 *  age >= 2 x TTL). Not applied when ttlHours is 0 — that means "always revalidate", and
 *  cache.ts marks such entries stale the moment they are written. */
const STALE_TTL_MULTIPLE = 2;
/** Libraries checked at once. Bounds fan-out to remote hosts (security finding, PAR-707 review). */
export const DOCTOR_CONCURRENCY = 3;

function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

/** Probe for an entry without probeQueries: its description minus the library's
 *  own name tokens; the name itself when that leaves nothing. */
export function deriveProbeQuery(entry: LibraryEntry): string {
  const nameTokens = new Set(words(entry.name));
  const rest = words(entry.description ?? "").filter((t) => !nameTokens.has(t));
  return rest.length > 0 ? rest.join(" ") : entry.name;
}

function probeQueriesFor(entry: LibraryEntry): { query: string; derived: boolean }[] {
  if (entry.probeQueries && entry.probeQueries.length > 0) {
    return entry.probeQueries.map((query) => ({ query: clipText(cleanText(query), MAX_TOPIC_CHARS), derived: false }));
  }
  return [{ query: clipText(cleanText(deriveProbeQuery(entry)), MAX_TOPIC_CHARS), derived: true }];
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** One library's row. Never throws: an unexpected error (unreadable cache file, EACCES on
 *  write, corrupt meta.json) becomes an `unreachable` row carrying the message, so one bad
 *  library cannot take down the whole report. */
async function checkLibrary(entry: LibraryEntry, offline: boolean, lookup?: AddressLookup, maxTokens?: number): Promise<LibraryReport> {
  try {
    return await checkLibraryUnguarded(entry, offline, lookup, maxTokens);
  } catch (e) {
    return {
      library: entry.name,
      kind: "unreachable",
      url: null,
      finalUrl: null,
      cacheAgeHours: null,
      stale: false,
      ttlHours: entry.ttlHours ?? DEFAULT_TTL_HOURS,
      probes: [],
      followed: 0,
      dropped: 0,
      healthy: false,
      reasons: [`error: ${errorMessage(e)}`],
    };
  }
}

async function checkLibraryUnguarded(entry: LibraryEntry, offline: boolean, lookup?: AddressLookup, maxTokens?: number): Promise<LibraryReport> {
  const ttlHours = entry.ttlHours ?? DEFAULT_TTL_HOURS;
  const probes: ProbeResult[] = [];
  const sizeSkipNotes = new Set<string>();
  let source: { url: string; stale: boolean; finalUrl?: string } | undefined;
  let isIndex = false;

  for (const { query, derived } of probeQueriesFor(entry)) {
    const out = await getDocsDetailed(entry, { topic: query, offline, maxTokens }, undefined, undefined, undefined, lookup);
    if (!out.source) {
      // Nothing fetched, nothing cached: later probes would fail identically.
      source = undefined;
      probes.length = 0;
      break;
    }
    source = out.source;
    if (out.source.primarySizeSkipNote !== undefined) sizeSkipNotes.add(out.source.primarySizeSkipNote);
    isIndex = out.isIndex;
    // PAR-844 — the fourth branch: `out.matched > 0` but `out.returnedFromFollowed === 0` on an
    // INDEX-ONLY source means every returned section came from the index document itself, never
    // a followed page. Only meaningful when `out.isIndex` — a full-text source has no index/
    // follow step to have matched instead of, so it stays plain `"answered"` (the prisma/
    // "upsert" non-regression case: MEASURED live, genuinely on-topic, must stay healthy).
    // Blocking #1 (review round 2) — gated ALSO on `out.indexMatchLooksLikeToc`, not `out.isIndex`
    // alone: `isIndex` is a whole-document, 200-line-sampled fact that MEASURED false-positives
    // on hono/convex's own llms-full.txt (an early link-dense stretch, real prose everywhere
    // else) — see `ProbeStatus`'s own doc comment above for the full account. A document can be
    // `isIndex: true` and still have its query genuinely, substantively answered by its own
    // primary text; only when the RETURNED text is itself link-list-shaped does this fire.
    // PAR-804 — checked ahead of every other branch: `out.thin` means nothing was actually
    // rendered regardless of `out.matched`/`out.returnedFromFollowed`'s own values, so it must
    // win the classification rather than be silently read as "answered"/"index-followed".
    const status: ProbeStatus = out.thin
      ? "thin match"
      : out.matched === 0
        ? "no match"
        : out.returnedFromFollowed > 0
          ? "index-followed"
          : out.indexMatchLooksLikeToc
            ? "index-only-match"
            : "answered";
    probes.push({
      query,
      derived,
      status,
      followed: out.followed.length,
      dropped: out.dropped.outsideOrigin + out.dropped.tooLarge + out.dropped.unavailable,
    });
  }

  // PAR-812 (Phase 4) — classifies the document's actual shape/origin using `finalUrl` (the URL
  // it was ACTUALLY served from) rather than the pre-redirect CANDIDATE: a cross-host redirect
  // that also changes path shape was classified against a URL the document was never really
  // served from. `readCache` right below stays on the CANDIDATE (`source.url`) — that call is
  // a cache-lookup by the key the cache is keyed by, unrelated to what `kindFromStructure` is
  // trying to infer, and must not change (see this file's own explicit warning at this line).
  const kind: SourceKind = source ? kindFromStructure(source.finalUrl ?? source.url, isIndex) : "unreachable";
  // Read the cache AFTER probing so a refresh that just succeeded shows as fresh.
  const hit = source ? readCache(entry.name, source.url, ttlHours) : undefined;
  const cacheAgeHours = hit
    ? Math.round(((Date.now() - new Date(hit.meta.fetchedAt).getTime()) / 3600_000) * 10) / 10
    : null;
  const stale = hit?.stale ?? false;
  const followed = probes.reduce((n, p) => n + p.followed, 0);
  const dropped = probes.reduce((n, p) => n + p.dropped, 0);

  const reasons: string[] = [];
  if (hit && Date.parse(hit.meta.fetchedAt) > Date.now()) reasons.push("clock skew: cached fetchedAt is in the future; check the system clock and refresh");
  if (kind === "unreachable") reasons.push("unreachable: nothing fetched and nothing cached");
  // PAR-844 Blocking #1 (review round 2) — the aggregate "index-only, no links followed" check
  // this line used to run (`kind === "index-only" && followed === 0`) was REMOVED, not merely
  // relocated: it assumed "index-only and nothing followed" always means "answered from the
  // link list at best," which is exactly the false-positive Blocking #1 found, MEASURED live —
  // a document can be `kind: "index-only"` (a whole-document, 200-line-SAMPLED fact) and still
  // have `followed === 0` on every probe while genuinely, substantively answering every one of
  // them from its own primary text (this file's own "PAR-844 Blocking #1" regression fixture in
  // `test/doctor.test.ts` is exactly this shape). The per-probe `index-only-match` reason below
  // is what actually should fire for this concern, and does so STRICTLY more precisely: it only
  // fires when the RETURNED content is itself link-list-shaped, per query, which is what this
  // aggregate check was trying (and failing) to approximate at the whole-library level. Every
  // case the aggregate check correctly caught before (a genuinely link-only index, e.g. the
  // fastify-shaped fixtures elsewhere in this file) is still caught, by the per-probe check,
  // naming the specific failing query instead of a whole-library generality.
  for (const p of probes) if (p.status === "no match") reasons.push(`no match: "${p.query}"`);
  // PAR-844 — any single `index-only-match` probe is enough to mark the whole library
  // unhealthy — same severity as "no match": a doctor probe exists to prove retrieval reaches
  // real content, and matching the table of contents is not that, whether or not a sibling
  // probe on the same library did better (the next.js case — MEASURED live: "app router
  // layout" follows into a real page while "server actions revalidate" matches the index's
  // Blog section instead — is exactly why this is checked per probe, not once per library).
  for (const p of probes) {
    if (p.status === "index-only-match") {
      reasons.push(p.followed === 0
        ? `index-only match, no link followed: "${p.query}" (matched the index document's own content, not a followed page)`
        : `index-only match, no linked content returned: "${p.query}" (matched only index or link-title text)`);
    }
  }
  // PAR-804 — a thin match is never healthy: real content matched, but the token budget left
  // nothing actually rendered, so the probe proves less than "no match" even states it does not.
  for (const p of probes) {
    if (p.status === "thin match") {
      reasons.push(`thin match: "${p.query}" (matched, but the token budget left nothing to render)`);
    }
  }
  if (ttlHours > 0 && cacheAgeHours !== null && cacheAgeHours >= STALE_TTL_MULTIPLE * ttlHours) {
    reasons.push(`stale ${cacheAgeHours}h, over ${STALE_TTL_MULTIPLE}x TTL (${ttlHours}h)`);
  }

  return {
    library: entry.name,
    kind,
    // PAR-815 (Phase 4) — redacted: a structured `--json` field, decided the same way and for
    // the same reason as `search --json`'s `SearchGroup.url` (see `LibraryReport.url`'s own
    // doc comment). `source.url`/`source.finalUrl` themselves stay RAW throughout this
    // function's own body (the `readCache` call just above needs the raw candidate) — this is
    // the one place, at the very end, where the OUTPUT is built.
    url: source ? redactUrlForDisplay(source.url) : null,
    finalUrl: source?.finalUrl !== undefined ? redactUrlForDisplay(source.finalUrl) : null,
    cacheAgeHours,
    stale,
    ttlHours,
    probes,
    followed,
    dropped,
    healthy: reasons.length === 0,
    reasons,
    ...(sizeSkipNotes.size > 0 ? { sizeSkipNotes: [...sizeSkipNotes] } : {}),
  };
}

/** Run the doctor over the registry (or one library). Up to DOCTOR_CONCURRENCY
 *  libraries are checked at once; the report keeps registry order. */
export async function runDoctor(registry: Registry, opts: DoctorOptions = {}): Promise<DoctorReport> {
  let entries = [...registry.entries.values()];
  if (opts.library !== undefined) {
    const one = resolveLibrary(registry, opts.library); // canonical name or alias
    if (!one) throw new Error(unknownLibraryMessage(registry, opts.library));
    entries = [one];
  }
  const libraries = await mapLimit(entries, DOCTOR_CONCURRENCY, (e) => checkLibrary(e, opts.offline === true, opts.lookup, opts.maxTokens));
  const generatedAt = new Date().toISOString();
  const warn = opts.warn ?? ((m: string) => writeStderrWarning(m));
  const notes: string[] = [];
  // A19/PAR-728 — best effort (D-13): the report above is already complete regardless of
  // whether this succeeds, so a write failure here never fails the run, only the persistence
  // side effect — reported both to stderr and, since a `--json` caller never sees stderr, as a
  // report note (`warm.ts`'s `writeProjectRecord` call is the exact template this mirrors).
  //
  // code-reviewer round 1, B1 (BLOCKING): an `--offline` run's "unreachable" verdicts are the
  // EXPECTED, correct answer for that call ("nothing cached, network not touched" — README's
  // own documented behaviour), not a genuine probe failure — persisting them would poison every
  // later online response with a stale, misleading warning the moment the library is actually
  // fetched and answers fine. Skipped entirely for an offline run; an earlier online verdict
  // already on disk is left exactly as it was.
  if (opts.offline !== true) {
    try {
      const saved = saveDoctorVerdicts(
        libraries.map((l) => ({ name: l.library, kind: l.kind, healthy: l.healthy, reasons: l.reasons, checkedAt: generatedAt })),
        warn,
      );
      if (!saved) {
        const root = inspectCacheRoot();
        notes.push(root.status === "refused"
          ? `doctor verdicts not saved: cache root refused (${root.reason})`
          : "doctor verdicts not saved: newer schema on disk");
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      notes.push(`doctor verdicts not saved: ${reason}`);
      warn(`vibectx: doctor verdicts not saved: ${reason}\n`);
    }
  }
  const eviction = lastEvictionSummary();
  return {
    schemaVersion: DOCTOR_SCHEMA_VERSION,
    generatedAt,
    libraries,
    healthy: libraries.filter((l) => l.healthy).length,
    total: libraries.length,
    configIssues: configIssues(registry),
    ...(eviction !== undefined && eviction.evicted.length > 0 ? { eviction } : {}),
    ...(notes.length > 0 ? { notes } : {}),
    activityLog: activityLogStatus(),
    cacheRoot: { ...inspectCacheRoot(), path: "[redacted]" },
  };
}

/** The MCP `doctor` tool body: the table for the registry or one library, or the
 *  unknown-library message (no probe is run in that case). */
/** PAR-858 follow-up (should-fix, round 3 review) — always renders the FULL, uncollapsed
 *  per-library listing (`{ verbose: true }`), unlike the CLI's own default: only `vibectx
 *  doctor --verbose` restores it there, but the MCP tool has no `--verbose`-equivalent argument
 *  to ask for it, and a model reading an unhealthy library's own kind/cache/probe/links detail
 *  benefits more from having it than from the token cost of not needing it — a model is not
 *  scanning a terminal the way `vibectx doctor`'s human default is written for. Decision
 *  recorded in D-93 (`docs/decisions.md`). */
export async function doctorToolText(registry: Registry, library?: string, offline = false): Promise<string> {
  if (library !== undefined && !resolveLibrary(registry, library)) return unknownLibraryMessage(registry, library);
  const report = await runDoctor(registry, { library, offline });
  const rendered = formatDoctorTable(report, { verbose: true, redactCachePath: true });
  const where = report.cacheRoot?.status === "refused" || report.notes?.some((note) => note.startsWith("doctor verdicts not saved"))
    ? "cache" : (report.configIssues?.length ?? 0) > 0 ? "configuration"
      : !offline && report.libraries.some((row) => row.kind === "unreachable") ? "network" : undefined;
  if (!where) return rendered;
  return `${rendered}\n\n${bugFailureOffer({ operation: "doctor", where, errorClass: where === "cache" ? "CacheError" : where === "configuration" ? "ConfigError" : "NetworkError", version: VERSION, platform: process.platform, nodeVersion: process.version })}`;
}

/** The discovered config files the loader skipped (D-19), in precedence order. */
function configIssues(registry: Registry): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  for (const file of registry.config?.files ?? []) {
    if (file.error !== undefined) issues.push({ path: file.display ?? file.path, scope: file.scope, reason: file.error });
  }
  return issues;
}

/** 0 when every checked library is healthy AND every discovered config file loaded, else 1.
 *  A skipped config file (D-19) is a health problem in its own right: the libraries it
 *  pins are simply missing, so every row can be green while the answer is wrong. */
export function doctorExitCode(report: DoctorReport): 0 | 1 {
  return report.healthy === report.total && (report.configIssues?.length ?? 0) === 0 ? 0 : 1;
}

function describeProbes(probes: ProbeResult[]): string {
  if (probes.length === 0) return "—";
  if (probes.length === 1) {
    const p = probes[0];
    return p!.status;
  }
  const counts = new Map<ProbeStatus, number>();
  for (const p of probes) counts.set(p.status, (counts.get(p.status) ?? 0) + 1);
  const parts = [...counts.entries()].map(([status, n]) => `${n} ${status}`);
  return `${probes.length} probes: ${parts.join(", ")}`;
}

function describeCache(lib: LibraryReport): string {
  if (lib.cacheAgeHours === null) return "—";
  return `${lib.cacheAgeHours.toFixed(1)}h${lib.stale ? " stale" : ""}`;
}

/** PAR-858 — one remedy sentence per known reason PREFIX (`checkLibraryUnguarded`'s own
 *  `reasons.push` call sites are the source of truth for these prefixes — a new one there
 *  without an entry here just falls through to the generic fallback, not a build error, since
 *  a missing remedy is a worse UX regression than none at all but never a correctness bug). */
const REMEDY_BY_PREFIX: readonly { prefix: string; remedy: string }[] = [
  { prefix: "unreachable:", remedy: "Run `vibectx warm` to cache it, or retry without --offline if you passed it." },
  { prefix: "no match:", remedy: "The document was reached but this topic wasn't found in it — check the probe query or the document's real coverage." },
  {
    prefix: "index-only match, no link followed:",
    remedy: "The index matched by keyword overlap only, with no linked page actually followed — check the entry's allowedHosts or the probe query.",
  },
  {
    prefix: "index-only match, no linked content returned:",
    remedy: "Linked pages were followed, but their content did not answer the probe. Check the probe query and the linked pages' coverage.",
  },
  { prefix: "thin match:", remedy: "Content matched, but the token budget left nothing to render — raise maxTokens or narrow the probe." },
  { prefix: "stale ", remedy: "The cached copy is past 2x its TTL — call the MCP refresh tool for this library, or run `vibectx warm --force` in a project that depends on it." },
  { prefix: "error:", remedy: "This library's check failed — inspect the error, check the cache directory's permissions and free space, then retry; report a bug if it persists." },
];

function remedyForReason(reason: string): string {
  for (const { prefix, remedy } of REMEDY_BY_PREFIX) {
    if (reason.startsWith(prefix)) return remedy;
  }
  return "See the reason above.";
}

/** One remedy sentence per DISTINCT reason prefix present, in the reasons' own order,
 *  deduplicated — a library with two reasons that map to the same remedy states it once. */
function remedyForReasons(reasons: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of reasons) {
    const remedy = remedyForReason(r);
    if (!seen.has(remedy)) {
      seen.add(remedy);
      out.push(remedy);
    }
  }
  return out.join(" ");
}

/** Human-readable table; the same text the CLI prints and the MCP doctor tool returns.
 *
 * PAR-858 — the DEFAULT (non-verbose) rendering collapses unhealthy libraries: verified
 * baseline, `doctor --offline` on a cold cache (`test/_scratch-doctor-offline` style run, 30
 * default libraries, nothing cached) printed 66 near-identical lines — a 30-row table where
 * every row read `unreachable  —  —  0/0  ✗` except for the library name, followed by 30
 * `✗ <lib>: unreachable: nothing fetched and nothing cached` lines stating the identical cause
 * 30 times. Unhealthy libraries are grouped by their EXACT `reasons` signature (the cause) —
 * one line per group, naming up to 5 members (`+N more`, the same convention `eviction`'s own
 * rendering below already uses) with a remedy sentence — instead of one row and one reason line
 * per library. When every failure shares one cause, this collapses to exactly one group; MIXED
 * causes produce one group per cause, each naming its own members. HEALTHY libraries keep their
 * individual table row always (their columns are usually genuinely different from each other,
 * and there is no "same cause" to collapse for a row that already passed). `--verbose` restores
 * the full per-library listing: every library's own row, and one `✗ <lib>: <reasons>` block
 * per unhealthy library — full per-library detail, matching what `--json` has always carried
 * unabridged. PAR-1033 query echoes are fenced separately from status rows in both modes.
 * This function never touches the JSON path — `cli.ts` calls `JSON.stringify(report,
 * …)` directly, so `--json` output is unaffected by anything below.
 */
export function formatDoctorTable(report: DoctorReport, opts: { verbose?: boolean; redactCachePath?: boolean } = {}): string {
  const verbose = opts.verbose === true;
  const header = ["library", "kind", "cache", "probe", "links", "mark"];
  const shownLibraries = verbose ? report.libraries : report.libraries.filter((lib) => lib.healthy);
  const rows = shownLibraries.map((lib) => [
    lib.library,
    lib.kind,
    describeCache(lib),
    describeProbes(lib.probes),
    `${lib.followed}/${lib.dropped}`,
    lib.healthy ? "✓" : "✗",
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const render = (cells: string[]) =>
    cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join("  ");
  const lines = [
    `vibectx doctor · ${report.generatedAt} · cache ${opts.redactCachePath ? "[redacted]" : cacheRoot()}`,
    "",
    ...(report.cacheRoot?.status === "refused" ? [`cache root refused (${report.cacheRoot.reason}) — nothing is being cached this run${opts.redactCachePath ? "" : ` at ${cacheRoot()}`}`, ""] : []),
    ...(shownLibraries.length > 0 ? [render(header), ...rows.map(render), ""] : []),
    `${report.healthy}/${report.total} libraries healthy`,
  ];
  const unhealthy = report.libraries.filter((lib) => !lib.healthy);
  for (const lib of report.libraries) {
    for (const note of lib.sizeSkipNotes ?? []) lines.push(cleanText(`note: ${lib.library}: ${note}`));
  }
  // PAR-1033: keep status columns single-line. Echo each probe on separate fenced lines;
  // format the same raw query in reason strings through that boundary as well.
  for (const lib of shownLibraries) {
    for (const p of lib.probes) {
      lines.push(`Probe for ${lib.library}: ${p.status}`,
        fenceEchoedIdentifier(`"${clipText(cleanText(p.query), MAX_TOPIC_CHARS)}"${p.derived ? " (derived)" : ""}`, MAX_TOPIC_CHARS + 14));
    }
  }
  const shownReasons = (lib: LibraryReport): string[] => lib.reasons.map((reason) => {
    if (opts.redactCachePath && reason.startsWith("error:")) return "error: internal check failed; run vibectx doctor in a terminal";
    // Match the complete producer reason, including its literal suffix. A shorter
    // configured query can be a quoted prefix of another; prefix matching would leave
    // the longer query's remainder outside the fence.
    const queryReasons = [
      { prefix: "no match:", suffix: "" },
      { prefix: "thin match:", suffix: " (matched, but the token budget left nothing to render)" },
      { prefix: "index-only match, no link followed:", suffix: " (matched the index document's own content, not a followed page)" },
      { prefix: "index-only match, no linked content returned:", suffix: " (matched only index or link-title text)" },
    ];
    for (const p of lib.probes) {
      for (const { prefix, suffix } of queryReasons) {
        if (reason === `${prefix} "${p.query}"${suffix}`) {
          return `${prefix}\n${fenceEchoedIdentifier(`"${clipText(cleanText(p.query), MAX_TOPIC_CHARS)}"`, MAX_TOPIC_CHARS + 2)}\n${suffix.trimStart()}`;
        }
      }
    }
    return reason;
  });
  if (verbose) {
    for (const lib of unhealthy) lines.push(`✗ ${lib.library}: ${shownReasons(lib).join("; ")}`);
  } else {
    // Group by the exact reasons signature (the cause) — insertion order preserved (a Map
    // iterates in first-insertion order), so groups appear in the same order their first
    // member would have under the old per-library listing.
    const groups = new Map<string, { reasons: string[]; members: string[] }>();
    for (const lib of unhealthy) {
      const key = JSON.stringify(shownReasons(lib)); // collision-safe, unlike a plain join
      let g = groups.get(key);
      if (!g) {
        g = { reasons: shownReasons(lib), members: [] };
        groups.set(key, g);
      }
      g.members.push(lib.library);
    }
    for (const { reasons, members } of groups.values()) {
      const named = members.slice(0, 5).join(", ");
      const more = members.length > 5 ? `, +${members.length - 5} more` : "";
      lines.push(
        `✗ ${members.length} librar${members.length === 1 ? "y" : "ies"} (${named}${more}): ${reasons.join("; ")} — ${remedyForReasons(reasons)}`,
      );
    }
  }
  for (const issue of report.configIssues ?? []) {
    lines.push(opts.redactCachePath
      ? `✗ config [redacted] (${issue.scope}): local config error; inspect vibectx doctor in a terminal — file skipped`
      : `✗ config ${issue.path} (${issue.scope}): ${issue.reason} — file skipped`);
  }
  // D-13 / code-reviewer, security-architect round 1, B2/S-2 — a best-effort failure stated
  // here too, not just on stderr, so a `--json` caller (which never sees stderr) can see it.
  for (const n of report.notes ?? []) lines.push(opts.redactCachePath
    ? "note: local diagnostic available; inspect vibectx doctor in a terminal"
    : cleanText(`note: ${n}`));
  // PAR-652 item 7a: doctor's job is to say why retrieval is not what you expected, and
  // "the document was evicted under the size cap" is one of the answers. Reported only when
  // this run actually evicted something, so a healthy cache says nothing about it.
  // A19/PAR-728: reads `report.eviction` (computed once, in `runDoctor`) rather than calling
  // `lastEvictionSummary()` again here — a second read of that process-wide singleton could in
  // principle disagree with what the JSON report already stated, and there is no reason for
  // the text table and the JSON output to ever see two different answers to the same question.
  const eviction = report.eviction;
  if (eviction !== undefined && eviction.evicted.length > 0) {
    // D-71 (PAR-749, code-reviewer round 2, S1) — `e.library` is `libDirName`'s on-disk
    // directory name, hash-suffixed since D-71 for collision resistance; the suffix is load-
    // bearing on disk and meaningless to a person reading this table, so it is stripped here,
    // display-only. Cosmetic: `e.document` (a URL slug) keeps its own suffix — it was already
    // an opaque folded URL before D-71, not a name a user would recognize either way.
    const named = eviction.evicted
      .slice(0, 5)
      .map((e) => `${e.library.replace(/_[0-9a-f]{12}$/, "")}/${e.document}`)
      .join(", ");
    lines.push(
      `cache: evicted ${eviction.evicted.length} least-recently-fetched document(s), ` +
        `${formatBytes(eviction.totalBytesBefore - eviction.totalBytesAfter)} freed, now ` +
        `${formatBytes(eviction.totalBytesAfter)} against a ${formatBytes(eviction.capBytes)} cap (VIBECTX_CACHE_MAX_MB) — ` +
        `${named}${eviction.evicted.length > 5 ? `, +${eviction.evicted.length - 5} more` : ""}`,
    );
  }
  // PAR-799 — one line, unconditional (unlike eviction/notes above, which report only an
  // anomaly): "is vibectx even keeping the record it says it keeps" is worth stating on every
  // run, healthy or not.
  const activityLog = report.activityLog;
  lines.push(
    `activity log: ${activityLog.exists ? `${opts.redactCachePath ? "present" : activityLogPath()} — ${formatBytes(activityLog.sizeBytes ?? 0)} (${activityLog.sizeBytes} bytes)` : "not yet created"} · logging: ${activityLog.enabled ? "on" : "off"}${activityLog.enabled ? "" : " (VIBECTX_NO_LOG)"}`,
  );
  return lines.join("\n");
}
