import { closeSync, constants as fsConstants, fchmodSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync, type Stats } from "node:fs";
import { join } from "node:path";

/**
 * The file-write discipline every store in the cache directory shares (S4 / S-C, PAR-656):
 * the document cache (src/cache.ts), the resolution store (src/resolved-store.ts) and the
 * project records (src/project-store.ts).
 *
 * Write: never write a final path in place. Write a temp file beside the target and rename
 * over it, so a concurrent reader — another vibectx process on the same cache, the startup
 * autowarm beside a tool call — sees the old file or the new one, never a partial one.
 *
 * Sweep: a process killed between `writeFileSync` and `renameSync` leaves the temp file
 * behind, and nothing ever reads or removes it. `sweepTempFiles` deletes those orphans;
 * `sweepCacheTempFiles` runs it over the directories this tool writes temp files into.
 * Best effort throughout: a sweep that cannot run must never fail a warm or a server start.
 */

/** Suffix every temp file here carries: `<target>.<pid>.<ms>.tmp`. */
export const tempPathFor = (path: string): string => `${path}.${process.pid}.${Date.now()}.tmp`;

/** Matches exactly the names `tempPathFor` produces — `.<pid>.<ms>.tmp` — so a file a person
 *  happens to have called `notes.tmp` is never swept. The second group is the `<ms>` stamp.
 *  PAR-1034 (final audit L-7): the stamp must be 13 digits, the width `Date.now()` has had since
 *  2001 and keeps until 2286. Any digits used to match, and age was read from that number, so a
 *  person's `backup.1.2.tmp` counted as an ancient orphan and was deleted. */
export const TEMP_FILE_PATTERN = /\.\d+\.(\d{13})\.tmp$/;

/** A temp file is only an ORPHAN once it is old enough that no writer could still be inside
 *  `writeAtomic`. Below this age it is assumed to be a concurrent writer's in-flight file —
 *  another vibectx process on the same cache, the startup autowarm beside a tool call — and
 *  sweeping it would delete the data that process is about to rename into place. One minute
 *  is far beyond any write here (ASSUMED: the largest document is a few MB) and far below
 *  the interval at which orphans matter, since nothing reads them. */
export const SWEEP_MIN_AGE_MS = 60_000;

/** Write `path` via a temp file in the same directory and an atomic rename. The temp file is
 *  removed if the write fails.
 *
 *  `opts.mode` (PAR-791, defaulted to `0o600` by PAR-862): the permission bits the TEMP file is
 *  created with. PAR-862 — every actual caller in this codebase already passes `{ mode: 0o600 }`
 *  explicitly (CONFIRMED: `grep -rln "writeAtomic(" src/*.ts` finds exactly six call sites —
 *  `activity-log.ts`, `cache.ts`, `doctor-store.ts`, `project-store.ts`, `resolved-store.ts`, and
 *  this file's own `writeIndex` caller in `search-index.ts` — every one already `0o600`, none
 *  outside the cache directory), so this default changes no CURRENT caller's behaviour; it exists
 *  so a FUTURE store added to this cache directory that forgets to pass `mode` still gets
 *  owner-only rather than the platform default (`0o666` minus umask) — the same "one shared
 *  function, not six places to remember it" reasoning `ensureCacheRoot` already applies to
 *  directory creation, now applied to file creation too. `renameSync` replaces whatever
 *  permissions `path` already had with the temp file's, so an existing world-readable file from
 *  before a caller started passing (or defaulting to) `mode` is corrected on its very next write,
 *  not merely held steady. Only affects file CREATION (POSIX `open()`'s mode is ignored when the
 *  path already exists) — moot here, since `tempPathFor` names each temp file uniquely
 *  (`<pid>.<ms>`), so it is always newly created.
 *
 *  `flag: "wx"` (PAR-860, `O_CREAT|O_EXCL`): the default `writeFileSync` flag (`"w"`,
 *  `O_WRONLY|O_CREAT|O_TRUNC`) FOLLOWS a symlink already sitting at the destination — and
 *  `tempPathFor`'s name is predictable to within a process id and a millisecond
 *  (`${path}.${pid}.${Date.now()}.tmp`), so an attacker who can predict or race that name could
 *  plant a symlink there ahead of a write. `wx` refuses to open ANY existing entry at that exact
 *  path, symlink or not, even a dangling one — POSIX: `open()` with `O_CREAT|O_EXCL` on a path
 *  naming a symbolic link fails `EEXIST` regardless of what the link points to, never following
 *  it. Safe against a false failure: a genuine collision needs two writes to the IDENTICAL path
 *  in the IDENTICAL millisecond from the IDENTICAL process, and every caller here is
 *  single-threaded and synchronous, so no two calls to this function can ever race each other
 *  within one process, and `tempPathFor`'s own `<pid>` component rules out a collision ACROSS
 *  processes too. The existing `catch` below is already correct for the refusal case: `rmSync` on
 *  a symlink removes the link itself, never the target it points to, so cleanup after a refused
 *  write never touches whatever a planted link aimed at. */
export function writeAtomic(path: string, data: string, opts: { mode?: number } = {}): void {
  const tmp = tempPathFor(path);
  try {
    writeFileSync(tmp, data, { encoding: "utf8", mode: opts.mode ?? 0o600, flag: "wx" });
    renameSync(tmp, path);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* cleanup must not replace the write failure */ }
    throw e;
  }
}

/** The no-follow open flag this platform supports: `O_NOFOLLOW` on POSIX, `undefined` on
 *  Windows, where Node does not define it. */
const PLATFORM_NO_FOLLOW: number | undefined = process.platform === "win32" ? undefined : fsConstants.O_NOFOLLOW;

/** `O_NONBLOCK` where defined (POSIX). A write-only open of a FIFO with no reader otherwise waits
 *  forever, so the `fstat` check below would never run; with it the open fails with ENXIO. It has
 *  no effect on a regular file. */
const NON_BLOCKING_OPEN = fsConstants.O_NONBLOCK ?? 0;

/** Append `data` to the regular file at `path`, creating it with `mode` if absent, and set
 *  `mode` on the file actually opened (PAR-1030, final audit H-1). Never appends to or chmods
 *  whatever a symlink at `path` points at; a symlink or other non-regular file throws, and the
 *  caller's own error handling decides what to report.
 *
 *  `appendFileSync` + `chmodSync(path)` both follow a symlink at the final component, so a link
 *  planted (or swapped in after a caller's own `lstat`) redirected both onto an outside file.
 *  POSIX: `O_NOFOLLOW` makes the open itself fail on a symlink, `O_NONBLOCK` makes it fail on a
 *  FIFO with no reader instead of hanging, and `fstat` refuses a FIFO or device that opened. Windows: no `O_NOFOLLOW`, so see `appendRegularFileWith`'s fallback. */
export function appendRegularFile(path: string, data: string, mode = 0o600): void {
  appendRegularFileWith(path, data, mode, PLATFORM_NO_FOLLOW);
}

/** `appendRegularFile` with the no-follow flag passed in, so tests on POSIX can force the
 *  Windows fallback (`noFollow: undefined`). Production code calls `appendRegularFile`; there is
 *  no environment or config switch that reaches this parameter.
 *
 *  Fallback when `noFollow` is `undefined`: refuse a non-regular entry by `lstat` BEFORE the
 *  open, then, after the open and before any chmod or write, require that `path` is still a
 *  regular file with the same device/inode as the opened descriptor (the check
 *  `readBoundedRegularFile` in cache.ts uses). A swap between the `lstat` and the open is caught
 *  there. Residual: if the swapped-in link points at a path that does not exist, `O_CREAT` can
 *  create that empty file before the check refuses; nothing is written into it. */
export function appendRegularFileWith(path: string, data: string, mode: number, noFollow: number | undefined): void {
  let before: Stats | undefined;
  if (noFollow === undefined) {
    try {
      before = lstatSync(path);
    } catch {
      before = undefined; // absent: the open below creates it
    }
    if (before && !before.isFile()) throw new Error(`refusing to append: ${path} is not a regular file`);
  }
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | NON_BLOCKING_OPEN | (noFollow ?? 0), mode);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error(`refusing to append: ${path} is not a regular file`);
    if (noFollow === undefined) {
      const now = lstatSync(path);
      if (!now.isFile() || now.dev !== opened.dev || now.ino !== opened.ino) {
        throw new Error(`refusing to append: ${path} changed while it was opened`);
      }
    }
    // PAR-791's self-healing owner-only mode for a file created by an older release, applied to
    // the descriptor so it cannot land on a link target.
    fchmodSync(fd, mode);
    const bytes = Buffer.from(data, "utf8");
    for (let offset = 0; offset < bytes.length;) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error(`append to ${path} made no progress`);
      offset += written;
    }
  } finally {
    closeSync(fd);
  }
}

/** Create `path` with `data` only if nothing exists there yet (`O_CREAT | O_EXCL`, which never
 *  follows a symlink), and set `mode` on the new descriptor. Returns `false`, writing nothing,
 *  when an entry already exists; other errors throw (PAR-1039: a rotated log's new live file
 *  must not replace a record another process appended first). */
export function createRegularFileExclusive(path: string, data: string, mode = 0o600): boolean {
  let fd: number;
  try {
    // O_EXCL with O_CREAT already fails on any existing entry, a symlink included; O_NOFOLLOW
    // states it explicitly where the platform defines it.
    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (PLATFORM_NO_FOLLOW ?? 0), mode);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  try {
    fchmodSync(fd, mode);
    const bytes = Buffer.from(data, "utf8");
    for (let offset = 0; offset < bytes.length;) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error(`write to ${path} made no progress`);
      offset += written;
    }
  } finally {
    closeSync(fd);
  }
  return true;
}

/** True only for a REGULAR file — `lstat`, so a symbolic link answers false rather than being
 *  followed to whatever it points at. Any error (the entry vanished, the directory is
 *  unreadable) answers false: the sweep skips what it cannot positively identify.
 *
 *  Exported for the temp-file sweep; bounded store readers use their own `lstatSync` so one
 *  syscall checks both file type and size. */
export function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Remove orphan temp files directly inside `dir` (not recursive; only names matching
 * TEMP_FILE_PATTERN). Every error is swallowed — a missing directory, an unreadable one, a
 * file another process removed first — because this runs on the startup path.
 *
 * S-C symlink rule: the cache directory is a trust boundary, so a name is removed only when
 * `lstat` says it is a REGULAR FILE. A symlink shaped like a temp file is left alone entirely
 * — the sweep must never be the thing that deletes a path outside the cache, and leaving one
 * dangling link is a smaller harm than the alternative being wrong once.
 *
 * Age rule: a name whose embedded `<ms>` is within the last SWEEP_MIN_AGE_MS — or ahead of
 * our clock — is skipped. Two vibectx processes share one cache, so the file a sweep sees may
 * be a write still in flight, and deleting it would make the other process's rename fail on
 * work it had already done. Waiting a minute costs nothing: nothing reads a temp file.
 */
export function sweepTempFiles(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    const stamped = TEMP_FILE_PATTERN.exec(name);
    if (!stamped) continue;
    if (now - Number(stamped[1]) < SWEEP_MIN_AGE_MS) continue; // a writer may still be inside writeAtomic
    const path = join(dir, name);
    if (!isRegularFile(path)) continue; // a symlink or a directory is never ours to remove
    try {
      rmSync(path, { force: true });
    } catch {
      /* best effort: another process may have swept it already */
    }
  }
}

/**
 * Sweep every directory this tool writes temp files into: the cache root (resolved.json),
 * `projects/` (project records) and each per-library document directory, which is one level
 * under the root. Nothing deeper is walked and nothing outside the root is touched.
 *
 * S-C symlink rule: descent uses `lstat`, so a SYMLINKED child of the cache root is not a
 * directory as far as this walk is concerned and is never entered — otherwise a link planted
 * in the cache would aim the sweep at temp-shaped files anywhere on the filesystem.
 */
export function sweepCacheTempFiles(root: string): void {
  // PAR-1034 (final audit M-4): every other operation refuses a cache root that is not a real
  // directory (D-46); the sweep followed one and deleted temp-shaped files in the link target.
  try {
    if (!lstatSync(root).isDirectory()) return;
  } catch {
    return;
  }
  const sweepRealDir = (path: string): void => {
    try {
      if (!lstatSync(path).isDirectory()) return; // a symlinked child is not descended
    } catch {
      return;
    }
    sweepTempFiles(path);
  };
  sweepTempFiles(root); // the root itself is the caller's, not a name found inside the cache
  sweepRealDir(join(root, "projects"));
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "projects") continue; // already swept above
    sweepRealDir(join(root, name));
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The on-disk file's `schemaVersion` when it parses and is NEWER than `ours` (K2); undefined
 * when the file is absent, corrupt, ours, older, or a symlink rather than a regular file
 * (`lstat`, never followed), or above its probe size ceiling. Shared across every store that carries a
 * `schemaVersion` and still calls this function directly (`resolved-store.ts`,
 * `search-index.ts`, `project-store.ts`, `doctor-store.ts` — four real callers, security review
 * round 3: `activity-log.ts` used to be a fifth, but PAR-795 moved its own probe into
 * `readActivityFile`'s own `lstat`/prefix-read instead, so it no longer calls this function at
 * all; `cache.ts`'s own `touchCache` never called it either, since a TTL revalidation never
 * changes a record's schema): closes the symlink-safety of the SCHEMA-VERSION PROBE read for
 * all four callers in one place, the same way `writeAtomic` above closes the write side.
 * The default 8 MiB probe ceiling covers the small JSON stores. The index caller passes its
 * own 64 MiB file ceiling so a legitimate large index is still inspected. The leaf `lstat`
 * and subsequent read retain a check-then-act race if a local process swaps the path.
 *
 * This function only ever guards the schema-version PROBE, never each store's own DATA read —
 * that guard lives separately, at each store's own read function (`readResolvedEntries`,
 * `readDoctorVerdicts`, `readProjectRecord`, `search-index.ts`'s `readIndex`,
 * `activity-log.ts`'s `readActivityFile`), each with its own symlink/size handling suited to its
 * own read shape. See D-94 (`docs/decisions.md`) for which PAR closed which store and
 * why: `resolved-store.ts` and `doctor-store.ts` needed it because their own save functions
 * read-merge-persist (a planted symlink's content would otherwise be merged into and written
 * back to the real file, not merely served once and discarded); `project-store.ts` does not
 * read-merge-persist and only needed the plainer guard.
 */
export const MAX_SCHEMA_PROBE_BYTES = 8 * 1024 * 1024;

export function newerSchemaVersion(path: string, ours: number, maxBytes = MAX_SCHEMA_PROBE_BYTES): string | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > maxBytes) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isRecord(parsed) && typeof parsed.schemaVersion === "number" && parsed.schemaVersion > ours) return String(parsed.schemaVersion);
  } catch {
    return undefined;
  }
  return undefined;
}
