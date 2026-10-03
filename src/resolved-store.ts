import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRegularFile, newerSchemaVersion, writeAtomic } from "./atomic-store.js";
import { cacheRoot, ensureCacheRoot, isRealDirectory } from "./cache.js";
import { derivedAllowedHosts, redactUrlForDisplay, sanitizeRemoteUrl } from "./link-policy.js";
import { isExactVersionTagUrl, normalisePyPiName, npmNameError, pypiNameError } from "./package-names.js";
import { MAX_URLS_PER_ENTRY } from "./limits.js";
import { stripControlBidi } from "./text.js";
import type { LibraryEntry, ResolvedMeta, VersionedDocument } from "./registry.js";
import { writeStderrWarning } from "./redact-paths.js";

/**
 * Persistence for resolve_library (PAR-655): `<cacheRoot>/resolved.json`, shape
 * `{ schemaVersion: 2, entries: [ { name, urls, description?, resolved, versionedDocuments? } ] }`.
 *
 * The file is a trust boundary — anything in the cache directory can write it — so
 * every record is re-validated on load with the same rules the resolver applies to
 * live metadata, malformed records are skipped, a corrupt file reads as empty, and
 * `allowedHosts` is never read from disk: it is re-derived from the record's
 * homepage / docs URL, so a persisted record cannot widen its own allow-list.
 */

export const RESOLVED_SCHEMA_VERSION = 2;
const FILE_NAME = "resolved.json";
const MAX_DESCRIPTION = 200;
const MAX_VERSIONED_DOCUMENTS = 16;
const METADATA_HOSTS = new Set(["registry.npmjs.org", "pypi.org"]);
const warnedLegacyQueryFiles = new Set<string>();

export function resolvedStorePath(): string {
  return join(cacheRoot(), FILE_NAME);
}

/** Keep a description to one plain line of at most 200 characters. Control/bidi characters
 *  (D-48's shared class, `text.ts`) become a space, not nothing: this text is untrusted
 *  natural-language prose from a package registry, and a control character may be a real word
 *  separator (a tab, a newline) — deleting it would run two words together (A7 / PAR-720). */
export function cleanDescription(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const oneLine = stripControlBidi(value, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (oneLine.length === 0) return undefined;
  return oneLine.length > MAX_DESCRIPTION ? `${oneLine.slice(0, MAX_DESCRIPTION - 1)}…` : oneLine;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toVersionedDocuments(value: unknown): VersionedDocument[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_VERSIONED_DOCUMENTS) return undefined;
  const seen = new Set<string>();
  const documents: VersionedDocument[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || typeof candidate.version !== "string") return undefined;
    const url = sanitizeRemoteUrl(candidate.url);
    if (url === undefined || !isExactVersionTagUrl(candidate.version, url) || seen.has(candidate.version)) return undefined;
    seen.add(candidate.version);
    documents.push({ version: candidate.version, url });
  }
  return documents;
}

/** Validate one persisted record into a LibraryEntry; undefined when anything essential is off. */
export function toResolvedEntry(record: unknown): LibraryEntry | undefined {
  if (!isRecord(record)) return undefined;
  const { name, urls, description, resolved } = record;
  if (typeof name !== "string" || name !== name.trim().toLowerCase()) return undefined; // S2: keys are folded; "React" can never shadow "react"
  if (npmNameError(name) !== undefined && pypiNameError(name) !== undefined) return undefined;
  if (!Array.isArray(urls) || urls.length === 0) return undefined;
  const cleanUrls: string[] = [];
  for (const u of urls.slice(0, MAX_URLS_PER_ENTRY)) {
    const ok = sanitizeRemoteUrl(u);
    if (ok === undefined) return undefined; // a bad URL in the probe list is not skipped: the whole record is untrusted
    cleanUrls.push(ok);
  }
  if (!isRecord(resolved)) return undefined;
  if (resolved.source !== "npm" && resolved.source !== "pypi") return undefined;
  if (typeof resolved.resolvedAt !== "string" || Number.isNaN(Date.parse(resolved.resolvedAt))) return undefined;
  const metadataUrl = sanitizeRemoteUrl(resolved.metadataUrl);
  if (metadataUrl === undefined || !METADATA_HOSTS.has(new URL(metadataUrl).hostname)) return undefined;
  const meta: ResolvedMeta = { source: resolved.source, resolvedAt: resolved.resolvedAt, metadataUrl };
  const homepage = sanitizeRemoteUrl(resolved.homepage);
  const docsUrl = sanitizeRemoteUrl(resolved.docsUrl);
  if (homepage) meta.homepage = redactUrlForDisplay(homepage);
  if (docsUrl) meta.docsUrl = redactUrlForDisplay(docsUrl);
  const entry: LibraryEntry = { name, urls: cleanUrls, allowedHosts: derivedAllowedHosts(meta), resolved: meta };
  const versionedDocuments = toVersionedDocuments(record.versionedDocuments);
  if (record.versionedDocuments !== undefined && versionedDocuments === undefined) return undefined;
  if (versionedDocuments?.length) entry.versionedDocuments = versionedDocuments;
  const desc = cleanDescription(description);
  if (desc) entry.description = desc;
  return entry;
}

/** Every valid persisted resolution, in file order; [] when the file is missing, corrupt, of
 *  an unsupported schema, OR (PAR-859) a symlink rather than the regular file `saveResolvedEntry` writes
 *  — `isRegularFile` (`atomic-store.ts`, `lstat`, never `stat`) refuses to follow a link planted
 *  at `resolved.json`'s own path. Closes more than a served-and-discarded read: `saveResolvedEntry`
 *  below calls this function to merge a new entry into the existing list before writing back, so
 *  before this guard a planted symlink's attacker-authored entry would have been READ, MERGED,
 *  AND PERSISTED into the real file on the next save (see `test/resolved-store.test.ts`'s
 *  poisoning test, which proves the planted entry specifically, not just that the save "worked").
 *
 *  code-reviewer (Phase 1b review round) PROVED with an executed probe that the leaf check above
 *  is not enough on its own: `isRegularFile`/`lstat` only inspects the FINAL path component, so a
 *  symlinked cache ROOT (an intermediate component of `resolvedStorePath()`, not the leaf) whose
 *  target genuinely holds a real `resolved.json` was still followed for traversal and its content
 *  served in full — the leaf-only guard never even saw a symlink. `isRealDirectory(cacheRoot())`
 *  (`cache.ts`, `lstat`, already exported and reused by `readCache`/`touchCache` for the identical
 *  reason) closes it: a symlinked root reads as absent before the leaf is ever inspected, matching
 *  `readCache`'s own root-then-leaf ordering. */
export function readResolvedEntries(): LibraryEntry[] {
  if (!isRealDirectory(cacheRoot())) return [];
  if (!isRegularFile(resolvedStorePath())) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolvedStorePath(), "utf8"));
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.entries)) return [];
  // Schema 2 adds optional versioned documents. Schema-1 resolutions remain valid and
  // pass the same record validation below; a later save upgrades them without losing entries.
  if (parsed.schemaVersion !== 1 && parsed.schemaVersion !== RESOLVED_SCHEMA_VERSION) return [];
  const out: LibraryEntry[] = [];
  const seen = new Set<string>();
  for (const raw of parsed.entries) {
    const e = toResolvedEntry(raw);
    if (e && !seen.has(e.name)) {
      seen.add(e.name);
      out.push(e);
    }
  }
  // PAR-991: older writes could retain package-registry homepage/docsUrl query tokens.
  // Reading is deliberately non-mutating: rewriting here could overwrite a concurrent
  // save or a newer schema. Tell the operator that the old file needs manual cleanup.
  const hasLegacyQuery = parsed.entries.some((raw) =>
    isRecord(raw) && isRecord(raw.resolved) &&
    (typeof raw.resolved.homepage === "string" && raw.resolved.homepage.includes("?") ||
      typeof raw.resolved.docsUrl === "string" && raw.resolved.docsUrl.includes("?")));
  if (hasLegacyQuery) {
    const path = resolvedStorePath();
    if (!warnedLegacyQueryFiles.has(path)) {
      warnedLegacyQueryFiles.add(path);
      process.stderr.write("vibectx: legacy resolved.json may contain private URL query tokens; delete resolved.json from the VibeCTX cache directory to remove them (package resolution will rebuild it)\n");
    }
  }
  return out;
}

function toRecord(e: LibraryEntry): Record<string, unknown> {
  // allowedHosts is deliberately not written: it is derived on every load.
  return {
    name: e.name,
    urls: e.urls,
    ...(e.description ? { description: e.description } : {}),
    ...(e.versionedDocuments?.length ? { versionedDocuments: e.versionedDocuments } : {}),
    resolved: e.resolved,
  };
}

/** Keep the same bounded pin history in the live registry and on disk. An ecosystem switch
 * identifies a different package even when its name is identical, so its old pins cannot carry over. */
export function mergedVersionedDocuments(existing: LibraryEntry | undefined, incoming: LibraryEntry): VersionedDocument[] | undefined {
  const prior = existing?.resolved?.source === incoming.resolved?.source ? existing?.versionedDocuments : undefined;
  const documents = new Map(prior?.map((document) => [document.version, document]));
  for (const document of incoming.versionedDocuments ?? []) documents.set(document.version, document);
  const merged = [...documents.values()];
  return merged.length > 0 ? merged.slice(-MAX_VERSIONED_DOCUMENTS) : undefined;
}

/**
 * Persist one resolution: read the current file, replace-or-append by name, write to
 * a temp file in the same directory and rename over the original (readers see the old
 * or the new file, never a partial one). Returns false (with a note via `warn`) when
 * the file belongs to a NEWER schema version; an older one is replaced. Two processes saving at the same instant
 * can still lose one another's *record* (last writer wins) — acceptable for a
 * single-user local tool; the file is never corrupt.
 */
export function saveResolvedEntry(entry: LibraryEntry, warn: (message: string) => void = (m) => writeStderrWarning(m)): boolean {
  if (!entry.resolved) throw new Error(`saveResolvedEntry: "${entry.name}" is not a resolved entry`);
  const valid = toResolvedEntry(toRecord(entry));
  if (!valid) throw new Error(`saveResolvedEntry: "${entry.name}" does not pass resolved-record validation`);
  const dir = cacheRoot();
  // PAR-805: owner-only (0700), and warns once if the root pre-existed looser. Wrapped, not
  // passed straight through: a caller-supplied `warn` here may append no newline of its own
  // (this module's default, `writeStderrWarning`, ends every warning with exactly one since
  // PAR-1044 L-5), which would otherwise run `ensureCacheRoot`'s message into whatever this
  // process writes to stderr next (code-reviewer, PAR-805 review round). `ensureCacheRoot` cannot
  // fix this centrally: it has no way to inspect whether the `warn` it was given already appends
  // a newline, so appending one itself would double it for callers that already do.
  //
  // PAR-859: a symlinked `dir` is now refused by `ensureCacheRoot` itself (returns `false`,
  // warns once) rather than silently written through — bail here, writing nothing, exactly as
  // the K2 "newer schema" refusal below already does.
  if (!ensureCacheRoot(dir, (m) => warn(`${m}\n`))) return false;
  const path = resolvedStorePath();
  const newer = newerSchemaVersion(path, RESOLVED_SCHEMA_VERSION);
  if (newer !== undefined) {
    // K2: a file written by a NEWER vibectx is not ours to rewrite; the resolution stays in memory.
    // An OLDER schemaVersion is ours to replace (aligned with the project store, PAR-656).
    warn(`vibectx: not saving "${valid.name}" — ${path} has a newer schemaVersion ${newer} (this version writes ${RESOLVED_SCHEMA_VERSION}); upgrade vibectx or delete the file\n`);
    return false;
  }
  const entries = readResolvedEntries();
  // PAR-825/D-90 — dedup by exact name UNLESS both the incoming and the candidate record are
  // PyPI: two PyPI spellings of the same project (`typing-extensions` / `typing_extensions`)
  // should collapse to one persisted record (PEP 503 identity), but an npm or mixed-ecosystem
  // pair must never fold on spelling alone — the same ecosystem-scoped rule `registry.ts`
  // applies to load-time merge and lookup (PAR-854), applied here to the persisted store so it
  // cannot grow an unbounded number of records for what is really one npm/PyPI resolution
  // resolved twice under different punctuation, while never conflating two independently
  // valid, differently-spelled npm (or mixed-ecosystem) names.
  const isTwin = (e: LibraryEntry): boolean =>
    valid.resolved?.source === "pypi" && e.resolved?.source === "pypi"
      ? normalisePyPiName(e.name) === normalisePyPiName(valid.name)
      : e.name === valid.name;
  const at = entries.findIndex(isTwin);
  if (at === -1) entries.push(valid);
  else {
    const versionedDocuments = mergedVersionedDocuments(entries[at], valid);
    entries[at] = { ...valid, ...(versionedDocuments ? { versionedDocuments } : {}) };
  }
  // PAR-805 (F-7 file-mode half): owner-only, self-healing across every write (writeAtomic's own comment).
  writeAtomic(path, JSON.stringify({ schemaVersion: RESOLVED_SCHEMA_VERSION, entries: entries.map(toRecord) }, null, 2), { mode: 0o600 });
  return true;
}
