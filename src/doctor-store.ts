import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRegularFile, newerSchemaVersion, writeAtomic } from "./atomic-store.js";
import { cacheRoot, ensureCacheRoot, isRealDirectory } from "./cache.js";
import { validIsoInstant } from "./cache-meta.js";
import { MAX_DOCTOR_VERDICTS } from "./limits.js";
import { clipText } from "./text.js";
import type { SourceKind } from "./source-kind.js";
import { writeStderrWarning } from "./redact-paths.js";

/**
 * Persistence for `vibectx doctor`'s per-library verdict (A19/PAR-728): `<cacheRoot>/doctor.json`,
 * shape `{ schemaVersion: 1, verdicts: [ { name, kind, healthy, reasons, checkedAt } ] }`.
 *
 * `runDoctor` computes `LibraryReport[]` fresh, in memory, on every call — nothing persisted it
 * before this. Without a persisted verdict, `list_libraries` and `get_docs` have no way to warn
 * that a library which LOOKS cached and healthy actually failed its last probe (the PAR-704
 * fastify shape: index-only, topic queries return "No sections matched", yet `list_libraries`
 * reported it cached with no error) short of re-running a probe on every call — which
 * `list_libraries` is documented never to do (it touches only the cache) and `get_docs` cannot
 * afford per response. So doctor's verdict is written here once, and read back cheaply.
 *
 * The file is a trust boundary (K1, mirroring `resolved-store.ts`): anything with write access
 * to the cache directory can edit it, so every record is re-validated field by field on read —
 * ONE invalid field drops the WHOLE record (never a partially-trusted one, matching
 * `resolved-store.ts`'s own `urls` handling: "a bad element is not skipped, the whole record is
 * untrusted") — and a corrupt file reads as empty rather than throwing.
 *
 * security-architect (A19/PAR-728 round 1, S-1, BLOCKING): the cache directory — and so this
 * file — is process-global, while a library's registry entry, URLs and config are PER PROJECT.
 * Persisting `reasons` (built in part from config-authored `probeQueries` text, and from raw
 * error messages that can carry filesystem paths or internal hostnames) and rendering it in
 * ANOTHER project's `list_libraries`/`get_docs` output would leak that text across a boundary
 * neither side chose. Fixed by never rendering `reasons` in a cross-project-visible surface at
 * all — `list-libraries.ts` and `get-docs.ts` render only the closed `kind` enum and the
 * `checkedAt` date, never free text. `reasons` is still persisted (useful for a same-project
 * `vibectx doctor --json` reader) and still cleaned/clipped here on read, as defence in depth,
 * but no caller may treat that cleaning as sufficient to render it across a project boundary.
 */

export const DOCTOR_STORE_SCHEMA_VERSION = 1;
const FILE_NAME = "doctor.json";
/** A `Record`, not a `readonly SourceKind[]` — this literal fails to compile the moment
 *  `SourceKind` (source-kind.ts) gains a member this file does not also list (security-architect
 *  round 1, N-4), rather than silently rejecting every verdict of the new kind at runtime. */
const SOURCE_KINDS: Record<SourceKind, true> = { "full-text": true, "index-only": true, readme: true, unreachable: true };
/** ASSUMED: generous headroom over any real library name (`registry.ts`'s canonical names are
 *  short, human-picked identifiers), matching the bound `resolved-store.ts` uses for the same
 *  field's own persisted copy. */
const MAX_NAME_CHARS = 300;
/** ASSUMED: matches `list-libraries.ts`'s own `MAX_LIBRARY_FIELD_CHARS` headroom for a one-line
 *  row field. */
const MAX_REASON_CHARS = 300;
/** ASSUMED: doctor.ts's own `reasons` never carries more than a handful (one per unhealthy
 *  condition plus at most one per configured probe query); this is generous headroom over that,
 *  not a measured ceiling. */
const MAX_REASONS = 10;
/** Longest RAW `reasons` array `toDoctorVerdict` will even look at, well above `MAX_REASONS`
 *  (security-architect round 1, N-3) — bounds the cost of validating one record to a constant
 *  regardless of how large a forged array is, rather than filtering/slicing the whole thing
 *  first and only then discovering it was too long. A record whose raw array exceeds this is
 *  treated as malformed (the whole record dropped), the same as an over-length `name`. */
const MAX_RAW_REASONS = MAX_REASONS * 10;

export interface DoctorVerdict {
  name: string;
  kind: SourceKind;
  healthy: boolean;
  reasons: string[];
  /** ISO, when this verdict was computed (`DoctorReport.generatedAt`). Rendered to the reader
   *  wherever the verdict itself is (A19/PAR-728, code-reviewer round 1, B3) — an unhealthy
   *  verdict with no date reads as a present-tense fact forever, even long after the library
   *  was fixed and simply never re-checked. */
  checkedAt: string;
}

export function doctorStorePath(): string {
  return join(cacheRoot(), FILE_NAME);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** K1: every field re-checked against its own rule; the whole record is dropped, never
 *  partially trusted, the moment one field — including one element of `reasons` — fails. */
function toDoctorVerdict(raw: unknown): DoctorVerdict | undefined {
  if (!isRecord(raw)) return undefined;
  const { name, kind, healthy, reasons, checkedAt } = raw;
  // S2 (resolved-store.ts precedent): keys are folded, so a persisted "React" can never shadow
  // "react" — `entry.name` is always already trim().toLowerCase()'d (registry.ts's `fold`).
  if (typeof name !== "string" || name !== name.trim().toLowerCase() || name.length === 0 || name.length > MAX_NAME_CHARS) {
    return undefined;
  }
  if (typeof kind !== "string" || !(kind in SOURCE_KINDS)) return undefined;
  if (typeof healthy !== "boolean") return undefined;
  // security-architect round 1, S-3a: `ISO_INSTANT` bounds the shape (and so the length) of
  // `checkedAt` — `Date.parse` alone accepts an arbitrarily long fractional-seconds run as a
  // finite timestamp (cache-meta.ts's own MEASURED finding), which `Number.isFinite(Date.parse(...))`
  // alone would not have caught.
  if (!validIsoInstant(checkedAt)) return undefined;
  if (!Array.isArray(reasons) || reasons.length > MAX_RAW_REASONS) return undefined;
  const cleanReasons: string[] = [];
  for (const r of reasons.slice(0, MAX_REASONS)) {
    if (typeof r !== "string") return undefined; // one bad element: the whole record is untrusted
    cleanReasons.push(clipText(r, MAX_REASON_CHARS));
  }
  return { name, kind: kind as SourceKind, healthy, reasons: cleanReasons, checkedAt };
}

/** Every persisted verdict, keyed by library name. A corrupt file, a schema mismatch, or any
 *  read error all read as empty (K1) — a missing verdict means "doctor has not reported on this
 *  library," never a crash for a caller on the get_docs / list_libraries hot path. Also empty for
 *  a symlink planted at `doctor.json`'s own path (PAR-859, `isRegularFile`, `atomic-store.ts`) —
 *  never followed. This closes more than a served-and-discarded read: `saveDoctorVerdicts` below
 *  calls this function to merge new verdicts into the existing set before writing back, so before
 *  this guard a planted symlink's attacker-authored verdict would have been READ, MERGED, AND
 *  PERSISTED into the real file on the next save — the same shape `resolved-store.ts`'s
 *  `saveResolvedEntry`/`readResolvedEntries` has (see that module's own comment), closed here for
 *  the identical reason (`test/doctor-store.test.ts`'s equivalent poisoning test).
 *
 *  code-reviewer (Phase 1b review round) PROVED the leaf-only guard above is not enough alone: a
 *  symlinked cache ROOT (an intermediate path component, not the leaf `isRegularFile` inspects)
 *  whose target genuinely holds a real `doctor.json` is resolved for traversal regardless, so the
 *  leaf check never even sees a symlink. `isRealDirectory(cacheRoot())` (`cache.ts`, already
 *  exported for exactly this reuse by `readCache`/`touchCache`) closes it: a symlinked root reads
 *  as absent before the leaf is inspected at all. */
export function readDoctorVerdicts(warn: (message: string) => void = (message) => writeStderrWarning(message)): Map<string, DoctorVerdict> {
  if (!isRealDirectory(cacheRoot())) return new Map();
  if (!isRegularFile(doctorStorePath())) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(doctorStorePath(), "utf8"));
  } catch {
    warn("vibectx: doctor.json is corrupt or unreadable; previous doctor verdicts were not loaded. Run doctor again.");
    return new Map();
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== DOCTOR_STORE_SCHEMA_VERSION || !Array.isArray(parsed.verdicts)) {
    warn("vibectx: doctor.json has an invalid or unsupported shape; previous doctor verdicts were not loaded. Run doctor again with a compatible version.");
    return new Map();
  }
  const out = new Map<string, DoctorVerdict>();
  let discarded = 0;
  for (const raw of parsed.verdicts) {
    const v = toDoctorVerdict(raw);
    if (v) out.set(v.name, v);
    else discarded++;
  }
  if (discarded > 0) warn("vibectx: doctor.json contains invalid verdict records; those records were discarded. Valid verdicts were retained. Run doctor again.");
  return out;
}

function toRecord(v: DoctorVerdict): Record<string, unknown> {
  return { name: v.name, kind: v.kind, healthy: v.healthy, reasons: v.reasons, checkedAt: v.checkedAt };
}

/**
 * Merge `verdicts` into the persisted store: replace-or-append by name, so a `--library` run
 * leaves every other library's last verdict untouched. Bounded to `MAX_DOCTOR_VERDICTS`
 * (security-architect round 1, S-3b) — oldest (by `checkedAt`) dropped first once the merged
 * set would exceed it, the same rule `activity-log.ts` applies to its own entry cap.
 *
 * K2: a file with a NEWER schemaVersion than this process knows was written by a newer vibectx
 * and is left alone — returns `false`, with a note via `warn`, rather than overwriting it.
 * Mirrors `resolved-store.ts`'s `saveResolvedEntry` / `project-store.ts`'s `writeProjectRecord`
 * exactly: no blanket try/catch here — an I/O error (EACCES, a full disk) propagates to the
 * caller, which already has to build its own report notes around this call (D-13) the same way
 * `warm.ts` does around `writeProjectRecord`. `warn` defaults to stderr (security-architect
 * round 1, S-2, BLOCKING) — a no-op default made both the K2 refusal and a write failure
 * permanently silent, the opposite of D-13's "a stderr warn plus a report note, never silent".
 *
 * Each verdict is round-tripped through `toDoctorVerdict(toRecord(v))` before it is trusted to
 * write (security-architect round 1, N-5) — the same "the write side must produce something
 * the read side itself would accept" discipline `saveResolvedEntry` applies — so a future bug
 * upstream (doctor.ts constructing a verdict this store's own read validation would reject)
 * throws here, on the one write this process controls, rather than writing a record only a
 * FUTURE read would discover is malformed.
 */
export function saveDoctorVerdicts(verdicts: DoctorVerdict[], warn: (message: string) => void = (m) => writeStderrWarning(m)): boolean {
  if (verdicts.length === 0) return true;
  const valid = verdicts.map((v) => {
    const checked = toDoctorVerdict(toRecord(v));
    if (!checked) throw new Error(`saveDoctorVerdicts: "${v.name}" does not pass doctor-verdict validation`);
    return checked;
  });
  const path = doctorStorePath();
  const newer = newerSchemaVersion(path, DOCTOR_STORE_SCHEMA_VERSION);
  if (newer !== undefined) {
    warn(`vibectx: not saving doctor verdicts — ${path} has a newer schemaVersion ${newer} (this version writes ${DOCTOR_STORE_SCHEMA_VERSION}); upgrade vibectx or delete the file\n`);
    return false;
  }
  // PAR-805: owner-only (0700), and warns once if the root pre-existed looser. Wrapped: this
  // module's own `warn` default has no trailing newline, unlike `ensureCacheRoot`'s own
  // (`toStderr`) — see `resolved-store.ts`'s identical wrap for the full reasoning.
  //
  // PAR-859: a symlinked root is now refused by `ensureCacheRoot` itself — bail here, writing
  // nothing, exactly as the K2 "newer schema" refusal above already does.
  if (!ensureCacheRoot(cacheRoot(), (m) => warn(`${m}\n`))) return false;
  const existing = readDoctorVerdicts();
  for (const v of valid) existing.set(v.name, v);
  let merged = [...existing.values()];
  if (merged.length > MAX_DOCTOR_VERDICTS) {
    merged = merged.sort((a, b) => b.checkedAt.localeCompare(a.checkedAt)).slice(0, MAX_DOCTOR_VERDICTS);
  }
  // PAR-805 (F-7 file-mode half): owner-only, self-healing across every write.
  writeAtomic(path, JSON.stringify({ schemaVersion: DOCTOR_STORE_SCHEMA_VERSION, verdicts: merged.map(toRecord) }, null, 2), { mode: 0o600 });
  return true;
}
