import { homedir } from "node:os";
import type { Registry } from "./registry.js";
import { describeConfig } from "./config.js";
import { clipText } from "./text.js";
import { readCacheMetadata, inspectCacheRoot } from "./cache.js";
import { autowarmStatus } from "./autowarm-status.js";
import { readProjectRecord, summariseProjectRecord } from "./project-store.js";
import { readDoctorVerdicts } from "./doctor-store.js";
import { bugFailureOffer } from "./bug-report.js";
import { VERSION } from "./version.js";

/** Longest config- or registry-supplied field (name, one alias, description) in one row.
 *  A row is a one-line summary; anything longer is a payload, not a description. ASSUMED. */
export const MAX_LIBRARY_FIELD_CHARS = 200;

export interface ListLibrariesOptions {
  /** Directory whose `vibectx warm` record (if any) is summarised on the last line (default: process.cwd()). */
  projectDir?: string;
  /** Entries the startup autowarm has in flight (default: the live set). */
  warming?: ReadonlySet<string>;
  /** Directory the config paths in the header are shown relative to (default: process.cwd()). */
  cwd?: string;
  /** Home directory the header `~`-abbreviates against (default: os.homedir()). */
  home?: string;
}

/** The list_libraries tool body. One line per library: name (plus `(aka …)` when it has
 *  aliases), description, cache status — with `warming…` while the startup autowarm is
 *  fetching that entry (PAR-656) — the source kind stored at the last cache write
 *  (`unknown` for legacy metadata without that field; `vibectx doctor` fetches and probes), and `[resolved]` for
 *  entries resolve_library synthesized, and (A19/PAR-728) a `[doctor: check failed (<kind>),
 *  checked <date>]` note when the last `vibectx doctor` run found the entry unhealthy — e.g.
 *  index-only with no link followed successfully, or a probe that returned no match — a fact
 *  the cache-status and kind brackets alone do not carry (PAR-704: a source can be cleanly
 *  cached and still fail every probe). Absent entirely when doctor has never checked the
 *  entry, so "no note" never overclaims health the way `unknown` for the kind bracket already
 *  declines to. Deliberately states only the closed `kind` enum and the check date, never
 *  doctor's free-text `reasons` — the persisted verdict store is process-global while a
 *  library's config is per-project, so free text from one project's `doctor` run could
 *  otherwise leak into another project's response (security-architect, A19/PAR-728 round 1,
 *  S-1). When `vibectx warm` has a record for the working directory, one closing line
 *  summarises it. Never touches the network. */
export function listLibrariesText(registry: Registry, opts: ListLibrariesOptions = {}): string {
  const warming = opts.warming ?? autowarmStatus().inFlight;
  const doctorVerdicts = readDoctorVerdicts();
  const rows = [...registry.entries.values()].map((e) => {
    const ttl = e.ttlHours ?? 168;
    let cached: ReturnType<typeof readCacheMetadata>;
    for (const u of e.urls) {
      cached = readCacheMetadata(e.name, u, ttl);
      if (cached) {
        break;
      }
    }
    const base = cached ? `cached ${cached.meta.fetchedAt}${cached.stale ? " (stale)" : ""}` : "not cached";
    const status = warming.has(e.name) ? `${base}, warming…` : base;
    const kind = cached?.meta.sourceKind ?? "unknown";
    // S2 (PAR-657): name, aliases and description come from a config file or a package
    // registry — text this process did not write. Clean every one of them at the point of
    // render, so a terminal escape or a bidi override cannot ride out in a tool answer —
    // and CLIP them, because cleaning leaves length: a 5 KB `description` in one entry
    // would otherwise bury the other rows of the answer in a client's log pane.
    const show = (s: string): string => clipText(s, MAX_LIBRARY_FIELD_CHARS);
    const aka = e.aliases && e.aliases.length > 0 ? ` (aka ${e.aliases.map(show).join(", ")})` : "";
    const resolved = e.resolved ? " [resolved]" : ""; // synthesized by resolve_library, not curated (PAR-655)
    const description = e.resolved && e.description ? `(package-supplied) ${e.description}` : (e.description ?? "");
    // A19/PAR-728 — security-architect round 1, S-1 (BLOCKING): the cache directory `doctorVerdicts`
    // is read from is process-global, but a library's config (and so its `reasons`, built in
    // part from config-authored `probeQueries` text and from raw error messages that can carry
    // filesystem paths) is per project. Rendering free-text `reasons` here would leak another
    // project's config-authored or error text into THIS project's tool response. Fixed by
    // rendering only the closed `kind` enum and the check date — never `reasons` — the same
    // restriction `get_docs`'s own stamp (`retrieval.ts`'s `doctorKind`) already applied.
    const verdict = doctorVerdicts.get(e.name);
    const doctorNote = verdict && !verdict.healthy ? ` [doctor: check failed (${verdict.kind}), checked ${verdict.checkedAt}]` : "";
    return `- **${show(e.name)}**${aka} — ${show(description)} [${status}] [${kind}]${resolved}${doctorNote}`;
  });
  const record = readProjectRecord(opts.projectDir ?? process.cwd());
  const footer = record ? `\n\n${summariseProjectRecord(record, { redactDir: true })}` : "";
  // D-18 (PAR-657): which config files this server actually loaded, in precedence order,
  // then any deprecation / ignored-file note. A hand-built registry has no resolution to
  // report, so it keeps the 0.1.x header.
  const header = registry.config
    ? describeConfig(registry.config, { cwd: opts.cwd ?? process.cwd(), home: opts.home ?? homedir(), redactPaths: true })
    : [];
  const root = inspectCacheRoot();
  const rootLine = `Cache dir: [redacted]${root.status === "refused" ? ` — refused (${root.reason}); nothing is being cached this run` : ""}`;
  const offer = root.status === "refused"
    ? `\n\n${bugFailureOffer({ operation: "list_libraries", where: "cache", errorClass: "CacheError", version: VERSION, platform: process.platform, nodeVersion: process.version })}`
    : "";
  return `${[...header, rootLine].join("\n")}\n\n${rows.join("\n")}${footer}${offer}`;
}
