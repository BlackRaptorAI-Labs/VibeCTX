import { chmodSync, closeSync, constants as fsConstants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, existsSync, realpathSync, renameSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { sweepCacheTempFiles, tempPathFor, writeAtomic } from "./atomic-store.js";
import { redactUrlForDisplay, sanitizeRemoteUrl } from "./link-policy.js";
import { MAX_CONFIG_VALUE_CHARS, MAX_DISPLAY_PATH_CHARS } from "./config.js";
import { clipText } from "./text.js";
import { noteCacheWrite } from "./cache-evict.js";
import { MAX_NAME_LENGTH } from "./package-names.js";
import { classifySourceKind } from "./source-kind.js";
import {
  type CacheMeta,
  toCacheMeta,
  readMetaFile,
  urlSlug,
  urlHashFor,
  contentHashFor,
  libDirName,
  metaMatchesSlug,
  metaMatchesUrl,
  metaMatchesLibrary,
  validEtag,
  MAX_META_FILE_BYTES,
} from "./cache-meta.js";
import { cachePermissionRepair, writeStderrWarning } from "./redact-paths.js";

// D-71 (PAR-749) moved the shared validator, the collision-resistant `urlSlug`/`libDirName`
// transforms and the meta/slug provenance check into `./cache-meta.ts` — the one module both this file
// and `cache-evict.ts` import it from, so neither has to import the other for it. Re-exported
// here for existing callers (`toCacheMeta`, `CacheMeta`, `urlSlug` are part of this module's
// public surface and other files/tests import them from `cache.js`).
export type { CacheMeta };
export { toCacheMeta, urlSlug, libDirName };

export interface CacheHit {
  content: string;
  meta: CacheMeta;
  /** True when past TTL — caller decides whether to refetch or serve stale. */
  stale: boolean;
  /** Actual body hash reused only by the opt-in search memo, including legacy entries. */
  verifiedContentHash?: string;
  /** Classification of the validated body retained in the search memo. */
  verifiedIndexOnly?: boolean;
}

const MAX_CONTENT_MEMO_BYTES = 64 * 1024 * 1024;
const MAX_CONTENT_MEMO_ENTRIES = 128;
const contentMemo = new Map<string, { stamp: string; content: string; hash: string; indexOnly: boolean }>();
let contentMemoBytes = 0;

export function resetCacheReadMemo(): void { contentMemo.clear(); contentMemoBytes = 0; }

/** Nanosecond stat identity catches replacements, in-place writes and restored mtimes. */
function contentStat(path: string): { stamp: string; size: number } | undefined {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(MAX_CACHED_CONTENT_BYTES)) return undefined;
    return { stamp: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`, size: Number(stat.size) };
  } catch { return undefined; }
}

function forgetContent(path: string): void {
  const old = contentMemo.get(path);
  if (old) { contentMemoBytes -= old.content.length * 2; contentMemo.delete(path); }
}

function rememberContent(path: string, stamp: string, content: string, hash: string, indexOnly: boolean): void {
  forgetContent(path);
  const bytes = content.length * 2;
  if (bytes > MAX_CONTENT_MEMO_BYTES) return;
  while (contentMemoBytes + bytes > MAX_CONTENT_MEMO_BYTES || contentMemo.size >= MAX_CONTENT_MEMO_ENTRIES) forgetContent(contentMemo.keys().next().value!);
  contentMemo.set(path, { stamp, content, hash, indexOnly }); contentMemoBytes += bytes;
}

/** Storage status and last written kind, without claiming a fresh body hash verification.
 * Legacy entries have no recorded kind. Both files still must be regular and bounded. */
export function readCacheMetadata(library: string, url: string, ttlHours: number): Pick<CacheHit, "meta" | "stale"> | undefined {
  const root = cacheRoot();
  if (!isRealDirectory(root)) return undefined;
  const dir = libDirIn(root, library);
  if (!isRealDirectory(dir)) return undefined;
  const slug = urlSlug(url), meta = readMetaFile(join(dir, `${slug}.meta.json`));
  if (!meta || !metaMatchesUrl(meta, url) || !metaMatchesLibrary(meta, library)) return undefined;
  const stat = contentStat(join(dir, `${slug}.md`));
  if (!stat || (meta.contentBytes !== undefined && meta.contentBytes !== stat.size)) return undefined;
  const ageMs = Date.now() - Date.parse(meta.fetchedAt);
  return { meta, stale: ageMs < 0 || !(ageMs < ttlHours * 3600_000) };
}

/** The cache directory under the user's home. */
export const CACHE_DIR_NAME = ".vibectx";
/** What it was called when the package was `docs-cache-mcp`. Migrated once, see below. */
export const LEGACY_CACHE_DIR_NAME = ".docs-cache-mcp";

export interface CacheRootOptions {
  /** Where the one-off notes go. Defaults to stderr — this is a stdio MCP server, so
   *  stdout belongs to the protocol and nothing else may be written to it. */
  warn?: (message: string) => void;
}

const toStderr = (message: string): void => {
  writeStderrWarning(message);
};

/** Once-per-process migration state; `cacheRoot()` is called on nearly every path. */
let resolvedDefaultRoot: string | undefined;

/**
 * The first canonical target for each configured root spelling. A symlink in a configured
 * ancestor is an intentional deployment choice (for example macOS `/var`), so it is resolved
 * rather than refused. The result pins the path spelling, not an open directory handle: later
 * cache operations still use path-based synchronous filesystem calls. Component `lstat` checks
 * reject a symlink already present in a not-yet-created tail, but a local writer can still race a
 * check against a later mkdir/open/rename. See D-95 in `docs/decisions.md`.
 *
 * A symlink at the configured root *itself* remains uncanonicalised and is refused by the
 * existing exact-leaf checks. That preserves D-46/D-84's distinct policy for a cache root link.
 */
const pinnedConfiguredRoots = new Map<string, string>();
/** Canonical existing prefix before any not-yet-created configured-root tail. */
const pinnedConfiguredRootBases = new Map<string, string>();

/** PAR-786 — roots `writeCache` has already refused because they are a symlink or another
 *  non-directory, said once per distinct root per process, mirroring `cache-evict.ts`'s
 *  `refusedRoots` for the identical reason: a warm run calling `writeCache` for twenty
 *  libraries against the same misconfigured `VIBECTX_CACHE_DIR` must print one line, not
 *  twenty identical ones. */
const refusedWriteRoots = new Set<string>();

/** PAR-805 — cache ROOTS `ensureCacheRoot` has already warned about because they pre-existed
 *  with a mode looser than `0700`, said once per distinct root per process. A `Set`, not a
 *  single boolean, for the same reason `refusedWriteRoots` above is one rather than a flag: it
 *  is realistically always exactly one root per process, so a boolean would behave identically
 *  in practice, but a `Set` costs nothing extra and keeps this file's dedupe state uniform in
 *  shape (one pattern to read, not two) rather than correct only by coincidence of how many
 *  roots a single process happens to ever see. */
const warnedLooseRoots = new Set<string>();

/** PAR-859 — `dir` values `ensureCacheRoot` has already refused because a symlink sits at
 *  exactly that leaf, said once per distinct `dir` per process. Deliberately a THIRD, separate
 *  set rather than reuse of either existing one — but not, corrected here (code-reviewer, Phase
 *  1b review round), for the reason an earlier version of this comment gave. That version claimed
 *  reuse "could suppress one caller's warning behind an unrelated caller's dedup entry... through
 *  a different `warn` callback" — but `refusedEnsureRootDirs` ITSELF has exactly that property: it
 *  is keyed on `dir` alone, so the FIRST store to hit a symlinked root suppresses this warning for
 *  every OTHER store that later calls `ensureCacheRoot` on the SAME `dir` with a DIFFERENT `warn`.
 *  That cross-caller behaviour is real, and is the deliberate, accepted trade-off this set makes —
 *  one line per process per distinct root, not one per store per distinct root — the same
 *  trade-off `warnedLooseRoots` below already makes for the identical reason. It is not costless:
 *  `resolve_library` renders `ensureCacheRoot`'s message directly to the model (`resolve.ts`), so
 *  if an earlier `search` call already consumed the one warning for a symlinked root this process
 *  will ever print, a LATER `resolve_library` call against the same root degrades to a generic
 *  "could not be written" rather than naming the symlink — accepted here as it is everywhere else
 *  this file dedupes by root alone, not fixed by this item.
 *  The REAL reason these three sets stay separate: they track three DIFFERENT FACTS about the
 *  SAME `dir` — `refusedWriteRoots` is "not a real directory at all" (`writeCache`'s own, broader,
 *  earlier PAR-786 check, which also catches a plain file, not only a symlink); `warnedLooseRoots`
 *  is "a real directory, but its permission is looser than 0700"; `refusedEnsureRootDirs` is "a
 *  symlink sits here". Merging any two would let one FACT's dedup entry silently suppress a
 *  DIFFERENT fact's warning for the identical path — e.g. a root already marked in
 *  `refusedWriteRoots` for being a plain file would, if that set were reused here, never warn
 *  about a LATER, genuinely different discovery that it is now a symlink instead. That is the
 *  actual bug reuse would cause; keeping three facts in three sets is what avoids it. */
const refusedEnsureRootDirs = new Set<string>();

/** Test seam: forget what this process has already noted and migrated. */
export function resetCacheRootState(): void {
  resolvedDefaultRoot = undefined;
  pinnedConfiguredRoots.clear();
  pinnedConfiguredRootBases.clear();
  refusedWriteRoots.clear();
  warnedLooseRoots.clear();
  refusedEnsureRootDirs.clear();
}

/** Empty is not a directory: an exported-but-empty variable reads as unset rather than as
 *  "cache into the current working directory". */
const configured = (value: string | undefined): string | undefined =>
  value !== undefined && value.length > 0 ? value : undefined;

/** Resolve a configured root's existing prefix once and append any not-yet-created tail.
 *
 * `realpathSync` only accepts an existing path. Cache roots commonly do not exist on first run,
 * so walk upward until an existing prefix can be canonicalised, then rebuild the missing tail.
 * The resulting path and its existing canonical prefix are memoised before cache creation.
 * Missing tail components are checked individually before directory creation. These are
 * path-based checks, not descriptor-relative operations, so a concurrent local writer can still
 * race a check; see `symlinkInPinnedCachePath` and D-95 in `docs/decisions.md`.
 * B-04/B-25 retained decision: migration and followed-page cleanup keep their narrower
 * local-process check-then-act windows; this pin does not claim descriptor-relative writes.
 */
function pinConfiguredCacheRoot(configuredRoot: string): string {
  const absolute = resolve(configuredRoot);
  const known = pinnedConfiguredRoots.get(absolute);
  if (known !== undefined) return known;

  // D-46: a link *at* the cache-root leaf is not an accepted configured-root indirection. Leave
  // its exact path intact so the pre-existing lstat-based root refusal sees and rejects it.
  if (isSymlinkAt(absolute)) {
    pinnedConfiguredRoots.set(absolute, absolute);
    pinnedConfiguredRootBases.set(absolute, absolute);
    return absolute;
  }

  const missingTail: string[] = [];
  let existingPrefix = absolute;
  for (;;) {
    try {
      const canonicalPrefix = realpathSync(existingPrefix);
      const pinned = missingTail.length === 0 ? canonicalPrefix : join(canonicalPrefix, ...missingTail);
      pinnedConfiguredRoots.set(absolute, pinned);
      pinnedConfiguredRootBases.set(absolute, canonicalPrefix);
      return pinned;
    } catch {
      const parent = dirname(existingPrefix);
      // `resolve` always has a filesystem root. This is a defensive fallback for unusual hosts
      // where canonicalising that root itself fails; it retains the existing path behaviour.
      if (parent === existingPrefix) {
        pinnedConfiguredRoots.set(absolute, absolute);
        pinnedConfiguredRootBases.set(absolute, absolute);
        return absolute;
      }
      missingTail.unshift(basename(existingPrefix));
      existingPrefix = parent;
    }
  }
}

/** Gate decision (Tom, PAR-805/PAR-859, 2026-09-18, recorded as an amendment to D-84 in
 *  docs/decisions.md): true only when the cache root about to be resolved is the DEFAULT one
 *  (`~/.vibectx`, with `defaultCacheRoot`'s own rebrand-migration rules) — reached only when
 *  the current env override is unset. Mirrors `configured()`'s own emptiness rule EXACTLY (a
 *  non-`undefined`, non-empty-string value counts as configured) rather than restating it, so
 *  this predicate can never disagree with what `cacheRoot()` itself is about to resolve to — the
 *  two must agree for the "default root" framing below to mean what it says. An env var
 *  configured to a value that happens to equal the default path's string is still "configured"
 *  here, and stays warn-only: this predicate answers "did the user set an override", not "does
 *  the resolved path happen to look like the default one". */
function usingDefaultCacheRoot(): boolean {
  return configured(process.env.VIBECTX_CACHE_DIR) === undefined;
}

/** A real directory this tool would be willing to treat as a cache (D-46: lstat, not stat).
 *
 *  PAR-786 (findings F-2a/F-2b) — exported: this was
 *  `dropFollowedPageCache`'s own guard alone until this item, which reuses it for `readCache`
 *  and `writeCache` (below) so a symlinked root or library directory reads/writes exactly as a
 *  missing one does, the same D-46 rule `cache-evict.ts`'s `rootIsSweepable` already applies to
 *  eviction. Also exported for reuse by `activity-log.ts` (a later item, PAR-805, which already
 *  imports `cacheRoot` from this same file — no circular-import risk). */
export function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** PAR-786 write-side guard: does something already sit at `path` that is NOT a real directory?
 *  `false` both when `path` does not exist at all (nothing to refuse — the caller creates a
 *  fresh, real chain exactly as it always has) and when it IS already a real directory (the
 *  ordinary, overwhelmingly common case). `true` only when `lstat` finds an ENTRY there that is
 *  not a directory — a symlink, most importantly, but also, defensively, any other
 *  non-directory node. `lstat`, never `stat`: the question is what the ENTRY at this exact path
 *  is, never what it resolves to (D-46's rule, applied here to the WRITE side for the first
 *  time — see `writeCache`'s own comment for what this closes). */
function existsAsNonDirectory(path: string): boolean {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return false;
  }
  return !stat.isDirectory();
}

/** PAR-786: is a symlink already planted at exactly this leaf? Checked BEFORE `mkdirSync` runs,
 *  regardless of what the link points to — MEASURED (this file's own investigation, folded into
 *  PAR-786, correcting an earlier assumption in the issue this closes): a symlink leaf pointing
 *  at an EXISTING real directory does not make `mkdirSync(dir, { recursive: true })` throw at
 *  all — Node's recursive `mkdir` sees `EEXIST` on the raw syscall, then `stat`s (follows the
 *  link) to check whether what is already there is a directory, and a real directory at the far
 *  end of the link reads as "already exists, nothing to do" — SUCCESS, silently, with every
 *  subsequent write in `writeCache` resolving through the link into that directory. Only a
 *  DANGLING symlink leaf throws (`ENOENT`, since the followed `stat` fails); a symlink to an
 *  existing FILE throws too, but as `EEXIST` — indistinguishable by error code from the
 *  pre-existing "library directory position is a plain file" case this function has always
 *  thrown for (see `test/cache.test.ts`'s "a failed write (the library dir is a file) throws"
 *  case). Catching by error code after the fact would therefore either miss the dangerous
 *  existing-directory shape entirely (it never throws) or have to swallow the plain-file case
 *  this function must keep throwing for. Checking the leaf's own `lstat` up front sidesteps all
 *  three shapes uniformly, with one rule: a plain file at this exact leaf is untouched by this
 *  check and still throws out of `mkdirSync` exactly as it always has; only a SYMLINK here is
 *  new to PAR-786. */
function isSymlinkAt(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Find a symlink in the pinned root's newly-created tail or below it.
 *
 * The configured root can contain a not-yet-created tail. Checking only its leaf is not enough:
 * an intermediate component planted as a symlink after pinning would make recursive mkdir and
 * every later write follow it. Begin at the canonical existing prefix saved while pinning, so
 * intentional ancestor aliases (for example `/var` resolving to `/private/var`) remain valid. */
function symlinkInPinnedCachePath(dir: string): string | undefined {
  const root = cacheRoot();
  const tailFromRoot = relative(root, dir);
  if (tailFromRoot === ".." || tailFromRoot.startsWith(`..${sep}`) || isAbsolute(tailFromRoot)) {
    // Non-cache callers retain their historical exact-leaf check (important for /var-style
    // aliases used by tests and platform paths).
    return isSymlinkAt(dir) ? dir : undefined;
  }
  const configuredRoot = resolve(configured(process.env.VIBECTX_CACHE_DIR) ?? "");
  const base = pinnedConfiguredRootBases.get(configuredRoot) ?? root;
  const tail = relative(base, dir);
  const components = tail === "" ? [] : tail.split(sep).filter(Boolean);
  let current = base;
  if (isSymlinkAt(current)) return current;
  for (const component of components) {
    current = join(current, component);
    if (isSymlinkAt(current)) return current;
  }
  return undefined;
}

/** Consent reads/reset must honor the same pinned-tail symlink refusal as writes.
 * A missing root is safe as an empty store; a symlink or non-directory is not. */
export function cacheRootReadable(): boolean {
  const root = cacheRoot();
  if (symlinkInPinnedCachePath(root) !== undefined) return false;
  try {
    return lstatSync(root).isDirectory();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/** PAR-1034 (final audit M-4) — the startup temp sweep, gated like every other root operation:
 *  a root that is a symlink, or whose pinned tail now passes through one (D-95), is not swept,
 *  so the sweep cannot delete temp-shaped files outside the cache. */
export function sweepCacheRootTempFiles(): void {
  if (cacheRootReadable()) sweepCacheTempFiles(cacheRoot());
}

/**
 * PAR-805/PAR-859 — the ONE place `mkdirSync` is called for anything under the cache root,
 * across all six sites that used to call it separately with no `mode` at all (five of them;
 * `activity-log.ts` was already passing `0o700` on its own): `resolved-store.ts`,
 * `search-index.ts`, `project-store.ts` (its `projects/` subdirectory), `doctor-store.ts`,
 * `activity-log.ts`, and `cache.ts`'s own `writeCache` (its per-library directory) — and (as of
 * PAR-859) the ONE place that decides whether a SYMLINKED root or subdirectory is refused at all,
 * for every one of those same six sites.
 *
 * RETURNS `boolean` (PAR-859 — was `void` through PAR-805): `true` when `dir` now exists safely,
 * either freshly created by this call or already a real, non-symlinked directory; `false` when
 * refused — a symlink sits at exactly this leaf BEFORE `mkdirSync` runs, or (security-architect,
 * Phase 1b review round, optional hardening) `dir` is no longer a real directory AFTER
 * `mkdirSync` runs, a belt-and-suspenders TOCTOU recheck — in either case `mkdirSync` either was
 * never attempted or its result is not trusted, and the CALLER must not write anything under
 * `dir`. Every call site now checks this return value and bails on `false` —
 * `resolved-store.ts`'s `saveResolvedEntry`, `search-index.ts`'s `writeIndex`, `doctor-store.ts`'s
 * `saveDoctorVerdicts`, `activity-log.ts`'s `recordActivity`, and BOTH of `project-store.ts`'s
 * `writeProjectRecord` calls (the root, then `projects/` — a symlink could be planted
 * specifically at the subdirectory with a perfectly real root) — EXCEPT `writeCache`'s own two
 * calls, which keep ignoring it; see the note on that below for why that is provably safe rather
 * than an oversight carried over from PAR-805.
 *
 * WHY A SHARED FUNCTION AT ALL: `mkdirSync` never retroactively `chmod`s a directory that
 * already exists, so whichever of these six calls happens to run FIRST in a given process
 * permanently decides the cache root's mode for that process's lifetime — before this, only
 * `activity-log.ts` passed a `mode`, so in practice the root almost always ended up at the
 * default `0o755` (umask-adjusted), because `cache.ts`'s own read/write path is the one that
 * runs first in the overwhelming majority of real invocations (`get_docs`, `warm`, `refresh`).
 * A single function every site calls removes the "did I remember the mode this time" question
 * entirely, and MEASURED (this file's own investigation): Node's recursive `mkdir` applies the
 * SAME `mode` to every directory it actually creates in one call, not only the leaf — so a
 * single call creating both a not-yet-existing root and a subdirectory under it (the shape
 * `project-store.ts`'s two `ensureCacheRoot` calls and `cache.ts`'s own `writeCache` both rely
 * on) gets both at `0o700` when the root does not exist yet, with no separate call needed for
 * the root specifically — and, separately, a newly created LEAF under an already-existing
 * (looser) root still gets the `mode` passed here regardless of the root's own mode (MEASURED: a
 * leaf created under a pre-existing `0o755` root with `mode: 0o700` is itself `0o700`, not
 * `0o755`). Also MEASURED, and the mechanism matters here, not just the result: an explicit
 * `mode` is NOT immune to the process umask in general — umask masks (clears bits from) every
 * mode passed to `mkdir`/`open`, explicit or not, per POSIX. `0o700`/`0o600` survive every umask
 * this file's own investigation tried (`0`, `0o022`, `0o077`, `0o002`) for a narrower, structural
 * reason: umask can only CLEAR bits, never set one, and `0o700`/`0o600` contain ONLY owner
 * bits — none of those four umasks touch the owner position, so there is nothing for any of them
 * to clear. A umask that DOES include owner bits (an unusual but valid one, e.g. `0o700` itself)
 * would mask this value too; this file's own guarantee holds only because the two constants it
 * chose (`0o700` for directories, `0o600` for files) happen to have no bits outside the position
 * ordinary umasks never restrict, not because an explicit mode escapes umask as a rule.
 *
 * PRE-EXISTING UNSAFE ROOT, PERMISSION HALF — an env-CONFIGURED root (`VIBECTX_CACHE_DIR` or the
 * configured `VIBECTX_CACHE_DIR`) that already exists looser than `0700` is disclosed, never
 * `chmod`'d and never refused (unchanged from D-84's original decision). Two reasons, both stated
 * because a future reader will otherwise reasonably ask "why not just fix it": retroactively
 * tightening a directory the user (or another process) already set up could break an
 * intentionally SHARED cache — this project already treats a shared `VIBECTX_CACHE_DIR` as
 * "moving the trust boundary by choice" (see the README's own paragraph on this) — and refusing
 * to use it would break every cache created by a vibectx version older than this fix, on the very
 * next upgrade, for a mode difference that has never actually leaked anything document-shaped.
 * So: disclosure without mutation, the same house style `noteStrandedLegacy` (above, in this
 * file) already uses.
 *
 * PRE-EXISTING UNSAFE ROOT, THE DEFAULT ROOT SPECIFICALLY — GATE DECISION, AMENDING D-84 (Tom,
 * 2026-09-18, PAR-805/PAR-859): the DEFAULT root (`~/.vibectx` — reached only when NEITHER env
 * override is set, `usingDefaultCacheRoot()` above) is auto-TIGHTENED to `0700` on the next call
 * that finds it looser, with one stderr line saying what was done — never refused, and never
 * silently, but no longer merely disclosed either. The distinction that makes this consistent
 * with the env-configured case rather than a reversal of it: `~/.vibectx` is vibectx's OWN
 * directory, created by an earlier vibectx (or a user acting on vibectx's own instructions) under
 * `$HOME` — it is never one a user deliberately pointed a shared process at, the way an
 * env-configured root can be, so the "moving the trust boundary by choice" framing above simply
 * does not apply to it: there is no other process this tightening could be taking access away
 * from on purpose. `chmodSync` is wrapped in its own `try/catch` — a failure (`EPERM`, most
 * plausibly a root now owned by a different user than the one running this process) is warned
 * about and left exactly as it was, never thrown, so a hardening attempt can never be the reason
 * an ordinary retrieval fails; see `test/cache-permissions.test.ts`'s EPERM case. Also guarded by
 * an OWNERSHIP check (security-architect, Phase 1b review round, optional hardening) — `chmodSync`
 * is attempted only when the `lstat`'d `stat.uid` matches this process's own (`process.getuid?.()`,
 * `undefined`/false on Windows, where this branch never fires): `chmod(2)` dereferences symlinks
 * (no portable `lchmod`), so a local attacker with write access to `dir`'s PARENT directory could
 * otherwise race a symlink swap between this `lstat` and the `chmodSync` call and turn a
 * tightening attempt into a `chmod` that follows the link elsewhere. The ownership check does not
 * close that race (the swap can still land after the check reads its own stale `stat`), but it
 * does mean a directory that was NOT ours at the moment we looked never gets a tightening attempt
 * at all — a distinct, narrower message is warned for that case (see the code below), not the
 * env-configured one, since that one's "did you deliberately share this" framing does not fit a
 * default root someone else's process happens to own.
 *
 * Both checks above run ONLY when `dir` is the literal cache root (`dir === cacheRoot()`, a
 * second call but a free one — `cacheRoot()` is a memoized env-var read for the default path, or
 * a direct env-var read for an overridden one, never a network or disk call on this path since
 * the caller already resolved it once to produce `dir`), not for every per-library or `projects/`
 * subdirectory this function is also called for — warning (or tightening) every subdirectory of
 * an old, already-populated cache would be pure noise repeating the same one fact endlessly.
 *
 * THE SYMLINK CHECK (PAR-859) — the FIRST thing this function does, before either permission
 * check above, mirroring `isSymlinkAt`'s own leaf-`lstat` policy (this file, already used by
 * `writeCache`'s own pre-check, below): a symlink planted at exactly `dir`, whatever it points
 * at — including an EXISTING real directory, which `mkdirSync(dir, { recursive: true })` would
 * otherwise accept SILENTLY and write straight through (see `isSymlinkAt`'s own comment for the
 * MEASURED mechanism) — is refused outright, with no `mkdirSync` attempted at all. A PLAIN FILE
 * at `dir` is untouched by this check, matching `isSymlinkAt`'s existing, narrower behaviour, and
 * still throws `EEXIST` out of `mkdirSync` below exactly as it always has (`test/cache.test.ts`'s
 * "library dir is a file" case, which this must not change). Deduplicated by
 * `refusedEnsureRootDirs` (above) — see that set's own comment for why it is a third set, not a
 * reuse of either existing one. Because this check now runs unconditionally, BEFORE the
 * `dir === cacheRoot()` gate, `dir` is proven non-symlink by the time either permission check
 * below runs — the earlier version of this function's own `!stat.isSymbolicLink()` guard inside
 * that block (needed when a symlinked root's mode was compared against `0700` and warned about
 * for no reason — see D-84's own corrected-finding note) is now dead code and has been removed;
 * this comment records why, rather than leaving a future reader to wonder if the removal was an
 * accident.
 *
 * `writeCache`'s OWN two calls (root, then the per-library directory) are UNAFFECTED IN
 * PRACTICE by the new symlink check: `writeCache`'s own `existsAsNonDirectory`/`isSymlinkAt`
 * pre-checks already run BEFORE either of its `ensureCacheRoot` calls (TRACED, not assumed —
 * `writeCache`'s own body, below, shows both pre-checks strictly before both `ensureCacheRoot`
 * calls), so by the time they run, `root`/`dir` are already proven non-symlink and this
 * function's own check simply returns `true` — redundant, but harmless. `writeCache` therefore
 * keeps ignoring both calls' return values, unchanged from before this item: a `false` there
 * cannot actually happen given `writeCache`'s own pre-checks.
 *
 * NEWLINE CONVENTION — not this function's to solve centrally (code-reviewer, PAR-805 review
 * round): `warn` here is an opaque callback, and this file's own default (`toStderr`) already
 * appends exactly one trailing newline before writing, but `resolved-store.ts`, `search-index.ts`,
 * `doctor-store.ts` and `project-store.ts` each default THEIR OWN `warn` to a bare
 * `process.stderr.write(m)` with none — `ensureCacheRoot` cannot tell which convention the
 * `warn` it was handed follows, so it cannot safely append a newline itself: doing so
 * unconditionally would double it for the two callers whose `warn` already does. Those four
 * call sites each wrap their own `warn` (`(m) => warn(\`${m}\\n\`)`) when calling this function
 * specifically, so THIS function's message always reaches the real stream newline-terminated,
 * without touching those modules' other, pre-existing `warn(...)` calls (which already manage
 * their own newlines correctly). See any of those four call sites for the wrap itself.
 */
export function ensureCacheRoot(dir: string, warn: (message: string) => void = toStderr, stderrIsTTY = process.stderr.isTTY === true): boolean {
  // PAR-859 — checked first, unconditionally: see this function's own doc comment for why this
  // must run before `mkdirSync` rather than be discovered by catching what it throws (it often
  // does not throw at all), and before the permission checks below (which now assume `dir` is
  // proven non-symlink by the time they run).
  const symlinkPath = symlinkInPinnedCachePath(dir);
  if (symlinkPath !== undefined) {
    if (!refusedEnsureRootDirs.has(symlinkPath)) {
      refusedEnsureRootDirs.add(symlinkPath);
      warn(
        `vibectx: refusing to use ${clipText(symlinkPath, MAX_DISPLAY_PATH_CHARS)} — it is a symlink, not a directory ` +
          `vibectx created. Nothing was written.`,
      );
    }
    return false;
  }
  if (dir === cacheRoot() && existsAsNonDirectory(dir)) {
    if (!refusedWriteRoots.has(dir)) {
      refusedWriteRoots.add(dir);
      warn("vibectx: refusing to use the cache root: it is a non-directory. Nothing was written; set VIBECTX_CACHE_DIR to a real directory.");
    }
    return false;
  }
  if (dir === cacheRoot()) {
    let stat;
    try {
      stat = lstatSync(dir);
    } catch {
      stat = undefined; // does not exist yet: mkdirSync below creates it at 0700, nothing to warn about
    }
    if (stat !== undefined) {
      const mode = stat.mode & 0o777;
      if (mode !== 0o700 && !warnedLooseRoots.has(dir)) {
        warnedLooseRoots.add(dir);
        // security-architect (Phase 1b review round, optional hardening) — a real, if narrow,
        // TOCTOU: `chmod(2)` dereferences symlinks (there is no portable `lchmod`), so a local
        // attacker with write access to `dir`'s PARENT directory could, between this `lstatSync`
        // and the `chmodSync` call below, swap `dir` for a symlink and turn a tightening attempt
        // into a `chmod` that follows the link to an arbitrary target. This does not close that
        // race (the swap can still happen after this check reads), but it closes a related, cheap
        // case for free: `stat` here is already the pre-swap observation, so requiring its owner
        // to be the CURRENT process before ever attempting `chmodSync` means a directory that
        // was NOT ours at the moment we looked never gets a tightening attempt at all — the
        // ordinary case (vibectx's own freshly-created or long-owned `~/.vibectx`) is unaffected,
        // since a process only ever owns directories it (or its own user) created.
        // `process.getuid` is POSIX-only (`undefined` on Windows) — where it is absent, this
        // comparison is always false and the auto-tighten branch simply never fires, consistent
        // with this whole feature already being POSIX-only (see the README's own Windows note).
        const ownedByThisProcess = stat.uid === process.getuid?.();
        if (usingDefaultCacheRoot() && ownedByThisProcess) {
          // Gate decision, amending D-84 (Tom, PAR-805/PAR-859, 2026-09-18) — see this function's
          // own doc comment for why the default root is tightened rather than merely disclosed.
          try {
            chmodSync(dir, 0o700);
            warn(
              `vibectx: the cache root ${clipText(dir, MAX_DISPLAY_PATH_CHARS)} was mode ` +
                `0${mode.toString(8).padStart(3, "0")} — tightened to 0700 (vibectx's own default cache ` +
                `directory is owner-only).`,
            );
          } catch (e) {
            // Never throw out of a hardening attempt (see doc comment): every caller of this
            // function must be able to proceed exactly as it would have before this gate
            // decision existed, whether or not the chmod itself succeeded.
            warn(
              `vibectx: the cache root ${clipText(dir, MAX_DISPLAY_PATH_CHARS)} is mode ` +
                `0${mode.toString(8).padStart(3, "0")} and vibectx could not tighten it to 0700 ` +
                `(${e instanceof Error ? e.message : String(e)}); using it as-is.`,
            );
          }
        } else if (usingDefaultCacheRoot()) {
          // The default root exists but is NOT owned by this process (the `ownedByThisProcess`
          // guard above) — an unusual shape (a different user, or a process running under `sudo`,
          // created `~/.vibectx` first) that the env-configured message below is not written for:
          // that one's "did you deliberately share this" framing assumes a directory the READER
          // chose to point at, which is not what "the tool's own default path" means here. Said
          // plainly instead, and left untouched, for the identical reason the TOCTOU comment above
          // gives: this process should not be attempting to `chmod` a directory it does not own.
          warn(
            `vibectx: the cache root ${clipText(dir, MAX_DISPLAY_PATH_CHARS)} already exists with mode ` +
              `0${mode.toString(8).padStart(3, "0")} but is not owned by this process — it was NOT changed. ` +
              `If this is unexpected, check who created it.`,
          );
        } else {
          warn(
            `vibectx: the cache root ${clipText(dir, MAX_DISPLAY_PATH_CHARS)} already exists with mode ` +
              `0${mode.toString(8).padStart(3, "0")} (vibectx creates new cache roots owner-only, at 0700) — ` +
              `it was NOT changed. Existing files and directories in it are not tightened either. If you did ` +
              `not deliberately share this cache directory with another user or process, tighten it with:\n` +
              cachePermissionRepair(dir, stderrIsTTY),
          );
        }
      }
    }
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // security-architect (Phase 1b review round, optional hardening) — belt-and-suspenders against
  // a TOCTOU between the `isSymlinkAt` check at the very top of this function and the `mkdirSync`
  // call just above (an external process replacing `dir` with a symlink in that window): the SAME
  // shape `writeCache`'s own post-`mkdirSync` recheck already has for its own two calls (see that
  // function's own comment, below) — centralised here so every one of `ensureCacheRoot`'s other
  // five call sites gets it too, not only `writeCache`'s. `writeCache`'s own copy is deliberately
  // LEFT IN PLACE, not removed in favour of this one: redundant but harmless (this check already
  // runs, inside `ensureCacheRoot`, before `writeCache`'s own copy would even be reached), and
  // removing it would be unnecessary extra diff for no behaviour change. No dedup set, matching
  // `writeCache`'s own choice not to dedup this specific warning: the race this guards is rare
  // enough, and this specific check narrow enough, that `writeCache`'s own precedent already
  // treats a plain, undeduped `warn` as sufficient.
  // DISCLOSED, NOT TESTED (mirroring `writeCache`'s own identical disclosure): removing this check
  // alone makes no test in the suite fail — every reachable, single-threaded test scenario that
  // would trip it is already caught by the `isSymlinkAt` check at the top of this function, since
  // nothing changes `dir`'s own leaf between that check and `mkdirSync` in a synchronous test.
  // This exists only for the genuine multi-process race (CWE-367) `dropFollowedPageCache`'s own
  // comment names and does not close either — real, but not exercisable from a single synchronous
  // test process.
  if (!isRealDirectory(dir)) {
    warn(`vibectx: refusing to use ${clipText(dir, MAX_DISPLAY_PATH_CHARS)} — it is no longer a real directory. Nothing was written.`);
    return false;
  }
  return true;
}

/** Longest cache CONTENT file this process will read back (PAR-786, finding F-10). Mirrors
 *  `PRIMARY_DOC_MAX_BYTES` (`src/fetcher.ts`, 25 MiB) as a SEPARATE constant, not an import:
 *  `fetcher.ts` imports `{ readCache, writeCache, touchCache }` from THIS file, so importing the
 *  other way would be circular. `PRIMARY_DOC_MAX_BYTES` is `fetchUrl`'s own `maxBytes` bound —
 *  applied by the CALLER (`getLibraryDoc`/`fetchLinkedPage`, `fetcher.ts`) to live fetches.
 *  `writeCache` independently enforces this same 25 MiB UTF-8 byte ceiling before any
 *  filesystem write. This constant also remains the READ-side
 *  backstop for a `.md` file that reached disk some other way regardless (a planted or corrupted
 *  file, or a stale write from a build that had a different `PRIMARY_DOC_MAX_BYTES`) — see
 *  `test/cache-content-size.test.ts`'s boundary assertion that this stays `>=`
 *  `PRIMARY_DOC_MAX_BYTES`, so raising the write-side bound alone can never silently make every
 *  large document permanently uncacheable. F-10 measured a planted 31,457,287-byte `.md` file
 *  read wholesale and served in full before this existed. */
export const MAX_CACHED_CONTENT_BYTES = 25 * 1024 * 1024;

/** A real, regular file (never a symlink — `lstat`, not `stat`, so the ENTRY at this exact path
 *  decides, never what it points at) no larger than `maxBytes`. Returns its contents as utf8, or
 *  `undefined` for anything else: missing, a symlink, a directory, oversized, or unreadable all
 *  read the same as "not cached" to the caller, matching the trust rule A4 already applies to
 *  `.meta.json` (`readMetaFile`, `cache-meta.ts`) and now applies to this file's other half
 *  (PAR-786, findings F-2a/F-10). The size check runs BEFORE any read — an oversized file costs
 *  one `lstat`, never a descriptor read (`test/cache-content-size.test.ts` proves this by call
 *  count, not merely by return value). Exported for reuse by `activity-log.ts` (PAR-805, a later
 *  item).
 *
 *  AUDIT-20260920-01: the descriptor is pinned before any bytes are read. POSIX opens with
 *  `O_NOFOLLOW`; every platform also compares the opened descriptor's device/inode to the first
 *  `lstat`, so Windows (where `O_NOFOLLOW` is not a reliable filesystem primitive) refuses a
 *  changed final component rather than following a replacement symlink. Reading exactly the
 *  descriptor's validated size prevents an append after `fstat` from bypassing the byte ceiling. */
export function readBoundedRegularFile(path: string, maxBytes: number): string | undefined {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch {
    return undefined;
  }
  if (!stat.isFile() || stat.size > maxBytes) return undefined;
  let fd: number;
  try {
    // O_NOFOLLOW makes a swap to a symlink fail atomically on POSIX. Windows does not provide
    // equivalent no-follow semantics here, so the descriptor identity comparison below is the
    // conservative fallback for its reparse-point/symlink replacement race.
    // PAR-1030 audit (F-A1030-1): O_NONBLOCK, so a FIFO swapped in after the lstat opens at once
    // (and is then refused by the descriptor check below) instead of blocking for a writer.
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW);
    fd = openSync(path, flags);
  } catch {
    return undefined;
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > maxBytes || opened.dev !== stat.dev || opened.ino !== stat.ino) return undefined;
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read === 0) return undefined;
      offset += read;
    }
    return bytes.toString("utf8");
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/**
 * Rule 1 keeps an existing `~/.vibectx` and moves nothing — correct, and it used to be
 * SILENT. An EMPTY `~/.vibectx` (a `mkdir`, a dotfile manager, a half-finished earlier run)
 * took that same path, so a full legacy cache sat stranded beside it while the tool
 * re-downloaded every document the user already had, with no way to find out why.
 *
 * One note, and no move: the rule does not change — deciding for the user which of two caches
 * wins is exactly the judgement rule 1 refuses to make — they are just told where the other
 * one is. Best effort throughout; an unreadable directory means nothing is said.
 */
function noteStrandedLegacy(current: string, legacy: string, warn: (message: string) => void): void {
  if (!isRealDirectory(legacy)) return; // only a real directory is a cache worth mentioning
  let currentIsEmpty: boolean;
  try {
    currentIsEmpty = readdirSync(current).length === 0;
  } catch {
    return;
  }
  if (!currentIsEmpty) return; // this user has a cache at the new path and has moved on
  warn(
    `vibectx: ${current} is empty, so the cache at ${legacy} (the old package name) is not being used ` +
      `and nothing was moved. Delete ${current} to have it migrated on the next run, or delete ${legacy} ` +
      `if you no longer want it.`,
  );
}

/**
 * The default root, with the one-time rebrand migration (D-45, PAR-652).
 *
 * The rules, in the order they are checked, because each exists to prevent a specific way
 * of losing someone's cache:
 *   1. `~/.vibectx` already exists → use it and touch nothing. A user who has both
 *      directories has already moved on; overwriting the new one with the old would lose
 *      the newer cache, which is the worst outcome available here. If it is EMPTY and a
 *      legacy cache is sitting beside it, say so once (`noteStrandedLegacy`) — the rule is
 *      unchanged, but it is no longer silent about what it left behind.
 *   2. No `~/.docs-cache-mcp` → use `~/.vibectx`. Nothing to migrate.
 *   3. `~/.docs-cache-mcp` is not a REAL DIRECTORY (D-46, PAR-652b) → rename nothing, say so
 *      once, and degrade exactly as rule 4 does. `existsSync` follows symlinks, so without
 *      this check a link planted at the legacy path passed rule 2 and rule 3 renamed THE LINK
 *      — `renameSync` moves the link itself, so `~/.vibectx` became a symlink aiming wherever
 *      the link aimed, and every cached document and every eviction from then on landed in
 *      whatever directory that was. Measured by the security gate. The link is never followed
 *      into a rename and never removed.
 *      RESIDUAL, stated because it is real: writes during that one run still resolve through
 *      the link. What this closes is the PERMANENT capture (`~/.vibectx` is not made a link)
 *      and deletion — both `enforceCacheSizeCap` (cache-evict.ts) and `dropFollowedPageCache`
 *      (A3, PAR-716) refuse a root that is not a real directory, so nothing is evicted or
 *      dropped through it either.
 *   4. Otherwise rename `~/.docs-cache-mcp` to `~/.vibectx` — a rename, never a copy: a
 *      copy can half-succeed and leave two divergent caches, and a rename either happens
 *      or does not.
 *   5. The rename failed (cross-device, permissions, a race with another process) → keep
 *      using the OLD path for this run and say so once. Degrading is right: the cache is
 *      a cache, but silently starting from an empty one would re-download every document
 *      the user already has.
 */
function defaultCacheRoot(warn: (message: string) => void): string {
  if (resolvedDefaultRoot !== undefined) return resolvedDefaultRoot;
  const home = homedir();
  if (home.trim().length === 0 || !isAbsolute(home)) {
    throw new Error("The home directory must be a nonempty absolute path; set VIBECTX_CACHE_DIR to an absolute directory");
  }
  const current = join(home, CACHE_DIR_NAME);
  const legacy = join(home, LEGACY_CACHE_DIR_NAME);
  resolvedDefaultRoot = current;
  if (existsSync(current)) {
    noteStrandedLegacy(current, legacy, warn);
    return current;
  }
  if (!existsSync(legacy)) return current;
  // D-46: prove the legacy path before renaming it. lstat, not stat — the question is what
  // the ENTRY is, not what it points at. A throw here means it vanished between the two
  // calls, which is rule 2 arriving late: there is nothing to migrate.
  let legacyStats;
  try {
    legacyStats = lstatSync(legacy);
  } catch {
    return current;
  }
  if (!legacyStats.isDirectory()) {
    resolvedDefaultRoot = legacy;
    warn(
      `vibectx: not moving ${legacy} → ${current} — ${legacy} is ` +
        `${legacyStats.isSymbolicLink() ? "a symlink" : "not a directory"}, and only a real directory is moved. ` +
        `Using ${legacy} for this run; nothing was renamed, copied or deleted. ` +
        `Remove it, or set VIBECTX_CACHE_DIR to a real directory.`,
    );
    return resolvedDefaultRoot;
  }
  try {
    renameSync(legacy, current);
    warn(`vibectx: moved the cache directory ${legacy} → ${current} (renamed once; nothing was copied or deleted).`);
  } catch (e) {
    resolvedDefaultRoot = legacy;
    warn(
      `vibectx: could not move the cache directory ${legacy} → ${current} (${e instanceof Error ? e.message : String(e)}); ` +
        `using ${legacy} for this run. Nothing was copied and no cached document was lost.`,
    );
  }
  return resolvedDefaultRoot;
}

/**
 * Where the cache lives: `VIBECTX_CACHE_DIR`, else `~/.vibectx` with the one-time
 * legacy-directory migration above. The old override retired at 0.3.0; operators with a
 * custom old location must set `VIBECTX_CACHE_DIR` explicitly to retain it.
 */
export function cacheRoot(opts: CacheRootOptions = {}): string {
  const warn = opts.warn ?? toStderr;
  const preferred = configured(process.env.VIBECTX_CACHE_DIR);
  if (preferred !== undefined) {
    if (preferred.trim().length === 0 || !isAbsolute(preferred) || dirname(preferred) === preferred || resolve(preferred) === resolve(preferred, "..")) {
      throw new Error("VIBECTX_CACHE_DIR must be an absolute directory below the filesystem root");
    }
    return pinConfiguredCacheRoot(preferred);
  }
  return defaultCacheRoot(warn);
}

/** PAR-861: read-only presentation probe. A missing root is creatable, not a refusal;
 *  callers must not create or follow a suspect root merely to describe its status. */
export function inspectCacheRoot(): { status: "ready"; path: string } | { status: "refused"; path: string; reason: "symlink" | "not-directory" | "inaccessible" } {
  const path = cacheRoot();
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return { status: "refused", path, reason: "symlink" };
    if (!stat.isDirectory()) return { status: "refused", path, reason: "not-directory" };
    return { status: "ready", path };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { status: "ready", path };
    return { status: "refused", path, reason: "inaccessible" };
  }
}

/** Round 2 (security-architect, C1) — the library directory for a ROOT the caller already
 *  has in hand, so a caller that must prove the root is real (D-46) checks and uses the SAME
 *  value rather than one `cacheRoot()` call proving a root a second, later call re-resolves.
 *  `cacheRoot()` is memoised (`resolvedDefaultRoot`) so the two calls agree in practice, but
 *  that agreement is an invariant of `cacheRoot()`'s implementation, not a property this
 *  function's callers should have to depend on.
 *
 *  D-71 (PAR-749): the directory name itself is `libDirName(library)` — folded AND hash-
 *  suffixed, so two library names that fold to the same characters (`foo.bar` / `foo_bar`) no
 *  longer share a directory. */
function libDirIn(root: string, library: string): string {
  // One directory per library; page files keyed by a slug of their URL.
  return join(root, libDirName(library));
}

export function readCache(
  library: string,
  url: string,
  ttlHours: number,
  opts: { memoize?: boolean } = {},
): CacheHit | undefined {
  // PAR-786 (finding F-2a) — mirrors the D-46
  // leaf-`lstat` policy `dropFollowedPageCache` and `enforceCacheSizeCap` (`cache-evict.ts`)
  // already apply to DELETION: the ROOT, then the LIBRARY DIRECTORY, must each be proven a
  // real directory before anything below either is trusted, not just the two files at the
  // leaf (which is all this function checked before this item — F-2a: the content file had no
  // `lstat` guard at all). `isRealDirectory` returning `false` for a root or library directory
  // that does not exist yet is exactly right — nothing is cached either way, so an absent
  // cache and a refused symlinked one report the identical outward "uncached" result,
  // silently, matching this function's existing philosophy (see the corruption classes below)
  // that anything this process cannot trust is reported as a miss, never a special error.
  // `root` is resolved ONCE and threaded through `libDirIn` (not `libDir`, which calls
  // `cacheRoot()` again internally) so the value proven real is provably the value used — the
  // same discipline `dropFollowedPageCache` already follows, for the same reason (D-46's
  // comment there).
  const root = cacheRoot();
  if (!isRealDirectory(root)) return undefined;
  const dir = libDirIn(root, library);
  if (!isRealDirectory(dir)) return undefined;
  const slug = urlSlug(url);
  const contentPath = join(dir, `${slug}.md`);
  const metaPath = join(dir, `${slug}.meta.json`);
  const meta = readMetaFile(metaPath);
  // A4 supersedes N-6: a bad `fetchedAt` used to read as stale-but-served (ageMs went NaN,
  // and `!(NaN < x)` is true). It now drops the whole meta, so the entry reads as uncached —
  // Gate 3's rule for all four corruption classes, not just this one field.
  if (!meta) return undefined;
  // D-71 (PAR-749, Root 1) — the read-side verification `readCache` never did: a folded slug
  // is a lookup key, not proof of identity, and before this a collision (or a foreign file
  // planted under a name-shaped slug) served ONE document's content under ANOTHER's name,
  // silently, with a meta that passed every A4 check. `urlSlug` is now collision-RESISTANT
  // (D-71 — see its own comment for what that does and doesn't guarantee), which already makes
  // an accidental fold collision astronomically unlikely; THIS check is what actually makes
  // serving the wrong document impossible regardless: a meta whose own identity does not match
  // the URL actually requested is not this entry, whatever its file name says.
  // PAR-806 (Phase 4) — `metaMatchesUrl` (`cache-meta.ts`), not a direct `meta.url !== url`
  // comparison: `meta.url` is now the REDACTED display form, so comparing it against the raw
  // requested `url` directly would treat every query-string-bearing entry as a permanent
  // mismatch. `metaMatchesUrl` restores full fidelity via `meta.urlHash` (see its own comment).
  if (!metaMatchesUrl(meta, url)) return undefined;
  // PAR-787 — the library-NAME dimension's own second, independent check, mirroring the URL
  // dimension's `metaMatchesUrl` exactly (see that function's and `CacheMeta.library`'s own
  // comments): a `.meta.json` whose recorded library does not match the library this call was
  // actually made for is not this entry, whatever directory it was found in.
  if (!metaMatchesLibrary(meta, library)) return undefined;
  // PAR-786 (F-2a, F-10) — the same bounded, symlink-refusing read `.meta.json` already gets
  // via `readMetaFile` (`cache-meta.ts`), now applied to the content half: `readBoundedRegularFile`
  // refuses a symlink (a secret file swapped in for this entry's `.md` — Attack 1 in the
  // finding), a dangling link, a directory, or anything over `MAX_CACHED_CONTENT_BYTES` — the
  // read-side ceiling `.meta.json` has always had but the content file never did (F-10: a
  // planted 31 MB `.md` was returned in full, 58 ms, before this). Same trust boundary as the
  // meta half, same rule (security-architect, A4 round 1, F1): an unreadable, oversized or
  // untrustworthy content file reads as uncached, not a throw — `configuredEntriesNeedingWarm`'s
  // pre-scan (autowarm.ts) calls this function directly, with no
  // try/catch of their own to fall back on.
  // Search alone opts into bounded reuse. Root/library/meta identity still runs every
  // time; a body is reusable only at the same regular-file stat and expected hash.
  const before = opts.memoize ? contentStat(contentPath) : undefined;
  if (opts.memoize && !before) { forgetContent(contentPath); return undefined; }
  const memo = opts.memoize ? contentMemo.get(contentPath) : undefined;
  const reusable = memo && memo.stamp === before?.stamp && (meta.contentHash === undefined || memo.hash === meta.contentHash);
  if (opts.memoize && !reusable) forgetContent(contentPath);
  const content = reusable ? memo.content : readBoundedRegularFile(contentPath, MAX_CACHED_CONTENT_BYTES);
  if (content === undefined) return undefined;
  if (meta.contentBytes !== undefined && meta.contentBytes !== (before?.size ?? Buffer.byteLength(content, "utf8"))) return undefined;
  const hash = reusable ? memo.hash : (opts.memoize || meta.contentHash !== undefined ? contentHashFor(content) : undefined);
  if (meta.contentHash !== undefined && hash !== meta.contentHash) return undefined;
  const indexOnly = opts.memoize ? (reusable ? memo.indexOnly : classifySourceKind(url, content) === "index-only") : undefined;
  if (opts.memoize) {
    const after = contentStat(contentPath);
    if (!after || after.stamp !== before?.stamp) return undefined;
    if (!reusable) rememberContent(contentPath, after.stamp, content, hash!, indexOnly!);
  }
  const ageMs = Date.now() - new Date(meta.fetchedAt).getTime();
  // Negated `<` rather than `>=`: a TTL of 0 means "expire immediately", even when written
  // and read within the same millisecond. `meta.fetchedAt` is now guaranteed a valid ISO
  // instant by `toCacheMeta`, so `ageMs` is never NaN here.
  return {
    content,
    meta,
    stale: ageMs < 0 || !(ageMs < ttlHours * 3600_000),
    ...(opts.memoize ? { verifiedContentHash: hash, verifiedIndexOnly: indexOnly } : {}),
  };
}

/** Refresh a cache entry's TTL clock without rewriting content — used after a
 *  304 Not Modified revalidation confirms the upstream is unchanged.
 *
 *  Round-trips through `toCacheMeta` (N4, code-reviewer): the rewritten file carries only
 *  the validated, reconstructed fields, so a valid-but-over-length or valid-but-wrong-shape
 *  `etag` that somehow reached disk is silently dropped here rather than merely ignored for
 *  one read. Benign — the field is a revalidation hint, not identity — and consistent with
 *  every write in this file already going through a validator before it lands. */
/** Returns the `fetchedAt` it wrote, or `undefined` on any of the best-effort no-op paths
 *  (A17/PAR-726: callers that need to report exactly when a revalidated document was fetched
 *  read it from here rather than calling `new Date()` a second time, which could disagree
 *  with what actually landed on disk by the width of that second call).
 *
 *  `finalUrl` (PAR-776, D-74): a 304 revalidation still follows redirects to reach the server
 *  that answered it, and that final URL can change between fetches even though the CONTENT
 *  (per the etag) has not — a site's redirect target moving is not a content change. Passing
 *  the newly observed value here keeps a long-lived, repeatedly-revalidated entry's `finalUrl`
 *  from going stale itself. `undefined` (the caller observed no redirect, or has nothing new
 *  to report) leaves whatever was already persisted untouched rather than erasing it.
 *
 *  PAR-786 (security-architect review round) — this is a THIRD read/write path through the same
 *  `.meta.json`, reachable on every 304 revalidation (`fetcher.ts`'s `getLibraryDoc`/
 *  `fetchLinkedPage`), and it was the one this item's first pass missed: `readMetaFile` already
 *  made the meta FILE itself symlink-safe (its own `lstat`, `cache-meta.ts`), but nothing here
 *  checked the ROOT or the LIBRARY DIRECTORY above it — `existsSync(metaPath)` follows a symlink
 *  through every path component, so a symlinked root or library directory let this function
 *  read AND rewrite a `.meta.json` on the far side of the link. Brought under the identical
 *  policy `readCache` uses, for the identical reason (D-46/D-83): a symlinked root or library
 *  directory reports the same outward "nothing to touch" result a missing one does, silently. */
export function touchCache(library: string, url: string, finalUrl?: string): string | undefined {
  const root = cacheRoot();
  if (!isRealDirectory(root)) return undefined;
  const dir = libDirIn(root, library);
  if (!isRealDirectory(dir)) return undefined;
  const metaPath = join(dir, `${urlSlug(url)}.meta.json`);
  const meta = readMetaFile(metaPath);
  // Best effort (D-13): a meta this process cannot trust has nothing to refresh. The next
  // `readCache` reports the entry uncached and the next fetch writes a fresh, valid meta.
  if (!meta) return undefined;
  // D-71 (PAR-749, Root 1) — same verification as `readCache`: a meta whose own identity does
  // not match the URL this call was asked to refresh is not this entry, whatever the file
  // name says. Refreshing it anyway would extend the TTL of a mismatched record.
  // PAR-806 (Phase 4): `metaMatchesUrl`, not a direct `meta.url !== url` comparison — see
  // `readCache`'s identical comment above for why.
  if (!metaMatchesUrl(meta, url)) return undefined;
  // PAR-787 — same library-dimension check `readCache` applies; see its identical comment above.
  if (!metaMatchesLibrary(meta, library)) return undefined;
  meta.fetchedAt = new Date().toISOString();
  // Stored only when it actually differs from `url` (matching `writeCache`'s own rule below) —
  // an entry that has never redirected stays byte-for-byte the same file shape it always was,
  // and a redirect that stops happening on this revalidation correctly clears the old value
  // rather than leaving a now-false "redirected from" fact behind. `sanitizeRemoteUrl`-validated
  // for the same reason `writeCache` validates it (security-architect, PAR-776 round 1, B-1) —
  // an oversized or malformed value is dropped, not written, rather than risking this entry's
  // `.meta.json` growing past `MAX_META_FILE_BYTES` on a revalidation.
  // code-reviewer B1 / security-architect S2 (Phase 4 round 2) — redacted, exactly like
  // `writeCache`'s identical block, and for the identical reason: `.meta.json` must not carry a
  // plaintext secret in `finalUrl` any more than it does in `url`. The "differs" comparison is
  // REDACTED-to-REDACTED, not raw-to-raw, so a raw finalUrl differing from the candidate only by
  // query/fragment/userinfo is correctly treated as "nothing left to report" rather than stored
  // as a confusing `finalUrl` that would render identically to `url` once both are redacted.
  if (finalUrl !== undefined) {
    const clean = sanitizeRemoteUrl(finalUrl);
    const redactedFinal = clean === undefined ? undefined : redactUrlForDisplay(clean);
    if (redactedFinal !== undefined && redactedFinal !== redactUrlForDisplay(url)) meta.finalUrl = redactedFinal;
    else delete meta.finalUrl;
  }
  // PAR-805 (F-7 file-mode half): owner-only, self-healing across every write (writeAtomic's
  // own comment) — this call had no `mode` at all before, unlike `writeCache`'s own writes below.
  writeAtomic(metaPath, JSON.stringify(meta, null, 2), { mode: 0o600 });
  return meta.fetchedAt;
}

/**
 * Both files are staged as temp files first, then renamed back to back — content, then meta
 * (N-5, PAR-656). Renaming is the only work between the two, so the window in which a
 * concurrent reader sees NEW content beside OLD meta (an etag that no longer describes the
 * document, an under-stated age) is two syscalls wide instead of a whole file write. It is
 * not zero: POSIX has no two-file atomic rename, and closing it entirely would need a single
 * content+meta file, which is a format change. Accepted, and bounded to a single-user local
 * cache where the loss is at worst one wasted revalidation.
 *
 * A crash before the second rename leaves the previous meta (or, on a first write, content
 * with no meta at all, which readCache reports as a miss — both files are required), so no
 * reader ever observes a partially written file.
 */
/** Returns the `fetchedAt` it wrote (A17/PAR-726 — see `touchCache`'s doc comment; the same
 *  reasoning applies here: report the timestamp actually persisted, not a freshly-taken one).
 *
 *  `finalUrl` (PAR-776, D-74): the URL the content was ACTUALLY fetched from, when `fetchUrl`
 *  followed a redirect away from `url` (the candidate this write is keyed by). Persisted only
 *  when it differs from `url` — the common, non-redirected case writes exactly the same file
 *  shape it always did — so a later CACHE HIT (no network call at all) can still tell `readCache`
 *  callers where the document's relative links and host policy should resolve against, not only
 *  the live fetch that first observed the redirect. Validated with `sanitizeRemoteUrl` even
 *  though it comes from `fetchUrl`'s own internal redirect-following (already held to the same
 *  https/non-forbidden-host bound `hopAllowed` enforces on every hop) — not to re-decide the
 *  host, but to bound its LENGTH the way `validEtag` already bounds `etag`'s (security-architect,
 *  PAR-776 round 1, B-1: an unbounded `Location` header written here can push a single entry's
 *  `.meta.json` past `MAX_META_FILE_BYTES`, making the WHOLE entry — not just its redirect
 *  awareness — permanently unreadable, defeating offline fallback for it). Dropped alone on
 *  rejection, exactly like an invalid `etag`: the entry still writes, just without the
 *  redirect-aware extra. */
/** Refuses to write through a symlinked cache root or a symlinked library directory, silently
 *  for the caller (never throws) but not silently for the operator: `warn` (defaulting to this
 *  file's `toStderr`) fires once per distinct refused ROOT per process (`refusedWriteRoots`,
 *  mirroring `cache-evict.ts`'s `refusedRoots`), and once per refused CALL for a symlinked
 *  library directory (rarer, so not worth a second dedupe set).
 *
 *  The root and library-directory checks run BEFORE `mkdirSync`, not after: `mkdirSync(dir, {
 *  recursive: true })` where the ROOT is a symlink succeeds SILENTLY and creates the library
 *  directory and both files INSIDE the symlink's target — there is no exception to catch
 *  afterward, so a check placed later would be too late. There is a THIRD, later refusal path
 *  too (the post-`mkdirSync` TOCTOU recheck below, whose own comment covers it) for which
 *  "nothing was created" no longer holds, since `mkdirSync` has by then already run.
 *
 *  On every refusal, whichever of the three checks catches it: `noteCacheWrite` is never called
 *  and nothing is written to `contentPath`/`metaPath`; the return value is
 *  `new Date().toISOString()` computed once up front — safe because no caller re-reads the cache
 *  to get the content it just tried to write (`fetcher.ts`'s `getLibraryDoc`/`fetchLinkedPage`
 *  serve the in-memory fetched body they already have; `writeCache`'s return is only ever used
 *  as the `fetchedAt` shown to the caller). See D-94 (`docs/decisions.md`, PAR-786) for
 *  the MEASURED finding that motivated checking before `mkdirSync` rather than after. */
export function writeCache(
  library: string,
  url: string,
  content: string,
  etag?: string,
  finalUrl?: string,
  warn: (message: string) => void = toStderr,
): string {
  if (Buffer.byteLength(content, "utf8") > MAX_CACHED_CONTENT_BYTES) throw new RangeError("Cached content exceeds 25 MiB; nothing was written");
  const fallbackFetchedAt = new Date().toISOString();
  const root = cacheRoot();
  // Deliberately ANY non-directory here, not "a symlink specifically" (`existsAsNonDirectory`,
  // not `isSymlinkAt` — contrast the LIBRARY-directory check below, which uses `isSymlinkAt` and
  // still lets a plain file at that narrower position throw, unchanged, out of `mkdirSync`).
  // The two are allowed to differ on purpose (code-reviewer, S2, PAR-786): a wrong ROOT is a
  // whole-cache misconfiguration — nothing under `VIBECTX_CACHE_DIR` is usable regardless of
  // which library asked — so it should degrade to "nothing persists this run" for every write,
  // not crash whichever request happens to go first. A plain file colliding with one specific
  // LIBRARY's directory position is narrow enough (one library, one name) that surfacing it as
  // an exception remains the more useful signal, and is the function's pre-existing behaviour
  // (`test/cache.test.ts`'s "library dir is a file" case) — not something this item changes.
  if (existsAsNonDirectory(root)) {
    if (!refusedWriteRoots.has(root)) {
      refusedWriteRoots.add(root);
      warn(
        `vibectx: refusing to cache into ${clipText(root, MAX_DISPLAY_PATH_CHARS)} — it is a symlink or another ` +
          `non-directory, not a real directory. Nothing was written. Remove it, or point VIBECTX_CACHE_DIR at a ` +
          `real directory.`,
      );
    }
    return fallbackFetchedAt;
  }
  const dir = libDirIn(root, library);
  // See `isSymlinkAt`'s own comment for why this is checked here, before `mkdirSync`, rather
  // than by catching whatever `mkdirSync` throws: a symlink leaf pointing at an existing real
  // directory does not throw at all.
  if (isSymlinkAt(dir)) {
    warn(
      `vibectx: refusing to cache "${clipText(library, MAX_CONFIG_VALUE_CHARS)}" into ` +
        `${clipText(dir, MAX_DISPLAY_PATH_CHARS)} — that path is a symlink, not a directory vibectx created. ` +
        `Nothing was written.`,
    );
    return fallbackFetchedAt;
  }
  // PAR-805: the ROOT first, THEN the library directory — two `ensureCacheRoot` calls, not one.
  // Calling it only on `dir` (as an earlier version of this fix did) never triggers the
  // pre-existing-loose-ROOT warning at all, because `ensureCacheRoot`'s own check is
  // `dir === cacheRoot()`, which a per-library directory can never equal — this call site would
  // then be the one PAR-805 site that silently skips the very check the OTHER five stores all
  // get, for a root the user may have set up before installing this fix. Calling it on `root`
  // first closes that gap; calling it again on `dir` still creates (or confirms) the library
  // directory at 0700 exactly as before — a newly created leaf gets the passed mode regardless
  // of its already-existing parent's own mode (MEASURED, this file's own investigation).
  // Unchanged from before this item: a plain file already at the LIBRARY-directory leaf still
  // throws EEXIST out of the `mkdirSync` inside `ensureCacheRoot`, exactly as
  // `test/cache.test.ts`'s "library dir is a file" case has always required —
  // `ensureCacheRoot` does not catch or soften that throw.
  ensureCacheRoot(root, warn);
  ensureCacheRoot(dir, warn);
  // Belt-and-suspenders against a TOCTOU between the `isSymlinkAt` check above and the writes
  // below (an external process replacing `dir` with a symlink in that window) — the same
  // residual `dropFollowedPageCache` documents and does not close either; cheap, since this
  // function already pays for the shape of this check elsewhere in the file.
  //
  // DISCLOSED, NOT TESTED (R5/R9 mutation check, PAR-786): removing this check alone, with
  // `isSymlinkAt` above left intact, makes no test in the suite fail — every reachable,
  // single-threaded test scenario that would trip this check is already caught by
  // `isSymlinkAt` first, since nothing changes `dir`'s own leaf between that check and
  // `mkdirSync` in a synchronous test. This line exists ONLY for the genuine multi-process race
  // (CWE-367) `dropFollowedPageCache`'s own comment names and does not close either — real, but
  // not exercisable from a single synchronous test process. Kept rather than removed: cheap
  // (one `lstat` this function already has the shape to do), and the alternative (dropping it)
  // would be quietly narrowing coverage of a real, if rare, race.
  if (!isRealDirectory(dir)) {
    warn(
      `vibectx: refusing to cache "${clipText(library, MAX_CONFIG_VALUE_CHARS)}" into ` +
        `${clipText(dir, MAX_DISPLAY_PATH_CHARS)} — it is not a real directory. Nothing was written.`,
    );
    return fallbackFetchedAt;
  }
  const slug = urlSlug(url);
  const contentPath = join(dir, `${slug}.md`);
  const metaPath = join(dir, `${slug}.meta.json`);
  // validEtag, not a bare passthrough (write-side asymmetry, security-architect A4 round 2):
  // `etag` here is `res.headers.get("etag")`, already normalised by the Fetch spec so it can
  // never carry a newline — but a nonconforming server's high-byte obs-text or an oversized
  // value would otherwise land on disk unfiltered, cost space against the size cap, and be
  // silently dropped again on the very next read anyway.
  // PAR-806 (Phase 4) — `url` is stored REDACTED (query/fragment/userinfo stripped) and
  // `urlHash` carries the full-fidelity identity proof (`urlHashFor`'s FULL 64-character SHA-256
  // digest of the RAW url — security-architect, Phase 4 round 2, B1: deliberately NOT the
  // 12-character value `urlSlug`'s own filename suffix uses; see `urlHashFor`'s own comment for
  // why conflating the two was a real, fixed regression) that `metaMatchesUrl`/`metaMatchesSlug`
  // (`cache-meta.ts`) use instead of a plaintext comparison — see `CacheMeta.url`'s own doc
  // comment for the full design and the backward-compatibility story for a `.meta.json` written
  // before this item.
  const meta: CacheMeta = { url: redactUrlForDisplay(url), urlHash: urlHashFor(url), contentHash: contentHashFor(content), contentBytes: Buffer.byteLength(content, "utf8"), sourceKind: classifySourceKind(url, content) as CacheMeta["sourceKind"], fetchedAt: fallbackFetchedAt };
  // PAR-787 — the library-NAME dimension's own identity record, mirroring `urlHash` above:
  // written on every new write, bounded (`toCacheMeta`'s own `MAX_NAME_LENGTH` check) so an
  // absurd `library` value never grows the file past `MAX_META_FILE_BYTES`; a value that fails
  // that bound is simply omitted (degrading this one entry to the old-format "nothing to check"
  // behaviour `metaMatchesLibrary` already falls back to), never a thrown error.
  if (library.length > 0 && library.length <= MAX_NAME_LENGTH) meta.library = library;
  if (validEtag(etag)) meta.etag = etag;
  // code-reviewer B1 / security-architect S2 (Phase 4 round 2) — `finalUrl` is redacted the same
  // way `url` is: before this fix, `.meta.json` stored the CLEANED-but-unredacted redirect
  // target, a second plaintext-secret site right next to the one this phase's own PAR-806 item
  // just closed for `url`. The "was there a redirect" gate now compares REDACTED-to-REDACTED
  // (not raw-to-raw): a raw finalUrl that differs from the candidate only by query/fragment/
  // userinfo redacts to the SAME string as the candidate, and in that case nothing meaningful
  // survives redaction to report — `meta.finalUrl` is correctly left unset rather than storing a
  // value that would render as "(redirected from X)" for the identical, already-shown X.
  if (finalUrl !== undefined) {
    const clean = sanitizeRemoteUrl(finalUrl);
    const redactedFinal = clean === undefined ? undefined : redactUrlForDisplay(clean);
    if (redactedFinal !== undefined && redactedFinal !== redactUrlForDisplay(url)) meta.finalUrl = redactedFinal;
  }
  const contentTmp = tempPathFor(contentPath);
  const metaTmp = tempPathFor(metaPath);
  try {
    // PAR-805 (F-7 file-mode half): owner-only at creation (POSIX `open()`'s mode is ignored
    // once a path exists, but `tempPathFor` names each temp file uniquely, so these are always
    // newly created) — `renameSync` then carries that mode onto `contentPath`/`metaPath`,
    // self-healing an older, looser file on its very next write, the same mechanism
    // `writeAtomic`'s own `opts.mode` already documents.
    //
    // PAR-860: `flag: "wx"` (`O_CREAT|O_EXCL`) on both — the default `writeFileSync` flag ("w",
    // `O_WRONLY|O_CREAT|O_TRUNC`) FOLLOWS a symlink already sitting at the destination, and
    // `tempPathFor`'s name is predictable to within a process id and a millisecond. `wx` refuses
    // to open ANY existing entry at that exact path, symlink or not, even a dangling one — POSIX:
    // `open()` with `O_CREAT|O_EXCL` on a path naming a symbolic link fails `EEXIST` regardless of
    // what the link points to, never following it. Safe against a false failure: a genuine
    // collision needs two writes to the IDENTICAL path in the IDENTICAL millisecond from the
    // IDENTICAL process, which this single-threaded synchronous function cannot produce for its
    // own two calls (`contentTmp`/`metaTmp` are already distinct paths) and cannot produce across
    // two separate `writeCache` invocations either, for the same reason. The existing `catch`
    // below (`rmSync(..., { force: true })`) is already correct for the refusal case: `rmSync` on
    // a symlink removes the link itself, never the target, so cleanup after a refused write never
    // touches whatever the planted link pointed at.
    writeFileSync(contentTmp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    writeFileSync(metaTmp, JSON.stringify(meta, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(contentTmp, contentPath);
    renameSync(metaTmp, metaPath);
  } catch (e) {
    try { rmSync(contentTmp, { force: true }); } catch { /* preserve the write failure */ }
    try { rmSync(metaTmp, { force: true }); } catch { /* preserve the write failure */ }
    throw e;
  }
  // Only after BOTH renames land: this document now exists and counts toward the cap, and it
  // is protected from eviction for the rest of this run (PAR-652 item 7a). Sweeping is
  // amortised inside noteCacheWrite, which never throws — an unsweepable cache must not fail
  // a write that already succeeded. `root`, not a second `cacheRoot()` call: the value this
  // function already proved real above.
  noteCacheWrite(root, contentPath, Buffer.byteLength(content, "utf8"));
  return meta.fetchedAt;
}

/**
 * A3 (PAR-716) — a successful refresh of a library's primary document drops every OTHER
 * cached page for that library: the pages `get_docs` followed from the OLD primary's link
 * structure. Those pages are keyed by their own URL (`fetchLinkedPage` → `writeCache`) in the
 * same per-library directory `writeCache` uses for the primary document, so a refresh that
 * replaces the primary leaves them sitting there, attributed to link text and a heading path
 * that may no longer exist. Nothing re-validates them until their own TTL expires, so the
 * next `get_docs` on that library can silently blend fresh primary content with a followed
 * page fetched under the document this refresh just replaced.
 *
 * Scope: only pages, keyed by URL, other than one of `keepUrls` — the primary document just
 * written, PLUS every other candidate URL still on the entry (round 1, code-reviewer, S2):
 * `entry.urls[1..n]` are `getLibraryDoc`'s own fallback chain (its "network failed everywhere"
 * loop, `fetcher.ts`), not followed pages, and deleting them turned a future primary-candidate
 * outage into a hard FAILED where the stale fallback used to serve a flagged document. Callers
 * pass the full candidate list, not just the one URL that was just fetched.
 *
 * Called only after a refetch that actually changed something (both `refresh.ts` call sites):
 * the direct-fetch path guards on `fetcher.ts`'s `isDocUnchanged(doc)`, and the
 * resolved-entry re-resolution path guards on `!out.unchanged` (`resolve.ts`'s
 * `ResolveOutcome.unchanged`, itself derived from the same two `DocResult` fields). Before
 * PAR-744 (F-7), NEITHER guard could tell a byte-identical 304 revalidation apart from a
 * genuine fresh fetch — `doc.staleNote` only ever distinguished a failed-network stale-cache
 * fallback, and the resolved-entry path had no staleness signal at all — so an unchanged
 * primary dropped its followed pages on every revalidated refresh. Fixed by adding
 * `DocResult.notModified` (`fetcher.ts`) and threading it through both call sites. ETag-only
 * (round 2, code-reviewer, S3): `fetchUrl` sends `if-none-match` and nothing else, so this only
 * helps a docs site that actually serves an `etag` — a site with no validator at all still
 * drops its followed pages on every scheduled refresh, exactly as before this item.
 *
 * THE COST WAS REAL, NOT ONLY A WASTED RE-FETCH (round 2, code-reviewer, SF-1, on the
 * now-fixed ETag-revalidation case — the earlier wording here claimed the dropped pages are
 * "simply re-fetched next time, never served wrong"; MEASURED false for the offline path and
 * corrected). A page dropped on an unchanged refresh, that used to be served flagged `STALE:`
 * during an upstream outage or under `offline`, reported "Could not fetch N index links"
 * instead — `fetchLinkedPage`'s offline/unavailable branch (its `offline && !hit` case,
 * `fetcher.ts`) had nothing to fall back to once the cached copy was gone. Never a correctness
 * bug (nothing was ever served WRONG), but a real cost against this project's offline-first
 * convention, and it landed on the common ETag-revalidated case above — which is why this was
 * worth fixing rather than merely disclosing.
 *
 * RESIDUAL, disclosed rather than fixed here (round 2, code-reviewer, S6; filed PAR-788):
 * `notModified`/`staleNote` mean "this URL's bytes are unchanged", not "the library's PRIMARY
 * document is unchanged" — `getLibraryDoc` probes `entry.urls` in order and returns the first
 * candidate that succeeds, so if candidate A (long cached, still carrying a valid etag) was
 * failing and candidate B became the primary `get_docs` actually served and followed links
 * from, then A later recovers and revalidates via 304, `doc.url` is A, `notModified` is true,
 * and this function is skipped — leaving B's followed pages attributed to a primary that is no
 * longer A's (or B's) current one. Narrow, and not new IN KIND: the pre-existing `staleNote`
 * fallback has the identical exposure (it also takes the first cached candidate, never
 * specifically the previously-chosen one) — this item adds a second door to the same room, not
 * a new room. No cheap fix: `refresh.ts` does not know which URL was previously primary, and
 * followed pages are not keyed by which primary they were followed from.
 *
 * Best effort (D-13): an unreadable directory or an unremovable file costs a page that
 * outlives its purpose, never a throw — refresh's own result is not this function's to fail.
 *
 * D-46, in full (round 1, code-reviewer, B1; round 2, security-architect, C1): the ROOT is
 * proven a real directory before anything below it is touched, not just the library directory
 * — `cacheRoot()` itself does not make that guarantee (`lstat` on `<symlinked-root>/<library>`
 * answers `isDirectory() true` because it stats the target) — and the checked root is captured
 * once into `root` and threaded through `libDirIn`, so the value proven real is provably the
 * value used, not a second, later `cacheRoot()` call this function has to trust agrees with
 * the first. RESIDUAL, stated rather than silently accepted: an external process could still
 * replace the root or this library's directory with a symlink between the `isRealDirectory`
 * checks and the `readdirSync`/`rmSync` calls below (CWE-367) — the same residual
 * `enforceCacheSizeCap` (cache-evict.ts) carries and does not document either. Bounded two
 * ways: this function's body is entirely synchronous (no `await` inside it for such a race to
 * land in), and `rmSync` on a plain path issues `unlink(2)` on the final path component, which
 * POSIX never resolves through a symlink — so even a same-instant swap of a FILE for a symlink
 * removes the link, not whatever it points at. Round 3 (security-architect, N3): C2 below
 * widens this same window by one `readFileSync` + `JSON.parse` per candidate — the residual's
 * KIND is unchanged (still only the non-final path components are swappable, still fully
 * synchronous), but its DURATION is longer than round 1's version.
 *
 * Below the root, symlinked or non-regular entries are left alone, never followed or removed.
 * A candidate must be a REAL file whose name is one of this library's own `<slug>.md` /
 * `<slug>.meta.json` pairs, its slug not one of `keepUrls`', AND (round 2, security-architect,
 * C2) its `.meta.json` half must exist, be no larger than `MAX_META_FILE_BYTES` (R3 — the same
 * `Stats` the existence check already paid for), pass the SAME validation `readCache` requires
 * (`readMetaFile`/`toCacheMeta`, A4's four corruption classes), AND (round 4, code-reviewer,
 * SF-C — closing security-architect's N1 in full, not just its empty-slug instance) have a
 * `url` field that `urlSlug` maps back to the SAME slug the filename carries — the actual
 * proof that this is the file `writeCache` produced for that URL, not merely A file that
 * happens to sit under a name shaped like one. A lone `.md`, a lone `.meta.json`, an oversized
 * one, one this process cannot trust, or one whose meta names a different URL entirely is left
 * in place for eviction, rather than unlinked on name shape alone (the temp sweep does NOT
 * apply here: `TEMP_FILE_PATTERN` matches neither suffix). This bounds a `VIBECTX_CACHE_DIR`
 * aimed at a real directory this tool does not otherwise own: only files this tool itself
 * wrote — proven, not merely name-shaped — are deleted. `library` itself is also refused when
 * empty, above: `libDirName("")` is no longer able to collapse the scan to `root` (D-71 gave
 * it a non-empty hash suffix regardless of input), but the guard is kept as the documented
 * contract rather than an implementation accident.
 *
 * COLLISION-RESISTANT since D-71 (PAR-749) — previously the finding recorded here, now fixed
 * rather than merely disclosed: `libDirIn`'s `library → directory` mapping used to fold
 * distinct valid names that differ only in a character its regex maps to `_` (e.g. an npm name
 * `foo.bar` and `foo_bar`) onto the SAME directory, EVERY time, so refreshing one could delete
 * the other's cached primary — the SF-C proof above could not catch it, because the deleted
 * pair genuinely WAS one this tool wrote, just for the other library sharing the folded name.
 * `libDirName` now appends a hash of the full library name to the fold, so two distinct names
 * sharing a fold no longer collide in the ordinary case (see `shortHash`'s comment in
 * `cache-meta.ts` for the precise, non-absolute guarantee — a deliberately forced collision on
 * this dimension has no second check to fall back on, unlike the URL dimension's `meta.url`
 * comparison; see `libDirName`'s own comment) — see `test/cache.test.ts`'s "no longer collide"
 * case, which replaced the old characterization test of this same finding.
 */
export function dropFollowedPageCache(
  library: string,
  keepUrls: readonly string[],
  warn: (message: string) => void = toStderr,
): void {
  // Round 3 (security-architect, N1): an empty `library` collapses `libDirIn(root, "")` to
  // `root` itself (`path.join` drops a zero-length segment) — unreachable from this item's own
  // callers (`refresh.ts` always passes a Registry-resolved, non-empty `entry.name`), but this
  // function is exported and guards neither end of its own contract otherwise. Refused here.
  if (library.length === 0) return;
  const root = cacheRoot();
  if (!isRealDirectory(root)) return; // D-46 / C1: prove the ROOT — and use THIS value, not a second cacheRoot() call — before anything below can delete through it
  const dir = libDirIn(root, library);
  if (!isRealDirectory(dir)) return; // nothing cached for this library, or not ours to touch
  const keep = new Set(keepUrls.map(urlSlug));
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const slugs = new Set<string>();
  for (const name of names) {
    if (name.endsWith(".md")) slugs.add(name.slice(0, -".md".length));
    else if (name.endsWith(".meta.json")) slugs.add(name.slice(0, -".meta.json".length));
  }
  let dropped = 0;
  for (const slug of slugs) {
    // Round 3 (code-reviewer, SF-A, MEASURED): `urlSlug` can never return "" for a non-empty
    // URL (its own `.replace` leaves at least one character per non-empty input), so a literal
    // `.md` / `.meta.json` pair — empty slug — cannot be a file THIS tool wrote under any URL.
    // Cheap early exit before the lstat calls below; SUPERSEDED as the security boundary by the
    // `urlSlug(meta.url) === slug` check further down (round 4, code-reviewer, SF-C), which
    // subsumes this case along with every other malformed slug — kept only as an optimisation.
    if (slug.length === 0 || keep.has(slug)) continue;
    const contentPath = join(dir, `${slug}.md`);
    const metaPath = join(dir, `${slug}.meta.json`);
    let metaStat: Stats;
    try {
      // C2: a candidate must be a REAL file with a META that PARSES — never a lone half of
      // the pair, and never one unlinked on name shape alone.
      if (!lstatSync(contentPath).isFile()) continue;
      metaStat = lstatSync(metaPath);
      if (!metaStat.isFile()) continue;
    } catch {
      continue; // one half vanished, or is a symlink/directory: not ours to touch here
    }
    // Round 2 (security-architect, R3): the same `Stats` already paid for above bounds the
    // read C2 requires — no candidate this tool itself wrote is anywhere near this size (a
    // `CacheMeta` is a URL, an ISO instant and an optional etag), so a directory entry over it
    // is either not this tool's or already unparseable; skip the read+parse either way rather
    // than paying for a `JSON.parse` a directory of many planted files could otherwise force.
    if (metaStat.size > MAX_META_FILE_BYTES) continue;
    const meta = readMetaFile(metaPath);
    if (meta === undefined) continue; // C2: unproven — leave it for eviction
    // Round 4 (code-reviewer, SF-C; closes security-architect's N1 in full, not just the
    // empty-slug instance): a real, parseable pair is STILL not proof this tool wrote it under
    // THIS name — nothing before this line checks that the meta's own `url` is the one that
    // produced `slug`. A directory entry named, say, `my-notes.md` / `my-notes.meta.json`
    // carrying any OTHER valid `CacheMeta` passed every check above and was deleted.
    // `metaMatchesSlug` (D-71, `./cache-meta.js`) is the same `urlSlug` round-trip `writeCache`
    // used to NAME the file in the first place, so requiring it is not a new rule
    // — it is the one this function already claimed to enforce, actually checked. Validated
    // safe for every legitimate pair (including one whose URL is long enough to hit `urlSlug`'s
    // 120-char truncation): `urlSlug` is a pure function of the URL alone, so a slug
    // `writeCache` produced from a URL always round-trips.
    if (!metaMatchesSlug(meta, slug)) continue;
    try {
      rmSync(contentPath, { force: true });
      rmSync(metaPath, { force: true });
      dropped += 1;
    } catch (e) {
      warn(
        `vibectx: could not drop stale followed-page cache file ${clipText(contentPath, MAX_DISPLAY_PATH_CHARS)}: ${clipText(e instanceof Error ? e.message : String(e), MAX_CONFIG_VALUE_CHARS)}`,
      );
    }
  }
  // C3: the delete is otherwise silent on success — say what happened, so a mis-aimed
  // VIBECTX_CACHE_DIR or an unexpectedly empty offline cache has a trail to follow.
  if (dropped > 0) warn(`vibectx: refresh dropped ${dropped} stale followed-page${dropped === 1 ? "" : "s"} for "${clipText(library, MAX_CONFIG_VALUE_CHARS)}"`);
}
