import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { parse, resolve as resolvePath } from "node:path";
import { installResolvedEntry, type LibraryEntry, type Registry } from "./registry.js";
import { getLibraryDoc, type DocResult } from "./fetcher.js";
import { discoverProjectDependencies, isDeniedDependency, type ProjectDependency, type ProjectDiscovery } from "./project-deps.js";
import { lookupLibrary, resolvePackage } from "./resolve.js";
import { MAX_BACKGROUND_RESOLUTIONS_PER_HOUR } from "./limits.js";
import { envFlag } from "./text.js";
import { readCache } from "./cache.js";
import { mapLimit } from "./concurrency.js";
import { openIndexSession } from "./search-index.js";
import { markAutowarmStarted, addInFlight, deleteInFlight, clearInFlight } from "./autowarm-status.js";
import { writeStderrWarning } from "./redact-paths.js";

// Re-exported so existing importers keep pinning the live implementation, now defined in
// autowarm-status.ts (A8 / PAR-721, Move 5): src/index.ts (the only PRODUCTION consumer —
// do not delete this line, index.ts's `started.closed` handler, currently at :48, has an
// orphan-process guard that depends on it), test/autowarm.test.ts, test/server.test.ts, and
// test/autowarm-status.test.ts (which imports both symbols through this file specifically to
// pin their identity against autowarm-status.js's own exports -- that identity test is what
// goes red first if this re-export is deleted). list-libraries.ts is NOT a consumer of this
// re-export -- it was repointed to autowarm-status.js directly, which is what actually breaks
// the list-libraries -> autowarm -> fetcher edge this item exists to remove.
export { autowarmStatus, resetAutowarm } from "./autowarm-status.js";

/**
 * Startup revalidation for the long-lived MCP server (PAR-656, from the PAR-653 comment:
 * "the cache does not warm or refresh itself"). After the server's first online tool call —
 * and only there: never under `doctor` / `resolve` / `warm`, never with `--offline` — the
 * libraries in scope (PAR-1048: by default the project's dependencies that match a configured
 * library; with `all`, every CONFIGURED library; resolved records are left alone) that are
 * uncached or past their TTL are fetched in the background through the ordinary `getLibraryDoc`: an entry with
 * a cached copy is revalidated with `If-None-Match` first (a 304 costs no body), an
 * uncached one is fetched in candidate order. Only the primary document; no index links.
 *
 * Runs at AUTOWARM_CONCURRENCY. server.ts starts it (never awaited on the request path)
 * AFTER the transport is connected, so it never delays the handshake and never blocks a
 * tool call (fetches are async I/O; a concurrent get_docs for the same entry simply
 * fetches too — both write the same content, atomically). Every error is swallowed into one
 * summary line on stderr; the server cannot crash because of it. Opt out with
 * `VIBECTX_NO_AUTOWARM=1`. When the transport closes, the AbortSignal server.ts passes fires
 * and no further entry is scheduled (R4); a fetch already in flight completes on its own
 * (the fetcher's 20 s timeout bounds it; index.ts ends the process after a short grace).
 *
 * Volume, for the record (scope `all`): a first start with an empty cache fetches up to 30 default
 * entries × (their llms.txt candidates + the README fallback) — the same requests
 * `refresh` would make, spread two at a time; a start with a warm cache makes at most one
 * conditional request per stale entry, and none for fresh ones.
 */

export const AUTOWARM_CONCURRENCY = 2;
export const AUTOWARM_OPT_OUT_ENV = "VIBECTX_NO_AUTOWARM";
/** PAR-1048: `all` opts back into warming every configured library; anything else is `project`. */
export const AUTOWARM_SCOPE_ENV = "VIBECTX_AUTOWARM";

/**
 * PAR-1048 (Tom's F11, option a; amends D-97's "starts autowarm") — what the server's autowarm
 * covers. `project` (the default): the dependencies of the project in `dir` that match a
 * built-in or configured library, with no npm or PyPI request; unknown dependencies are resolved
 * in the background only while `mayResolve()` (consent `allowed`, re-read before each one), within
 * `MAX_BACKGROUND_RESOLUTIONS_PER_HOUR` (F32). `all`: every configured library, the pre-0.3.0
 * behaviour, now opt-in. `startAutowarm` called without a scope warms `all` (its own unit tests
 * exercise the warm machinery); the server always passes the decided scope.
 */
export type AutowarmScope =
  | { kind: "all" }
  | {
      kind: "project";
      /** The working directory, read when the warm starts (inside its error handling). */
      cwd: () => string;
      home?: string;
      /** Re-read before every background resolution: true only while consent is `allowed`. */
      mayResolve: () => boolean;
    };

/** `all` or `project` from the user-config `autowarm` key (over `VIBECTX_AUTOWARM`). A bad value
 *  prints one line and keeps `project`; a project config never reaches here (registry.ts). */
export function autowarmScopeSetting(env: NodeJS.ProcessEnv, configValue: unknown, warn: (message: string) => void): "all" | "project" {
  if (configValue !== undefined) {
    if (configValue === "all" || configValue === "project") return configValue;
    warn('vibectx: autowarm in config must be "all" or "project"; using "project"\n');
    return "project";
  }
  const raw = (env[AUTOWARM_SCOPE_ENV] ?? "").trim().toLowerCase();
  if (raw === "" || raw === "project") return "project";
  if (raw === "all") return "all";
  warn(`vibectx: ${AUTOWARM_SCOPE_ENV} must be "all" or "project"; using "project"\n`);
  return "project";
}

/** PAR-1048 (F12) — the project autowarm may read: the working directory, resolved, when it
 *  holds a supported manifest. The home folder and a filesystem root never count, even with a
 *  stray manifest in them: neither is a project, and warming from one would be a guess. */
export function autowarmProjectDir(cwd: string, home: string = homedir()): string | undefined {
  return scanAutowarmProject(cwd, home)?.dir;
}

/** `autowarmProjectDir` plus the discovery it read, so the project is scanned once. Home and
 *  root are compared by real path, so a symlinked home (or a link to it) is still home. */
function scanAutowarmProject(cwd: string, home: string): ProjectDiscovery | undefined {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolvePath(p);
    }
  };
  const dir = resolvePath(cwd);
  const realDir = real(dir);
  if (realDir === real(home) || realDir === parse(realDir).root || dir === parse(dir).root) return undefined;
  const discovery = discoverProjectDependencies(dir);
  return discovery.manifests.length > 0 ? { ...discovery, dir } : undefined;
}

/** F32: start times of this process's background resolutions, a one-hour sliding window. */
let backgroundResolutionStarts: number[] = [];
function takeBackgroundResolutionSlot(nowMs: number): boolean {
  backgroundResolutionStarts = backgroundResolutionStarts.filter((t) => nowMs - t < 3600_000);
  if (backgroundResolutionStarts.length >= MAX_BACKGROUND_RESOLUTIONS_PER_HOUR) return false;
  backgroundResolutionStarts.push(nowMs);
  return true;
}
/** Test hook: forget the background window. */
export function resetBackgroundResolutionWindow(): void {
  backgroundResolutionStarts = [];
}
const DEFAULT_TTL_HOURS = 168;

export interface AutowarmSummary {
  /** Entries that needed warming when the run started. */
  attempted: number;
  cached: number;
  failed: string[];
  /** Entries never scheduled because the transport closed first (R4). */
  aborted: number;
}

/** Off when `VIBECTX_NO_AUTOWARM` is an on-word or unrecognized (`envFlag`, PAR-1044 I-3); absent,
 *  "", 0, false, no or off leave autowarm on. The server has
 *  no `--offline` mode (that flag belongs to `doctor` / `warm`), so nothing else is consulted;
 *  subcommands never reach this: server.ts alone calls it, on the server path (R5). */
export function shouldAutowarm(env: NodeJS.ProcessEnv): boolean {
  return envFlag(env[AUTOWARM_OPT_OUT_ENV]) === false; // PAR-1044 (I-3): an unrecognized value keeps autowarm off
}

function needsWarm(e: LibraryEntry): boolean {
  const ttl = e.ttlHours ?? DEFAULT_TTL_HOURS;
  return !e.urls.some((u) => {
    const hit = readCache(e.name, u, ttl);
    return hit !== undefined && !hit.stale;
  });
}

/** Configured (non-resolved) entries with no fresh cached candidate. */
export function configuredEntriesNeedingWarm(registry: Registry): LibraryEntry[] {
  const out: LibraryEntry[] = [];
  for (const e of registry.entries.values()) {
    if (e.resolved) continue;
    if (needsWarm(e)) out.push(e);
  }
  return out;
}

/** PAR-1048 — the project's dependencies split into configured entries to warm (matched by
 *  name or alias, deduplicated, fresh ones skipped) and names no library matches. Resolved
 *  records are left alone, as before. Denied (noise-list) names are neither. */
export function projectAutowarmTargets(registry: Registry, discovery: ProjectDiscovery): { entries: LibraryEntry[]; unknown: ProjectDependency[] } {
  const entries = new Map<string, LibraryEntry>();
  const unknown: ProjectDependency[] = [];
  for (const dep of discovery.dependencies) {
    if (isDeniedDependency(dep.name, dep.ecosystem)) continue;
    const entry = lookupLibrary(registry, dep.name);
    if (entry === undefined) unknown.push(dep);
    else if (!entry.resolved && !entries.has(entry.name) && needsWarm(entry)) entries.set(entry.name, entry);
  }
  return { entries: [...entries.values()], unknown };
}

/**
 * Warm every entry `configuredEntriesNeedingWarm` returns. Never throws and never rejects:
 * per-entry failures are collected, one summary line goes to `warn` (stderr by default)
 * when anything was attempted, and the summary is returned for tests.
 */
export async function startAutowarm(
  registry: Registry,
  opts: {
    concurrency?: number;
    warn?: (message: string) => void;
    /** Once aborted (transport close or consent revocation), no further entry is scheduled (R4). */
    signal?: AbortSignal;
    /** Distinguish a later consent revocation from transport close in the summary. */
    abortReason?: () => string;
    /** Test seam; defaults to getLibraryDoc. */
    fetchDoc?: (entry: LibraryEntry) => Promise<DocResult | undefined>;
    /** PAR-1048: what to warm; omitted means every configured library (`all`). */
    scope?: AutowarmScope;
  } = {},
): Promise<AutowarmSummary> {
  markAutowarmStarted();
  const warn = opts.warn ?? ((m: string) => writeStderrWarning(m));
  const fetchDoc = opts.fetchDoc ?? ((entry: LibraryEntry) => getLibraryDoc(entry));
  const summary: AutowarmSummary = { attempted: 0, cached: 0, failed: [], aborted: 0 };
  const errors: string[] = [];
  const lookups = { attempted: 0, resolved: 0, unresolved: [] as string[], stopped: undefined as string | undefined };
  // R2: one index read and one index write for the whole autowarm, not one pair per library.
  const index = openIndexSession(warn);
  try {
    const scope = opts.scope ?? { kind: "all" };
    let targets: LibraryEntry[];
    let unknown: ProjectDependency[] = [];
    if (scope.kind === "all") targets = configuredEntriesNeedingWarm(registry);
    else {
      const project = scanAutowarmProject(scope.cwd(), scope.home ?? homedir());
      if (project === undefined) targets = []; // F12: no project here; get_docs still fetches on demand
      else ({ entries: targets, unknown } = projectAutowarmTargets(registry, project));
    }
    summary.attempted = targets.length;
    await mapLimit(targets, opts.concurrency ?? AUTOWARM_CONCURRENCY, async (entry) => {
      if (opts.signal?.aborted) {
        summary.aborted += 1;
        return;
      }
      addInFlight(entry.name);
      try {
        const doc = await fetchDoc(entry);
        // D-34 (PAR-659): the startup autowarm leaves a usable cross-library search index
        // behind, so the first `search` of a session is the fast path. Only the PRIMARY
        // document, and best effort — the index is derived, so a failure here changes nothing
        // about the warm (D-13).
        if (doc) index.add(entry.name, doc.url, doc.content);
        if (doc && !doc.staleNote) summary.cached += 1;
        else summary.failed.push(entry.name);
      } catch (e) {
        summary.failed.push(entry.name);
        errors.push(`${entry.name}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        deleteInFlight(entry.name);
      }
    });
    // PAR-1048 (F11): unknown dependencies only under `allowed` consent — under `disclosed` this
    // makes no npm or PyPI request at all — and within the background budget (F32), one at a
    // time, after the matched libraries. A resolved entry is installed exactly as `warm` does.
    // Consent is re-read before EVERY lookup: a `vibectx consent deny` or `reset` mid-run stops
    // the next one (an in-flight lookup may finish). Lookups are reported in the summary line;
    // they are not tool calls, so the activity log (D-51) does not record them.
    if (scope.kind === "project" && unknown.length > 0 && scope.mayResolve()) {
      for (const dep of unknown) {
        if (opts.signal?.aborted || !scope.mayResolve()) {
          lookups.stopped = opts.signal?.aborted ? (opts.abortReason?.() ?? "transport closed") : "consent no longer allowed";
          break;
        }
        if (!takeBackgroundResolutionSlot(Date.now())) {
          lookups.stopped = `background limit of ${MAX_BACKGROUND_RESOLUTIONS_PER_HOUR} per hour reached`;
          break;
        }
        lookups.attempted += 1;
        try {
          const out = await resolvePackage(dep.name, { ecosystem: dep.ecosystem, version: dep.version, strictDns: registry.strictDns, warn: (m) => errors.push(m.trimEnd()) });
          if (out.ok && out.entry) {
            installResolvedEntry(registry, out.persistedEntry ?? out.entry);
            lookups.resolved += 1;
          } else {
            lookups.unresolved.push(dep.name);
          }
          if (out.limited) {
            lookups.stopped = "the per-process lookup limit was reached";
            break;
          }
        } catch (e) {
          lookups.unresolved.push(dep.name);
          errors.push(`${dep.name}: ${e instanceof Error ? e.message : String(e)}`.trimEnd());
        }
      }
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    index.flush();
    clearInFlight();
  }
  if (summary.attempted > 0 || errors.length > 0 || lookups.attempted > 0 || lookups.stopped !== undefined) {
    const failed = summary.failed.length > 0 ? `; not fetched: ${summary.failed.join(", ")}` : "";
    const aborted = summary.aborted > 0 ? `; ${summary.aborted} not started (${opts.abortReason?.() ?? "transport closed"})` : "";
    const detail = errors.length > 0 ? ` (${errors.join("; ")})` : "";
    // PAR-1048: background lookups of unknown dependencies, so none goes unreported.
    const looked = lookups.attempted > 0 || lookups.stopped !== undefined
      ? `; looked up ${lookups.attempted} unknown dependenc${lookups.attempted === 1 ? "y" : "ies"} (${lookups.resolved} resolved${lookups.unresolved.length > 0 ? `; not resolved: ${lookups.unresolved.join(", ")}` : ""})${lookups.stopped !== undefined ? `; lookups stopped: ${lookups.stopped}` : ""}`
      : "";
    try {
      warn(`vibectx: autowarm cached ${summary.cached}/${summary.attempted} configured libraries${failed}${aborted}${looked}${detail}\n`);
    } catch {
      // stderr closed: nothing left to report to
    }
  }
  return summary;
}
