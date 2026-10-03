import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { closeSync, constants as fsConstants, fstatSync, linkSync, lstatSync, openSync, readdirSync, readSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { appendRegularFile, createRegularFileExclusive, writeAtomic } from "./atomic-store.js";
import { cacheRoot, ensureCacheRoot, isRealDirectory, readBoundedRegularFile } from "./cache.js";
import { ISO_INSTANT, validIsoInstant } from "./cache-meta.js";
import { ACTIVITY_LOG_MAX_ENTRIES, ACTIVITY_LOG_ROTATE_ENTRIES, DEFAULT_ACTIVITY_LOG_ARCHIVES, MAX_ACTIVITY_FILE_BYTES } from "./limits.js";
import { MAX_REMOTE_URL_LENGTH, redactUrlForDisplay } from "./link-policy.js";
import { cleanText, clipText, envFlag } from "./text.js";
import { MAX_NAME_LENGTH } from "./package-names.js";
import { writeStderrWarning } from "./redact-paths.js";

/**
 * D-51 (A20, PAR-729) — VibeCTX's own activity log: `<cacheRoot>/activity.json`, newline-
 * delimited `{ schemaVersion: 2, ...entry }` records. One entry per call THAT RUNS TO COMPLETION through
 * `get_docs`, `search`, `resolve_library` or `refresh` (the write hooks live in those four
 * modules, not here — this module only knows how to persist and read back an entry it is
 * handed). PAR-793: every ORDINARY outcome — matched, no-match, not-cached, unresolved, refused
 * — is recorded; an unexpected internal error that throws before a write hook is reached writes
 * no entry for that call. This is a record of what completed, not a guarantee that every call
 * attempted is represented — stated in README.md's own "Activity log" section too, not only here.
 *
 * WHAT IT RECORDS, AND WHAT IT NEVER DOES (the whole point of D-51): what was *consulted* —
 * the tool, the library, the topic/query, the document URL, a content HASH, freshness, and
 * the outcome. Never the document TEXT, the same boundary the search index holds (D-33): a
 * hash proves a document was the one served without needing to store what it said. This is
 * what makes the log usable as evidence of a specific consultation claim (the motivating
 * case: a signed Change Record attesting to file contents that were never actually read)
 * without turning the cache directory into a second copy of every document ever served.
 *
 * TRUST BOUNDARY, SAME AS EVERY OTHER STORE HERE (A4). Anything with write access to the
 * cache directory can edit this file, so every field is re-validated on read against the
 * rule it actually has (`toActivityEntry`); an unknown `tool` or `outcome` drops the row
 * (K3 — the vocabulary is closed, and future growth needs a version bump the same way
 * `WARM_STATUSES` does); a corrupt file reads as empty, never thrown.
 *
 * WRITES NEVER THROW (D-13). `recordActivity` is a void function that swallows every error
 * from `mkdirSync` through `writeAtomic` — a full disk, a read-only `$HOME`, a newer
 * schemaVersion on disk — because a log write can never be allowed to turn a successful
 * retrieval into a failed one. This is the same shape as `indexCachedDocument`
 * (`search-index.ts`): best effort, void, silent past one warn line.
 *
 * OFF SWITCH: `VIBECTX_NO_LOG=1` (see `shouldLog`), read by the shared `envFlag` (PAR-1044 I-3),
 * like `VIBECTX_NO_AUTOWARM`: on-words or anything unrecognized turn logging off; ""/0/false/no/off
 * leave it on.
 *
 * BOUNDED (D-51): at most `ACTIVITY_LOG_MAX_ENTRIES`, oldest dropped first — the same
 * least-recently-written-wins shape `cache-evict.ts` uses for cache bytes, sized down for a
 * single small JSON file instead of a directory of documents. Every field below is itself
 * bounded (`MAX_LIBRARY_CHARS`, `MAX_LOGGED_QUERY_CHARS`, `MAX_URL_CHARS`, a fixed-width hash, a
 * closed `tool`/`outcome` vocabulary, one ISO timestamp), so the entry cap is also a byte
 * cap, not a second independent mechanism: MEASURED, one entry at every field's worst-case
 * length, pretty-printed exactly as this module writes it, is 1,032 bytes; `limits.ts`'s
 * `ACTIVITY_LOG_MAX_ENTRIES` entries of that worst case is ~2.06 MiB — see that constant's
 * own comment for the number.
 *
 * B-24 APPEND PATH: every normal write appends one complete NDJSON record with O_APPEND rather
 * than replacing a shared snapshot, so independent processes retain one another's records.
 * Reads still parse the bounded file to validate and render its recent-entry window; retention
 * is logical rather than a concurrent whole-file compaction that could discard an append.
 *
 * PAR-1039 ROTATION WITH A LINKED TRAIL (Tom, 2026-09-24; amends B-24): once the live file holds
 * `ACTIVITY_LOG_ROTATE_ENTRIES` entries (or is unusable: oversized or corrupt), it is renamed —
 * never rewritten — to `activity-<seq>.json`, and the new live file's first line is a link
 * record naming that archive with its entry count, first and last timestamps, SHA-256 and byte
 * length. Each archive's own first line links to the one before it, so the files form a trail.
 * Retention keeps the newest `DEFAULT_ACTIVITY_LOG_ARCHIVES` archives (`VIBECTX_LOG_ARCHIVES`,
 * the user-config key `logArchives`); a removed archive is still named by the next file's link,
 * so the trail's end is reported, never silent. The archive name is always derived from the
 * link's sequence NUMBER, never from text in the file, so a planted link cannot point a read
 * outside the cache. Still no lock (B-24): an append that lands in the old file during a
 * rotation changes its hash, and `--trail` reports that as "entries added after rotation".
 */

/** B-24 changes the persisted representation from one JSON envelope to NDJSON records. */
export const ACTIVITY_LOG_SCHEMA_VERSION = 2;
const LEGACY_ACTIVITY_LOG_SCHEMA_VERSION = 1;
const FILE_NAME = "activity.json";

/** Off switch (D-51). Mirrors `shouldAutowarm` (`autowarm.ts`) exactly, through the shared
 *  `envFlag` (PAR-1044 I-3): an on-word (1/true/yes/on) or any unrecognized value turns logging
 *  OFF; absent, "", 0, false, no or off leave it on — so a variable someone set to `0` to
 *  disable something is never read as enabling it, and a typo never turns logging back on. */
export const ACTIVITY_LOG_OFF_ENV = "VIBECTX_NO_LOG";

export function shouldLog(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag(env[ACTIVITY_LOG_OFF_ENV]) === false; // PAR-1044 (I-3): an unrecognized value keeps logging off
}

export const ACTIVITY_TOOLS = ["get_docs", "search", "resolve_library", "refresh"] as const;
export type ActivityTool = (typeof ACTIVITY_TOOLS)[number];

/** Closed vocabulary (K3): `matched` — content was found and served; `no-match` — the
 *  library/document was consulted but the topic or query found nothing in it; `not-cached`
 *  — nothing was available to serve (no cached or fetchable document); `unresolved` — the
 *  library name itself could not be established; `refused` — the tool DECLINED TO ACT, which
 *  is a different fact from "nothing was found" or "nothing was available": originally
 *  (PAR-848, Phase 3) `get_docs` had a document to serve but `maxTokens` could not hold the
 *  mandatory source stamp (and, when one was requested, the version verdict), so the call was
 *  refused rather than rendered with either fact silently dropped; PAR-796 (Phase 8) reuses the
 *  SAME value for two `refresh` cases that fit the identical shape — a rate-limited call, and a
 *  resolved entry declined because it would have overridden a curated one — rather than adding
 *  a second value for the same underlying fact. Distinct from `no-match` (a document WAS
 *  searched, the topic just isn't in it) and from `not-cached` (no document at all); logging a
 *  refusal as either would misstate what actually happened. Each write hook's own doc comment
 *  says which of the five applies to each of its branches. */
export const ACTIVITY_OUTCOMES = ["matched", "no-match", "not-cached", "unresolved", "refused"] as const;
export type ActivityOutcome = (typeof ACTIVITY_OUTCOMES)[number];

/** Longest `library`: npm's published package-name limit, the same bound `project-store.ts`
 *  and `search.ts` already apply to the same kind of field. */
const MAX_LIBRARY_CHARS = MAX_NAME_LENGTH;
/** Longest `query` (get_docs's `topic`, search's `query`): matches get_docs's own echo bound
 *  (`MAX_ECHOED_TOPIC_CHARS`) — this is a log entry, not the rendered response, but the same
 *  "one short phrase" reasoning applies. */
const MAX_LOGGED_QUERY_CHARS = 200;
/** Longest `url`: matches `search.ts`'s own `MAX_URL_CHARS`. */
const MAX_URL_CHARS = 300;
/** Longest `version`: reserved for a future source (see the field's own comment below);
 *  bounded now so a value from an untrusted future caller cannot inflate the file. */
const MAX_VERSION_CHARS = 100;
/** PAR-797 — longest `libraries` array: matches `search.ts`'s own `MAX_RENDERED_LIBRARIES`
 *  (not imported — `search.ts` already imports `recordActivity` from THIS module, so the
 *  reverse import would be a cycle; duplicated the same way `MAX_LIBRARY_CHARS`/`MAX_URL_CHARS`
 *  above already duplicate `search.ts`'s own bounds rather than import them). A hand-planted
 *  file claiming more than this is truncated, not dropped whole — the same "bound the field,
 *  not the row" rule every other array-shaped concern in this module follows. */
const MAX_LOGGED_LIBRARIES = 8;
/** `documentHash` (`search-index.ts`) is exactly 16 lowercase hex characters. */
const HASH_PATTERN = /^[0-9a-f]{16}$/;

export interface ActivityEntry {
  tool: ActivityTool;
  /** Canonical library name, when the call is scoped to one. Absent for a multi-library
   *  `search` (no single library is "the" one consulted) and for a full (no-argument)
   *  `refresh`. */
  library?: string;
  /** PAR-797 — the canonical names of the groups a multi-library `search` call ACTUALLY
   *  returned (after ranking, the `MAX_RENDERED_LIBRARIES` cap and budget selection — so this
   *  is never longer than that cap), when there is more than one. Before this field existed, a
   *  multi-library search's entry carried `library: undefined` and nothing else identified
   *  which libraries it actually consulted, unlike every other tool call this log records.
   *  Absent (never `[]`) on a single-library search (`library` above already names it) and on
   *  every other tool. */
  libraries?: string[];
  /** The topic (`get_docs`) or query (`search`), cleaned and clipped — never the document
   *  text itself. */
  query?: string;
  /** The document URL actually consulted, when there is exactly one (absent for a
   *  multi-library `search` and a full `refresh`, for the same reason as `library`).
   *  Validated by SHAPE only, not the fetch-time host allow-list, and redacted (query,
   *  fragment and userinfo stripped) via the shared `redactUrlForDisplay` — see
   *  `sanitizeLoggedUrl`'s own comment (PAR-792, consolidated into PAR-817 at Phase 4). */
  url?: string;
  /** PAR-813 (Phase 4) — the URL this document was ACTUALLY served from, when a redirect moved
   *  it away from `url` (mirrors `GetDocsOutcome.source.finalUrl` / `StampFacts.redirectedFrom`,
   *  PAR-776/D-74). Before this field existed, that fact had no reader outside the rendered
   *  stamp prose — a budget-dependent signal that degrades first under a tight `maxTokens`
   *  (`requiredHeader`'s own comment, retrieval.ts), which makes it unreliable as an AUDIT
   *  signal even though it is correct on its own terms. Redacted and bounded exactly like `url`.
   *  Absent whenever no redirect occurred, or the write hook has nothing to report. */
  finalUrl?: string;
  /** PAR-807 (Phase 4) — true when the RAW url this entry was built from carried a query string
   *  or a fragment that `redactUrlForDisplay` removed. Two documents differing only by query
   *  string (`…llms.txt?version=v2` vs `…llms.txt?version=v3`) are legitimately DIFFERENT
   *  cached documents (D-71's own cache-key design), but once every `url` in this log is
   *  query-stripped they render as the identical string — distinguishable only by
   *  `contentHash`, which is optional and not consistently populated by every write hook
   *  (`search.ts`'s entries carry neither `url` nor `contentHash` today). This field keeps the
   *  log honest about the elision rather than silently rendering two distinct sources as one:
   *  a reader sees "this string is not the whole story" instead of assuming it is. Absent
   *  (never `false`) when `url` is absent, or when nothing was actually stripped. */
  urlHadQuery?: boolean;
  /** `documentHash` (`search-index.ts`) of the document's content — proves WHICH document
   *  without storing what it said (D-33's own boundary, reused here). */
  contentHash?: string;
  /** Reserved: VibeCTX does not track a package's semver today — nothing upstream of this
   *  module resolves one (`ResolveOutcome`/`ResolvedMeta` carry no version field) — so this
   *  is always `undefined` in every entry this version writes. Kept in the schema, not
   *  invented a value for, so a future source can populate it without a schema bump. */
  version?: string;
  /** Whether the consulted copy was fresh (not past its TTL), when that is known. */
  fresh?: boolean;
  /** PAR-804 — true when this `get_docs` call genuinely matched real content (`outcome` is
   *  still `"matched"`) but the token budget left nothing to actually render, so `matched` alone
   *  is indistinguishable from a full answer. A new, purely-additive field rather than a new
   *  `ActivityOutcome` value — the outcome IS accurately "matched", this states an extra fact
   *  about it, the same shape `urlHadQuery` already uses for `url`. Absent (never `false`) on
   *  every other entry. Only `get_docs` ever sets it; `search`, `resolve_library` and `refresh`
   *  have no equivalent "matched but rendered nothing" case today. */
  thin?: boolean;
  /** PAR-796 (review round 2, code-reviewer S4) — WHICH refusal, when `outcome` is `"refused"`
   *  for a `refresh` call: `"rate-limited"` (a full, no-argument refresh hit
   *  `MAX_FULL_REFRESHES_PER_HOUR`, nothing was even attempted) or `"curated"` (a resolved
   *  entry was declined because it would have overridden a curated one; a genuine document WAS
   *  fetched and ready). Reusing the single `"refused"` outcome value for both (rather than a
   *  second `ActivityOutcome`, the same reasoning PAR-796's own decision record gives) means
   *  the two are otherwise indistinguishable from the log alone — this field is what tells them
   *  apart, the same purely-additive, no-schema-bump shape `thin` already established one field
   *  above. Absent for every other `refused` (`get_docs`'s budget/topic-length refusals) and
   *  every non-`refused` entry — never invented a value where the write hook has none to give. */
  refusedReason?: "rate-limited" | "curated";
  outcome: ActivityOutcome;
  /** ISO-8601 UTC instant, `Date.prototype.toISOString`'s own shape — the same one
   *  `project-store.ts` requires of `warmedAt`/`failedAt`. */
  timestamp: string;
}

export function activityLogPath(): string {
  return join(cacheRoot(), FILE_NAME);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Entry timestamps use cache-meta.ts's shared `validIsoInstant` (L-33). Its length bound matters
// here: an unbounded planted timestamp would widen every `vibectx log` table row and be written
// back on every later `recordActivity`, since a valid row is never dropped once accepted.

/** One bounded, cleaned string field, or `undefined` when absent, invalid, or EMPTY AFTER
 *  CLEANING (PAR-794): a raw string made entirely of control/bidi characters (`stripControlBidi`
 *  removes them all — `text.ts`) has non-zero raw length, so checking `value.length` BEFORE
 *  cleaning let such a value through to become a stored, rendered empty string instead of the
 *  field correctly reading as absent, the same way a genuinely empty input already does. The
 *  length check now runs on the CLEANED result. */
function cleanField(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clipped = clipText(value, max);
  return clipped.length === 0 ? undefined : clipped;
}

/** Longest raw URL string this module will attempt to parse — a guard before `new URL()`
 *  runs, independent of `MAX_URL_CHARS`'s post-sanitization storage clip. PAR-809 (Phase 4):
 *  this used to be an independent, undocumented duplicate of `link-policy.ts`'s own
 *  `MAX_REMOTE_URL_LENGTH` (private there before this item) — now imported from the one place
 *  that owns the value, so the two constants cannot drift apart silently. */
const MAX_RAW_URL_CHARS = MAX_REMOTE_URL_LENGTH;

/**
 * D-51/PAR-792 (security-architect): the persisted `url` is only ever DISPLAYED — `vibectx
 * log` never fetches it, and `test/import-graph.test.ts`'s done-when (c) pins that
 * `activity-log.ts` cannot even reach `fetcher.ts` transitively, so this premise cannot go
 * stale silently — so it is validated by SHAPE (https, well-formed, no userinfo), not by the
 * fetch-time host allow-list `sanitizeRemoteUrl` (`link-policy.ts`) applies. Structurally the
 * same move `cache-meta.ts`'s own `validMetaUrl` makes (its own stated reason is narrower —
 * "the trust decision was already made when the document was written" — but the effect is
 * the same: no host check on a value nothing here re-fetches). Without it, an internal/
 * air-gapped library's document URL (`allowInternalHosts: true`) fails `sanitizeRemoteUrl`'s
 * `isForbiddenHost` check and is silently dropped from the one place meant to evidence it was
 * consulted — exactly the air-gapped deployment this tool's own README courts.
 *
 * Also strips the QUERY STRING, not only the fragment `sanitizeRemoteUrl` already strips: a
 * config-authored `urls` entry carrying `?token=…`/`?api_key=…` (a realistic internal-docs
 * pattern) must not be written into a log file in plaintext — PAR-817 (Phase 4): the
 * redaction itself is now the ONE shared `redactUrlForDisplay` (`link-policy.ts`), not a
 * private copy of the same few lines this function used to carry on its own. DISCLOSED COST,
 * not costless: the cache key is the FULL url including its query (`urlSlug`, `cache-meta.ts`),
 * so two requests differing only in query (`?v=2` vs `?v=3`) are genuinely different documents
 * that `url` alone can no longer tell apart — PAR-807 (Phase 4) is what keeps this log honest
 * about that: the returned `hadQuery` reports whether the RAW value carried a query string or
 * a fragment before redaction, so `toActivityEntry` can record it (`ActivityEntry.urlHadQuery`)
 * rather than silently rendering two distinct sources as one identical `url`. `contentHash`
 * still distinguishes them when populated.
 *
 * D-92 (PAR-808) — a future change to this function's VALIDATION rule (tightening or loosening
 * which strings it accepts) does not need an `ACTIVITY_LOG_SCHEMA_VERSION` bump on its own; see
 * that decision for why. A bump is still required if this field's TYPE or PRESENCE changes.
 */
function sanitizeLoggedUrl(value: unknown): { url: string; hadQuery: boolean } | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (raw.length === 0 || raw.length > MAX_RAW_URL_CHARS) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  const hadQuery = url.search.length > 0 || url.hash.length > 0;
  return { url: redactUrlForDisplay(raw), hadQuery };
}

/**
 * Validate one persisted row (K1, mirroring `project-store.ts`'s own `toWarmRow`): `tool`
 * and `outcome` must be in their closed vocabularies and `timestamp` a strict ISO instant —
 * any of those failing drops the ROW; `library`, `query`, `url`, `finalUrl`, `version` are
 * bounded and cleaned — failing drops only that FIELD; `contentHash` must match
 * `documentHash`'s exact shape or is dropped; `fresh`/`urlHadQuery` must be booleans or are
 * dropped. Every surviving string passes through `cleanText` via `clipText`, so no control,
 * bidi or zero-width character reaches a render of this file (S3).
 */
export function toActivityEntry(raw: unknown): ActivityEntry | undefined {
  if (!isRecord(raw)) return undefined;
  const { tool, library, libraries, query, url, finalUrl, urlHadQuery, contentHash, version, fresh, thin, refusedReason, outcome, timestamp } = raw;
  if (typeof tool !== "string" || !(ACTIVITY_TOOLS as readonly string[]).includes(tool)) return undefined;
  if (typeof outcome !== "string" || !(ACTIVITY_OUTCOMES as readonly string[]).includes(outcome)) return undefined;
  if (!validIsoInstant(timestamp)) return undefined;
  const cleanedLibrary = cleanField(library, MAX_LIBRARY_CHARS);
  // PAR-797 — an array of the same kind of string `library` already is: each element cleaned
  // and clipped the same way, the whole array capped at MAX_LOGGED_LIBRARIES (truncated, not
  // dropped whole — a hand-planted file claiming more libraries than any real search could
  // ever return states a fact, just an over-long one). Non-string elements are dropped rather
  // than failing the whole field, matching this function's own "bound the field" philosophy.
  const cleanedLibraries = Array.isArray(libraries)
    ? libraries
        .filter((l): l is string => typeof l === "string")
        .map((l) => cleanField(l, MAX_LIBRARY_CHARS))
        .filter((l): l is string => l !== undefined)
        .slice(0, MAX_LOGGED_LIBRARIES)
    : undefined;
  const cleanedQuery = cleanField(query, MAX_LOGGED_QUERY_CHARS);
  const sanitizedUrl = sanitizeLoggedUrl(url);
  // PAR-813 (Phase 4) — `finalUrl` is sanitized/redacted exactly like `url` (same function,
  // same bound); its own `hadQuery` is not surfaced separately — `urlHadQuery` below reports
  // for `url`, the field every existing reader already keys off, and adding a second such flag
  // for `finalUrl` would be a second, narrower fact nothing yet consumes (PAR-807's own scope).
  const sanitizedFinalUrl = sanitizeLoggedUrl(finalUrl);
  const cleanedVersion = cleanField(version, MAX_VERSION_CHARS);
  // Built in this exact field order (K1, amended PAR-813/PAR-807/PAR-804/PAR-797/PAR-796 (review
  // round 2) — new keys APPENDED, per this schema's own "new keys may be appended without a
  // bump" rule, README): tool, library, query, url, finalUrl, urlHadQuery, contentHash, version,
  // fresh, thin, refusedReason, libraries, outcome, timestamp. This is the ONE
  // place an `ActivityEntry` is ever constructed — both a freshly recorded one (`recordActivity`,
  // via this same function) and one read back off disk — so there is no second "record" shape to
  // keep in lockstep with this one: `writeAtomic`'s write and `vibectx log --json`'s read both
  // serialize these objects directly, and this order is what each promises to keep stable within
  // a schemaVersion.
  const entry: ActivityEntry = { tool: tool as ActivityTool } as ActivityEntry;
  if (cleanedLibrary !== undefined) entry.library = cleanedLibrary;
  if (cleanedQuery !== undefined) entry.query = cleanedQuery;
  if (sanitizedUrl !== undefined) entry.url = clipText(sanitizedUrl.url, MAX_URL_CHARS);
  if (sanitizedFinalUrl !== undefined) entry.finalUrl = clipText(sanitizedFinalUrl.url, MAX_URL_CHARS);
  // PAR-807 — `toActivityEntry` is called BOTH on a fresh write (where `url` is still the RAW,
  // pre-redaction candidate — `sanitizeLoggedUrl` can genuinely detect a query/fragment on it)
  // AND on a read-back of an already-persisted entry (where `url` in the parsed JSON is already
  // redacted, so re-deriving `hadQuery` from IT would always read false and silently lose the
  // fact on every round trip). The already-written boolean is therefore trusted when it is one
  // (`explicitHadQuery`), and `sanitizedUrl.hadQuery` is only the FALLBACK for the fresh-write
  // path (where no such stored flag exists yet) and for an old-format entry written before this
  // field existed (correctly reads as false — no signal was ever recorded for it). Never set
  // (not even `false`) when `url` itself is absent: nothing to disclose.
  const explicitHadQuery = typeof urlHadQuery === "boolean" ? urlHadQuery : undefined;
  if (sanitizedUrl !== undefined && (explicitHadQuery ?? sanitizedUrl.hadQuery)) entry.urlHadQuery = true;
  if (typeof contentHash === "string" && HASH_PATTERN.test(contentHash)) entry.contentHash = contentHash;
  if (cleanedVersion !== undefined) entry.version = cleanedVersion;
  if (typeof fresh === "boolean") entry.fresh = fresh;
  // PAR-804 — same "only present when true" convention as `urlHadQuery` above: a thin match is
  // the exceptional case, and an old-format entry written before this field existed correctly
  // reads as "not thin" (no signal was ever recorded for it either way).
  if (thin === true) entry.thin = true;
  // PAR-796 (review round 2) — a closed, two-value vocabulary: anything else (including a
  // hand-planted or future-version string) is dropped, the same "bound the field" discipline
  // every other closed-vocabulary field in this module follows.
  if (refusedReason === "rate-limited" || refusedReason === "curated") entry.refusedReason = refusedReason;
  // PAR-797 — appended at the end of the optional-field zone, same "new keys are APPENDED"
  // convention `thin`/`urlHadQuery`/`finalUrl` already follow, not inserted next to `library`
  // where it reads most naturally — the persisted key ORDER is a promise this schema version
  // makes independently of where a field sits in the `ActivityEntry` TYPE declaration above.
  // Absent (never `[]`) when there is nothing to report.
  if (cleanedLibraries !== undefined && cleanedLibraries.length > 0) entry.libraries = cleanedLibraries;
  entry.outcome = outcome as ActivityOutcome;
  entry.timestamp = timestamp;
  return entry;
}

/** One bounded read+parse of `activity.json`, shared by `readActivityEntries` (below) and
 *  `recordActivity`'s newer-schemaVersion check.
 *
 *  PAR-795: these used to be TWO separate reads of the same file on every `recordActivity`
 *  call — `newerSchemaVersion`'s (`atomic-store.ts`) own `lstatSync` + `readFileSync` +
 *  `JSON.parse`, immediately followed by this function's own identical three calls via
 *  `readActivityEntries` — doubling the read+parse cost of the one write path this file's own
 *  top comment already calls out as paid on every ordinary retrieval, not merely a rare write.
 *  `schemaVersionOnDisk` reports whatever value indicates the on-disk schema (the parsed
 *  `parsed.schemaVersion`, even when it is not a valid, current schema — or, for a file too
 *  large to parse at all, `probeOversizedSchemaVersion`'s bounded-prefix best-effort read; see
 *  its own comment for why that second path exists too, round-3 review) so `recordActivity` can
 *  still detect and refuse a genuinely NEWER file either way; `entries` is only ever non-empty
 *  when the schema on disk exactly matches this version's own, the same rule the pre-PAR-795
 *  two-read version enforced.
 *
 *  PAR-790 — this used to be the one cache-directory reader with no size bound at all: a bare
 *  `readFileSync` + `JSON.parse`, unlike `readMetaFile` (`cache-meta.ts`, `MAX_META_FILE_BYTES`),
 *  `readIndex` (`search-index.ts`, `MAX_INDEX_FILE_BYTES`) and `readConfigFile` (`config.ts`,
 *  `MAX_CONFIG_BYTES`) — a 31 MB planted `activity.json` was read and fully `JSON.parse`d before
 *  this. `lstatSync`, not `statSync`, for the same reason `readMetaFile`'s own comment gives:
 *  the question is what the directory ENTRY is (never what a symlink at that name points at) —
 *  one call now does both the PAR-805 symlink refusal and the PAR-790 size bound, mirroring
 *  `readMetaFile`'s exact shape rather than `isRegularFile` (`atomic-store.ts`) plus a second,
 *  separate size check. Folding PAR-795's single-read fix in here also means the
 *  newer-schemaVersion check is now covered by this same size bound — `newerSchemaVersion`'s own
 *  `isRegularFile` carried no size check at all, so an oversized file used to be read and fully
 *  parsed there even though `readActivityEntries` would have refused it a moment later.
 *
 *  PAR-790 (also) — `ACTIVITY_LOG_MAX_ENTRIES` used to be enforced only on WRITE
 *  (`recordActivity`, below): a hand-planted or pre-upgrade file carrying more entries than the
 *  cap allows was read back in full. Applied here too, oldest-dropped-first — the same rule
 *  `recordActivity` already applies — so this function's own OUTPUT is bounded regardless of
 *  what is actually sitting on disk.
 *
 *  PAR-793 — `problem` states WHY the file was ignored (corrupt, oversized, wrong shape, a
 *  foreign schemaVersion, a non-regular file, or invalid entries dropped), mirroring
 *  `search-index.ts`'s own `readIndex`/`problem` field exactly: a missing file is the ordinary
 *  first-run state and stays silent (not a problem); everything else that resulted in an empty
 *  or partial read is named, not left for a reader to notice only as an unexpectedly short log.
 *
 *  Security review finding (round 3, BLOCKING): the leaf-only `lstatSync(path)` below never
 *  sees a symlinked cache ROOT — an intermediate component of `path`, not the leaf — whose
 *  target genuinely holds a real `activity.json`; ordinary path resolution follows it for
 *  traversal and the leaf check finds a real regular file at the far end. `isRealDirectory
 *  (cacheRoot())` (`cache.ts`) closes it, the same guard `resolved-store.ts`,
 *  `project-store.ts`, `doctor-store.ts` and `search-index.ts` already each carry — this
 *  module was the one store missing it. */

/** How much of an oversized `activity.json` `probeOversizedSchemaVersion` reads — this
 *  module's own writer (`recordActivity`, via `JSON.stringify({ schemaVersion, entries }, null,
 *  2)`) always places `schemaVersion` as the very first key, a few bytes in; 512 is generous
 *  headroom over that for any schemaVersion this tool will ever write, while staying a small,
 *  fixed cost regardless of how large the actual file is. */
const SCHEMA_PROBE_PREFIX_BYTES = 512;

/** Round-3 review finding (BLOCKING): a file too large to fully read (`MAX_ACTIVITY_FILE_BYTES`)
 *  used to report `schemaVersionOnDisk: undefined` unconditionally, so `recordActivity`'s
 *  newer-schemaVersion guard could never fire for it — an oversized file carrying a genuinely
 *  NEWER schemaVersion was silently overwritten instead of refused. This reads only the first
 *  `SCHEMA_PROBE_PREFIX_BYTES` bytes (`openSync`/`readSync`, never the whole file — the size cap
 *  this function exists alongside must not be defeated by the very check meant to respect it)
 *  and regex-extracts a `"schemaVersion": <digits>` value from that prefix. Returns `undefined`
 *  when the prefix does not reveal one (a hand-crafted file with the key placed elsewhere, or a
 *  read failure) — that file still falls through to being treated as ignorable/overwritable,
 *  unchanged from before this fix; this only closes the specific case where the prefix DOES
 *  reveal a newer version. */
function probeOversizedSchemaVersion(path: string): number | undefined {
  let fd: number;
  try {
    // PAR-1030 audit (F-A1030-1): non-blocking and no-follow, then a regular-file check on the
    // descriptor, so a FIFO or link swapped in after the caller's lstat cannot hang or redirect it.
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW));
  } catch {
    return undefined;
  }
  try {
    if (!fstatSync(fd).isFile()) return undefined;
    const buf = Buffer.alloc(SCHEMA_PROBE_PREFIX_BYTES);
    const bytesRead = readSync(fd, buf, 0, SCHEMA_PROBE_PREFIX_BYTES, 0);
    const prefix = buf.toString("utf8", 0, bytesRead);
    const match = /"schemaVersion"\s*:\s*(\d+)/.exec(prefix);
    if (!match) return undefined;
    const n = Number(match[1]);
    return Number.isSafeInteger(n) ? n : undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** PAR-1039 — the first line of every file a rotation starts: which archive it replaced. */
export interface ActivityRotationLink {
  /** Always `activityArchiveName(previousSeq)` — derived, never read from the file. */
  previous: string;
  previousSeq: number;
  /** Valid entries in the archive when it was rotated; absent when it could not be read. */
  previousEntries?: number;
  previousFirstAt?: string;
  previousLastAt?: string;
  /** SHA-256 of the archive's UTF-8 text at rotation; absent when it was too large to read. */
  previousSha256?: string;
  previousBytes?: number;
  rotatedAt: string;
}

/** `VIBECTX_LOG_ARCHIVES` — how many archives rotation keeps (default 5; 0 keeps none). */
export const ACTIVITY_LOG_ARCHIVES_ENV = "VIBECTX_LOG_ARCHIVES";
const ARCHIVE_PATTERN = /^activity-(\d{6,})\.json$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** The sequence number in an archive file name, or `undefined` for any other name, including
 *  one whose digits do not fit a safe integer (a planted name cannot overflow the numbering). */
function archiveSeq(name: string): number | undefined {
  const m = ARCHIVE_PATTERN.exec(name);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n >= 1 && n <= MAX_ARCHIVE_SEQ ? n : undefined;
}

/** PAR-1039 audit (F-A1039-2): archive numbers stop far below 2^53 (at 4,000 entries per archive
 *  this is beyond any real log), so the next number is always one the reader accepts; a planted
 *  name above it is not an archive at all. */
const MAX_ARCHIVE_SEQ = 999_999_999_999;

export function activityArchiveName(seq: number): string {
  return `activity-${String(seq).padStart(6, "0")}.json`;
}

function toRotationLink(raw: Record<string, unknown>): ActivityRotationLink | undefined {
  const seq = raw.previousSeq;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1 || seq > MAX_ARCHIVE_SEQ || !validIsoInstant(raw.rotatedAt)) return undefined;
  const count = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined);
  const link: ActivityRotationLink = { previous: activityArchiveName(seq), previousSeq: seq, rotatedAt: raw.rotatedAt };
  if (count(raw.previousEntries) !== undefined) link.previousEntries = count(raw.previousEntries);
  if (validIsoInstant(raw.previousFirstAt)) link.previousFirstAt = raw.previousFirstAt;
  if (validIsoInstant(raw.previousLastAt)) link.previousLastAt = raw.previousLastAt;
  if (typeof raw.previousSha256 === "string" && SHA256_PATTERN.test(raw.previousSha256)) link.previousSha256 = raw.previousSha256;
  if (count(raw.previousBytes) !== undefined) link.previousBytes = count(raw.previousBytes);
  return link;
}

interface ActivityFile {
  schemaVersionOnDisk: unknown;
  entries: ActivityEntry[];
  /** PAR-1039 — every valid entry in the file, before the `ACTIVITY_LOG_MAX_ENTRIES` window. */
  total?: number;
  /** PAR-1039 — the file's link record, when a rotation started it. */
  link?: ActivityRotationLink;
  /** PAR-1039 — a regular file whose bytes are not a usable log (oversized or corrupt): the
   *  next write rotates it to an archive instead of erasing it (F14). */
  unusable?: boolean;
  /** PAR-1039 — device and inode of the regular file this read saw. A rotation archives only
   *  this file, so a process that read a file another process has since rotated appends
   *  instead of rotating the other process's new file. */
  identity?: { dev: number; ino: number };
  /** A pre-B-24 `{ schemaVersion, entries }` envelope that the next write must migrate. */
  legacy?: boolean;
  /** The previous bytes were not a usable log; the next write starts a fresh journal. */
  reset?: boolean;
  problem?: string;
}

function validatedActivityEntries(rawEntries: unknown[]): { entries: ActivityEntry[]; dropped: number } {
  const entries: ActivityEntry[] = [];
  let dropped = 0;
  for (const raw of rawEntries) {
    const entry = toActivityEntry(raw);
    if (entry) entries.push(entry);
    else dropped += 1;
  }
  return { entries, dropped };
}

/**
 * B-24 — records are newline-delimited JSON, one complete self-describing entry per append.
 * `appendRegularFile` opens with O_APPEND, so concurrent writers append records instead of each
 * replacing a shared read-modify-write snapshot. The old envelope remains readable and is
 * migrated on the next successful write.
 */
function readActivityFile(path: string): ActivityFile {
  if (!isRealDirectory(cacheRoot())) {
    return { schemaVersionOnDisk: undefined, entries: [], problem: "activity log ignored: the cache root is not a real directory" };
  }
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return { schemaVersionOnDisk: undefined, entries: [] }; // no file yet is the ordinary first-run state
  }
  if (stat.isDirectory()) {
    // PAR-1030: a rename cannot replace a directory, so no fresh log can start; every write fails
    // and is reported. Say so instead of promising a fresh log.
    return { schemaVersionOnDisk: undefined, entries: [], reset: true, problem: "activity log ignored: activity.json is a directory, so nothing can be logged until it is removed" };
  }
  if (!stat.isFile()) {
    // PAR-1030 (final audit H-1): `reset` routes the next write to `writeAtomic`, whose rename
    // replaces the link itself. Without it the write took the append branch and followed the link.
    return { schemaVersionOnDisk: undefined, entries: [], reset: true, problem: "activity log ignored: not a regular file (a symlink or other special file); a fresh log starts on the next write" };
  }
  return { ...readRegularActivityFile(path, stat), identity: { dev: stat.dev, ino: stat.ino } };
}

function readRegularActivityFile(path: string, stat: Stats): ActivityFile {
  if (stat.size > MAX_ACTIVITY_FILE_BYTES) {
    // Round-3 review finding (BLOCKING): returning `schemaVersionOnDisk: undefined`
    // unconditionally here meant `recordActivity`'s newer-schemaVersion guard could never fire
    // for an oversized file — an oversized file carrying a NEWER schemaVersion was silently
    // overwritten with a fresh, current-version log instead of being refused and warned about,
    // exactly the outcome the guard exists to prevent for an undersized file of the same shape.
    // `probeOversizedSchemaVersion` is the fix: a small, BOUNDED prefix read (never the whole
    // oversized file) that can still reveal a genuinely newer version when one is there, so the
    // guard below has something to act on. A file whose prefix does not reveal a newer version
    // (a hand-crafted file with the key placed elsewhere, or genuinely no version conflict)
    // still falls through to being overwritten, unchanged from before this fix — this closes
    // the specific "newer version silently destroyed" case, not every possible oversized file.
    return {
      schemaVersionOnDisk: probeOversizedSchemaVersion(path),
      entries: [], reset: true, unusable: true,
      problem: `activity log ignored: ${path} is ${stat.size} bytes, over the ${MAX_ACTIVITY_FILE_BYTES}-byte limit`,
    };
  }
  let content: string;
  try {
    // AUDIT-20260920-01: `lstatSync` above is a useful diagnostic and pre-size check, but it
    // cannot itself pin a hostile final path component. Re-open through the descriptor-bound
    // helper so a swap to a symlink cannot turn this model-visible log read into a local-file
    // disclosure between the check and JSON.parse.
    const read = readBoundedRegularFile(path, MAX_ACTIVITY_FILE_BYTES);
    if (read === undefined) {
      return { schemaVersionOnDisk: undefined, entries: [], problem: "activity log ignored: file changed or is no longer a regular file; a fresh log starts on the next write" };
    }
    content = read;
    if (content === "") {
      return { schemaVersionOnDisk: undefined, entries: [], problem: "activity log ignored: file changed or is no longer a regular file; a fresh log starts on the next write" };
    }
  } catch (e) {
    // S2 / the D-22 precedent (search-index.ts's own jsonProblem): the parser's POSITION, by
    // design, not the file's own content — V8's syntax-error message quotes bytes from the file
    // verbatim, and this note can reach a rendered response (`vibectx log`, `--json`). See
    // `jsonProblem`'s own comment for the narrow case this does not fully close.
    return { schemaVersionOnDisk: undefined, entries: [], problem: `activity log unreadable (${jsonProblem(e)}); a fresh log starts on the next write` };
  }
  return parseActivityContent(content);
}

/** The bytes of one log file, already read, as entries (PAR-1039: shared by the live file, the
 *  archives the trail reaches, and the description a rotation writes into its link record). */
function parseActivityContent(content: string): ActivityFile {
  // A whole-file JSON value is the legacy envelope. Newline-delimited records intentionally do
  // not parse as one value, so this check safely distinguishes the two formats.
  try {
    const parsed: unknown = JSON.parse(content);
    if (isRecord(parsed) && Array.isArray(parsed.entries)) {
      const schemaVersionOnDisk = parsed.schemaVersion;
      if (schemaVersionOnDisk !== LEGACY_ACTIVITY_LOG_SCHEMA_VERSION && schemaVersionOnDisk !== ACTIVITY_LOG_SCHEMA_VERSION) {
        return { schemaVersionOnDisk, entries: [], problem: `activity log ignored: schemaVersion ${String(schemaVersionOnDisk)} (this version reads ${ACTIVITY_LOG_SCHEMA_VERSION})` };
      }
      const { entries, dropped } = validatedActivityEntries(parsed.entries);
      const bounded = entries.length > ACTIVITY_LOG_MAX_ENTRIES ? entries.slice(entries.length - ACTIVITY_LOG_MAX_ENTRIES) : entries;
      return dropped > 0
        ? { schemaVersionOnDisk, entries: bounded, legacy: true, problem: `activity log: ${dropped} invalid entr${dropped === 1 ? "y" : "ies"} dropped` }
        : { schemaVersionOnDisk, entries: bounded, legacy: true };
    }
    if (!isRecord(parsed) || parsed.schemaVersion !== ACTIVITY_LOG_SCHEMA_VERSION) {
      return { schemaVersionOnDisk: isRecord(parsed) ? parsed.schemaVersion : undefined, entries: [], reset: true, unusable: true, total: 0, problem: "activity log ignored: not a valid log file; it is kept as an archive on the next write" };
    }
    // One NDJSON record is also valid JSON as a whole. Let the line parser handle it below.
  } catch (e) {
    // Expected for multi-line NDJSON. A single malformed JSON value is still the legacy
    // corruption case and keeps the precise, redacted parse diagnostic.
    if (!content.includes("\n")) {
      return { schemaVersionOnDisk: undefined, entries: [], reset: true, unusable: true, total: 0, problem: `activity log unreadable (${jsonProblem(e)}); it is kept as an archive on the next write` };
    }
  }

  const rawEntries: unknown[] = [];
  let dropped = 0;
  let futureSchemaVersion: number | undefined;
  let link: ActivityRotationLink | undefined;
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed) && parsed.schemaVersion === ACTIVITY_LOG_SCHEMA_VERSION && parsed.type === "rotation") {
        // PAR-1039: a link record, not an entry. Normally the first line; a rotation that lost a
        // creation race appends it after another process's first record instead (still read).
        const parsedLink = toRotationLink(parsed);
        if (parsedLink === undefined) dropped += 1;
        else link ??= parsedLink;
        continue;
      }
      if (!isRecord(parsed) || parsed.schemaVersion !== ACTIVITY_LOG_SCHEMA_VERSION) {
        if (isRecord(parsed) && typeof parsed.schemaVersion === "number" && parsed.schemaVersion > ACTIVITY_LOG_SCHEMA_VERSION) {
          futureSchemaVersion = Math.max(futureSchemaVersion ?? ACTIVITY_LOG_SCHEMA_VERSION, parsed.schemaVersion);
        }
        dropped += 1;
        continue;
      }
      rawEntries.push(parsed);
    } catch {
      dropped += 1;
    }
  }
  if (futureSchemaVersion !== undefined) {
    return { schemaVersionOnDisk: futureSchemaVersion, entries: [], problem: `activity log ignored: schemaVersion ${futureSchemaVersion} (this version reads ${ACTIVITY_LOG_SCHEMA_VERSION})` };
  }
  const validated = validatedActivityEntries(rawEntries);
  dropped += validated.dropped;
  const bounded = validated.entries.length > ACTIVITY_LOG_MAX_ENTRIES
    ? validated.entries.slice(validated.entries.length - ACTIVITY_LOG_MAX_ENTRIES)
    : validated.entries;
  const total = validated.entries.length;
  return dropped > 0
    ? { schemaVersionOnDisk: ACTIVITY_LOG_SCHEMA_VERSION, entries: bounded, total, ...(link ? { link } : {}), problem: `activity log: ${dropped} invalid entr${dropped === 1 ? "y" : "ies"} dropped` }
    : { schemaVersionOnDisk: ACTIVITY_LOG_SCHEMA_VERSION, entries: bounded, total, ...(link ? { link } : {}) };
}

/** `invalid JSON at position N` — an anchored regex accepts only a terminal V8-shaped
 *  position marker (with optional line/column detail), never a broad error-message slice.
 *  The marker's provenance is not provable if quoted file content itself ends in the same
 *  shape; that pathological edge case is not excluded by this regex. Mirrors
 *  `search-index.ts`'s own private `jsonProblem` (not imported — that file is a different trust
 *  boundary and exports it to nobody, the same reasoning `ISO_INSTANT`'s own comment above gives
 *  for this file's other small duplicated primitives). */
function jsonProblem(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  // V8 quotes hostile source bytes before the real diagnostic, so only accept its position
  // marker at the end of the engine message (optionally followed by line/column detail).
  const match = / at position (\d+)(?: \(line \d+ column \d+\))?$/.exec(raw);
  return match ? `invalid JSON at position ${match[1]}` : "invalid JSON";
}

/** Every valid persisted entry, oldest first; `[]` when the file is missing, corrupt, of
 *  another schema, too large, OR (PAR-805) a symlink rather than the regular file
 *  `recordActivity` writes. Drops the `problem` note `readActivityFile` may carry — use
 *  `readActivityLog` when that note matters to the caller (PAR-793). */
export function readActivityEntries(): ActivityEntry[] {
  return readActivityFile(activityLogPath()).entries;
}

/** PAR-1039 — the user-config `logArchives` value, set once at startup by `configureActivityLog`
 *  (`undefined`: not configured). Project config never reaches here (registry.ts). */
let configuredArchives: unknown;
/** Each bad setting is reported once per process, not on every rotation. */
let reportedBadSettings = new Set<string>();

/** Startup hook for the CLI and the server: pass the loaded registry's `logArchives`. A bad
 *  value (or a bad `VIBECTX_LOG_ARCHIVES`) is reported once, here, and 5 is used. */
export function configureActivityLog(opts: { logArchives?: unknown; env?: NodeJS.ProcessEnv; warn?: (message: string) => void }): void {
  configuredArchives = opts.logArchives;
  reportedBadSettings = new Set();
  archivesToKeep(opts.env ?? process.env, opts.warn ?? ((m) => writeStderrWarning(m)));
}

function wholeNumber(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : undefined;
  return n !== undefined && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/** How many archives to keep: the user-config key, else `VIBECTX_LOG_ARCHIVES`, else 5. A bad
 *  value prints one stderr line and keeps 5 (Tom's decision); it never stops logging. */
function archivesToKeep(env: NodeJS.ProcessEnv, warn: (message: string) => void): number {
  const reportOnce = (key: string, message: string) => {
    if (reportedBadSettings.has(key)) return;
    reportedBadSettings.add(key);
    warn(message);
  };
  if (configuredArchives !== undefined) {
    const n = typeof configuredArchives === "number" ? wholeNumber(configuredArchives) : undefined;
    if (n !== undefined) return n;
    reportOnce("config", `vibectx: logArchives in config must be a whole number 0 or more; keeping ${DEFAULT_ACTIVITY_LOG_ARCHIVES}`);
    return DEFAULT_ACTIVITY_LOG_ARCHIVES;
  }
  const raw = env[ACTIVITY_LOG_ARCHIVES_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_ACTIVITY_LOG_ARCHIVES;
  const n = wholeNumber(raw);
  if (n !== undefined) return n;
  reportOnce(`env:${raw}`, `vibectx: ${ACTIVITY_LOG_ARCHIVES_ENV} must be a whole number 0 or more; keeping ${DEFAULT_ACTIVITY_LOG_ARCHIVES}`);
  return DEFAULT_ACTIVITY_LOG_ARCHIVES;
}

const sha256Hex = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const entryLine = (entry: ActivityEntry) => JSON.stringify({ schemaVersion: ACTIVITY_LOG_SCHEMA_VERSION, ...entry });

/**
 * PAR-1039 — move the live file to the next archive and start a new live file whose first line
 * links to it, then apply retention. Concurrency (still no lock, B-24):
 * - The archive is made with `link` + `unlink`, not `rename`: `link` fails if the archive name
 *   exists, so two processes rotating at once can never overwrite an archive (F14.2).
 * - The archive must be the very file this process read (`identity`, device and inode). A
 *   process that read a full file another process has since rotated, or a name swapped by
 *   anything else, gets its new name removed and appends its entry instead. This also covers
 *   platforms where `link` follows a symlink: the result is never that identity. It relies on
 *   the read file still existing, which a competing rotation guarantees (its own archive name
 *   holds the file); a file deleted outright can have its inode number reused at once (Linux),
 *   so identity is not proof against deletion by something other than a rotation.
 * - The new live file is created exclusive: if another process appended first, the link record
 *   is appended after its record instead of replacing it (readers accept it anywhere).
 * - A file system without hard links (some Windows and removable drives) falls back to a
 *   `rename` taken only when the archive name is free and the live file is still the one read;
 *   the remaining window between that check and the rename is a stated residual.
 * Losing a race never loses the entry: it is appended to whatever live file is there.
 */
function rotateAndRecord(path: string, read: ActivityFile, entry: ActivityEntry, env: NodeJS.ProcessEnv, warn: (message: string) => void): void {
  const root = cacheRoot();
  const identity = read.identity;
  const keepEntry = () => appendRegularFile(path, `${entryLine(entry)}\n`, 0o600);
  if (identity === undefined) return keepEntry();
  // PAR-1039 audit (F-A1039-1): one rotation per file. Two processes that read the same full
  // file could otherwise both archive it, and the slower one would remove the faster one's new
  // live file (and the entry in it). The claim is named for the file's identity and created
  // exclusively; a process that does not get it appends its entry instead. Appends themselves
  // stay lock-free (B-24). A claim left by a process that died mid-rotation is taken over after
  // ROTATION_CLAIM_STALE_MS.
  const claim = join(root, `${FILE_NAME}.rotating-${identity.dev}-${identity.ino}`);
  if (!takeRotationClaim(claim)) return keepEntry();
  try {
    rotateClaimed(path, read, identity, entry, env, warn, keepEntry);
  } finally {
    try {
      unlinkSync(claim);
    } catch {
      /* already gone */
    }
  }
}

const ROTATION_CLAIM_STALE_MS = 60_000;

/** Take the single-holder rotation marker (Tom, 2026-10-01: rotation-only mutual exclusion;
 *  appends stay lock-free per B-24). Created exclusive and no-follow, holding this process's ID.
 *  An existing marker is cleared and the claim retried once when it is:
 *  - not a regular file (a planted link or other entry: only its own name is removed, never
 *    followed, so nothing outside the cache is touched and rotation is not blocked forever);
 *  - left by a holder that is gone: its recorded process is not running on this machine; or
 *  - older than ROTATION_CLAIM_STALE_MS (covers a reused process ID or another machine).
 *  Otherwise another process is rotating this file, and the caller appends its entry instead. */
function takeRotationClaim(claim: string): boolean {
  if (createRegularFileExclusive(claim, `${process.pid}\n`, 0o600)) return true;
  let judged: Stats;
  try {
    judged = lstatSync(claim);
  } catch {
    return createRegularFileExclusive(claim, `${process.pid}\n`, 0o600); // released meanwhile
  }
  const stale = !judged.isFile() || Date.now() - judged.mtimeMs >= ROTATION_CLAIM_STALE_MS || markerHolderGone(claim);
  if (!stale || !clearStaleMarker(claim, judged)) return false;
  return createRegularFileExclusive(claim, `${process.pid}\n`, 0o600);
}

/** Remove the marker judged stale, and only that one (audit pass 2: judging and removing are two
 *  steps, so two processes could both clear a stale marker and both rotate). The marker is first
 *  renamed aside, an atomic step only one process can take for a given file, then checked: if
 *  it is the very file judged stale it is removed; if another process had already replaced it
 *  with its own fresh marker, that marker is linked back without replacing anything newer, and
 *  this process does not rotate. Rename and unlink act on names, never following a link. */
function clearStaleMarker(claim: string, judged: Stats): boolean {
  const aside = `${claim}.stale-${process.pid}-${Date.now()}`;
  try {
    renameSync(claim, aside);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT"; // already cleared by another process
  }
  let moved: Stats | undefined;
  try {
    moved = lstatSync(aside);
  } catch {
    moved = undefined;
  }
  // Same file = same device, inode, modification time and size. The inode alone is not enough:
  // on Linux a deleted marker's inode number is reused at once by the next file created, so a
  // fresh marker can carry the stale one's inode. Rename changes none of these four (it does
  // change ctime, which is why ctime is not compared).
  if (moved !== undefined && moved.dev === judged.dev && moved.ino === judged.ino && moved.mtimeMs === judged.mtimeMs && moved.size === judged.size) {
    try {
      unlinkSync(aside);
    } catch {
      /* already gone */
    }
    return true;
  }
  try {
    linkSync(aside, claim); // fails, replacing nothing, if a newer marker is already in place
  } catch {
    /* a newer marker holds the name */
  }
  try {
    unlinkSync(aside);
  } catch {
    /* already gone */
  }
  return false;
}

/** True when the marker names a process ID that is not running here (ESRCH). Any doubt (an
 *  unreadable marker, a permission error, a live process) answers false: the age rule decides. */
function markerHolderGone(claim: string): boolean {
  const raw = readBoundedRegularFile(claim, 64);
  const pid = raw === undefined ? NaN : Number(raw.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function rotateClaimed(
  path: string,
  read: ActivityFile,
  identity: { dev: number; ino: number },
  entry: ActivityEntry,
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void,
  keepEntry: () => void,
): void {
  const root = cacheRoot();
  let maxSeq = read.link?.previousSeq ?? 0;
  for (const other of readdirSync(root)) maxSeq = Math.max(maxSeq, archiveSeq(other) ?? 0);
  const seq = maxSeq + 1;
  if (seq > MAX_ARCHIVE_SEQ) {
    // Audit pass 2 (F-A1039-2): no number is left that the reader accepts. Never write an
    // unreadable link: keep the entry in the live file and say so once.
    if (!reportedBadSettings.has("ceiling")) {
      reportedBadSettings.add("ceiling");
      warn(`vibectx: activity log not rotated: archive numbering is exhausted (an archive is numbered ${MAX_ARCHIVE_SEQ}); move activity-*.json files out of the cache to resume`);
    }
    return keepEntry();
  }
  const name = activityArchiveName(seq);
  const archivePath = join(root, name);
  const isReadFile = (s: Stats) => s.isFile() && s.dev === identity.dev && s.ino === identity.ino;
  let linked = false;
  try {
    linkSync(path, archivePath);
    linked = true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOENT") return keepEntry(); // another process rotated first
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "ENOSYS") throw e;
    // No hard links on this file system: rename, but only onto a free name and only the file read.
    let current: Stats;
    try {
      current = lstatSync(path);
    } catch {
      return keepEntry();
    }
    if (!isReadFile(current) || lstatSync(archivePath, { throwIfNoEntry: false }) !== undefined) return keepEntry();
    // Residual: rename replaces a target, so an archive another process creates under this
    // same name between the check above and this call would be overwritten (stated in D-104).
    renameSync(path, archivePath);
  }
  if (linked) {
    const dropNewName = () => {
      try {
        unlinkSync(archivePath); // only the name this call made: the file is someone else's, or still live
      } catch {
        /* already gone */
      }
    };
    if (!isReadFile(lstatSync(archivePath))) {
      dropNewName();
      return keepEntry();
    }
    try {
      unlinkSync(path);
    } catch {
      // Another process already moved this same file to its own archive (or, on Windows, the
      // file is open): leave no second name for it off the trail, and keep the entry.
      dropNewName();
      return keepEntry();
    }
  }

  // Describe the archive from the bytes now in it, so the hash matches what --trail re-reads.
  const content = readBoundedRegularFile(archivePath, MAX_ACTIVITY_FILE_BYTES);
  const link: Record<string, unknown> = { schemaVersion: ACTIVITY_LOG_SCHEMA_VERSION, type: "rotation", previous: name, previousSeq: seq };
  let moved: string;
  if (content !== undefined) {
    const parsed = parseActivityContent(content);
    const all = parsed.total ?? parsed.entries.length;
    const bytes = Buffer.from(content, "utf8");
    link.previousEntries = all;
    if (parsed.entries.length > 0) {
      link.previousFirstAt = firstEntryTimestamp(content) ?? parsed.entries[0]!.timestamp;
      link.previousLastAt = parsed.entries[parsed.entries.length - 1]!.timestamp;
    }
    link.previousSha256 = sha256Hex(bytes);
    link.previousBytes = bytes.length;
    moved = parsed.unusable ? "a log that is not valid activity records" : `${all} entr${all === 1 ? "y" : "ies"}`;
  } else {
    link.previousBytes = lstatSync(archivePath).size;
    moved = "a log too large to read";
  }
  link.rotatedAt = entry.timestamp;
  const body = `${JSON.stringify(link)}\n${entryLine(entry)}\n`;
  if (!createRegularFileExclusive(path, body, 0o600)) appendRegularFile(path, body, 0o600);

  const keep = archivesToKeep(env, warn);
  const removed = applyRetention(name, keep);
  const kept = removed.includes(name) ? " (the archive count is 0, so it was not kept)" : "";
  const dropped = removed.filter((n) => n !== name);
  warn(`vibectx: activity log rotated: ${moved} moved to ${name}${kept}${dropped.length > 0 ? `; older history removed: ${dropped.join(", ")}` : ""}`);
}

/** PAR-1039 — keep the newest `keep` archives of THIS trail: walk the link records back from
 *  the archive just made and remove what lies beyond the count. Only regular files this trail
 *  reaches are removed, so a planted name elsewhere (any number) can never steer a deletion. */
function applyRetention(newest: string, keep: number): string[] {
  const root = cacheRoot();
  const chain: string[] = [];
  let name: string | undefined = newest;
  let lastSeq = Number.POSITIVE_INFINITY;
  while (name !== undefined) {
    const seq = archiveSeq(name);
    if (seq === undefined || seq >= lastSeq) break;
    lastSeq = seq;
    const path = join(root, name);
    let isFile = false;
    try {
      isFile = lstatSync(path).isFile();
    } catch {
      break; // already removed: the trail beyond it is gone too
    }
    if (!isFile) break; // never followed, never removed
    chain.push(name);
    name = readLinkRecord(path).link?.previous; // an unreadable archive ends the walk: nothing older is removed
  }
  const removed: string[] = [];
  for (const old of chain.slice(keep)) {
    try {
      unlinkSync(join(root, old));
      removed.push(old);
    } catch {
      /* best effort: another process may have removed it first */
    }
  }
  return removed;
}

/** PAR-1039 — an archive's link record, read from a small bounded prefix of the file (no-follow
 *  open, then the opened file's device and inode must match the `lstat`), falling back to a full
 *  bounded read only when the link is not on the first line (a rotation that lost a creation
 *  race, or the first-ever file). `unreadable` when that full read finds no usable log. */
function readLinkRecord(path: string): { link?: ActivityRotationLink; unreadable?: boolean } {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch {
    return { unreadable: true };
  }
  if (!stat.isFile()) return { unreadable: true };
  let fd: number;
  try {
    // O_NONBLOCK: a FIFO swapped in after the lstat opens at once and fails the identity check
    // below, instead of blocking for a writer (the PAR-1030 cross-audit read-side fix).
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW));
  } catch {
    return { unreadable: true };
  }
  let firstLine: string | undefined;
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) return { unreadable: true };
    const buf = Buffer.alloc(LINK_PREFIX_BYTES);
    const n = readSync(fd, buf, 0, LINK_PREFIX_BYTES, 0);
    const text = buf.toString("utf8", 0, n);
    const end = text.indexOf("\n");
    if (end !== -1) firstLine = text.slice(0, end);
  } catch {
    return { unreadable: true };
  } finally {
    closeSync(fd);
  }
  if (firstLine !== undefined) {
    try {
      const parsed: unknown = JSON.parse(firstLine);
      if (isRecord(parsed) && parsed.schemaVersion === ACTIVITY_LOG_SCHEMA_VERSION && parsed.type === "rotation") {
        const link = toRotationLink(parsed);
        if (link !== undefined) return { link };
      }
    } catch {
      /* not a record: fall through */
    }
  }
  const file = readActivityFile(path);
  return archiveUnreadable(file) ? { unreadable: true } : { link: file.link };
}

/** An archive with no usable log in it: its link (if any) cannot be trusted, so the trail ends. */
function archiveUnreadable(file: ActivityFile): boolean {
  return file.unusable === true || (file.entries.length === 0 && file.link === undefined && file.problem !== undefined);
}

/** A link record is a few hundred bytes; this is generous headroom for one line. */
const LINK_PREFIX_BYTES = 4096;

/** The first valid entry's timestamp in the whole file (`parseActivityContent` keeps only the
 *  newest window), found without validating every later line twice. */
function firstEntryTimestamp(content: string): string | undefined {
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed) || parsed.schemaVersion !== ACTIVITY_LOG_SCHEMA_VERSION || parsed.type === "rotation") continue;
      const entry = toActivityEntry(parsed);
      if (entry) return entry.timestamp;
    } catch {
      /* not a record: keep looking */
    }
  }
  return undefined;
}

/** What a write hook hands in: everything `ActivityEntry` has except `timestamp`, which this
 *  module stamps itself (a caller-supplied clock is a test seam only, `opts.now` below). */
export type ActivityInput = Omit<ActivityEntry, "timestamp">;

/**
 * Append one entry and persist it. Readers expose at most `ACTIVITY_LOG_MAX_ENTRIES` newest
 * records. NEVER THROWS (D-13): a failure anywhere — the directory cannot be created, the
 * file cannot be read or written, a newer schemaVersion is on disk — costs one `warn` line
 * and the entry is simply not recorded; the retrieval that triggered this call already
 * succeeded or failed on its own terms before this function was ever reached, and nothing
 * here may change that.
 *
 * PAR-794 (mirrors `debug.ts`'s `debugEvent` fix, same class of bug): `warn` is itself
 * caller-suppliable, and production's own default (`process.stderr.write`) throws on a
 * closed/full pipe — e.g. a piped MCP client that went away. Every call to `warn` below,
 * including the outer `catch` block's own failure-reporting call, goes through `safeWarn`,
 * which swallows a throw from `warn` itself rather than letting it escape this function — a
 * diagnostic that can turn a handled failure into an unhandled one is not a diagnostic
 * (`debugEvent`'s own doc comment states the same principle).
 *
 * A no-op (no directory even created) when `shouldLog` is off, so `VIBECTX_NO_LOG=1` costs
 * nothing at all, not even a stat call.
 */
export function recordActivity(
  input: ActivityInput,
  opts: { env?: NodeJS.ProcessEnv; warn?: (message: string) => void; now?: () => Date } = {},
): void {
  const rawWarn = opts.warn ?? ((m: string) => writeStderrWarning(m));
  const warn = (message: string) => {
    try {
      rawWarn(message);
    } catch {
      // Deliberately silent — see this function's own doc comment (PAR-794).
    }
  };
  try {
    if (!shouldLog(opts.env ?? process.env)) return;
    const now = opts.now ?? (() => new Date());
    const entry = toActivityEntry({ ...input, timestamp: now().toISOString() });
    if (!entry) return; // the caller handed this module a value its own fields cannot hold
    const dir = cacheRoot();
    // PAR-791 (security-architect) originally required 0o700 here specifically, because this
    // file holds what the user asked about — the first thing in the cache directory that does
    // — but noted a real limitation: `mkdirSync` never retroactively `chmod`s an existing
    // directory, and most cache roots already existed by the time a retrieval logged its first
    // entry, since `cache.ts`'s own read/write path almost always creates the root FIRST, with
    // no mode. PAR-805 closes that gap at its source rather than papering over it here: EVERY
    // site that may create the cache root now goes through the same `ensureCacheRoot`
    // (`cache.ts`) this call now also uses, so whichever one actually runs first still produces
    // 0o700 — see that function's own comment for the full rationale, including why a
    // PRE-EXISTING looser root is warned about, not tightened.
    // PAR-859: a symlinked `dir` is now refused by `ensureCacheRoot` itself (warns once, returns
    // `false`) rather than written through silently — a plain `return;`, not falling through to
    // `writeAtomic`, which would otherwise throw against a directory that was never created and
    // land in this function's own outer `catch`, printing a second, redundant "activity not
    // logged" line on top of `ensureCacheRoot`'s own warning for the same refusal.
    if (!ensureCacheRoot(dir, warn)) return;
    const path = activityLogPath();
    // PAR-795: one read, not two — see readActivityFile's own comment for what this replaced.
    const read = readActivityFile(path);
    const { schemaVersionOnDisk, entries, legacy, reset, total, unusable } = read;
    if (typeof schemaVersionOnDisk === "number" && schemaVersionOnDisk > ACTIVITY_LOG_SCHEMA_VERSION) {
      warn(`vibectx: activity not logged — ${path} has a newer schemaVersion ${schemaVersionOnDisk} (this version writes ${ACTIVITY_LOG_SCHEMA_VERSION}); upgrade vibectx or delete the file`);
      return;
    }
    if (unusable || (total ?? 0) >= ACTIVITY_LOG_ROTATE_ENTRIES) {
      // PAR-1039: a full live file, or a regular file that is not a usable log (F14.1), is
      // archived and linked from the new file — never erased (unless the archive count is 0).
      rotateAndRecord(path, read, entry, opts.env ?? process.env, warn);
      return;
    }
    if (legacy || reset) {
      // The old format needs one conversion write. All normal writes after that are O_APPEND.
      const migrated = [...(legacy ? entries : []), entry].slice(-ACTIVITY_LOG_MAX_ENTRIES)
        .map((record) => JSON.stringify({ schemaVersion: ACTIVITY_LOG_SCHEMA_VERSION, ...record }))
        .join("\n");
      writeAtomic(path, `${migrated}\n`, { mode: 0o600 });
    } else {
      // B-24: one complete record per append. Readers enforce the retention cap logically;
      // compaction is deliberately not a concurrent rewrite that could discard another writer.
      // PAR-1030: `appendRegularFile` opens without following a symlink and sets PAR-791's
      // owner-only mode on the opened descriptor, so a link swapped in after the read above
      // makes this append fail (reported below) instead of writing through it.
      appendRegularFile(path, `${JSON.stringify({ schemaVersion: ACTIVITY_LOG_SCHEMA_VERSION, ...entry })}\n`, 0o600);
    }
  } catch (e) {
    warn(`vibectx: activity not logged: ${cleanText(e instanceof Error ? e.message : String(e))}`);
  }
}

/** `vibectx log --json`'s shape — the one interface every reader needs, in the same
 *  `{ schemaVersion, entries }` envelope every other command
 *  emits. New keys may be appended in a later version; `schemaVersion` is bumped only when
 *  an existing key is renamed, removed or changes meaning (the same rule every other
 *  `--json` surface in this tool documents). `problem` (PAR-793, additive) states why the file
 *  was ignored or partially dropped, mirroring `search-index.ts`'s `readIndex`; absent when
 *  there is nothing to report, including the ordinary first-run "no file yet" state. */
export interface ActivityLogReport {
  schemaVersion: typeof ACTIVITY_LOG_SCHEMA_VERSION;
  entries: ActivityEntry[];
  problem?: string;
}

/** The `vibectx log` CLI body's data: every valid entry, oldest first, plus (PAR-793) a stated
 *  reason when the on-disk file was ignored or partially dropped rather than a corrupt file
 *  silently reading as an empty, healthy-looking log. Never throws (D-13, the same as
 *  `readActivityEntries`, which this no longer merely wraps — both now share the one read via
 *  `readActivityFile`, PAR-795). */
export function readActivityLog(): ActivityLogReport {
  const live = readActivityFile(activityLogPath());
  let entries = live.entries;
  const problems = live.problem !== undefined ? [live.problem] : [];
  // PAR-1039: follow the trail back through the archives for the newest ACTIVITY_LOG_MAX_ENTRIES.
  // Past that window only each archive's link record is read, so the walk still reaches the
  // trail's end (a removal is always reported) without reading every archive in full.
  walkTrail(live.link, (name, path) => {
    if (entries.length >= ACTIVITY_LOG_MAX_ENTRIES) return readLinkRecord(path);
    const archive = readActivityFile(path);
    if (archiveUnreadable(archive)) return { unreadable: true };
    if (archive.problem !== undefined) problems.push(`activity log archive ${name}: ${archive.problem}`);
    entries = [...archive.entries, ...entries].slice(-ACTIVITY_LOG_MAX_ENTRIES);
    return { link: archive.link };
  }, (end) => {
    const note = trailEndNote(end);
    if (note !== undefined) problems.push(end.kind === "refused" ? `activity log archive refused: ${end.name} is not a regular file` : note);
  });
  const problem = problems.length > 0 ? problems.join("; ") : undefined;
  return problem !== undefined
    ? { schemaVersion: ACTIVITY_LOG_SCHEMA_VERSION, entries, problem }
    : { schemaVersion: ACTIVITY_LOG_SCHEMA_VERSION, entries };
}

/** How the trail ends: at the first-ever file (`start`), at an archive retention removed, at a
 *  name that is not a regular file (never followed), at an archive that cannot be read as a log
 *  (its own link, if any, cannot be trusted), or at a link that does not go back. */
export type ActivityTrailEnd =
  | { kind: "start" }
  | { kind: "removed"; name: string }
  | { kind: "refused"; name: string }
  | { kind: "unreadable"; name: string }
  | { kind: "loop"; name: string };

function trailEndNote(end: ActivityTrailEnd): string | undefined {
  switch (end.kind) {
    case "start":
      return undefined;
    case "removed":
      return `older history removed: ${end.name}`;
    case "refused":
      return `archive refused: ${end.name} is not a regular file`;
    case "unreadable":
      return `archive ${end.name} cannot be read as a log; older history cannot be followed past it`;
    case "loop":
      return `trail loops at ${end.name}; stopped following it`;
  }
}

/** Walk link records from the live file back. `visit` reads one archive and returns its own
 *  link (or that it was unreadable). Sequence numbers must strictly decrease, so a planted
 *  cycle ends the walk instead of repeating it; names come from the numbers, never the file. */
function walkTrail(
  link: ActivityRotationLink | undefined,
  visit: (name: string, path: string) => { link?: ActivityRotationLink; unreadable?: boolean },
  done: (end: ActivityTrailEnd) => void,
): void {
  let lastSeq = Number.POSITIVE_INFINITY;
  while (link !== undefined) {
    const name = link.previous;
    if (link.previousSeq >= lastSeq) return done({ kind: "loop", name });
    lastSeq = link.previousSeq;
    const path = join(cacheRoot(), name);
    let isFile: boolean;
    try {
      isFile = lstatSync(path).isFile();
    } catch {
      return done({ kind: "removed", name });
    }
    if (!isFile) return done({ kind: "refused", name });
    const next = visit(name, path);
    if (next.unreadable) return done({ kind: "unreadable", name });
    link = next.link;
  }
  done({ kind: "start" });
}

export const ACTIVITY_TRAIL_SCHEMA_VERSION = 1;

export interface ActivityTrailFile {
  name: string;
  entries: number;
  firstAt?: string;
  lastAt?: string;
  /** `live` for the live file; for an archive, whether its bytes still match its link record. */
  hash: string;
}

/** `vibectx log --trail [--json]`'s data (PAR-1039): the live file, then each archive the trail
 *  reaches, newest first, and how the trail ends. Never throws (D-13). */
export interface ActivityTrail {
  schemaVersion: typeof ACTIVITY_TRAIL_SCHEMA_VERSION;
  files: ActivityTrailFile[];
  end: ActivityTrailEnd;
}

export function readActivityTrail(): ActivityTrail {
  const files: ActivityTrailFile[] = [];
  // The same root check every other cache reader makes: a symlinked root is not followed.
  if (!isRealDirectory(cacheRoot())) return { schemaVersion: ACTIVITY_TRAIL_SCHEMA_VERSION, files, end: { kind: "start" } };
  const liveContent = readBoundedRegularFile(activityLogPath(), MAX_ACTIVITY_FILE_BYTES);
  const live = liveContent === undefined ? undefined : parseActivityContent(liveContent);
  if (live !== undefined) files.push({ name: FILE_NAME, ...describeFile(liveContent ?? "", live), hash: "live" });
  let end: ActivityTrailEnd = { kind: "start" };
  let pending = live?.link;
  walkTrail(pending, (name, path) => {
    const link = pending as ActivityRotationLink;
    const content = readBoundedRegularFile(path, MAX_ACTIVITY_FILE_BYTES);
    const parsed = content === undefined ? undefined : parseActivityContent(content);
    files.push({ name, ...(parsed ? describeFile(content ?? "", parsed) : { entries: link.previousEntries ?? 0 }), hash: hashStatus(content, link) });
    if (parsed === undefined || parsed.unusable) return { unreadable: true };
    pending = parsed.link;
    return { link: pending };
  }, (e) => {
    end = e;
  });
  return { schemaVersion: ACTIVITY_TRAIL_SCHEMA_VERSION, files, end };
}

function describeFile(content: string, parsed: ActivityFile): { entries: number; firstAt?: string; lastAt?: string } {
  const entries = parsed.total ?? parsed.entries.length;
  const firstAt = firstEntryTimestamp(content);
  const lastAt = parsed.entries[parsed.entries.length - 1]?.timestamp;
  return { entries, ...(firstAt ? { firstAt } : {}), ...(lastAt ? { lastAt } : {}) };
}

/** Whether an archive's bytes still match the hash its successor's link recorded. An append
 *  that landed in the old file during rotation (B-24, no lock) leaves the recorded bytes intact
 *  as a prefix: that is reported as such, not as tampering. */
function hashStatus(content: string | undefined, link: ActivityRotationLink): string {
  if (link.previousSha256 === undefined) return "not recorded";
  if (content === undefined) return "not checked: unreadable or over the size limit";
  const bytes = Buffer.from(content, "utf8");
  if (sha256Hex(bytes) === link.previousSha256) return "ok";
  if (link.previousBytes !== undefined && bytes.length > link.previousBytes && sha256Hex(bytes.subarray(0, link.previousBytes)) === link.previousSha256) {
    const added = bytes.subarray(link.previousBytes).toString("utf8").split("\n").filter((l) => l.trim() !== "").length;
    return `entries added after rotation (${added} line${added === 1 ? "" : "s"})`;
  }
  return "changed since rotation (hash mismatch)";
}

/** Human table for `vibectx log --trail`. */
export function formatActivityTrailTable(trail: ActivityTrail): string {
  const header = ["file", "entries", "first", "last", "hash"];
  const rows = trail.files.map((f) => [f.name, String(f.entries), f.firstAt ?? "—", f.lastAt ?? "—", f.hash].map(cleanText));
  const widths = header.map((h, i) => rows.reduce((max, r) => Math.max(max, r[i]!.length), h.length));
  const render = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join("  ");
  const end = trailEndNote(trail.end) ?? "start of history";
  return [render(header), ...rows.map(render), "", end].join("\n");
}

/** PAR-800 — the one clip every PADDED column shares. Originally added for `timestamp` alone
 *  (the one field `toActivityEntry` accepts by SHAPE rather than an explicit length bound), but
 *  this function's own doc comment claims the table "must hold for any `ActivityEntry` it is
 *  handed" — true only for `timestamp` before this. `tool`/`outcome` are closed-vocabulary
 *  strings and `library` is bounded by `toActivityEntry`'s own `MAX_LIBRARY_CHARS` on any entry
 *  that actually came back through validation, but this function does not get to assume that:
 *  a hand-built `ActivityEntry` (a test, a future caller) could hand it anything. `detail` (the
 *  last column) is deliberately EXCLUDED — it is never padded (see `render` below), so a long
 *  value there cannot widen any other row's cell the way an unclipped PADDED cell could. */
const MAX_TABLE_CELL_CHARS = 40;

/** Human-readable table for `vibectx log` (no `--json`) — the same shape every other
 *  subcommand's table takes: a header, one row per entry, a summary line. `detail` is the
 *  query when there is one, else the url, else nothing — the single most informative field
 *  this entry carries, since showing both would not fit a terminal width. Every cell passes
 *  through `cleanText` (S3): this file is a trust boundary like any other in the cache
 *  directory, and `toActivityEntry` already cleaned each field on read, but the table is the
 *  render boundary and must hold for any `ActivityEntry` it is handed, not only one that
 *  came back through validation. (code-reviewer S7, review round 2: this comment and
 *  `MAX_TABLE_CELL_CHARS`'s own, directly above, had been swapped — reordered so each sits
 *  directly above what it describes.) */
export function formatActivityLogTable(entries: ActivityEntry[]): string {
  const header = ["timestamp", "tool", "library", "outcome", "detail"];
  // PAR-804 — a thin match renders as "matched (thin)" in the one place a human actually reads
  // this log, not just as a `thin: true` sibling key a `--json` reader has to know to look for.
  const outcomeCell = (e: ActivityEntry) => (e.thin ? `${e.outcome} (thin)` : e.outcome);
  const rows = entries.map((e) =>
    [clipText(e.timestamp, MAX_TABLE_CELL_CHARS), clipText(e.tool, MAX_TABLE_CELL_CHARS), clipText(e.library ?? "—", MAX_TABLE_CELL_CHARS), clipText(outcomeCell(e), MAX_TABLE_CELL_CHARS), e.query ?? e.url ?? "—"].map(
      cleanText,
    ),
  );
  // PAR-790 — `Math.max(...rows.map(...))` throws `RangeError: Maximum call stack size
  // exceeded` once the spread argument list is large enough (tens of thousands of rows, which
  // `readActivityEntries` could hand this before PAR-790's own read-side entry cap existed) —
  // V8 bounds how many arguments one call may pass, and `Math.max(...arr)` passes `arr.length`
  // of them. A loop/reduce has no such ceiling regardless of row count.
  const widths = header.map((h, i) => rows.reduce((max, r) => Math.max(max, r[i]!.length), h.length));
  const render = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join("  ");
  return [render(header), ...rows.map(render), "", `${entries.length} entr${entries.length === 1 ? "y" : "ies"}`].join("\n");
}
