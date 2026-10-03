import { lstatSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { MAX_REMOTE_URL_LENGTH, redactUrlForDisplay, sanitizeRemoteUrl } from "./link-policy.js";
import { MAX_NAME_LENGTH } from "./package-names.js";

/**
 * D-71 (PAR-749) — the ONE shared answer to "does this file belong to this key?". Every
 * `.meta.json` PARSE in the cache layer goes through `readMetaFile`/`toCacheMeta` here:
 * directly, from `cache.ts`'s `readCache`, `touchCache` and `dropFollowedPageCache`, and from
 * `cache-evict.ts`'s `resolveRecency` (in turn called by `enforceCacheSizeCap` — it has no
 * meta-parsing call of its own, since its DELETE decision deliberately does not need the
 * provenance proof `dropFollowedPageCache` does; see `enforceCacheSizeCap`'s own docstring).
 * `writeCache` participates by construction, not by calling into this module: it always writes
 * a meta whose `url` is the one just fetched, under the name `urlSlug`/`libDirName` derive from
 * that same URL. Extracted to its own module (rather than left in `cache.ts`, which
 * `cache-evict.ts` already has a reverse import relationship with via `noteCacheWrite`) so
 * neither file has to import the other for it.
 *
 * Two roots, one file:
 *   Root 1 — `urlSlug`/`libDirName` were lossy name folds used as storage keys with no
 *   collision check: two distinct URLs (or library names) differing only in a character the
 *   fold maps to `_` produced the SAME file name, and nothing on the read side compared a
 *   record's own identity against what was actually requested. Two independent fixes, both
 *   present: the folds now append a short hash of the FULL input (collision-RESISTANT, not a
 *   mathematical guarantee — see `urlSlug`'s own comment for what is and isn't load-bearing
 *   about that), and `readCache`/`touchCache` (`cache.ts`) additionally compare the meta's own
 *   `url` against the URL actually requested, which is what actually makes serving the wrong
 *   document impossible on the URL dimension regardless of hash collisions.
 *   Root 2 — `.meta.json` had four readers at four different trust levels (a strict
 *   per-field validator in `cache.ts`, a provenance round-trip in `dropFollowedPageCache`, a
 *   lax ad-hoc parse in `cache-evict.ts`'s recency read, and no check at all in
 *   `enforceCacheSizeCap`'s eviction decision). `toCacheMeta`/`readMetaFile` are now the one
 *   validator every reader calls, at the one trust level (including the `MAX_META_FILE_BYTES`
 *   size bound, enforced inside `readMetaFile` itself so every caller gets it for free).
 */

export interface CacheMeta {
  /**
   * PAR-806 (Phase 4) — REDACTED (query, fragment, userinfo stripped via the shared
   * `redactUrlForDisplay`) as of the write that produced `urlHash` below. Before this item this
   * field held the RAW candidate URL — a config-authored `?token=…` reached this file in
   * plaintext, a disk surface no rendered redaction ever touched. `urlHash` is what actually
   * carries the identity/collision-resistance guarantee now (see its own comment); this field
   * is the human-legible remainder, same spirit as `urlSlug`'s own folded prefix.
   *
   * BACKWARD COMPATIBILITY: a `.meta.json` written before this item has no `urlHash` at all —
   * `urlHash` is `undefined` on the `CacheMeta` this function returns for one, and this field
   * is then the RAW url exactly as it always was (old files are never rewritten in place).
   * `metaMatchesUrl`/`metaMatchesSlug` (below) both branch on whether `urlHash` is present,
   * which is what makes reading an old-format file still work correctly without special-casing
   * every caller.
   */
  url: string;
  /**
   * PAR-806 (Phase 4), WIDENED (security-architect, Phase 4 round 2, B1) — `urlHashFor`'s FULL,
   * untruncated 64-character SHA-256 digest of the RAW candidate url (query included), the exact
   * identity proof `readCache`/`touchCache`'s own `meta.url !== url` check used to get for free
   * from `url` itself before that field was redacted.
   *
   * DELIBERATELY NOT `urlSlug`'s own 12-character filename suffix, even though both derive from
   * the same input: a first version of this field reused that exact 12-character/48-bit value,
   * which meant the filename's own cheap, offline-forceable hash collision (~2^48 SHA-256
   * evaluations) would ALSO satisfy this identity check — the wrong-document-served regression
   * `urlHashFor`'s own comment records in full. A full 256-bit digest makes that infeasible,
   * restoring the same strength the pre-PAR-806 raw-string comparison had. `metaMatchesSlug`
   * still reconstructs the on-disk filename's slug from `url` (the prefix) and the FIRST 12
   * CHARACTERS of this field (which equal `urlSlug`'s own suffix by construction — `shortHash`
   * and `urlHashFor` share the same SHA-256 prefix) — see that function's own comment.
   *
   * Written by `writeCache` on every new write; absent on a `.meta.json` from before this item
   * (see `url`'s own comment for exactly how the two fields' absence/presence interact).
   */
  urlHash?: string;
  fetchedAt: string; // ISO
  /** SHA-256 of UTF-8 content on new writes. Older entries remain readable without it. */
  contentHash?: string;
  /** Stored size and source classification let metadata-only listings avoid body reads. */
  contentBytes?: number;
  sourceKind?: "full-text" | "index-only" | "readme";
  etag?: string;
  /** PAR-776 (D-74) — the URL the content actually came from, when a redirect moved it away
   *  from `url` (the candidate URL this entry is keyed and requested by). Absent when there
   *  was no redirect, or when the writer never observed one (a cache-only path with nothing to
   *  report). `url` above stays the CANDIDATE throughout — the lookup key `readCache`/
   *  `touchCache` verify against and the identity `search-index.ts` correlates against — never
   *  overloaded to mean "wherever this ended up"; this field exists precisely so callers that
   *  need to resolve relative links or apply the host policy against the document's real
   *  origin (`get-docs.ts`) have a persisted answer on a CACHE HIT, not only on the live fetch
   *  that first observed it. UNLIKE `url`, this DOES gate something on read: `get-docs.ts` uses
   *  it as the same-origin base for `isAllowedLink`'s host-policy check (`link-policy.ts`'s
   *  same-origin rule grants a document's own host unconditionally), so a `.meta.json` this
   *  process cannot trust must never hand a caller an attacker-chosen host to trust as that
   *  origin — see `toCacheMeta`'s validation below (code-reviewer, PAR-776 round 1, B1: a value
   *  merely shaped like a URL is not enough here, unlike `url` itself, which is never used this
   *  way). A stale or missing `finalUrl` still costs a caller only its redirect-aware behaviour,
   *  never a wrong document served — that guarantee is unchanged. */
  finalUrl?: string;
  /**
   * PAR-787 — the library-NAME dimension's own second, independent check, mirroring D-71's
   * URL-dimension design exactly: `urlSlug`/`libDirName` are collision-RESISTANT folds used as
   * storage keys, and `metaMatchesUrl` (above) is what actually makes a forced URL-hash
   * collision harmless regardless — but before this field, `CacheMeta` recorded no library
   * identity at all, so a forced `libDirName` collision (two library names whose folds hash to
   * the same directory) had nothing to fall back on the way a URL collision does. Impact was
   * always availability-only (a colliding write clobbers the OTHER library's directory; the
   * existing `metaMatchesUrl` check on the URL dimension already means a content file is never
   * served under the wrong library's REQUEST — only that the collision itself is unrecoverable
   * once it happens), not a wrong-document-served defect — this closes the one asymmetry, it
   * does not respond to a live cross-library leak.
   *
   * Written by `writeCache` on every new write. BACKWARD COMPATIBILITY, the identical pattern
   * `urlHash` (above) established: absent on a `.meta.json` written before this item —
   * `metaMatchesLibrary` (below) treats an absent field as "nothing to check", falling back to
   * whatever check existed before (the URL dimension alone), never to a false mismatch.
   */
  library?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The same strict UTC-instant SHAPE `project-store.ts` and `search-index.ts` use for their
 *  own `warmedAt` / `fetchedAt` — `Date.parse` alone takes a string carrying a bidi override
 *  (e.g. U+202E), and this file's `fetchedAt` is rendered verbatim in the list_libraries
 *  footer and in every get_docs `STALE:` note.
 *
 *  The fractional-seconds group here is bounded to 9 digits (nanosecond precision — already
 *  past anything real `toISOString` produces), because `Number.isFinite(Date.parse(…))` is
 *  not a backstop against length — MEASURED, `Date.parse("2020-01-01T00:00:00." + "1".repeat(10_000) + "Z")`
 *  returns a finite timestamp. `project-store.ts` and `search-index.ts` carried an unbounded
 *  `(\.\d+)?` copy until PAR-801 (Phase 7 audit). Every persisted store now imports this one
 *  declaration, so a future shape change has one owner rather than four copies that can drift.
 *
 *  Exported (A19/PAR-728, security-architect S-3a) so `doctor-store.ts`'s `checkedAt` — a new
 *  use site, not one of the two pre-existing unbounded ones above — reuses this shared shape
 *  (D-48: one definition, not a local variant per module) rather than adding a third copy of
 *  the same unbounded-length gap this comment already tracks. */
export const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

/** L-33: the one persisted-instant check, imported by every store that reads an instant back.
 *  The bounded shape comes first because `Date.parse` is not a length backstop (it accepts an
 *  arbitrarily long fractional-seconds run); `Date.parse` then rejects a well-shaped
 *  impossibility such as `2026-13-45T06:00:00Z`. */
export function validIsoInstant(value: unknown): value is string {
  return typeof value === "string" && ISO_INSTANT.test(value) && Number.isFinite(Date.parse(value));
}

/** Longest `url` this file will hold — generous, not load-bearing (see `validMetaUrl`).
 *  code-reviewer S4 (Phase 4 round 2) — was an independent, undocumented duplicate of
 *  `link-policy.ts`'s own `MAX_REMOTE_URL_LENGTH` (the same PAR-809 class this file's `urlHash`
 *  shape constant is unrelated to); now imported so the two values cannot silently drift apart,
 *  the same fix PAR-809 already applied to `activity-log.ts`. */
const MAX_META_URL = MAX_REMOTE_URL_LENGTH;
/** Longest `etag` — an HTTP validator token, not free text; well past anything real. */
const MAX_META_ETAG = 512;
/** Round 2 (security-architect, R3) — longest `.meta.json` file this cache will read before
 *  parsing it. A real one is a URL, an ISO instant, an optional etag and (PAR-776) an optional
 *  SECOND url (`finalUrl`); this is generous headroom over `MAX_META_URL` × 2 + `MAX_META_ETAG`
 *  plus JSON overhead, not a measured figure — bumped from the original 4096 when `finalUrl`
 *  was added, since two 2048-character URL fields plus a 512-character etag no longer fit
 *  inside the old bound even before JSON overhead (round 1 self-review, before this shipped:
 *  4096 was sized for exactly one `MAX_META_URL`, and adding a second field without revisiting
 *  it would have made every real redirected entry with a long candidate AND a long final URL
 *  silently unreadable — the same class of self-inflicted bound this file exists to avoid).
 *  Enforced inside `readMetaFile` itself (D-71 round 2, code-reviewer/security-architect B1/S1)
 *  rather than left to each caller to apply separately — every `.meta.json` reader in the
 *  cache layer gets the bound this way, not just the one (`dropFollowedPageCache`) that used
 *  to apply it by hand against a `Stats` it happened to already have. */
export const MAX_META_FILE_BYTES = 8192;
/** Deliberately a STRICT SUBSET of RFC 9110 §5.5's field-value grammar (`field-vchar = VCHAR
 *  / obs-text`, `obs-text = %x80-FF`, leading/trailing whitespace excluded) — printable ASCII
 *  only, no HTAB, no high-byte `obs-text`, no leading or trailing space (security-architect,
 *  A4 round 2: confirmed against the RFC text). Neither exclusion is exploitable — a
 *  nonconforming server's etag is dropped, costing one extra full refetch, never a wrong
 *  answer — and every etag actually seen in this codebase (`test/fetcher.test.ts:391-422`:
 *  `"abc123"`, `"v1"`, `"v2"`) is well inside it.
 *
 *  A hostile `etag` outside this set makes `fetch` throw at header construction the moment it
 *  is next sent as `If-None-Match` (`fetcher.ts:131`) — `fetchUrl`'s try/catch turns that into
 *  a `miss`, but the SAME corrupt etag is re-read from this file on every following attempt
 *  (including `vibectx refresh`'s `forceRefresh`, which still reads the cached etag first), so
 *  tolerating the throw is not tolerating its consequence: the entry pins stale forever and is
 *  misreported as "all candidate URLs unreachable" — MEASURED against a real local server
 *  (code-reviewer, A4 round 2, S1). Validating the shape here, once, is cheaper than that
 *  failure mode. `+` rather than `*`: an etag is either absent or a real token, never present
 *  as an empty string, so the length check below has no empty-string case left to catch. */
const ETAG_SHAPE = /^[\x21-\x7e]+$/;

/** PAR-806 (Phase 4), WIDENED (security-architect B1, round 2 — a real, confirmed regression in
 *  the original 12-char version, not a style nit): exactly `urlHashFor`'s own output shape —
 *  the FULL 64 lowercase hex characters of a SHA-256 digest, deliberately NOT `shortHash`'s
 *  12-character truncation. See `urlHashFor`'s own comment for why the identity proof and the
 *  filename's collision-resistance suffix must never again be the same truncated value. */
const URL_HASH_SHAPE = /^[0-9a-f]{64}$/;

function validMetaUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_META_URL) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** Shared by `toCacheMeta` (read) and `writeCache` (write) — one rule, checked on both sides
 *  of the file, so `toCacheMeta`'s claim that it "only asks whether the file is what
 *  `writeCache` would have produced" is actually true rather than aspirational (write-side
 *  asymmetry, security-architect, A4 round 2). Before this, `writeCache` stored whatever
 *  `res.headers.get("etag")` returned verbatim: never the newline case (an HTTP response
 *  header value cannot itself carry one), but a nonconforming server's high-byte `obs-text` or
 *  an oversized value would still have reached disk, bloated the size cap, and been silently
 *  dropped again on the very next read. */
export function validEtag(value: string | undefined): value is string {
  return value !== undefined && value.length <= MAX_META_ETAG && ETAG_SHAPE.test(value);
}

/**
 * Validate one persisted `.meta.json` (A4, PAR-717; shared beyond `cache.ts` since D-71,
 * PAR-749) — every other store re-validates every field on read because the cache directory
 * is a trust boundary (`resolved-store.ts`, `project-store.ts`, `search-index.ts`); this was
 * the one that did not. ANY failure drops the whole record, so a reader reports the entry
 * uncached exactly as a missing file would, rather than trusting a meta this process cannot
 * verify:
 *
 *   url        a parseable URL string, ≤ 2048 characters. Not held to the fetch-time host
 *              policy (`sanitizeRemoteUrl`'s forbidden-host check) — an entry cached under
 *              `allowInternalHosts: true` (D-47) legitimately has an internal-host URL here,
 *              and that trust decision was already made when the document was written; this
 *              function only asks whether the file is what `writeCache` would have produced.
 *   urlHash    (PAR-806, Phase 4) exactly 64 lowercase hex characters — a FULL SHA-256 digest
 *              (`URL_HASH_SHAPE`), deliberately NOT the 12-character truncation `urlSlug`'s own
 *              filename suffix uses — see `urlHashFor`'s own comment for why conflating the two
 *              was a real, fixed regression, not a style choice. Dropped ALONE, not the whole
 *              record, when malformed: an invalid `urlHash` degrades `metaMatchesUrl`/
 *              `metaMatchesSlug` to their old-format fallback (comparing `url` directly), never
 *              to a false positive — see those functions' own comments. Absent entirely on a
 *              `.meta.json` from before this item.
 *   fetchedAt  a strict ISO-8601 UTC instant — the one field this file renders verbatim
 *   etag       ≤ 512 characters and HTTP field-value characters only (see `ETAG_SHAPE`) when
 *              present. Dropped alone, not the whole record: it is a revalidation hint (sent
 *              back as `If-None-Match`), not part of the entry's identity — but a shape check
 *              is not optional here (see `ETAG_SHAPE`'s comment for the stale-forever failure
 *              mode a merely-length-bounded etag still allows).
 *   finalUrl   (PAR-776) STRICTER than `url` above, deliberately: `sanitizeRemoteUrl`
 *              (`link-policy.ts`) — https only, no userinfo, ≤ 2048 characters, and the host
 *              must clear `isForbiddenHost` — rather than the merely-parseable `validMetaUrl`
 *              bound `url` gets. Not a stricter check for its own sake: `get-docs.ts` uses
 *              `finalUrl` as the same-origin base for `isAllowedLink`'s host-policy check, which
 *              grants a document's own host unconditionally (`link-policy.ts`), so accepting a
 *              value merely shaped like a URL here would let a hand-edited or corrupted
 *              `.meta.json` hand a caller an attacker-chosen "trusted" origin — a live fetch's
 *              redirect can never legitimately produce a `finalUrl` this check would reject
 *              (`fetcher.ts`'s `hopAllowed` enforces exactly this same rule, unconditionally, on
 *              every redirect hop and the final URL, even for an `allowInternalHosts` candidate —
 *              see D-74 in `docs/decisions.md`). Dropped alone, not the whole record,
 *              for the same reason `etag` is: it is provenance about where the fetch landed, not
 *              part of this entry's identity (`url`, the CANDIDATE, is what `readCache`/
 *              `touchCache` verify against) — a missing or rejected `finalUrl` costs a caller
 *              its redirect-aware relative-link/host-policy behaviour for this one read, never a
 *              wrong document served (code-reviewer, PAR-776 round 1, B1).
 */
export function toCacheMeta(raw: unknown): CacheMeta | undefined {
  if (!isRecord(raw)) return undefined;
  if (!validMetaUrl(raw.url)) return undefined;
  if (!validIsoInstant(raw.fetchedAt)) {
    return undefined;
  }
  const meta: CacheMeta = { url: raw.url, fetchedAt: raw.fetchedAt };
  if (raw.contentHash !== undefined) {
    if (typeof raw.contentHash !== "string" || !URL_HASH_SHAPE.test(raw.contentHash)) return undefined;
    meta.contentHash = raw.contentHash;
  }
  if (raw.contentBytes !== undefined) {
    if (typeof raw.contentBytes !== "number" || !Number.isSafeInteger(raw.contentBytes) || raw.contentBytes < 0) return undefined;
    meta.contentBytes = raw.contentBytes;
  }
  if (raw.sourceKind !== undefined) {
    if (raw.sourceKind !== "full-text" && raw.sourceKind !== "index-only" && raw.sourceKind !== "readme") return undefined;
    meta.sourceKind = raw.sourceKind;
  }
  if (typeof raw.urlHash === "string" && URL_HASH_SHAPE.test(raw.urlHash)) meta.urlHash = raw.urlHash;
  if (typeof raw.etag === "string" && validEtag(raw.etag)) meta.etag = raw.etag;
  // code-reviewer B1 / security-architect S2 (Phase 4 round 2) — redacted on READ too, not only
  // on write: a `.meta.json` written by a pre-fix version of this branch (or an older vibectx)
  // may still hold a raw, unredacted `finalUrl` on disk; this is what stops that raw value from
  // ever being read back into `CacheMeta.finalUrl` — and, from there, into `DocResult.finalUrl`
  // and every rendered/structured surface that reads it — even before the file is next rewritten.
  if (typeof raw.finalUrl === "string") {
    const clean = sanitizeRemoteUrl(raw.finalUrl);
    if (clean !== undefined) meta.finalUrl = redactUrlForDisplay(clean);
  }
  // PAR-787 — dropped ALONE, not the whole record, same rule as `etag`/`finalUrl`: this is an
  // identity CHECK, not part of what `url` already fully identifies, so a malformed value costs
  // this one field's check (degrading to the URL-only comparison `metaMatchesLibrary` already
  // falls back to for an absent field), never the whole cached entry.
  if (typeof raw.library === "string" && raw.library.length > 0 && raw.library.length <= MAX_NAME_LENGTH) {
    meta.library = raw.library;
  }
  return meta;
}

/** Parse and validate one `.meta.json`; `undefined` for anything unreadable, truncated,
 *  invalid JSON, wrong-shaped, or carrying a hostile `fetchedAt` (A4's four corruption
 *  classes) — never throws. The one function every `.meta.json` reader in `cache.ts` and
 *  `cache-evict.ts` calls (D-71) — there is no longer a second, laxer parse anywhere.
 *
 *  Bounded at `MAX_META_FILE_BYTES` (code-reviewer, D-71 round 1) — the size check used to be
 *  paid only by `dropFollowedPageCache`, which reused an `lstat` it already needed; every
 *  OTHER reader (`readCache`, `touchCache`, and `cache-evict.ts`'s `resolveRecency`) went
 *  through this same function with no bound at all, so a planted multi-megabyte `.meta.json`
 *  was fully read and `JSON.parse`d by all three before this. `lstatSync`, not `statSync` or
 *  `existsSync`, for the same reason every other check in this cache does: the question is
 *  what the directory ENTRY is, never what a symlink at that name points at. */
export function readMetaFile(metaPath: string): CacheMeta | undefined {
  let parsed: unknown;
  try {
    const stat = lstatSync(metaPath);
    if (!stat.isFile() || stat.size > MAX_META_FILE_BYTES) return undefined;
    parsed = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch {
    return undefined;
  }
  return toCacheMeta(parsed);
}

/** The full, untruncated SHA-256 digest (64 lowercase hex characters) — the one primitive
 *  `shortHash` (below, for filenames) and `urlHashFor` (for the identity proof, PAR-806) both
 *  build on, so the two can never accidentally diverge on WHICH hash function they mean. */
function fullHash(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function contentHashFor(content: string): string { return fullHash(content); }

// Immutable library/URL inputs recur on every cache read. Reuse only their exact digests;
// body bytes always go through contentHashFor after the descriptor-pinned read. The count
// and input-length bounds prevent arbitrary direct callers from retaining unbounded keys.
const keyDigests = new Map<string, string>();
function keyHash(input: string): string {
  if (input.length > MAX_REMOTE_URL_LENGTH) return fullHash(input);
  const known = keyDigests.get(input);
  if (known !== undefined) return known;
  const digest = fullHash(input);
  if (keyDigests.size >= 128) keyDigests.delete(keyDigests.keys().next().value!);
  keyDigests.set(input, digest);
  return digest;
}

/** Short, deterministic fingerprint of the raw input for FILENAME use ONLY — 12 hex characters,
 *  48 bits of a SHA-256 digest. NOT a mathematical injectivity guarantee (security-architect,
 *  D-71 round 2, S2) — a 48-bit digest can theoretically collide, and a DELIBERATE
 *  second-preimage against a specific input is within reach of an attacker who controls the
 *  input (feasible on commodity hardware, though not cheap: single-GPU hours at 2^48). What it
 *  buys is COLLISION RESISTANCE for the ordinary case this cache actually faces: at the scale of
 *  a single user's local cache (thousands, not billions, of entries) an ACCIDENTAL collision
 *  between two unrelated inputs is astronomically unlikely (~10⁻⁷ at 10,000 entries, by the
 *  birthday bound).
 *
 *  security-architect, Phase 4 round 2, B1 — THIS TRUNCATED VALUE MUST NEVER ALSO BE THE
 *  IDENTITY PROOF a correctness check relies on to detect a WRONG document (see `urlHashFor`'s
 *  own comment for the regression that shipped, briefly, when it was): a 48-bit second-preimage
 *  is exactly the "not cheap, but feasible" budget a real attacker can spend once, offline, with
 *  no interaction with this process at all. It remains fine for the FILENAME, where the
 *  independent, full-strength `urlHashFor` identity check is what actually stands between a
 *  forced filename collision and the wrong content being served — see `urlSlug`'s own comment. */
function shortHash(input: string): string {
  return keyHash(input).slice(0, 12);
}

/** The two halves of a URL storage slug, assembled identically whether they come from a fresh
 *  `url` (`urlSlug`) or a persisted `CacheMeta` (`metaMatchesSlug`) — one construction, so the
 *  two can never drift into producing different strings for what should be the same slug. */
function slugFrom(foldSource: string, hash: string): string {
  return `${foldSource.replace(/[^a-z0-9]/gi, "_").slice(0, 120)}_${hash}`;
}

/**
 * D-71 (PAR-749, Root 1) — a cache storage key derived from a URL. Before this, every
 * non-alphanumeric character folded to `_` with NO collision check at all, so `https://x.dev/a-b`
 * and `https://x.dev/a_b` produced the identical slug `https___x_dev_a_b` deterministically,
 * every time. Appending `shortHash`'s digest of the FULL, untruncated input makes an
 * ACCIDENTAL collision between two unrelated URLs collision-resistant rather than certain for
 * any pair sharing a fold (including two URLs sharing a 120-character common prefix before the
 * fold, the truncation-collision case the fold-only version also had) — see `shortHash`'s own
 * comment for exactly what that resistance does and does not guarantee.
 *
 * The load-bearing guarantee on THIS dimension is not the hash alone: `readCache` and
 * `touchCache` (`cache.ts`) additionally compare the meta's own identity against the URL
 * actually requested (`metaMatchesUrl`, below), and treat a mismatch as a miss. Even in the
 * near-impossible event of a forced FILENAME collision, the result is a cache miss and a
 * re-fetch — never the wrong document served under the wrong identity.
 *
 * security-architect, Phase 4 round 2, B1 — THIS SENTENCE IS ONLY TRUE BECAUSE THE IDENTITY
 * CHECK IS INDEPENDENT OF THE FILENAME'S HASH, and for one round of this phase it briefly was
 * not: `CacheMeta.urlHash` (below) was originally the SAME 12-character, 48-bit `shortHash` this
 * slug's own suffix uses, which made the "near-impossible event" above a genuinely feasible
 * ~2^48 offline attack — grind a same-origin, attacker-reachable URL (e.g. a followed index
 * link, which `isAllowedLink` grants a document's own host unconditionally) until its 48-bit
 * hash collides with a real target document's, and both the filename AND the identity check
 * would then agree, wrongly. Fixed by making `urlHashFor` the FULL, untruncated 64-character
 * SHA-256 digest — a completely different value from this slug's own 12-character suffix, so a
 * forced collision on the filename's cheap 48-bit hash no longer also satisfies the identity
 * check's full-strength one. The 12-character suffix here stays exactly as before (unaffected
 * filenames, unaffected collision-resistance-for-directory-listings characterisation above); it
 * is simply no longer asked to double as a security-critical identity proof.
 *
 * PAR-806 (Phase 4) — the FOLDED PREFIX is now computed from the REDACTED url
 * (`redactUrlForDisplay`, query/fragment/userinfo stripped), not the raw one: this prefix
 * "carries none of the uniqueness guarantee" (unchanged claim, see above) and exists purely
 * for a human glancing at the cache directory — so this change costs nothing on correctness
 * and closes the actual leak (a token's alphanumerics no longer appear in the FILE NAME at
 * all). The HASH suffix is unchanged: still `shortHash` of the FULL, untruncated, RAW url,
 * because two candidate URLs differing only by query string (`?v=2` vs `?v=3`) are legitimately
 * DIFFERENT documents (D-71's own design) and must keep producing different slugs — redacting
 * the hash's input too would make them collide. Consequence, stated plainly (docs/decisions.md
 * carries the full migration account): this DOES change the computed FILENAME for any url whose
 * redacted form differs from its raw one — every query-string, fragment or userinfo-bearing url,
 * and, as a side effect of `redactUrlForDisplay`'s own documented normalization (PAR-818), a url
 * with a non-default-cased host, an explicit default port or a non-ASCII host. An existing cache
 * entry for such a url, written under the OLD formula, is not found by a NEW `readCache` call for
 * the same url (cold miss; the old file becomes an orphan) — see docs/decisions.md for why that is the
 * chosen, accepted upgrade behaviour rather than a rename pass.
 */
export function urlSlug(url: string): string {
  return slugFrom(redactUrlForDisplay(url), shortHash(url));
}

/** PAR-806 (Phase 4), WIDENED (security-architect, Phase 4 round 2, B1 — the single most
 *  important correction in this whole item): the identity proof written into
 *  `CacheMeta.urlHash` — the FULL, untruncated 64-character SHA-256 digest of the raw url, via
 *  `fullHash`, NOT `shortHash`'s 12-character filename truncation.
 *
 *  WHY THIS MUST BE A DIFFERENT VALUE FROM THE FILENAME'S HASH, stated plainly because getting
 *  this wrong once already shipped a real regression: before this correction, `urlHashFor`
 *  returned `shortHash(url)` — LITERALLY the same 48-bit value already embedded as `urlSlug`'s
 *  own hash suffix, adding no independent dimension at all. Before PAR-806 existed, `readCache`'s
 *  identity check was a full, untruncated STRING comparison (`meta.url !== url`) — independent
 *  of the filename mechanism entirely, so even a forced filename collision left the identity
 *  check free to catch the mismatch by comparing the two full raw strings. Collapsing the
 *  identity proof onto the SAME 48-bit filename hash silently deleted that independence: an
 *  attacker who can get content written into the same per-library directory as a target
 *  document (a same-origin followed index link is enough — `isAllowedLink` grants a document's
 *  own host unconditionally) can grind a query-string suffix until their URL's 48-bit hash
 *  equals the target's (~2^48 SHA-256 evaluations, single-GPU hours, entirely offline, no
 *  interaction with this process). Their write then lands under the exact same filename AND
 *  passes the identity check, and the next legitimate read serves their content as the real
 *  document — exactly the "wrong document served under the wrong identity" outcome D-71 exists
 *  to make near-impossible, reopened by this phase and closed again here.
 *
 *  A full 256-bit digest makes a targeted second-preimage attack computationally infeasible
 *  (not merely "not cheap" — outside any realistic attacker's reach), restoring the SAME
 *  strength the pre-PAR-806 raw string comparison had, just carried by a hash instead of the
 *  plaintext (the whole point of PAR-806 in the first place: identical security property, no
 *  secret on disk). Filenames are completely unaffected — the 12-character suffix `urlSlug`
 *  computes is still `shortHash`, unchanged, so no cache filename changes as a result of this
 *  fix. `MAX_META_FILE_BYTES` (8192) has ample headroom for the ~52 extra bytes this adds per
 *  entry — verified against its own sizing comment (already generous for two 2048-character URL
 *  fields plus a 512-character etag); not bumped, because it does not need to be. */
export function urlHashFor(url: string): string {
  return keyHash(url);
}

/**
 * D-71 (PAR-749, Root 1) — the library-directory half of the same fix. `libDirIn`'s fold
 * (`[^a-z0-9_-]` → `_`) let two distinct, independently valid npm names — `foo.bar` and
 * `foo_bar` — share one directory; refreshing one could delete the other's cached primary (see
 * `dropFollowedPageCache`'s history). Collision-resistant for the same reason `urlSlug` is
 * (see `shortHash`'s comment) — but UNLIKE the URL dimension, there is no second, independent
 * check on this one: a library name is not itself stored in `.meta.json`, so a forced
 * directory-name collision has no `readCache`-style equality check to fall back on. Accepted:
 * the attacker's input space here (a package/library name reaching a user's own dependency
 * list or `vibectx.config.json`) is far narrower than an arbitrary URL, and the worst case is
 * loss of re-fetchable cache (availability), never wrong content served as right. Capped at
 * 120 characters before the hash, matching `urlSlug`, so an unbounded library name (nothing
 * enforces a maximum length on one — security-architect, D-71 round 2, S4) cannot push the
 * directory name toward a filesystem `NAME_MAX`; the hash is still of the FULL, uncapped name,
 * so truncating the visible prefix costs nothing on the collision-resistance side.
 */
export function libDirName(library: string): string {
  return `${library.replace(/[^a-z0-9_-]/gi, "_").slice(0, 120)}_${shortHash(library)}`;
}

/**
 * D-71 (PAR-749, Root 1) — the read-side half: does this `.meta.json`'s OWN identity actually
 * map to the slug its file name carries? A mismatch means this file was not written for the URL
 * it claims to describe (or, before D-71, a genuine fold collision) — either way, not proof
 * this is the record being asked for.
 *
 * PAR-806 (Phase 4) — NEW-FORMAT meta (`meta.urlHash` present, written by this version's
 * `writeCache`): the slug is reconstructed directly from `meta.url` (already the REDACTED
 * prefix source) and the FIRST 12 CHARACTERS of `meta.urlHash` — `urlSlug`'s own filename
 * suffix is, and must stay, `shortHash` (the 12-char truncation), even though `meta.urlHash`
 * itself is now the full 64-character digest (security-architect, Phase 4 round 2, B1 — see
 * `urlHashFor`'s own comment for why the two are deliberately different lengths/values). No raw
 * url is ever needed here: `meta.urlHash`'s first 12 characters ARE `shortHash(rawUrl)` by
 * construction (`fullHash` and `shortHash` share the same prefix). OLD-FORMAT meta (no
 * `urlHash`: a file written before this item, where `url` is still the RAW candidate): falls
 * back to the original `urlSlug(meta.url) === slug` round trip, unchanged — this is what lets
 * an old-format file keep being recognised as its own slug's owner without needing to be
 * rewritten.
 *
 * `dropFollowedPageCache` uses this spelling of the rule because it has no request URL to
 * compare against — only a filename it is deciding whether to delete, and the URL a candidate
 * SHOULD have (via the slug it is named for) is all there is to check it against.
 * `readCache`/`touchCache` (`cache.ts`) use `metaMatchesUrl` (below) instead, because they DO
 * have the actual requested URL in hand.
 */
export function metaMatchesSlug(meta: CacheMeta, slug: string): boolean {
  if (meta.urlHash !== undefined) return slugFrom(meta.url, meta.urlHash.slice(0, 12)) === slug;
  return urlSlug(meta.url) === slug;
}

/**
 * D-71 (PAR-749, Root 1) — the read-side half `readCache`/`touchCache` (`cache.ts`) use: does
 * this `.meta.json`'s OWN identity match the URL actually being requested? A check independent
 * of the filename mechanism entirely — it does not depend on `urlSlug` (or `shortHash`) staying
 * collision-resistant to be correct, which is exactly what makes it the real defense against a
 * forced FILENAME collision serving the wrong document (see `urlHashFor`'s own comment).
 *
 * PAR-806 (Phase 4), WIDENED (security-architect, Phase 4 round 2, B1) — NEW-FORMAT meta:
 * compares `meta.urlHash` (the FULL 64-character digest) against `urlHashFor(url)` — a full,
 * 256-bit hash comparison, the identical full-fidelity comparison the old, pre-PAR-806 direct
 * `meta.url !== url` string check made, just carried by a hash instead of the plaintext, so a
 * query-string-only difference (`?v=2` vs `?v=3`) is still correctly detected as a mismatch AND
 * a targeted second-preimage against this specific 256-bit value is computationally infeasible
 * — deliberately NOT the same 12-character/48-bit value `urlSlug`'s own filename suffix uses,
 * which would let a cheap, offline, ~2^48 forced FILENAME collision also satisfy this identity
 * check (the regression this widening fixes; full account on `urlHashFor`). OLD-FORMAT meta (no
 * `urlHash`): falls back to the original direct `meta.url === url` comparison, unchanged —
 * `meta.url` on such a record is still the RAW candidate, exactly as it always was.
 */
export function metaMatchesUrl(meta: CacheMeta, url: string): boolean {
  if (meta.urlHash !== undefined) return meta.urlHash === urlHashFor(url);
  return meta.url === url;
}

/**
 * PAR-787 — the library-NAME dimension's own version of `metaMatchesUrl`, same design exactly:
 * does this `.meta.json`'s OWN recorded library identity match the library actually being
 * requested? NEW-FORMAT meta (`library` present, written by this version's `writeCache`):
 * a direct string comparison — `library` names are not secrets and carry no query string to
 * redact, so (unlike `url`) there is no reason to hash-and-compare instead of comparing
 * directly. OLD-FORMAT meta (no `library`, written before this item): returns `true`
 * unconditionally — "nothing to check", the same "fall back to whatever check existed before"
 * rule `metaMatchesUrl`'s own OLD-FORMAT branch follows, so an old cache is read exactly as it
 * always was, with the URL-dimension check alone standing as it always has.
 */
export function metaMatchesLibrary(meta: CacheMeta, library: string): boolean {
  if (meta.library === undefined) return true;
  return meta.library === library;
}
