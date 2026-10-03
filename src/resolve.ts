import { installResolvedEntry, resolveLibrary, type LibraryEntry, type Registry, type ResolvedMeta } from "./registry.js";
import {
  MAX_METADATA_FETCHES,
  MAX_LLMS_CANDIDATES,
  MAX_README_CANDIDATES,
  MAX_VERSION_TAG_VARIANTS,
  MAX_VERSIONED_README_CANDIDATES,
  MAX_VERSION_METADATA_FETCHES,
  MAX_FETCHES_PER_RESOLUTION,
  MAX_RESOLUTIONS_PER_HOUR,
  README_VARIANTS,
} from "./limits.js";

export {
  MAX_METADATA_FETCHES,
  MAX_LLMS_CANDIDATES,
  MAX_README_CANDIDATES,
  MAX_VERSION_TAG_VARIANTS,
  MAX_VERSIONED_README_CANDIDATES,
  MAX_VERSION_METADATA_FETCHES,
  README_VARIANTS,
  MAX_URLS_PER_ENTRY,
  MAX_FETCHES_PER_RESOLUTION,
  MAX_RESOLUTIONS_PER_HOUR,
} from "./limits.js";
import { fetchUrl, getLibraryDoc, isDocUnchanged, OPERATION_DEADLINE_MS } from "./fetcher.js";
import type { AddressLookup } from "./address-policy.js";
import { derivedAllowedHosts, MAX_REMOTE_URL_LENGTH, redactUrlForDisplay, sanitizeRemoteUrl } from "./link-policy.js";
import { npmNameError, normalisePyPiName, pypiNameError, versionShapeError, MAX_VERSION_LENGTH, MAX_NAME_LENGTH } from "./package-names.js";
import { cleanDescription, resolvedStorePath, saveResolvedEntry } from "./resolved-store.js";
import { cacheRoot } from "./cache.js";
import { indexCachedDocument, documentHash } from "./search-index.js";
import { classifySourceKind, type SourceKind } from "./source-kind.js";
import { recordActivity } from "./activity-log.js";
import { clipText } from "./text.js";
import { fenceEchoedIdentifier } from "./retrieval.js";
import { bugFailureOffer } from "./bug-report.js";
import { VERSION } from "./version.js";
import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { writeStderrWarning } from "./redact-paths.js";

/**
 * resolve_library (PAR-655): any npm / PyPI package name → a docs source, with no
 * registry curation. Transport-free; index.ts, cli.ts, get-docs.ts and refresh.ts
 * delegate here.
 *
 * Chain (stop at the first usable document):
 *   1. registry hit — handled by the callers via resolveLibrary; this module never
 *      overrides a real entry.
 *   2. package metadata: npm `registry.npmjs.org/<name>/latest` (the latest-version
 *      document: 3–20 KB against 1–6 MB for the full packument — MEASURED 2026-09-06),
 *      then PyPI `pypi.org/pypi/<name>/json`. npm first, with a docs-site preference
 *      (see resolvePackage); `ecosystem` overrides.
 *   3. candidate synthesis: `<origin+path>/llms-full.txt`, `<origin+path>/llms.txt`,
 *      `<origin>/llms-full.txt`, `<origin>/llms.txt` on the docs URL (if any), then
 *      on the homepage; deduplicated; at most MAX_LLMS_CANDIDATES.
 *   4. GitHub README: `raw.githubusercontent.com/<o>/<r>/HEAD/<README variant>` — HEAD is
 *      the default branch, so no main/master guess; see README_VARIANTS. With a pinned
 *      version (A11/PAR-724), `refs/tags/v<version>/<variant>` and `refs/tags/<version>/
 *      <variant>` are tried FIRST, ahead of step 3, for the preferred ecosystem only.
 *   5. nothing usable → one plain line saying what was tried and how to pin it in config.
 *
 * Fetch bound per name (src/limits.ts): MAX_METADATA_FETCHES (2) + one version metadata
 * fetch when a version is pinned (MAX_VERSION_METADATA_FETCHES, 1) + the preferred
 * ecosystem's candidates (≤ 8 versioned README + 8 llms + 4 README = 20 with a version, 12
 * without) + — only if none of those served — the other found ecosystem's (≤ 4, README-only
 * by construction: only the docs-site ecosystem is ever `order[0]`, so a second ecosystem in
 * `order` never has llms candidates): MAX_FETCHES_PER_RESOLUTION = 43 with a version, 26
 * without (R2). The version-tag candidates are never offered to a fallback ecosystem, so the
 * reachable maximum is 27 with a version pinned, 18 without. Candidates are probed by
 * getLibraryDoc, which stops at the first usable document and caches it under the entry
 * name, so get_docs serves it immediately afterwards. A process may start at most
 * MAX_RESOLUTIONS_PER_HOUR resolutions (L2).
 *
 * Everything a registry returns is attacker-influenced (anyone can publish a package):
 * URLs go through sanitizeRemoteUrl (https, no userinfo, no IP / localhost / private
 * hosts), repositories must be github.com and are only ever turned into
 * raw.githubusercontent.com URLs, descriptions are flattened and capped.
 */

export type Ecosystem = "npm" | "pypi";

/** Registry metadata documents above this are treated as "no metadata". PyPI's JSON
 *  lists every release; boto3's is 3.3 MB (MEASURED 2026-09-06). ASSUMED headroom. */
export const METADATA_MAX_BYTES = 8 * 1024 * 1024;

export interface GitHubRepo {
  owner: string;
  repo: string;
}

export interface PackageMetadata {
  source: Ecosystem;
  metadataUrl: string;
  /** Sanitized https URLs. A github.com "homepage" is reported as `repository` instead. */
  homepage?: string;
  docsUrl?: string;
  repository?: GitHubRepo;
  description?: string;
}

export interface ResolveOutcome {
  /** The name as given (trimmed); the entry itself is stored under the folded name
   *  (npm) or the PEP 503 normalised name (PyPI). */
  name: string;
  ok: boolean;
  source?: Ecosystem;
  metadataUrl?: string;
  homepage?: string;
  docsUrl?: string;
  repository?: GitHubRepo;
  /** Every candidate URL, in probe order (the entry's `urls`). */
  candidates: string[];
  /** The candidate that served a document. */
  chosen?: string;
  kind?: SourceKind;
  chars?: number;
  /** `documentHash` (search-index.ts) of the chosen document's content — what the activity
   *  log records instead of the text (A20/PAR-729, D-51). Set exactly when `chosen` is. */
  contentHash?: string;
  entry?: LibraryEntry;
  /** False when resolved.json could not be written — another schema version on disk (K2), or
   *  (A5, PAR-718) the write itself failing on a read-only `$HOME` or a full disk; `saveNote`
   *  says which. */
  saved?: boolean;
  saveNote?: string;
  /** What was attempted, one phrase per step; the failure message is built from it. */
  attempts: string[];
  /** True when the per-hour resolution cap refused this name before any fetch (L2) — so a
   *  caller running many names (`warm`) can tell "try later" from "not resolvable". */
  limited?: true;
  /** C6: a failed dependency, not merely a lookup that used the network. */
  operationalFailure?: "network" | "cache";
  /** A16/PAR-725 — true when every ecosystem this call actually queried (not one skipped for
   *  an invalid name or an `ecosystem` restriction) answered its metadata lookup with a genuine
   *  HTTP 404: the name does not exist in npm or PyPI, distinct from "exists, but nothing
   *  usable was found" (see `couldNotResolveMessage`'s two distinct wordings). Undefined —
   *  never `false` — whenever existence could not be established either way (a network error,
   *  a name-validation skip, or a real document was found), so a caller reads "undefined" as
   *  "no claim", not as "confirmed to exist". */
  notFound?: true;
  /** A11/PAR-724 — the version `resolvePackage` was asked to match, when one was given, whether
   *  or not it was actually matched (see `versionMatched`). Absent when no version was
   *  requested. */
  requestedVersion?: string;
  /** A11/PAR-724 — true when `chosen` is a version-SPECIFIC document (a GitHub tag README
   *  probed at `requestedVersion`), never merely because a version was requested. Undefined —
   *  including when `requestedVersion` is set — means the chain fell back to the unversioned
   *  candidates; the caller states that fallback explicitly (see `retrieval.ts`'s
   *  `versionFallbackNote`) rather than leaving the substitution silent (D-50). */
  versionMatched?: true;
  /** A11/PAR-724 (code-reviewer round 1, B1) — set ONLY when it differs from `entry`: the
   *  entry a caller should INSTALL into the live registry and is what actually got persisted
   *  to `resolved.json` — with any version-pinned candidates stripped back out, so a later
   *  UNVERSIONED lookup of this name never silently resolves to the version-pinned document
   *  `entry` above was built to serve THIS call. `entry` itself keeps the full (version +
   *  unversioned) candidate list — it is what a caller uses to actually render THIS response,
   *  via `getLibraryDoc`'s cache-first lookup finding the just-written version-tag document —
   *  so `entry` must not be replaced by `persistedEntry` for that purpose. Undefined whenever
   *  no version was involved (`entry` is already what should be installed). See callers in
   *  `get-docs.ts`/`warm.ts`: `installResolvedEntry(registry, out.persistedEntry ?? out.entry)`. */
  persistedEntry?: LibraryEntry;
  /** PAR-744 (F-7) — true when `chosen`'s content is NOT new: either a 304 revalidation
   *  (`doc.notModified`) or a stale-cache fallback because the network was unreachable
   *  (`doc.staleNote`). `refresh.ts`'s resolved-entry branch uses this to decide whether a
   *  re-resolution should drop the library's followed-page cache — the same distinction
   *  `DocResult.notModified`/`staleNote` already give the direct-fetch path. Before this field
   *  existed, `ResolveOutcome` carried no staleness signal at all, so every successful
   *  re-resolution dropped followed pages unconditionally. */
  unchanged?: true;
  /** True when `chosen`'s content is the STALE fallback — the network was unreachable on every
   *  candidate and `getLibraryDoc` re-served a past-TTL cached copy (`doc.staleNote`). Deliberately
   *  NARROWER than `unchanged` above: `unchanged` also covers a 304 revalidation, which is
   *  content that is current (its TTL was just refreshed by `touchCache`), not stale — conflating
   *  the two here would report a stale fallback as `fresh` (code-reviewer, A20/PAR-729 round 1,
   *  B1: `resolveToolText`'s activity-log entry logged `fresh: true` unconditionally whenever
   *  `chosen` was set, on the mistaken assumption that `forceRefresh: true` guarantees a current
   *  document — it does not; `fetcher.ts`'s own stale-fallback branch is reachable through this
   *  exact `getLibraryDoc(entry, { forceRefresh: true })` call, on a re-resolution whose network
   *  is down). */
  stale?: true;
  /** PAR-824 (item 5) — true when `requestedVersion` was supplied but failed `VERSION_SHAPE`
   *  (hostile or malformed) and was therefore never actually searched for at all — the version
   *  was rejected outright, before any candidate was tried. Distinct from the ordinary "a
   *  shape-valid version was searched for and no version-specific document existed" case (where
   *  this is undefined and `versionMatched` alone tells the story): a caller rendering a
   *  fallback explanation needs to say "X is not a valid version and was ignored", not the
   *  generic "no document found for version X", which — for THIS case — implies a real search
   *  happened when it did not (see `retrieval.ts`'s `versionFallbackNote` and its caller in
   *  `get-docs.ts`). */
  versionShapeRejected?: true;
  /** The text the tool / CLI shows. */
  text: string;
}

const LABEL: Record<Ecosystem, string> = { npm: "npm", pypi: "PyPI" };
const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);
const REPO_SEGMENT = /^[A-Za-z0-9_.-]+$/;

// A11/PAR-724 (security-architect finding S-1/S-2) — `versionShapeError`/`MAX_VERSION_LENGTH`
// are imported from `./package-names.js`, the one place a version/ref shape is defined (D-48: a
// shared fact belongs in exactly one place, never a local variant per module, and the reporter
// is the gate — round 2's N-1 finding — not a second string a caller could drift from). See
// that module's own comment for the full rationale.

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function repoFrom(owner: string, repoRaw: string): GitHubRepo | undefined {
  const repo = repoRaw.replace(/\.git$/, "");
  if (!REPO_SEGMENT.test(owner) || !REPO_SEGMENT.test(repo)) return undefined;
  if (owner === "." || owner === ".." || repo === "." || repo === "..") return undefined;
  return { owner, repo };
}

/**
 * Owner / repo from any repository form npm or PyPI emit — `git+https://github.com/o/r.git`,
 * `https://github.com/o/r#readme`, `git://`, `git@github.com:o/r.git`, `ssh://git@github.com/o/r`,
 * `github:o/r`, `o/r`, or a `{ url }` object. github.com only (no other forge, no lookalike,
 * no subdomain); no userinfo on https; segments limited to `[A-Za-z0-9_.-]`.
 */
export function parseGitHubRepo(value: unknown): GitHubRepo | undefined {
  const raw = isRecord(value) ? value.url : value;
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  // code-reviewer S4 (Phase 4 round 2) — was an independent, undocumented duplicate of the same
  // 2048 bound `link-policy.ts`'s `MAX_REMOTE_URL_LENGTH` uses (the PAR-809 class); imported so
  // the two cannot silently drift, even though this value bounds a repository-form string, not
  // strictly a URL headed for `sanitizeRemoteUrl` — the underlying reasoning (generous headroom
  // over any real value, a ceiling against unbounded input) is the same.
  if (s.length === 0 || s.length > MAX_REMOTE_URL_LENGTH) return undefined;
  let m = /^(?:github:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(s);
  if (m) return repoFrom(m[1]!, m[2]!);
  m = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)\/?$/.exec(s);
  if (m) return repoFrom(m[1]!, m[2]!);
  let url: URL;
  try {
    url = new URL(s.replace(/^git\+/, ""));
  } catch {
    return undefined;
  }
  if (!["https:", "http:", "git:", "ssh:"].includes(url.protocol)) return undefined;
  if (!GITHUB_HOSTS.has(url.hostname)) return undefined;
  if (url.protocol !== "ssh:" && (url.username !== "" || url.password !== "")) return undefined;
  const parts = url.pathname.split("/").filter((p) => p.length > 0);
  if (parts.length < 2 || parts[0]!.includes("%") || parts[1]!.includes("%")) return undefined;
  return repoFrom(parts[0]!, parts[1]!);
}

function isGitHubUrl(url: string): boolean {
  try {
    return GITHUB_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Assign a sanitized URL to homepage / docsUrl, or — when it points at github.com — to
 *  the repository slot (github.com is not a docs host we can probe for llms.txt). */
function place(meta: PackageMetadata, slot: "homepage" | "docsUrl", value: unknown): void {
  const url = sanitizeRemoteUrl(value);
  if (!url) return;
  if (isGitHubUrl(url)) {
    if (!meta.repository) {
      const repo = parseGitHubRepo(url);
      if (repo) meta.repository = repo;
    }
    return;
  }
  if (meta[slot] === undefined) meta[slot] = url;
}

/** npm `/<name>/latest` document → metadata. Hostile or malformed fields are skipped, never fatal. */
export function parseNpmMetadata(json: unknown, metadataUrl: string): PackageMetadata {
  const meta: PackageMetadata = { source: "npm", metadataUrl };
  if (!isRecord(json)) return meta;
  const repo = parseGitHubRepo(json.repository);
  if (repo) meta.repository = repo;
  place(meta, "homepage", json.homepage);
  const description = cleanDescription(json.description);
  if (description) meta.description = description;
  return meta;
}

const DOCS_KEYS = /^(docs?|documentation)\b/;
const HOME_KEYS = /^(home ?page|home)$/;
const REPO_KEYS = /^(source( code)?|repository|repo|github|code)$/;

/** PyPI `/pypi/<name>/json` document → metadata from `info.project_urls` (keys matched
 *  case-insensitively: Documentation / Docs, Homepage / Home page, Source / Repository /
 *  GitHub / Code), falling back to `info.home_page`; `info.summary` is the description. */
export function parsePyPiMetadata(json: unknown, metadataUrl: string): PackageMetadata {
  const meta: PackageMetadata = { source: "pypi", metadataUrl };
  if (!isRecord(json) || !isRecord(json.info)) return meta;
  const info = json.info;
  let docs: unknown;
  let home: unknown;
  let repo: unknown;
  if (isRecord(info.project_urls)) {
    for (const [key, value] of Object.entries(info.project_urls)) {
      const k = key.trim().toLowerCase();
      if (docs === undefined && DOCS_KEYS.test(k)) docs = value;
      else if (home === undefined && HOME_KEYS.test(k)) home = value;
      else if (repo === undefined && REPO_KEYS.test(k)) repo = value;
    }
  }
  const parsedRepo = parseGitHubRepo(repo);
  if (parsedRepo) meta.repository = parsedRepo;
  place(meta, "docsUrl", docs);
  place(meta, "homepage", home);
  place(meta, "homepage", info.home_page);
  const description = cleanDescription(info.summary);
  if (description) meta.description = description;
  return meta;
}

/** A11/PAR-724 — `v<version>` and bare `<version>`, the two GitHub tag-name spellings this
 *  chain tries; see `MAX_VERSION_TAG_VARIANTS`'s own comment for why only these two. */
export function versionTagVariants(version: string): string[] {
  return [`v${version}`, version];
}

/** A11/PAR-724 — README variants at `refs/tags/<tag>` for each tag spelling, in probe order
 *  (tag first, then filename — so `v<version>/README.md` is tried before `<version>/README.md`),
 *  capped at MAX_VERSIONED_README_CANDIDATES. `refs/tags/<tag>` rather than the bare tag name as
 *  the ref segment (the form `synthesizeCandidates` already uses for `HEAD`): unlike `HEAD`, a
 *  tag name can collide with a branch of the same name, and the explicit `refs/tags/` form is
 *  the one that disambiguates on raw.githubusercontent.com.
 *
 *  PAR-855 (security audit) — this function is EXPORTED, and until this item it trusted its
 *  caller entirely: `resolvePackage` only ever calls it with a `VERSION_SHAPE`-validated
 *  `version` (see that gate at the top of `resolvePackage`), and the "control lives in a
 *  different module than the thing it protects" shape is exactly what has bitten this project
 *  before (D-48's lesson). Called directly with `"../../outside"`, the OLD code built the raw
 *  candidate `.../refs/tags/v../../outside/README.md`, round-tripped it through `new URL()`
 *  (which collapses the embedded `..` segments before the `startsWith(prefix)` check ever runs),
 *  saw the NORMALISED form still start with `prefix`, and pushed the RAW, un-normalised string
 *  into its returned list — the check validated one string and returned a different one. Now
 *  gated on its own precondition, `VERSION_SHAPE`, at the top: an invalid version is REFUSED
 *  (empty array), not silently sanitised or narrowed to "whatever survived the round-trip" —
 *  defense in depth alongside `resolvePackage`'s own gate, not instead of it; the round-trip
 *  check below stays too, as a second, independent proof for any input that DOES pass the shape
 *  gate. */
export function versionReadmeCandidates(repo: GitHubRepo, version: string): string[] {
  if (versionShapeError(version) !== undefined) return [];
  const urls: string[] = [];
  const prefix = `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/refs/tags/`;
  for (const tag of versionTagVariants(version)) {
    for (const f of README_VARIANTS) {
      const candidate = `${prefix}${tag}/${f}`;
      let normalised: string;
      try {
        normalised = new URL(candidate).href;
      } catch {
        continue;
      }
      if (normalised.startsWith(prefix)) urls.push(candidate);
    }
  }
  return urls.slice(0, MAX_VERSIONED_README_CANDIDATES);
}

/** Candidate URLs in probe order: llms-full.txt / llms.txt under the docs URL's path and
 *  origin, then the homepage's; then the GitHub README variants at `HEAD`. Never includes
 *  version-specific candidates — those are a separate, higher-priority list the caller
 *  (`resolvePackage`) prepends itself (via `versionReadmeCandidates`) only for the ecosystem it
 *  actually looked up a version for; this function stays the same unversioned chain every
 *  caller, versioned or not, still falls back to. */
export function synthesizeCandidates(meta: PackageMetadata): string[] {
  const llms: string[] = [];
  const push = (u: string) => {
    if (llms.length < MAX_LLMS_CANDIDATES && !llms.includes(u)) llms.push(u);
  };
  for (const base of [meta.docsUrl, meta.homepage]) {
    if (!base) continue;
    const u = new URL(base);
    const segments = u.pathname.split("/").filter((s) => s.length > 0);
    if (segments.length > 0 && /\.[a-z0-9]+$/i.test(segments[segments.length - 1]!)) segments.pop(); // index.html etc.
    const path = segments.length > 0 ? `/${segments.join("/")}` : "";
    if (path) {
      push(`${u.origin}${path}/llms-full.txt`);
      push(`${u.origin}${path}/llms.txt`);
    }
    push(`${u.origin}/llms-full.txt`);
    push(`${u.origin}/llms.txt`);
  }
  const readme = meta.repository
    ? README_VARIANTS.map((f) => `https://raw.githubusercontent.com/${meta.repository!.owner}/${meta.repository!.repo}/HEAD/${f}`)
    : [];
  return [...llms, ...readme.slice(0, MAX_README_CANDIDATES)];
}

function buildEntry(name: string, meta: PackageMetadata, urls: string[], now: Date): LibraryEntry {
  const resolved: ResolvedMeta = { source: meta.source, resolvedAt: now.toISOString(), metadataUrl: meta.metadataUrl };
  if (meta.homepage) resolved.homepage = redactUrlForDisplay(meta.homepage);
  if (meta.docsUrl) resolved.docsUrl = redactUrlForDisplay(meta.docsUrl);
  const entry: LibraryEntry = { name, urls, allowedHosts: derivedAllowedHosts(resolved), resolved };
  if (meta.description) entry.description = meta.description;
  return entry;
}

function describeMeta(meta: PackageMetadata): string {
  const parts: string[] = [];
  if (meta.homepage) parts.push(`homepage ${redactUrlForDisplay(meta.homepage)}`);
  if (meta.docsUrl) parts.push(`docs ${redactUrlForDisplay(meta.docsUrl)}`);
  if (meta.repository) parts.push(`repository github.com/${meta.repository.owner}/${meta.repository.repo}`);
  return parts.join(", ");
}

/** A16/PAR-725 — the two distinct existence wordings, and the generic (existence-not-
 *  established) one, all sharing the same `Could not resolve "<name>": ` lead and pin-it-by-hand
 *  tail so `runResolveCli`'s `text.startsWith("Could not resolve")` exit-code check keeps working
 *  under every variant. `"not-found"`: every ecosystem this call actually queried answered with
 *  a genuine 404 — the SAFETY signal (a name an LLM could have invented, distinct from a real
 *  package with no reachable docs). `"exists"`: at least one ecosystem's metadata was found, so
 *  the name is real, but no document was reachable — the ordinary documentation-miss case.
 *  Undefined: existence was never established either way (bad network, invalid name, rate
 *  limit) — no claim is made, per the same discipline `ResolveOutcome.notFound` documents.
 *  Claim discipline (PAR-725 Shape): the ONLY existence claim made anywhere is "this name does
 *  not exist in npm or PyPI" — never phrased as preventing hallucination in general. */
export function couldNotResolveMessage(
  name: string,
  attempts: string[],
  opts: {
    existence?: "not-found" | "exists";
    notFoundEcosystems?: Ecosystem[];
    /** PAR-824 (item 1) — the name STRING ACTUALLY SENT to each ecosystem's registry (npm
     *  folds to lowercase — `folded` in `resolvePackage`; PyPI folds to its PEP 503 form —
     *  `normalisePyPiName(name)`). Used ONLY for the "does not exist" existence clause, and
     *  only when exactly one ecosystem is being reported (`notFoundEcosystems.length === 1`):
     *  quoting the ORIGINAL `name` there for a legacy mixed-case npm package (`JSONStream`,
     *  queried and 404'd as `jsonstream`) misattributes which spelling actually 404'd. The
     *  three OTHER interpolations of `name` below (the lead line and the config-pin suggestion)
     *  keep the caller's own original spelling — that is what they typed and what they would
     *  paste into config, not what the registry saw. */
    queriedNames?: Partial<Record<Ecosystem, string>>;
  } = {},
): string {
  // A16/PAR-725 — "not-found" is scoped to whichever registry (or registries) actually
  // confirmed the absence: "npm or PyPI" for an unrestricted call that checked both, or just
  // "npm" / "PyPI" for a caller that deliberately restricted the lookup to one (`warm.ts`
  // always does, per the manifest's own ecosystem) — narrower, not broader, so it is never an
  // overclaim. Falls back to the general "npm or PyPI" phrasing if this is ever called with
  // `existence: "not-found"` and no ecosystem list (defensive; every real call site supplies one).
  const registries = opts.notFoundEcosystems?.length ? opts.notFoundEcosystems.map((e) => LABEL[e]).join(" or ") : "npm or PyPI";
  // PAR-822 (security-audit #1-ranked finding) — `name` is untrusted the same way `version` is
  // (see the A11/PAR-724 comment above): an MCP tool argument echoed straight into response
  // text on every failure path. `clipText(name, MAX_NAME_LENGTH)` at each of this function's
  // four interpolation points — the same `clipText` primitive `resolvePackage` already applies
  // to `version` at its own earlier clip site (`safeRequestedVersion`, above) — never a raw
  // copy of `name`, whatever this function does with it.
  const singleEcosystem = opts.notFoundEcosystems?.length === 1 ? opts.notFoundEcosystems[0] : undefined;
  const queriedName = (singleEcosystem !== undefined ? opts.queriedNames?.[singleEcosystem] : undefined) ?? name;
  if (name.includes('"') || queriedName.includes('"')) {
    const cleanName = clipText(name, MAX_NAME_LENGTH);
    const existence = opts.existence === "not-found"
      ? `The queried name does not exist in ${registries}.`
      : opts.existence === "exists"
        ? "The package exists but publishes no documentation VibeCTX can reach — this is not a sign the package does not exist."
        : "";
    const details = attempts.length > 0 ? `\nResolution attempts:\n${fenceEchoedIdentifier(attempts.join("; "), 1024)}` : "";
    return `Could not resolve:\n${fenceEchoedIdentifier(name, MAX_NAME_LENGTH)}${existence ? `\n${existence}` : ""}${details}\nAdd it to vibectx.config.json like: ${JSON.stringify({ name: cleanName, urls: ["https://..."] })}`;
  }
  const existence =
    opts.existence === "not-found"
      ? `"${clipText(queriedName, MAX_NAME_LENGTH)}" does not exist in ${registries}. `
      : opts.existence === "exists"
        ? `"${clipText(name, MAX_NAME_LENGTH)}" exists but publishes no documentation VibeCTX can reach — this is not a sign the package doesn't exist. `
        : "";
  return (
    `Could not resolve "${clipText(name, MAX_NAME_LENGTH)}": ${existence}${attempts.join("; ")}. ` +
    `Add it to vibectx.config.json like: { "name": "${clipText(name, MAX_NAME_LENGTH)}", "urls": ["https://..."] }`
  );
}

async function fetchMetadata(url: string, strictDns?: boolean, lookup?: AddressLookup, signal?: AbortSignal): Promise<{ json?: unknown; why?: string; notFound?: true }> {
  // PAR-1044 (final audit L-2): the caller's signal reaches the request, so a cancelled call
  // (or one past its deadline) starts no metadata fetch.
  const out = await fetchUrl(url, { maxBytes: METADATA_MAX_BYTES, publicFinalUrl: true, strictDns, lookup, operationSignal: signal });
  if (out.status === "too-large") return { why: `larger than ${METADATA_MAX_BYTES / (1024 * 1024)} MiB` };
  // A16/PAR-725 — `httpStatus` (fetcher.ts) is set only for a real, received 404/etc response
  // (the "http-status" miss reason); every other miss (redirect loop, DNS failure, a timeout)
  // leaves it undefined, so this is the one branch that can honestly say "the registry said no
  // such package" rather than "something went wrong asking".
  if (out.status === "miss" && out.httpStatus === 404) return { why: "404 (not found)", notFound: true };
  // PAR-824 (item 2) — a non-404 HTTP status (500, 503, a rate limit, …) IS available
  // (`out.httpStatus`) but was previously folded into the same generic "unreachable" every
  // network-level failure (DNS, timeout, connection refused) also produces — losing real,
  // already-known diagnostic information for no reason. Reported by its actual status now;
  // "unreachable" stays for the genuinely connection-level failures that have no status at all.
  if (out.status === "miss" && out.httpStatus !== undefined) return { why: `${out.httpStatus} (unexpected status)` };
  if (out.status !== "ok" || out.body === undefined) return { why: "unreachable" };
  try {
    return { json: JSON.parse(out.body) };
  } catch {
    return { why: "response was not JSON" };
  }
}

/** A11/PAR-724 — `version` selects the exact-version metadata document instead of `/latest`:
 *  npm's `registry.npmjs.org/<name>/<version>` and PyPI's `pypi.org/pypi/<name>/<version>/json`
 *  are both real, documented per-version endpoints (the same shape the unversioned lookup
 *  already uses, with the version in place of `latest`). */
function metadataUrlFor(eco: Ecosystem, name: string, version?: string): string {
  // npm's conventional scoped form keeps the leading "@" and encodes the "/" (`@scope%2Fname`).
  if (eco === "npm") {
    const base = `https://registry.npmjs.org/${encodeURIComponent(name).replace(/^%40/, "@")}`;
    return `${base}/${encodeURIComponent(version ?? "latest")}`;
  }
  const base = `https://pypi.org/pypi/${encodeURIComponent(normalisePyPiName(name))}`;
  return version ? `${base}/${encodeURIComponent(version)}/json` : `${base}/json`;
}

/** Resolutions started in the current sliding hour (L2); process-wide. */
let resolutionStarts: number[] = [];

/** Test hook: forget the sliding window. */
export function resetResolutionWindow(): void {
  resolutionStarts = [];
}

/** Test hook: seed the window so caller tests can exercise the full-cap branch without
 *  performing one hundred end-to-end resolutions first. The production cap is unchanged. */
export function seedResolutionWindowForTest(count: number, nowMs: number): void {
  resolutionStarts = Array.from({ length: count }, () => nowMs);
}

/** True when another resolution may start now; records it if so. */
function takeResolutionSlot(nowMs: number): boolean {
  resolutionStarts = resolutionStarts.filter((t) => nowMs - t < 3600_000);
  if (resolutionStarts.length >= MAX_RESOLUTIONS_PER_HOUR) return false;
  resolutionStarts.push(nowMs);
  return true;
}

/** PAR-815 (Phase 4), decision recorded in docs/decisions.md — redacted for the same reason the
 *  "urls (probed in order)" list below is: the whole point of this phase is no exceptions
 *  without a stated reason, and the URL's host/path structure (which candidate this was, and
 *  whether it was tried) is still fully visible; only the query string, fragment and userinfo
 *  are gone. These candidates are usually registry-derived (llms.txt/README URLs synthesized
 *  from package metadata), not hand-authored `urls:` entries, but package metadata is still
 *  attacker-influenced (PAR-725's own "anyone can publish a package" premise) and could in
 *  principle carry a query string — redacting here, uniformly, avoids deciding case by case
 *  based on provenance the reader of this text cannot see either way. */
function formatResolved(out: ResolveOutcome): string {
  const chosenAt = out.candidates.indexOf(out.chosen ?? "");
  const rows = out.candidates.map((u, i) => {
    const verdict = i < chosenAt ? "no document" : i === chosenAt ? "chosen" : "not tried";
    return `    ${i + 1}. ${redactUrlForDisplay(u)} — ${verdict}`;
  });
  const repo = out.repository ? `https://github.com/${out.repository.owner}/${out.repository.repo}` : "—";
  const hosts = out.entry?.allowedHosts?.length ? out.entry.allowedHosts.join(", ") : "none";
  const saved = out.saved === false
    ? `  NOT saved: ${out.saveNote ?? "resolved.json could not be written"} — this resolution lives in memory until restart; get_docs("${out.entry?.name}") works now.`
    : `  saved to ${resolvedStorePath()} — get_docs("${out.entry?.name}") works now; pin or override it in vibectx.config.json.`;
  // A11/PAR-724 — non-silent per D-50: whenever a version was requested, say plainly whether
  // it was matched or the resolution fell back to the latest available document. Not reachable
  // from any current production caller (code-reviewer round 2, should-fix #6): neither
  // `resolve_library` (`resolveToolText`) nor `vibectx resolve` accepts a `version` argument
  // today (a deliberate A11 scope decision — see the PR record — not an oversight), and the
  // two `resolvePackage` callers that DO pass one (`get-docs.ts`, `warm.ts`) never render
  // `out.text` on a success path. Kept, not removed: `resolvePackage`'s own contract is
  // version-aware regardless of which caller exercises it, `formatResolved` is its one
  // rendering of that contract, and this line is real, tested behaviour for any direct caller
  // (including a future `resolve_library`/`--version` addition) — not a placeholder.
  const version = out.requestedVersion
    ? [`  version:    ${out.requestedVersion} (${out.versionMatched ? "matched" : "no versioned document found; showing latest"})`]
    : [];
  return [
    `Resolved "${out.name}" via ${LABEL[out.source!]} — ${out.metadataUrl}`,
    ...(out.entry?.description ? [`  description: (package-supplied) ${out.entry.description}`] : []),
    ...version,
    `  homepage:   ${out.homepage ?? "—"}`,
    `  docs:       ${out.docsUrl ?? "—"}`,
    `  repository: ${repo}`,
    "  candidates (probed in order; first usable document wins):",
    ...rows,
    // PAR-815 (Phase 4): the same field `refresh.ts`'s "refreshed from <url>" line renders —
    // redacted here too, for the same reason and so the two do not diverge without cause.
    `  chosen: ${redactUrlForDisplay(out.chosen!)} (${out.kind}, ${(out.chars ?? 0).toLocaleString()} chars)`,
    `  followed-link hosts: ${hosts} (plus the source document's own host; https only)`,
    saved,
  ].join("\n");
}

/** npm parks taken-down / reserved names on this repository; such a name has no package. */
function isNpmPlaceholder(meta: PackageMetadata): boolean {
  return meta.repository?.owner === "npm" && meta.repository.repo === "security-holder";
}

/** A homepage or docs URL that is not github.com — the signal that this ecosystem's
 *  package is the documented project rather than a same-named repo-only package. */
function hasDocsSite(meta: PackageMetadata): boolean {
  return meta.homepage !== undefined || meta.docsUrl !== undefined;
}

/**
 * Resolve one package name. Never throws — not for bad input, not for a bad network, and
 * (A5, PAR-718) not for a failed cache or record write (EACCES/ENOSPC/EROFS: a read-only
 * `$HOME` or a full disk): the outcome's `text` is always a plain message. `ecosystem`
 * restricts the lookup to one registry.
 *
 * RESIDUAL, disclosed rather than silently accepted (see the `getLibraryDoc` call site
 * below): when the cache write fails before ANY document has been fetched for this library
 * (no per-library directory existed yet), the document itself is lost — recovering it is
 * `cache.ts`'s job, out of this item's authorised scope — and this reports the name as
 * unresolvable rather than serving the fetched text. When the write that fails is only
 * `resolved.json`'s (the document was already cached), the document IS still returned, with
 * `saved: false` and `saveNote` explaining why.
 *
 * Ecosystem choice without an override — npm first, then PyPI, with a docs-site
 * preference: an ecosystem whose metadata carries a homepage / docs URL is taken at
 * once (no second metadata fetch); one that offers only a repository README is held
 * while the other ecosystem is consulted, and loses to it if that one has a docs site.
 * MEASURED 2026-09-06: `httpx`, `fastapi` and `django` all exist on npm as unrelated
 * README-only or placeholder packages, so plain npm-first misresolves Python names.
 */
export async function resolvePackage(
  rawName: string,
  opts: {
    ecosystem?: Ecosystem;
    version?: string;
    strictDns?: boolean;
    now?: () => Date;
    warn?: (message: string) => void;
    lookup?: AddressLookup;
    /** PAR-1044 (L-2): the caller's cancellation (MCP request signal); every fetch honours it. */
    signal?: AbortSignal;
    /** Test seam: shortens the whole-resolution deadline. Production callers never pass it. */
    deadlineMs?: number;
  } = {},
): Promise<ResolveOutcome> {
  // PAR-1044 (final audit L-2): one deadline spans the whole resolution — every metadata,
  // version-metadata and candidate fetch — combined with the caller's cancellation. Before
  // this, one unknown name could keep requests going for minutes (each had only its own 20 s).
  const deadline = AbortSignal.timeout(opts.deadlineMs ?? OPERATION_DEADLINE_MS);
  opts = { ...opts, signal: opts.signal ? AbortSignal.any([deadline, opts.signal]) : deadline };
  const name = rawName.trim();
  const folded = name.toLowerCase(); // the registry's fold()
  const attempts: string[] = [];
  // A16/PAR-725 — ecosystems this call actually queried (not skipped for an invalid name or an
  // `ecosystem` restriction), and which of those came back a genuine 404. Declared here, ahead
  // of `fail`, so `fail`'s own closure sees the values phase 1 fills in — both start empty for
  // the two early-return cases below, where nothing has been queried yet.
  const triedEcosystems: Ecosystem[] = [];
  const notFoundIn: Ecosystem[] = [];
  let operationalFailure: "network" | "cache" | undefined;
  // A11/PAR-724 (security-architect S-1/S-2) — `opts.version`, verbatim, is untrusted: it is
  // either an MCP tool argument (any string an agent can supply) or captured from a committed
  // manifest file (`project-deps.ts`'s version parsers, threaded through by `warm.ts` — a path
  // that never passes through the MCP schema at all, so a schema-level bound alone would not
  // cover it). `version` below is the ONE value the rest of this function is allowed to build a
  // URL from or fetch with; `safeRequestedVersion` is the ONE value it is allowed to render —
  // both are computed here, once, rather than trusting every downstream site to remember to
  // gate or clip `opts.version` itself.
  const versionError = opts.version !== undefined ? versionShapeError(opts.version) : undefined;
  const version = versionError === undefined ? opts.version : undefined;
  const safeRequestedVersion = opts.version !== undefined ? clipText(opts.version, MAX_VERSION_LENGTH) : undefined;
  if (versionError !== undefined) {
    attempts.push(`version "${safeRequestedVersion}" is ${versionError}; ignored`);
  }
  // A16/PAR-725 — `existence` names which of the two distinct wordings applies; undefined makes
  // no claim either way (see `couldNotResolveMessage`'s own comment for the three cases). When
  // "not-found", `notFoundIn` (by then populated) says WHICH registry/registries confirmed the
  // absence — `opts.ecosystem` narrows the claim to just that one, an equally honest, narrower
  // reading of the same signal ("does not exist in npm" is still true and useful when the
  // caller deliberately asked only about npm — see `warm.ts`, which always restricts by the
  // manifest's own ecosystem and could never reach the two-registry claim otherwise).
  const fail = (existence?: "not-found" | "exists"): ResolveOutcome => ({
    name,
    ok: false,
    candidates: [],
    attempts,
    notFound: existence === "not-found" ? true : undefined,
    operationalFailure,
    requestedVersion: safeRequestedVersion,
    versionShapeRejected: versionError !== undefined ? true : undefined,
    // PAR-824 (item 1) — the name strings actually sent to each registry (see
    // `metadataUrlFor`'s own construction of each ecosystem's request), so a single-ecosystem
    // "not-found" claim quotes what actually 404'd.
    text: couldNotResolveMessage(name, attempts, { existence, notFoundEcosystems: notFoundIn, queriedNames: { npm: folded, pypi: normalisePyPiName(name) } }),
  });
  const now = opts.now ?? (() => new Date());

  const nameErrors: Record<Ecosystem, string | undefined> = { npm: npmNameError(folded), pypi: pypiNameError(name) };
  if (nameErrors.npm !== undefined && nameErrors.pypi !== undefined) {
    // PAR-822 — this string flows a SECOND time into `couldNotResolveMessage`'s own
    // `attempts.join("; ")` below (via `fail()`), so clipping only `couldNotResolveMessage`'s
    // own direct interpolations of `name` is not sufficient — this site needs its own
    // `clipText`, same bound, same primitive.
    attempts.push(`"${clipText(name, MAX_NAME_LENGTH)}" is not a valid npm or PyPI package name; nothing was fetched`);
    return fail();
  }
  if (opts.signal?.aborted) {
    // Cancelled before anything was fetched: do not spend one of the hourly resolutions.
    attempts.push("cancelled before any request");
    return fail();
  }
  if (!takeResolutionSlot(now().getTime())) {
    attempts.push(`resolution limit reached (${MAX_RESOLUTIONS_PER_HOUR} per hour per process); restart the MCP server to clear this process counter, wait for its window to pass, or pin the library`);
    return { ...fail(), limited: true };
  }

  // Phase 1: gather metadata (at most MAX_METADATA_FETCHES), stopping early on a docs site.
  const found: { eco: Ecosystem; meta: PackageMetadata; candidates: string[] }[] = [];
  let fetched = 0;
  for (const eco of ["npm", "pypi"] as const) {
    const label = LABEL[eco];
    if (opts.ecosystem !== undefined && opts.ecosystem !== eco) {
      attempts.push(`${label}: not tried (ecosystem ${opts.ecosystem})`);
      continue;
    }
    if (nameErrors[eco] !== undefined) {
      attempts.push(`${label}: not tried (not a valid ${label} name)`);
      continue;
    }
    if (fetched >= MAX_METADATA_FETCHES) break;
    triedEcosystems.push(eco);
    const metadataUrl = metadataUrlFor(eco, eco === "npm" ? folded : name);
    fetched += 1;
    const { json, why, notFound } = await fetchMetadata(metadataUrl, opts.strictDns, opts.lookup, opts.signal);
    if (json === undefined) {
      if (!notFound) operationalFailure = "network";
      attempts.push(`${label}: no metadata (${why})`);
      if (notFound) notFoundIn.push(eco);
      continue;
    }
    const meta = eco === "npm" ? parseNpmMetadata(json, metadataUrl) : parsePyPiMetadata(json, metadataUrl);
    if (eco === "npm" && isNpmPlaceholder(meta)) {
      // A16/PAR-725 (code-reviewer round 1, should-fix #1) — deliberately NOT pushed to
      // `notFoundIn`: a security-holder placeholder is a real, registered npm record (a 200
      // with real metadata), not a genuine 404 — the "does not exist in npm or PyPI" claim is
      // reserved for exactly that case (see `couldNotResolveMessage`'s own comment). Counting
      // this as absence would be the narrow overclaim this repo's claim discipline forbids.
      attempts.push("npm: name is held by npm's security-holder placeholder (no package)");
      continue;
    }
    const candidates = synthesizeCandidates(meta);
    if (candidates.length === 0) {
      attempts.push(`${label} metadata found but it has no https homepage, docs URL or GitHub repository`);
      continue;
    }
    found.push({ eco, meta, candidates });
    if (hasDocsSite(meta)) break;
  }
  // Docs-site ecosystem first, then the rest in registry order (R2: a dead end falls through).
  const order = [...found.filter((f) => hasDocsSite(f.meta)), ...found.filter((f) => !hasDocsSite(f.meta))];
  // A16/PAR-725 (code-reviewer round 1, nit) — the claim is specifically "does not exist in
  // npm OR PyPI", so it is only honest when BOTH were actually queried and BOTH came back a
  // genuine 404 (npm alone 404ing proves nothing about PyPI, and vice versa) — UNLESS the
  // caller explicitly restricted the lookup to one ecosystem (`opts.ecosystem`), which already
  // narrows the question to just that registry, so its own 404 answers it in full. See `fail`'s
  // own comment above for the full rationale.
  const doesNotExist =
    triedEcosystems.length > 0 &&
    triedEcosystems.every((eco) => notFoundIn.includes(eco)) &&
    (opts.ecosystem !== undefined || triedEcosystems.length === 2);
  if (order.length === 0) return fail(doesNotExist ? "not-found" : undefined);

  // A11/PAR-724 — Phase 1.5: when a SHAPE-VALID version is pinned, one extra metadata fetch
  // (MAX_VERSION_METADATA_FETCHES) at the exact version, for the chosen ecosystem only
  // (order[0]) — confirms the version is registered and may reveal a repository that differs
  // from `/latest`'s (a package that moved forges between releases, say). Never blocks
  // resolution either way: the unversioned fallback chain below still runs regardless of what
  // this fetch finds. Reads `version` (the shape-gated local), never `opts.version` directly —
  // see the top of this function for why.
  let versionRepo: GitHubRepo | undefined;
  if (version !== undefined) {
    const { eco, meta } = order[0]!; // order.length > 0: the empty case returned above
    const label = LABEL[eco];
    const versionUrl = metadataUrlFor(eco, eco === "npm" ? folded : name, version);
    fetched += MAX_VERSION_METADATA_FETCHES;
    const { json, why } = await fetchMetadata(versionUrl, opts.strictDns, opts.lookup, opts.signal);
    if (json !== undefined) {
      const vMeta = eco === "npm" ? parseNpmMetadata(json, versionUrl) : parsePyPiMetadata(json, versionUrl);
      versionRepo = vMeta.repository ?? meta.repository;
      attempts.push(`${label}: version ${clipText(version, MAX_VERSION_LENGTH)} metadata found`);
    } else {
      versionRepo = meta.repository; // still try the version-tag README against the latest repo
      attempts.push(`${label}: version ${clipText(version, MAX_VERSION_LENGTH)} not found in registry metadata (${why})`);
    }
  }

  // Phase 2: probe each found ecosystem's candidates in order; the first usable document wins.
  let budget = MAX_FETCHES_PER_RESOLUTION - fetched;
  for (let orderIndex = 0; orderIndex < order.length; orderIndex++) {
    const { eco, meta, candidates } = order[orderIndex]!;
    // A11/PAR-724 — version-specific candidates only for the ecosystem the version metadata
    // fetch above actually ran against (order[0]); an ecosystem tried later in this loop only
    // as R2's dead-end fallback gets the unversioned chain, same as an unversioned call always did.
    // `version`, not `opts.version`: a shape-invalid version never reaches URL construction.
    const versionCandidates = orderIndex === 0 && version !== undefined && versionRepo ? versionReadmeCandidates(versionRepo, version) : [];
    const versionUrlSet = new Set(versionCandidates);
    const urls = [...versionCandidates, ...candidates].slice(0, Math.max(0, budget)); // the hard ceiling
    budget -= urls.length;
    if (urls.length === 0) break;
    // PyPI names are keyed by their PEP 503 form (L3): typing_extensions and Typing-Extensions are one record.
    const entryName = eco === "pypi" ? normalisePyPiName(name) : folded;
    const entry = buildEntry(entryName, meta, urls, now());
    // A11/PAR-724 (code-reviewer round 1, B1) — `persistedEntry` is what gets SAVED to
    // resolved.json and what a caller should INSTALL into the live registry; `entry` above (used
    // for THIS call's fetch, and returned as `out.entry`) keeps the full candidate list so this
    // call's own document — already cached under the version-tag URL by the `getLibraryDoc`
    // call below — is actually reachable. Without this split, a version-pinned resolution would
    // replace the library's live registry entry AND `resolved.json` with the version-tag URL
    // first in `urls` — so a later, plain `get_docs("<lib>")` (no version) would resolve through
    // `lookupLibrary` straight to that entry and silently serve the pinned document, with no
    // `version` field in the stamp (nothing upstream of `getLibraryDoc` re-derives a match on an
    // unversioned call). That is exactly the silent substitution D-50 forbids, just in the other
    // direction — "you asked for latest, got a pin" instead of "you asked for a pin, got
    // latest". The version-matched document THIS call serves stays reachable (cached under its
    // own URL, and re-resolvable by name on a future versioned call) without becoming what an
    // unversioned call resolves to afterward.
    // A5 (PAR-718): this function's contract is "never throws for bad input or bad network"
    // (see the docstring above) — but `getLibraryDoc` also WRITES the document to the cache
    // (`cache.ts`'s `writeCache`), and that write throws on EACCES/ENOSPC/EROFS (a read-only
    // `$HOME` or a full disk), not just on a bad network. Caught here rather than left to
    // propagate: the caller only ever sees "this candidate set produced nothing", not a stack
    // trace. RESIDUAL, disclosed rather than silently accepted: the document itself is lost in
    // this branch — it WAS fetched, but a throw during the cache write aborts `getLibraryDoc`
    // before it returns the content, and recovering that content is `cache.ts`'s job, not this
    // function's.
    let doc: Awaited<ReturnType<typeof getLibraryDoc>>;
    try {
      doc = await getLibraryDoc(entry, { forceRefresh: true, strictDns: opts.strictDns, lookup: opts.lookup, signal: opts.signal });
    } catch (e) {
      operationalFailure = "cache";
      // Not "none of N candidates served a document" (the sibling message below, where all N
      // really were tried) — `getLibraryDoc` stops at the first candidate that fetched
      // successfully and aborts on ITS cache write, so fewer than `urls.length` were probed.
      attempts.push(
        `${LABEL[eco]} metadata found (${describeMeta(meta)}); the cache write failed while probing its candidates: ${e instanceof Error ? e.message : String(e)}`,
      );
      continue;
    }
    if (!doc) {
      operationalFailure = "network";
      attempts.push(
        `${LABEL[eco]} metadata found (${describeMeta(meta)}); none of ${urls.length} candidate URLs served a document: ${urls.join(", ")}`,
      );
      continue;
    }
    // Keep a tag document reachable for a later exact-pin lookup, but never put it in the
    // ordinary candidate list: a plain lookup still means latest. `doc.url` is recorded only
    // when a version candidate actually won, never when this resolution fell back to latest.
    const persistedEntry = versionCandidates.length > 0
      ? {
          ...entry,
          urls: candidates,
          ...(version !== undefined && versionUrlSet.has(doc.url)
            ? { versionedDocuments: [{ version, url: doc.url }] }
            : {}),
        }
      : entry;
    // D-34 (PAR-659, R1) — RESOLUTION IS A WRITER OF A PRIMARY CACHED DOCUMENT, so it keeps
    // the cross-library search index current like every other writer. The hooks used to sit at
    // the CALLERS, and two callers had none: `warm`'s `resolved+cached` branch left a
    // newly-resolved library unindexed, and `refresh`'s resolved branch invalidated the entry
    // and then returned without rebuilding it — so a SUCCESSFUL refresh left that library
    // deleted from the index until something else rewrote it.
    //
    // One hook here closes the class rather than the two instances: both callers reach the
    // cache through this function, and this is the only place that holds the document text and
    // the entry name together without a second read. (A hook inside `cache.ts`'s `writeCache`
    // would have been lower still, but that writer also serves FOLLOWED PAGES, which D-34
    // deliberately does not index — it would have filed a followed page under the library's
    // name and displaced its primary document.)
    let saveNote: string | undefined;
    let saved: boolean;
    // A5 (PAR-718): `saveResolvedEntry` throws on EACCES/ENOSPC/EROFS (`resolved-store.ts`'s
    // own `mkdirSync`/`writeAtomic`) — a read-only `$HOME` or a full disk turned a resolution
    // that HAD already produced a real document (the fetch and cache-write above succeeded)
    // into an uncaught exception through `get-docs.ts`. `saved`/`saveNote` are already on
    // `ResolveOutcome` for exactly this case (the K2 "newer schema on disk" refusal below sets
    // them via `warn` without throwing); a caught write exception now sets them the same way,
    // so the caller sees "resolved, not saved, here is why" rather than a stack trace.
    //
    // Deliberately broad, not narrowed to the I/O errors above: `saveResolvedEntry` also
    // throws two invariant errors (`resolved-store.ts:110,112`, "not a resolved entry" / "does
    // not pass resolved-record validation") that `buildEntry`'s own construction should make
    // unreachable here. Catching them too means an invariant violation degrades to the same
    // "not saved" outcome BY DESIGN rather than surfacing as a distinct crash — the same
    // trade-off this item makes everywhere else, made explicit rather than left implicit.
    try {
      saved = saveResolvedEntry(persistedEntry, (m) => {
        saveNote = m.replace(/^vibectx: not saving "[^"]*" — /, "").trim();
        (opts.warn ?? ((x: string) => writeStderrWarning(x)))(m);
      });
    } catch (e) {
      saved = false;
      saveNote = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim();
      (opts.warn ?? ((x: string) => writeStderrWarning(x)))(`vibectx: resolution not saved for "${persistedEntry.name}": ${saveNote}\n`);
    }
    // …and the index is written only once the RECORD is, in that order. Indexing first filed a
    // posting list under a library name that a refused save leaves no trace of anywhere else —
    // an orphan no later process could ever use, spending the index's size budget (D-40) that a
    // library the registry does know might then be shed to make room in.
    if (saved) indexCachedDocument(persistedEntry.name, doc.url, doc.content, undefined, opts.warn);
    const out: ResolveOutcome = {
      name,
      ok: true,
      source: eco,
      metadataUrl: meta.metadataUrl,
      homepage: entry.resolved?.homepage,
      docsUrl: entry.resolved?.docsUrl,
      repository: meta.repository,
      candidates: urls,
      chosen: doc.url,
      kind: classifySourceKind(doc.url, doc.content),
      chars: doc.content.length,
      contentHash: documentHash(doc.content),
      // `entry` (full candidate list) is what serves THIS call; `persistedEntry` (set only when
      // it differs) is what a caller should install/persist instead — see that variable's own
      // comment above and `ResolveOutcome.persistedEntry`'s doc comment for the full rationale.
      entry,
      persistedEntry: persistedEntry === entry ? undefined : persistedEntry,
      saved,
      saveNote,
      attempts,
      requestedVersion: safeRequestedVersion,
      text: "",
    };
    if (isDocUnchanged(doc)) out.unchanged = true;
    if (doc.staleNote !== undefined) out.stale = true;
    if (versionUrlSet.has(doc.url)) out.versionMatched = true;
    // PAR-824 (item 5) — a version was supplied but failed VERSION_SHAPE outright (`versionError`,
    // computed once at the top of this function): this success came entirely from the ordinary
    // unversioned chain, never from a real version-specific search, however this ecosystem's
    // candidates happened to resolve.
    if (versionError !== undefined) out.versionShapeRejected = true;
    out.text = formatResolved(out);
    return out;
  }
  // A16/PAR-725 — every ecosystem in `order` was reached because its metadata fetch succeeded
  // (the `order.length === 0` case above already returned), so the name is confirmed to exist —
  // this is the ordinary "no reachable document" case, not "does not exist".
  return fail("exists");
}

/** The lookup the tools use before resolving. `resolveLibrary` already tries the PEP 503
 *  form (curated entries first), so this is a named alias kept for the call sites (L3). */
export function lookupLibrary(registry: Registry, name: string): LibraryEntry | undefined {
  return resolveLibrary(registry, name);
}

/**
 * The MCP `resolve_library` tool body / `vibectx resolve`. A canonical name or alias that
 * is already a real (non-resolved) entry is reported without any network call; anything
 * else is resolved, adopted into the live registry (a resolved entry may be re-resolved,
 * e.g. to switch ecosystem) and reported.
 *
 * A20/PAR-729 (D-51): both branches write exactly one activity-log entry. The already-
 * curated fast path counts as `matched` — the name resolved to a real entry, even though no
 * network call was made; a failed `resolvePackage` is `unresolved`, and `library` falls back
 * to the requested name (cleaned by the log's own field bound) since no canonical one exists.
 * Model-visible/path-redacted output is the default; only the terminal CLI opts into full
 * local paths for diagnosis.
 */
export async function resolveToolText(registry: Registry, name: string, ecosystem?: Ecosystem, modelVisible = true, signal?: AbortSignal): Promise<string> {
  // S2: judge "already curated" on the folded key too, so an exact-case resolved entry
  // sitting beside a curated one ("React" next to "react") cannot slip past.
  const existing = lookupLibrary(registry, name);
  const curated = existing && !existing.resolved ? existing : lookupLibrary(registry, name.trim().toLowerCase());
  if (curated && !curated.resolved) {
    const existingCurated = curated;
    recordActivity({ tool: "resolve_library", library: existingCurated.name, outcome: "matched" });
    // PAR-822 (code-reviewer + security-architect, round 1) — `name` still reaches here raw:
    // `fold` (`trim().toLowerCase()`) strips only the ENDS, but `trim()` strips the full
    // ECMAScript WhiteSpace ∪ LineTerminator set (LF, CR, TAB, VT, FF, NBSP, U+2028, U+2029,
    // U+FEFF, U+3000, more) — not just plain spaces — so `"\n\nreact"` folds to `react`, hits
    // this branch, and rendered raw would put a bare `"` on the response's first line. Separately,
    // `resolveLibrary`'s third leg (`normalisePyPiName`, which collapses runs of `-`/`_`/`.` to a
    // single `-`) means a long run of that punctuation between two real name fragments
    // (`"react" + "-".repeat(50) + "_".repeat(50) + ".".repeat(50) + "query"`) also fold-matches
    // a curated `react-query` — reachable, unbounded, via the CLI (`vibectx resolve`, which never
    // touches the MCP Zod schema). No attacker-CHOSEN text can ride either path (both are
    // confirmed, by execution, to only ever smuggle whitespace/line-terminators or punctuation
    // runs, never an arbitrary letter) — but real line-structure corruption and an unbounded
    // response are exactly what `clipText` exists to close, same primitive, same bound, as
    // every other site in this fix.
    // PAR-815 (Phase 4), decision recorded in docs/decisions.md — this list exists specifically so a
    // caller can see every candidate that was tried, and redacting could be argued to reduce its
    // diagnostic value; decided anyway: the whole point of this phase is no exceptions without a
    // stated reason, and the URL's host/path/structure — which candidate this is — is still
    // fully visible, only the query string, fragment and userinfo are gone. `existingCurated.urls`
    // is the raw, config-authored candidate list (D-47/D-49), exactly as capable of carrying a
    // `?token=…` as any other `entry.urls` render site this phase closes.
    if (name.includes('"') || existingCurated.name.includes('"')) {
      return [
        "Already in the registry:",
        fenceEchoedIdentifier(name, MAX_NAME_LENGTH),
        ...(name === existingCurated.name ? [] : ["Registry name:", fenceEchoedIdentifier(existingCurated.name, MAX_NAME_LENGTH)]),
        "There is nothing to resolve.",
        "  urls (probed in order):",
        ...existingCurated.urls.map((u, i) => `    ${i + 1}. ${redactUrlForDisplay(u)}`),
        "  Use get_docs with the registry name shown above; override the entry in vibectx.config.json to change its sources.",
      ].join("\n");
    }
    return [
      `"${clipText(name, MAX_NAME_LENGTH)}" is already in the registry as "${existingCurated.name}" — nothing to resolve.`,
      "  urls (probed in order):",
      ...existingCurated.urls.map((u, i) => `    ${i + 1}. ${redactUrlForDisplay(u)}`),
      `  Use get_docs("${existingCurated.name}"); override the entry in vibectx.config.json to change its sources.`,
    ].join("\n");
  }
  const out = await resolvePackage(name, { ecosystem, strictDns: registry.strictDns, signal }); // PAR-1044 (L-2)
  if (out.ok && out.entry) installResolvedEntry(registry, out.persistedEntry ?? out.entry); // refuses a curated key (S2); replaces a resolved one
  recordActivity({
    tool: "resolve_library",
    library: out.entry?.name ?? name,
    url: out.chosen,
    contentHash: out.contentHash,
    // code-reviewer, A20/PAR-729 round 1, B1: NOT unconditionally true — `forceRefresh: true`
    // does not guarantee a current document; `out.stale` says whether the network was down and
    // `getLibraryDoc` fell back to a past-TTL cached copy (see `ResolveOutcome.stale`'s comment).
    fresh: out.chosen ? !out.stale : undefined,
    outcome: out.ok ? "matched" : "unresolved",
  });
  // The CLI keeps the exact local path for diagnosis; an MCP answer needs only the save
  // outcome. Save and cache-write errors name files under this same root.
  const shown = modelVisible ? redactResolvePathForModel(out.text, cacheRoot()) : out.text;
  if (out.ok || out.notFound || out.limited || !out.operationalFailure) return shown;
  return `${shown}\n\n${bugFailureOffer({
    operation: "resolve_library", where: out.operationalFailure, errorClass: out.operationalFailure === "cache" ? "CacheError" : "NetworkError",
    version: VERSION, platform: process.platform, nodeVersion: process.version,
  })}`;
}

/** Keep a filesystem-root override from replacing every slash in HTTPS URLs. */
export function redactResolvePathForModel(message: string, root = cacheRoot(), home = homedir()): string {
  if (root === "/" || /^[A-Za-z]:[\\/]$/.test(root)) {
    return "Resolution result has local cache paths; inspect vibectx resolve in a terminal for details.";
  }
  // Include the retired name only as a scrub target: it cannot select the cache root.
  const configured = [process.env.VIBECTX_CACHE_DIR, process.env.DOCS_CACHE_DIR]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => resolvePath(value));
  const paths = [...new Set([root, ...configured, home])]
    .filter((value) => isAbsolute(value) && value !== "/")
    .sort((a, b) => b.length - a.length);
  // D-96 keeps URL paths as document identity. Redact only non-URL spans, even when a
  // public URL happens to contain the same bytes as this machine's home/cache path.
  return message.split(/(https?:\/\/[^\s"'<>]+)/g).map((part, index) =>
    index % 2 === 1 ? part : paths.reduce((text, path) => text.replaceAll(path, "[cache]"), part),
  ).join("");
}
