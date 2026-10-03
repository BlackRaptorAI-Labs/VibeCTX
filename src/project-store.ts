import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isRegularFile, newerSchemaVersion, writeAtomic } from "./atomic-store.js";
import { cacheRoot, ensureCacheRoot, isRealDirectory } from "./cache.js";
import { validIsoInstant } from "./cache-meta.js";
import { redactUrlForDisplay, sanitizeRemoteUrl } from "./link-policy.js";
import type { DependencyEcosystem } from "./project-deps.js";
import { cleanText } from "./text.js";
import { writeStderrWarning } from "./redact-paths.js";
import { MAX_NAME_LENGTH } from "./package-names.js";

/**
 * Project records for `vibectx warm` (PAR-656): `<cacheRoot>/projects/<hash>.json`, one
 * per project directory. Schema 3 stores a directory hash instead of the personal path;
 * the `dir` field remains in the in-memory ProjectRecord only.
 * `hash` is the first 32 hex characters of SHA-256 over the normalised absolute path, so
 * nothing about the path (which may be long, or contain characters the filesystem
 * dislikes) is in the file name.
 *
 * Same discipline as resolved.json — and the same reason: the cache directory is a trust
 * boundary, so the file is written atomically (temp file + rename) and EVERY field is
 * re-validated on read against the rule that field has, not merely typechecked. In full
 * (K1): schema 3's `dirHash` must match the directory asked for (schema 2's legacy
 * `dir` is accepted only when it matches exactly),
 * `manifests` must be an array of bounded strings (each cleaned), `warmedAt` must be a strict
 * ISO-8601 UTC instant (`Date.parse` alone accepts `2020-01-01 (‮evil)`, and that string
 * lands verbatim in the list_libraries footer), and `dependencies` must be an array — any of
 * those failing makes the record absent. Then, per row: `name` 1…214 characters, `ecosystem`
 * exactly npm or pypi, `source` a relative manifest path (bounded, no absolute path, no `..`
 * segment — any alphabet),
 * `status` one of WARM_STATUSES and `failedAt` a strict ISO-8601 instant when present — each
 * of those failing drops the ROW; `library`
 * over 214 characters and a `url` that is not an https URL passing `sanitizeRemoteUrl` drop
 * that FIELD; a `note` over 512 characters is truncated on read, while new writes omit
 * path-bearing notes. Every surviving string passes through `cleanText`. A corrupt file
 * reads as absent. Upgrade policy (K2): schema 2 is read for its recent-failure memo and
 * replaced on the next write; still older versions are ignored on read and replaced (an older
 * vibectx wrote it; this version owns the format now); a HIGHER one is ignored on read and
 * never overwritten (a newer vibectx owns it — refuse, with a note on stderr). A record
 * whose identity does not match the directory asked for is treated as absent.
 *
 * The record is read for one decision only (R3): a dependency it shows `unresolved` with a
 * `failedAt` inside the last 24 h is reported `unresolved (recent)` on the next run without
 * spending a resolution slot, unless `--force`. Nothing else consults it.
 */

/** Bumped when a key is renamed, removed or changes meaning — and when a WarmStatus value is
 *  added or removed (K3): a reader validates `status` against WARM_STATUSES and drops rows
 *  with an unknown one, so a new value under the same version would silently lose rows for
 *  older readers. The ACCEPTED TIMESTAMP SHAPE is part of schemaVersion 1 on the same
 *  grounds: `warmedAt` and `failedAt` are strict ISO-8601 UTC instants (`…Z`), and a reader
 *  of this version treats any other shape as a corrupt record (`warmedAt`) or a bad row
 *  (`failedAt`) — so widening it, to an offset like `+01:00` for instance, requires a version
 *  bump exactly as the status vocabulary does. Version 1 is the first shipped shape (0.2.0).
 *
 *  Bumped to 2 (A16/PAR-725): "not found" added to WARM_STATUSES — the existence signal (a
 *  dependency name that does not exist in npm or PyPI, distinct from `unresolved`'s "exists,
 *  no reachable docs"). Per the K3 rule above: a reader still on version 1 that saw a "not
 *  found" row under an unchanged schemaVersion would silently drop it with no warning; the
 *  bump makes that reader refuse the whole file instead (K2's "newer schemaVersion" note),
 *  which is the honest failure mode. Schema 3 (PAR-993) replaces persisted `dir` with its
 *  full hash and omits path-bearing free-text row notes. */
export const PROJECT_RECORD_SCHEMA_VERSION = 3;
const warnedLegacyProjectRecords = new Set<string>();

export type WarmStatus =
  | "cached"
  | "already fresh"
  | "resolved+cached"
  | "unresolved"
  | "unresolved (recent)"
  | "not found"
  | "denied (noise list)"
  | "skipped (rate cap)"
  | "unreachable";

export const WARM_STATUSES: readonly WarmStatus[] = [
  "cached",
  "already fresh",
  "resolved+cached",
  "unresolved",
  "unresolved (recent)",
  "not found",
  "denied (noise list)",
  "skipped (rate cap)",
  "unreachable",
];

/** Statuses that mean "get_docs answers this name from disk right now". */
export const CACHED_STATUSES: ReadonlySet<WarmStatus> = new Set(["cached", "already fresh", "resolved+cached"]);

export interface WarmRow {
  /** The dependency as discovered (npm name as written; PyPI name in PEP 503 form). */
  name: string;
  ecosystem: DependencyEcosystem;
  /** Manifest file the name came from, relative to the project directory. */
  source: string;
  /** Registry entry that served it (canonical name), when one did. */
  library?: string;
  status: WarmStatus;
  /** The URL that is (now) cached, when one is. */
  url?: string;
  /** One plain phrase of detail: why unresolved, that a stale copy was kept, … */
  note?: string;
  /** ISO time of the resolution failure behind an `unresolved` / `unresolved (recent)` row —
   *  the memo's clock (R3); carried over unchanged while the memo holds. */
  failedAt?: string;
}

export interface ProjectRecord {
  schemaVersion: typeof PROJECT_RECORD_SCHEMA_VERSION;
  /** Absolute, normalised project directory. */
  dir: string;
  manifests: string[];
  dependencies: WarmRow[];
  /** ISO timestamp of the warm run that wrote the record. */
  warmedAt: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

/** Normalised absolute form of a project directory — hashed on disk, kept in memory for reports. */
export function normaliseProjectDir(dir: string): string {
  return resolve(dir);
}

function projectDirHash(dir: string): string {
  return createHash("sha256").update(normaliseProjectDir(dir)).digest("hex");
}

export function projectRecordPath(dir: string): string {
  const hash = projectDirHash(dir).slice(0, 32);
  return join(cacheRoot(), "projects", `${hash}.json`);
}

/**
 * Build a row with its keys in the documented order (K1): name, ecosystem, source, library?,
 * status, url?, note?, failedAt?. Every writer goes through here, which makes it the one
 * place S3 has to hold: each free-text field passes through `cleanText`, so a control, bidi
 * or zero-width character out of a manifest, a resolver message or a previous project record
 * cannot reach the table, the tool's text, OR the `--json` report — the renderers clean
 * again, but the JSON has no renderer to clean it.
 */
export function makeWarmRow(fields: {
  name: string;
  ecosystem: DependencyEcosystem;
  source: string;
  library?: string;
  status: WarmStatus;
  url?: string;
  note?: string;
  failedAt?: string;
}): WarmRow {
  const { ecosystem, status } = fields;
  const name = cleanText(fields.name);
  const source = cleanText(fields.source);
  const library = fields.library === undefined ? undefined : cleanText(fields.library);
  const row: WarmRow = library !== undefined ? { name, ecosystem, source, library, status } : { name, ecosystem, source, status };
  // PAR-806/PAR-815 (Phase 4) — `url` is display-only here (verified: `readProjectRecord`'s
  // result is used for `warmedAt`/`recentFailures` decisions keyed by name+ecosystem, never by
  // this field — see `warm.ts`'s `recentFailures`), so it is safe to redact at write time,
  // closing BOTH the on-disk project-record leak (PAR-806) and the `warm_project` table/`--json`
  // `url` column (PAR-815) with one fix: `formatWarmTable` and the MCP tool both render this
  // same `WarmRow.url`, and `warm --json` serializes it directly.
  if (fields.url !== undefined) row.url = cleanText(redactUrlForDisplay(fields.url));
  if (fields.note !== undefined) row.note = cleanText(fields.note);
  if (fields.failedAt !== undefined) row.failedAt = fields.failedAt;
  return row;
}

/** Longest `name` / `library`: npm's published package-name limit. */
const MAX_NAME = MAX_NAME_LENGTH;
/** Longest `source`: a manifest file name, possibly one directory deep. */
const MAX_SOURCE = 256;
/** Longest `note`: one plain phrase of detail, truncated with an ellipsis past this. */
export const MAX_NOTE = 512;

/**
 * A `source` is a manifest file name relative to the project directory — `package.json`,
 * `requirements-dev.txt`, `sub/requirements.txt`. The reader refuses it for what it DOES,
 * never for its alphabet: a real project directory may be named `треб/`, `req dir/` or
 * `req+dev/`, and an allow-list of ASCII punctuation would drop those rows as if the file
 * were hostile. So the rule is the property that matters — the path must be RELATIVE and must
 * not traverse — checked on the CLEANED text, since `cleanText` is what the row will actually
 * carry (`a U+200B before /etc/passwd` cleans to an absolute path and must be refused as one):
 *
 *   - no NUL in the raw value (`cleanText` would strip it, hiding a truncation trick),
 *   - bounded by MAX_SOURCE and non-empty once cleaned,
 *   - not absolute: no leading `/`, no leading `\` (a Windows root or a `\\server\share` UNC),
 *     no `X:` drive prefix,
 *   - no `..` segment, splitting on BOTH separators — `a/../b` and `a\..\b` alike.
 *
 * Failure drops the ROW. This is a read-side gate only: writers go through `makeWarmRow`, and
 * a source discovered on this machine is never validated on the way out — a path we can read
 * is a path we can record.
 */
const WINDOWS_DRIVE = /^[A-Za-z]:/;
function validSource(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_SOURCE) return false;
  if (value.includes("\u0000")) return false;
  const text = cleanText(value);
  if (text.length === 0) return false;
  if (text.startsWith("/") || text.startsWith("\\") || WINDOWS_DRIVE.test(text)) return false;
  return !text.split(/[/\\]/).includes("..");
}

/**
 * A UTC ISO-8601 instant exactly as `Date.prototype.toISOString` writes it — the only shape
 * anything here ever produces. `Date.parse` alone is far too lenient to validate a timestamp
 * off a trust boundary: it accepts `2020-01-01 (‮evil)`, comment and bidi override and
 * all, and that string is rendered verbatim in the list_libraries footer. Shape first, then
 * `Date.parse` to reject a well-shaped impossibility like `2026-13-45T06:00:00Z`.
 */
/**
 * `manifests` is descriptive — it is echoed, never opened — so each entry is bounded and
 * CLEANED rather than dropped: losing an entry would misreport what the run read, while a
 * bidi override in one must never survive into anything that renders it. An entry that is
 * empty, over the cap, or empty once cleaned makes the record absent: our writer never
 * produces one, so the file is not ours.
 */
function cleanManifests(value: unknown): string[] | undefined {
  if (!isStringList(value)) return undefined;
  const out: string[] = [];
  for (const raw of value) {
    if (raw.length === 0 || raw.length > MAX_SOURCE) return undefined;
    const text = cleanText(raw);
    if (text.length === 0) return undefined;
    out.push(text);
  }
  return out;
}

/** One plain line of at most MAX_NOTE characters; truncated, never dropped — the reason a
 *  name failed is worth showing even when whatever wrote the file was over-generous. */
function cleanNote(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const text = cleanText(value);
  if (text.length === 0) return undefined;
  return text.length > MAX_NOTE ? `${text.slice(0, MAX_NOTE - 1)}…` : text;
}

/**
 * Validate one persisted row (K1). The file is a trust boundary — anything with write access
 * to the cache directory can put a row here, and every field lands in a table a person and a
 * model both read — so each field is re-validated with the rule that field actually has:
 *
 *   name       required, 1…214 characters       — row dropped otherwise
 *   ecosystem  exactly "npm" or "pypi"          — row dropped otherwise
 *   source     a relative, non-traversing path  — row dropped otherwise (see validSource:
 *              ≤ 256 characters, non-empty once cleaned, no NUL, not absolute (no leading
 *              `/` or `\`, no `X:` drive), no `..` segment on either separator. Any other
 *              character is fine — `треб/extra.txt` is a real manifest path, not an attack.)
 *   status     one of WARM_STATUSES             — row dropped otherwise (K3)
 *   failedAt   a strict ISO-8601 instant when present — row dropped otherwise
 *   library    1…214 characters                 — FIELD dropped otherwise
 *   url        passes sanitizeRemoteUrl (https, no credentials, no forbidden host)
 *                                               — FIELD dropped otherwise
 *   note       ≤ 512 characters                 — TRUNCATED, never dropped
 *
 * Every surviving string also passes through `cleanText`, so no control, bidi or zero-width
 * character reaches the renderer (S3).
 */
function toWarmRow(raw: unknown): WarmRow | undefined {
  if (!isRecord(raw)) return undefined;
  const { name, ecosystem, source, library, status, url, note, failedAt } = raw;
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_NAME) return undefined;
  if (ecosystem !== "npm" && ecosystem !== "pypi") return undefined;
  if (!validSource(source)) return undefined;
  if (typeof status !== "string" || !(WARM_STATUSES as readonly string[]).includes(status)) return undefined; // K3: unknown status → row dropped
  if (failedAt !== undefined && !validIsoInstant(failedAt)) return undefined;
  return makeWarmRow({
    name,
    ecosystem,
    source,
    library: typeof library === "string" && library.length > 0 && library.length <= MAX_NAME ? library : undefined,
    status: status as WarmStatus,
    url: sanitizeRemoteUrl(url),
    note: cleanNote(note),
    failedAt: typeof failedAt === "string" ? failedAt : undefined,
  });
}

/**
 * Validate a parsed file into a ProjectRecord for `dir`; undefined when anything essential is
 * off. Schema 3 verifies the full directory hash; schema 2 verifies its legacy directory.
 * `warmedAt` is a strict ISO-8601 instant and `manifests` are bounded and cleaned.
 */
export function toProjectRecord(parsed: unknown, dir: string): ProjectRecord | undefined {
  if (!isRecord(parsed)) return undefined;
  if (parsed.schemaVersion === 2) {
    if (parsed.dir !== normaliseProjectDir(dir)) return undefined;
  } else if (parsed.schemaVersion === PROJECT_RECORD_SCHEMA_VERSION) {
    if (parsed.dirHash !== projectDirHash(dir)) return undefined;
  } else return undefined;
  const manifests = cleanManifests(parsed.manifests);
  if (manifests === undefined || !Array.isArray(parsed.dependencies)) return undefined;
  if (!validIsoInstant(parsed.warmedAt)) return undefined;
  const dependencies: WarmRow[] = [];
  for (const raw of parsed.dependencies) {
    const row = toWarmRow(raw);
    if (row) dependencies.push(row);
  }
  return { schemaVersion: PROJECT_RECORD_SCHEMA_VERSION, dir: normaliseProjectDir(dir), manifests, dependencies, warmedAt: parsed.warmedAt };
}

/** The record for `dir`, or undefined when absent, corrupt, of an unsupported schema, for another dir,
 *  or (PAR-859) a symlink rather than the regular file `writeProjectRecord` writes —
 *  `isRegularFile` (`atomic-store.ts`, `lstat`, never `stat`) refuses to follow a link planted at
 *  this project's record path. `writeProjectRecord` does NOT read this function's result to merge
 *  before writing (CONFIRMED by reading it: it serialises the `record` argument it was handed
 *  directly), so this closes a served-and-discarded read only, not a read-merge-persist one —
 *  contrast `resolved-store.ts`'s `readResolvedEntries` and `doctor-store.ts`'s
 *  `readDoctorVerdicts`, which are both.
 *
 *  code-reviewer (Phase 1b review round) PROVED the leaf-only guard above is not enough alone: a
 *  symlinked cache ROOT (an intermediate component of `projectRecordPath(dir)`, not the leaf
 *  `isRegularFile` inspects) whose target genuinely holds a real record is resolved for traversal
 *  regardless, so the leaf check never even sees a symlink. `isRealDirectory(cacheRoot())`
 *  (`cache.ts`, already exported for exactly this reuse by `readCache`/`touchCache`) closes it: a
 *  symlinked root reads as absent before the leaf is inspected at all. */
export function readProjectRecord(dir: string): ProjectRecord | undefined {
  if (!isRealDirectory(cacheRoot())) return undefined;
  if (!isRegularFile(projectRecordPath(dir))) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(projectRecordPath(dir), "utf8"));
  } catch {
    return undefined;
  }
  if (isRecord(parsed) && parsed.schemaVersion === 2 && !warnedLegacyProjectRecords.has(projectRecordPath(dir))) {
    warnedLegacyProjectRecords.add(projectRecordPath(dir));
    process.stderr.write("vibectx: old project records may contain personal paths; stop vibectx and remove old projects/*.json cache memos to clear them\n");
  }
  return toProjectRecord(parsed, dir);
}

/**
 * Write the record for `record.dir` via a temp file and rename (readers see the old or the
 * new file, never a partial one). Returns false, with a note via `warn`, when the file on
 * disk belongs to a NEWER schema version (K2), or the root/projects directory is refused.
 * The optional refusal callback lets report callers distinguish these false outcomes.
 */
export function writeProjectRecord(record: ProjectRecord, warn: (message: string) => void = (m) => writeStderrWarning(m), onRefusal?: (reason: "cache-root" | "projects-directory" | "newer-schema") => void): boolean {
  const dir = normaliseProjectDir(record.dir);
  const path = projectRecordPath(dir);
  // PAR-805: the ROOT first, THEN `projects/` — two `ensureCacheRoot` calls, not one, for the
  // identical reason `cache.ts`'s `writeCache` calls it twice (see that function's own
  // comment): calling it only on `join(cacheRoot(), "projects")` never triggers the
  // pre-existing-loose-ROOT warning at all, because `ensureCacheRoot`'s own check is
  // `dir === cacheRoot()`, which `<root>/projects` can never equal — VERIFIED (this file's own
  // investigation): a root pre-existing at 0777 produced zero warnings through the single-call
  // version of this fix. Calling it on the root first closes that gap; calling it again on
  // `projects/` still creates (or confirms) that subdirectory at 0700 exactly as before.
  const root = cacheRoot();
  // Wrapped: this module's own `warn` default has no trailing newline, unlike
  // `ensureCacheRoot`'s own (`toStderr`) — see `resolved-store.ts`'s identical wrap for the
  // full reasoning. Only the ROOT call ever actually emits a message (the subdirectory can
  // never equal `cacheRoot()`), but both are wrapped identically for consistency.
  const emit = (m: string): void => warn(`${m}\n`);
  // PAR-859: each call now checked and bailed on independently, not just chained — a symlink
  // could be planted specifically at `projects/` with a perfectly real root (or vice versa), so
  // the root being refused must stop this function BEFORE it even attempts the subdirectory call,
  // and the subdirectory being refused (with a real root) must stop it just the same.
  if (!ensureCacheRoot(root, emit)) { onRefusal?.("cache-root"); return false; }
  if (!ensureCacheRoot(join(root, "projects"), emit)) { onRefusal?.("projects-directory"); return false; }
  const newer = newerSchemaVersion(path, PROJECT_RECORD_SCHEMA_VERSION);
  if (newer !== undefined) {
    onRefusal?.("newer-schema");
    warn(
      `vibectx: not writing the project record for ${dir} — ${path} has a newer schemaVersion ${newer} (this version writes ${PROJECT_RECORD_SCHEMA_VERSION}); upgrade vibectx or delete the file\n`,
    );
    return false;
  }
  const body = JSON.stringify(
    {
      schemaVersion: PROJECT_RECORD_SCHEMA_VERSION,
      dirHash: projectDirHash(dir),
      manifests: record.manifests,
      dependencies: record.dependencies.map((row) => ({ ...row, note: row.note !== undefined && /[/\\]/.test(row.note) ? undefined : row.note })),
      warmedAt: record.warmedAt,
    },
    null,
    2,
  );
  // PAR-805 (F-7 file-mode half): owner-only, self-healing across every write.
  writeAtomic(path, body, { mode: 0o600 });
  return true;
}

/** The one line list_libraries appends when a record exists for the working directory. S3:
 *  `dir` and `warmedAt` pass through `cleanText` here as well as being validated on read —
 *  this function is the render boundary, and it must hold for any ProjectRecord it is handed,
 *  not only for one that came back through `toProjectRecord`. */
export function summariseProjectRecord(record: ProjectRecord, opts: { redactDir?: boolean } = {}): string {
  let cached = 0;
  let denied = 0;
  let unresolved = 0;
  for (const row of record.dependencies) {
    if (CACHED_STATUSES.has(row.status)) cached += 1;
    else if (row.status === "denied (noise list)") denied += 1;
    else unresolved += 1;
  }
  return `Project deps (${opts.redactDir ? "[redacted]" : cleanText(record.dir)}): ${cached} cached, ${unresolved} unresolved, ${denied} denied — warmed ${cleanText(record.warmedAt)}`;
}
