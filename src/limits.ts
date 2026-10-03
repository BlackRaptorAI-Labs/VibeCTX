/**
 * Resolver bounds (PAR-655), in one place so the store, the resolver and the tests
 * agree. See src/resolve.ts for how each is spent.
 */

/** Registry metadata documents fetched per resolution: npm, then PyPI. */
export const MAX_METADATA_FETCHES = 2;
/** llms-full.txt / llms.txt probes per ecosystem: 2 bases (docs URL, homepage) × 4 URLs. */
export const MAX_LLMS_CANDIDATES = 8;
/** README filename variants tried at GitHub's `HEAD` ref (the default branch, whatever
 *  its name — MEASURED 2026-09-06 on raw.githubusercontent.com). raw is case-sensitive:
 *  express ships `Readme.md`, resend `readme.md`, django `README.rst`. */
export const README_VARIANTS = ["README.md", "readme.md", "Readme.md", "README.rst"] as const;
export const MAX_README_CANDIDATES = README_VARIANTS.length;
/** A11/PAR-724 — tag-name spellings tried at GitHub's `refs/tags/<tag>` ref when a
 *  version is pinned: `v<version>` (the overwhelmingly common convention) and bare
 *  `<version>`. Not a general "usual variants" enumerator — two is what covers the
 *  ordinary case without multiplying the fetch budget further; anything else (a
 *  `<name>@<version>` monorepo tag, say) falls through to the unversioned chain below,
 *  same as an unreachable README always has. */
export const MAX_VERSION_TAG_VARIANTS = 2;
/** README filename variants × tag variants, at GitHub's `refs/tags/<tag>` ref, tried
 *  before the unversioned chain when a version is pinned (A11/PAR-724). */
export const MAX_VERSIONED_README_CANDIDATES = MAX_VERSION_TAG_VARIANTS * README_VARIANTS.length;
/** One extra registry metadata fetch, for the chosen ecosystem only, at the exact pinned
 *  version — separate from MAX_METADATA_FETCHES (which is spent on the unversioned `/latest`
 *  lookup every resolution needs regardless) because it fires only when a version is given
 *  (A11/PAR-724). Narrower purpose than the `/latest` fetch: confirm the version is
 *  registered and read its (possibly different) repository field, not synthesize documents
 *  from it directly. */
export const MAX_VERSION_METADATA_FETCHES = 1;
/** Candidate URLs one resolved entry may carry (= one ecosystem's full probe list, version
 *  candidates included). */
export const MAX_URLS_PER_ENTRY = MAX_LLMS_CANDIDATES + MAX_README_CANDIDATES + MAX_VERSIONED_README_CANDIDATES;
/** Hard ceiling on requests one resolution may issue: both metadata documents, the one
 *  version-specific metadata fetch when a version is pinned, then the preferred ecosystem's
 *  candidates and — if none served — the other's (R2). */
export const MAX_FETCHES_PER_RESOLUTION =
  MAX_METADATA_FETCHES + MAX_VERSION_METADATA_FETCHES + MAX_METADATA_FETCHES * MAX_URLS_PER_ENTRY;
/** Resolutions (name validated, metadata about to be fetched) one process may start per hour. */
export const MAX_RESOLUTIONS_PER_HOUR = 100;

/** PAR-1048 (F32) — resolutions the BACKGROUND autowarm may start per hour per process, under
 *  `allowed` consent, for project dependencies no library matches. Smaller than, and counted
 *  inside, `MAX_RESOLUTIONS_PER_HOUR`: the background can take at most this many of the shared
 *  slots (it reserves none for the person; audit F-A1048-1). ASSUMED: a fifth of the shared
 *  limit. */
export const MAX_BACKGROUND_RESOLUTIONS_PER_HOUR = 20;

/**
 * Full (no-argument) `refresh` calls one process may start per hour (A3, PAR-716). A no-name
 * `refresh` is model-callable and iterates the whole registry — up to thirty upstream fetches
 * per call, against thirty different documentation sites — with no limit before this. ASSUMED,
 * the same way MAX_RESOLUTIONS_PER_HOUR is: not derived from a cost measurement, a judgement
 * about acceptable retry-loop egress. Set an order of magnitude below the resolver's cap
 * because one call here already costs on the order of MAX_RESOLUTIONS_PER_HOUR/3 site-hits by
 * itself, not one. Single-library `refresh` is uncapped — the concern is bulk egress from the
 * no-argument form, not routine per-library use. */
export const MAX_FULL_REFRESHES_PER_HOUR = 5;

/**
 * `activity.json`'s read window (D-51, A20, PAR-729): `vibectx log` shows at most this many
 * newest entries (PAR-1039: following the rotation trail across archives; the files themselves
 * are bounded by `ACTIVITY_LOG_ROTATE_ENTRIES` and retention) — see `activity-log.ts`'s own top comment for why this single count also bounds
 * the file's bytes. ASSUMED, the same way `DEFAULT_CACHE_MAX_MB` is: not derived from a
 * measurement of how much history is useful, a judgement about what a local, single-user
 * activity record should cost on disk. MEASURED (`activity-log.ts`): 2,000 entries at every
 * field's worst-case length is ~2.06 MiB, pretty-printed exactly as the file is written.
 */
export const ACTIVITY_LOG_MAX_ENTRIES = 2000;

/** PAR-790 — `activity.json`'s size ceiling, checked with `lstatSync` before the file is ever
 *  read, the same pattern every other cache-directory reader already applies to its own file:
 *  `cache-meta.ts`'s `readMetaFile` (`MAX_META_FILE_BYTES`), `search-index.ts`'s `readIndex`
 *  (`MAX_INDEX_FILE_BYTES`), `config.ts`'s `readConfigFile` (`MAX_CONFIG_BYTES`).
 *  `readActivityEntries` was the one reader of a cache-directory store with no such bound —
 *  a bare `readFileSync` + `JSON.parse` with nothing checked first. ASSUMED (docs/decisions.md), sized
 *  the same way `MAX_INDEX_FILE_BYTES` is: generous headroom over the file's own OWN entry-count
 *  cap (`ACTIVITY_LOG_MAX_ENTRIES` × ~1,032 bytes/entry worst case, per `activity-log.ts`'s own
 *  comment, is ~2.06 MiB) — this is the size a PLANTED file must exceed to be refused, not the
 *  size a legitimately-written one could ever reach. */
export const MAX_ACTIVITY_FILE_BYTES = 8 * 1024 * 1024;

/** PAR-1039 (Tom, 2026-09-24; amends B-24) — the live `activity.json` is renamed to a
 *  sequence-named archive (`activity-000012.json`) once it holds this many entries, and a new
 *  live file starts with a link record to that archive. At the ~1,032-byte worst-case entry
 *  (`activity-log.ts`'s own top comment) this is ~4.1 MiB, under `MAX_ACTIVITY_FILE_BYTES`, so
 *  a file this tool wrote never reaches that limit. */
export const ACTIVITY_LOG_ROTATE_ENTRIES = 4000;

/** PAR-1039 — how many archives rotation keeps by default: with a full live file, up to 24,000
 *  entries (5 × 4,000 + 4,000). `VIBECTX_LOG_ARCHIVES` or the user-config key `logArchives` changes it; 0 keeps none. */
export const DEFAULT_ACTIVITY_LOG_ARCHIVES = 5;

/**
 * `doctor.json`'s verdict cap (A19/PAR-728, security-architect S-3b): oldest (by `checkedAt`)
 * dropped first once a write would exceed it, the same "oldest dropped first" rule
 * `ACTIVITY_LOG_MAX_ENTRIES` applies to its own file. ASSUMED: a generous multiple of any
 * registry this tool ships or is likely to accumulate across projects sharing one cache root
 * (the shipped default registry alone is 30 entries), not a measurement of how many verdicts
 * are useful. MEASURED (`doctor-store.ts`): 500 verdicts at every field's worst-case length
 * (a 300-character name, 10 reasons at 300 characters each) is ~1.71 MiB, pretty-printed
 * exactly as the file is written — the same order of magnitude as `ACTIVITY_LOG_MAX_ENTRIES`'s
 * own ~2.06 MiB bound.
 */
export const MAX_DOCTOR_VERDICTS = 500;

/** PAR-1033: shared topic bound, also applied to configured doctor probes before retrieval. */
export const MAX_TOPIC_CHARS = 200;

/** Shared input ceiling, including callers that bypass the tool schemas. */
export const MAX_TOKENS_BUDGET = 200_000;
export function validateTokenBudget(maxTokens: number | undefined): void {
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens <= 0 || maxTokens > MAX_TOKENS_BUDGET)) {
    throw new RangeError(`maxTokens must be a positive integer no greater than ${MAX_TOKENS_BUDGET}`);
  }
}
