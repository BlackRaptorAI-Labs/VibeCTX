import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { cleanText, clipText, stripBom } from "./text.js";
import { redactUrlForDisplay, validateLibraryUrl } from "./link-policy.js";
import { MAX_NAME_LENGTH } from "./package-names.js";
import { MAX_TOPIC_CHARS } from "./limits.js";
import type { LibraryEntry } from "./registry.js";

/**
 * Config discovery (PAR-657). MCP clients launch the server with a fixed command line, so
 * `--config <path>` can never carry a committed team config: this module finds one.
 *
 * Sources, highest precedence first (D-14):
 *   1. `--config <path>`                         (flag)
 *   2. `VIBECTX_CONFIG=<path>`                   (env)
 *   3. `./vibectx.config.json`, walking up to the git root   (project)
 *   4. `$XDG_CONFIG_HOME/vibectx/config.json`, else `~/.config/vibectx/config.json` (user)
 *   5. the shipped defaults
 *
 * An EXPLICIT source is authoritative: given a flag or the env var, discovery of (3) and (4)
 * is skipped entirely — exactly the 0.1.x behaviour for everyone already passing `--config`.
 * Otherwise user layers over the defaults and project layers over that (registry.ts does the
 * merging, one layer at a time, so D-06 / D-07 apply between layers as they do today).
 *
 * Everything here is injectable: `cwd`, `env` and `home` are parameters, never read from the
 * process, so tests cannot be changed by the machine they run on.
 */

export const CONFIG_FILENAME = "vibectx.config.json";
/** The user-level file is `<config dir>/vibectx/config.json` — the directory already names it. */
export const USER_CONFIG_FILENAME = "config.json";
export const CONFIG_ENV = "VIBECTX_CONFIG";
/** ASSUMED cap (D-17): no real config is this big, and a huge file is a mistake worth naming. */
export const MAX_CONFIG_BYTES = 1024 * 1024;

export type ConfigScope = "flag" | "env" | "project" | "user";

export interface ConfigFile {
  /** As given for a flag / env source; absolute for a discovered one. */
  path: string;
  scope: ConfigScope;
  /** Retained in reports for compatibility; discovered 0.3.0 files are never legacy. */
  legacy: boolean;
  /** D-19: set by the loader when a DISCOVERED file failed and was skipped — the reason,
   *  one line, without the path (the header and the warning add it). Never set for an
   *  explicit source: a `--config` or `VIBECTX_CONFIG` that cannot be honoured is fatal. */
  error?: string;
  /** How the loader named this file in its messages (cwd-relative, `~/…`, else absolute). */
  display?: string;
}

export interface ConfigResolution {
  /** LOWEST precedence first — registry.ts applies them in this order. */
  files: ConfigFile[];
  /** Ignored-file notes, already display-formatted (D-18). */
  notes: string[];
}

export interface DiscoverConfigOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** The `--config` value, when one was passed. */
  flag?: string;
  /** Home directory for the user-level file (default: os.homedir()). */
  home?: string;
  /** D-20 seam: who owns a directory (default: `statSync(dir).uid`, undefined when it cannot
   *  be read). Injectable so a test can plant a foreign owner without a second user. */
  ownerUid?: (dir: string) => number | undefined;
}

/** Resolve the config sources for one process. Throws only when a candidate path exists but
 *  is not a regular file (D-15); a missing file is simply not a source. */
export function discoverConfig(opts: DiscoverConfigOptions): ConfigResolution {
  const notes: string[] = [];
  const home = opts.home ?? homedir();
  const show = (p: string): string => displayPath(p, opts.cwd, home);

  // The trimmed value is what was tested for emptiness, so it is also what is used: a path
  // that differs from it only by surrounding whitespace is the same path.
  const flag = opts.flag?.trim();
  if (flag) return { files: [{ path: flag, scope: "flag", legacy: false }], notes };
  const env = (opts.env[CONFIG_ENV] ?? "").trim();
  if (env) return { files: [{ path: env, scope: "env", legacy: false }], notes };

  const files: ConfigFile[] = [];
  const userDir = userConfigDir(opts.env, home);
  const user = userDir === undefined ? undefined : pickInDirectory(userDir, "user", USER_CONFIG_FILENAME);
  if (user) files.push(user); // lowest precedence first
  const walk = projectDirs(opts.cwd, opts.ownerUid ?? directoryUid);
  let projectFound = false;
  for (const dir of walk.dirs) {
    const hit = pickInDirectory(dir, "project", CONFIG_FILENAME);
    if (hit) {
      files.push(hit); // nearest wins; parents are NOT layered (monorepo layering is a follow-up)
      projectFound = true;
      break;
    }
  }
  // D-20 + D-18: if the walk stopped on a foreign-owned directory that DOES hold a config,
  // say so. Silence would leave a team believing their committed file is in force — the
  // failure mode D-19 exists to prevent — while a directory without one says nothing, so
  // an ordinary start under /tmp stays quiet.
  //
  // The gate is "no PROJECT-scope file was found", not "no file at all": a user-level config
  // loading is not an answer to "why is my committed config not in force?", and gating on
  // `files.length` would have let the presence of `~/.config/vibectx/config.json` — which
  // almost every long-time user has — silence the note for everybody.
  if (!projectFound && walk.foreign !== undefined) {
    const path = join(walk.foreign, CONFIG_FILENAME);
    if (fileKind(path) !== "absent") {
      notes.push(`${show(path)} is ignored: ${show(walk.foreign)} is owned by another user`);
    }
  }
  return { files, notes };
}

/**
 * `$XDG_CONFIG_HOME/vibectx`, else `<home>/.config/vibectx`; undefined when there is no home.
 * The XDG base directory spec requires an ABSOLUTE path and says a relative one must be
 * ignored — and a relative one here would be resolved against the working directory, which
 * is how an unrelated repo's `./vibectx/config.json` would become "the user's config" (K2).
 */
function userConfigDir(env: NodeJS.ProcessEnv, home: string): string | undefined {
  const xdg = (env.XDG_CONFIG_HOME ?? "").trim();
  if (xdg && isAbsolute(xdg)) return join(xdg, "vibectx");
  if (!home) return undefined;
  return join(home, ".config", "vibectx");
}

/** `path.resolve` falls back to `process.cwd()` for a relative input; discovery must depend
 *  only on the cwd it was given (K2), so an absolute path is merely normalised. */
function fromCwd(cwd: string, path?: string): string {
  if (path === undefined) return isAbsolute(cwd) ? normalize(cwd) : resolve(cwd);
  return isAbsolute(path) ? normalize(path) : join(fromCwd(cwd), path);
}

/** Owner of a directory, or undefined when it cannot be stat'ed. */
function directoryUid(dir: string): number | undefined {
  return statSync(dir, { throwIfNoEntry: false })?.uid;
}

/**
 * D-15 — the directories the walk-up may look in: cwd, then each parent, stopping AFTER the
 * one that holds `.git` (a directory in a clone, a file in a worktree). With no `.git` above
 * cwd at all, only cwd is checked, so a stray config in `/tmp` or `$HOME` is never picked up.
 *
 * D-20 — and only directories the current user OWNS. The walk stops at the first directory
 * with a different uid: its config is not read and no parent of it is looked at. This is
 * git's `safe.directory` reasoning — on a shared machine anyone can create `/tmp/x/.git`
 * beside a `/tmp/x/vibectx.config.json` and wait for someone to run a server under it.
 * Where uids do not exist (Windows: no `process.getuid`) the check is skipped.
 */
function projectDirs(cwd: string, ownerUid: (dir: string) => number | undefined): { dirs: string[]; foreign?: string } {
  const start = fromCwd(cwd);
  const mine = typeof process.getuid === "function" ? process.getuid() : undefined;
  const trusted = (dir: string): boolean => mine === undefined || ownerUid(dir) === mine;
  const dirs: string[] = [];
  let cur = start;
  for (;;) {
    // Reaching an untrusted directory ends the walk WITHOUT a repository, so D-15's
    // no-repository rule applies just as it does at the filesystem root: cwd only. The
    // directories walked so far are not a project root — they are merely the ones below a
    // directory someone else owns, and returning them would let `/shared/vibectx.config.json`
    // be outranked while `/shared/proj/vibectx.config.json` silently became the team config.
    // (`dirs` is empty only when cwd ITSELF is foreign, and then nothing may be searched.)
    if (!trusted(cur)) return { dirs: dirs.slice(0, 1), foreign: cur };
    dirs.push(cur);
    if (existsSync(join(cur, ".git"))) return { dirs };
    const parent = dirname(cur);
    if (parent === cur) return { dirs: [start] }; // no repository anywhere above: cwd only
    cur = parent;
  }
}

/** The config file to use from one directory, with D-16's notes. */
function pickInDirectory(
  dir: string,
  scope: ConfigScope,
  mainName: string,
): ConfigFile | undefined {
  const main = join(dir, mainName);
  const mainKind = fileKind(main);
  if (mainKind !== "absent") {
    return withKind({ path: main, scope, legacy: false }, mainKind);
  }
  return undefined;
}

/** `file` when a regular file (symlinks are followed — the user's own tree), `other` for a
 *  directory / device / anything unreadable, `absent` when nothing is there.
 *  B-02 retained decision: linked monorepos and dotfile setups may use a symlinked config;
 *  placing one requires project write access that already permits editing the real config. */
function fileKind(path: string): "file" | "other" | "absent" {
  try {
    const st = statSync(path, { throwIfNoEntry: false });
    if (st === undefined) return "absent";
    return st.isFile() ? "file" : "other";
  } catch {
    return "other"; // it exists in some form we cannot inspect: reported, never silently skipped
  }
}

/** D-19: a DISCOVERED path that is not a usable file is a skipped source, not a fatal error —
 *  the layers below it still load. (An explicit `--config` naming one still fails in
 *  `readConfigFile`, where the same check is fatal.) */
function withKind(file: ConfigFile, kind: "file" | "other"): ConfigFile {
  return kind === "file" ? file : { ...file, error: "not a regular file" };
}

/**
 * D-18 display rule: relative to cwd when beneath it, `~`-abbreviated when under home,
 * absolute otherwise. Always POSIX separators, so the header reads the same everywhere.
 *
 * S3: the result is cleaned and clipped HERE, at the one place a display path is built, so
 * that every sink is safe by construction — the `list_libraries` header, the D-19 stderr
 * line, the `doctor` table and `configIssues[].path`. A directory or file name is text this
 * process did not write (anyone who can create a directory chooses it), and only the header
 * used to clean it: a repository called `repo<ESC>[31m<RLO>evil` otherwise carried a
 * terminal control sequence and a bidi override into three other sinks.
 */
export function displayPath(path: string, cwd: string, home?: string): string {
  return clipText(rawDisplayPath(path, cwd, home), MAX_DISPLAY_PATH_CHARS);
}

/** Longest display path. A path is a label in a one-line message here, not a value to be
 *  round-tripped, and 200 characters is well past any real repository path. ASSUMED. */
export const MAX_DISPLAY_PATH_CHARS = 200;

function rawDisplayPath(path: string, cwd: string, home?: string): string {
  const abs = fromCwd(cwd, path);
  const rel = relative(fromCwd(cwd), abs);
  if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return `./${rel.split(sep).join("/")}`;
  if (home && (abs === home || abs.startsWith(home + sep))) return `~/${relative(home, abs).split(sep).join("/")}`;
  return abs;
}

/**
 * D-18 — the lines `list_libraries` starts with: one `config:` line naming the sources
 * actually loaded, highest precedence first, then any deprecation / ignored-file note.
 * Everything passes through `cleanText` (S3), because a path is attacker-adjacent text.
 */
export function describeConfig(resolution: ConfigResolution, opts: { cwd: string; home?: string; redactPaths?: boolean }): string[] {
  const parts = [...resolution.files].reverse().map((f) => {
    const shown = opts.redactPaths ? "[redacted]" : displayPath(f.path, opts.cwd, opts.home);
    if (f.scope === "flag") return `--config ${shown}`;
    if (f.scope === "env") return `${CONFIG_ENV}=${shown}`;
    // D-19: a discovered file that failed is still named — silence would leave the reader
    // believing their committed config is in force.
    return `${shown} (${f.scope})${f.error === undefined ? "" : ` — NOT LOADED: ${f.error}`}`;
  });
  const header = parts.length === 0 ? "config: none (shipped defaults)" : `config: ${parts.join(" · ")}`;
  return [header, ...(opts.redactPaths ? resolution.notes.map(() => "config note: inspect terminal diagnostics") : resolution.notes)].map(cleanText);
}

/* ------------------------------------------------------------------ *
 * D-17 / D-22 — file validation. ONE line per failure, in ONE grammar:
 *
 *   <display path>: libraries[i].<field> ("<name>" when known): <message>
 *
 * for schema failures here and for the semantic ones registry.ts raises (alias
 * collisions, allowedHosts values, D-06 conflicts) alike. Never a zod issue dump,
 * never a JSON.parse stack, and never any content of the file: a config path can be
 * pointed at any file on disk (`--config ~/.env`), so only positions are reported.
 * ------------------------------------------------------------------ */

/** Longest config-error line. A message is read by a human in a terminal or an MCP
 *  client's log pane; anything longer is a payload, not a message. ASSUMED. */
export const MAX_CONFIG_ERROR_CHARS = 300;
/** Longest quoted value inside one (a hostname, a library name). ASSUMED. */
export const MAX_CONFIG_VALUE_CHARS = 80;

/**
 * One config failure, as one printable line. `detail` is the part after the display path,
 * which is what the D-18 header shows next to a file it could not load (D-19). Both parts
 * are cleaned and bounded on the way in, so every consumer prints a safe line.
 */
export class ConfigError extends Error {
  readonly display: string;
  readonly detail: string;
  constructor(display: string, detail: string) {
    const shownPath = clipText(display, MAX_CONFIG_ERROR_CHARS);
    const shownDetail = clipText(detail, MAX_CONFIG_ERROR_CHARS - 2);
    super(clipText(`${shownPath}: ${shownDetail}`, MAX_CONFIG_ERROR_CHARS));
    this.name = "ConfigError";
    this.display = shownPath;
    this.detail = shownDetail;
  }
}

/**
 * D-22's locator: `libraries[3].allowedHosts ("acme")`. The name is quoted only when the
 * file actually supplies one — a broken `name` field has nothing to quote — and is clipped,
 * because it is attacker-adjacent text from a file the user may not have written.
 */
export function configLocator(index: number, field: string, name?: unknown): string {
  const known = typeof name === "string" && name.trim().length > 0;
  const shown = known ? ` (${JSON.stringify(clipText(name as string, MAX_CONFIG_VALUE_CHARS))})` : "";
  return `libraries[${index}].${field}${shown}`;
}

/** PAR-853 — a config entry's `urls` is a hand-written candidate list (llms-full.txt,
 *  llms.txt, a curated fallback — the URL RULE comment in registry.ts describes the ordinary
 *  shape: 2-4 entries); nothing legitimate needs hundreds. Before this bound, only
 *  `MAX_CONFIG_BYTES` (1 MiB) capped the count — MEASURED (a temp config file built with 500
 *  distinct short `https://` URLs on one entry, parsed through `readConfigFile`): it loaded
 *  without complaint at roughly 20 KB, well under the 1 MiB byte ceiling — and `getLibraryDoc`
 *  iterates `entry.urls` with no count limit of its own (PAR-853's operation deadline bounds
 *  the TIME that costs; this bounds the count that could cost it, at the source). ASSUMED
 *  (docs/decisions.md): generous over every shipped `DEFAULT_REGISTRY` entry (the largest is 4) and
 *  over the `docs.expo.dev`-style 4-candidate pattern used throughout, while ruling out a
 *  pathological list. Distinct from `limits.ts`'s `MAX_URLS_PER_ENTRY` (20), which bounds a
 *  RESOLVED entry's own probe candidates (an entirely different code path — `resolved-store.ts`
 *  — that this file does not touch); the two are not meant to agree, since a config author
 *  writes `urls` by hand and a resolver generates its candidates programmatically. */
export const MAX_URLS_PER_CONFIG_ENTRY = 50;

const URLS_MESSAGE = `must be a non-empty array of at most ${MAX_URLS_PER_CONFIG_ENTRY} https URLs`;
/** PAR-1269 (D6): `versionUrls` reuses the `urls` bound for both the number of majors and each
 *  major's list — no new limit. Keys are whole major numbers ("6", never "6.x" or "06"). */
const VERSION_URLS_MESSAGE = `must map whole major numbers ("6") to non-empty arrays of at most ${MAX_URLS_PER_CONFIG_ENTRY} https URLs, for at most ${MAX_URLS_PER_CONFIG_ENTRY} majors`;
const MAJOR_KEY = /^(0|[1-9][0-9]*)$/;
const isUrlList = (v: unknown): boolean => Array.isArray(v) && v.length > 0 && v.length <= MAX_URLS_PER_CONFIG_ENTRY && v.every(isNonEmptyString);
const isVersionUrls = (v: unknown): boolean => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const entries = Object.entries(v as Record<string, unknown>);
  return entries.length > 0 && entries.length <= MAX_URLS_PER_CONFIG_ENTRY && entries.every(([key, list]) => MAJOR_KEY.test(key) && isUrlList(list));
};
const STRINGS_MESSAGE = "must be an array of non-empty strings";
const LIBRARIES_MESSAGE = "must be an array of library entries";
const TTL_MESSAGE = "must be a number of hours, 0 or greater (0 = always revalidate)";

const isNonEmptyString = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;
const isStringList = (v: unknown): boolean => Array.isArray(v) && v.every(isNonEmptyString);
/** PAR-868 — config discovery can load a project file the caller did not author, so the
 * canonical name is cleaned and bounded before any registry, cache, or diagnostic sees it. */
const cleanConfigName = (name: string): string => clipText(cleanText(name), MAX_NAME_LENGTH);
const isNonEmptyConfigName = (v: unknown): v is string => typeof v === "string" && cleanConfigName(v).trim().length > 0;

/** `err` is what `validateLibraryUrl` threw for `raw`; strips its self-describing `urls:
 *  "<value>" ` prefix so the D-22 locator (which already names the field and the value) is
 *  not printed twice — the same idiom `registry.ts`'s `whyHostRefused` uses for `allowedHosts`. */
function whyUrlRefused(err: unknown, raw: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const shown = typeof raw === "string" ? raw : JSON.stringify(raw);
  const prefix = `urls: "${shown}" `;
  return message.startsWith(prefix) ? message.slice(prefix.length) : message;
}

/** Unknown ENTRY keys are stripped, not rejected (forward-compatible): a config written for a
 *  later version still loads here. `resolved` goes with them — only the resolver may set it.
 *
 *  `ecosystem` — D-63 REVERSED at PAR-854/D-90 (`docs/decisions.md`): D-63 rejected a
 *  config-settable `ecosystem` because at the time it was purely advisory (`warm.ts`'s display
 *  note), reaching "no lookup, no fetch, no cache key, no exit code" — true THEN, no longer true
 *  now that `registry.ts`'s cross-layer merge and lookup key PEP 503 (PyPI punctuation)
 *  normalisation on this field: an npm/undeclared entry's spelling is never folded: two
 *  independently-registrable npm names (`foo.bar`, `foo_bar`) must never collapse into one, the
 *  defect PAR-854 fixed. A config author declaring `ecosystem: "pypi"` on their OWN entry is not
 *  a new trust boundary — they already fully control that entry's `urls`/`allowedHosts` — so
 *  accepting the value here is safe; the enum keeps it to exactly the two values `registry.ts`
 *  understands, an accurate value is the only thing a config author can supply. */
const EntrySchema = z
  .object({
    name: z.custom<string>(isNonEmptyConfigName, "must be a non-empty string").transform(cleanConfigName),
    // Shape only here (non-empty array of non-empty strings): the URL trust decision itself
    // — https-only, no userinfo, host not forbidden — is D-49's `validateLibraryUrl`, applied
    // per-entry below so it can see `allowInternalHosts`. Never re-implement a subset of it here.
    urls: z.custom<string[]>(isUrlList, URLS_MESSAGE),
    // PAR-1269 (D6): shape here; each URL clears the same `validateLibraryUrl` as `urls` below.
    versionUrls: z.custom<Record<string, string[]>>(isVersionUrls, VERSION_URLS_MESSAGE).optional(),
    aliases: z.custom<string[]>(isStringList, STRINGS_MESSAGE).optional(),
    probeQueries: z.custom<string[]>(isStringList, STRINGS_MESSAGE)
      .transform((queries) => queries.map((query) => clipText(cleanText(query), MAX_TOPIC_CHARS)))
      .refine(isStringList, STRINGS_MESSAGE).optional(),
    allowedHosts: z
      .custom<string[]>((v) => Array.isArray(v) && v.every((h) => typeof h === "string"), "must be an array of hostnames")
      .optional(),
    description: z.string({ invalid_type_error: "must be a string" }).optional(),
    // D-21: 0 is a real setting — "always revalidate", which is what a 0.1.3 config meant by it
    // and what cache.ts still does with it. Only a negative or non-finite value is a mistake.
    ttlHours: z
      .number({ invalid_type_error: TTL_MESSAGE, required_error: TTL_MESSAGE })
      .finite(TTL_MESSAGE)
      .min(0, TTL_MESSAGE)
      .optional(),
    // D-47: internal/loopback/non-routable hosts are reachable only through this explicit,
    // per-entry, author-written opt-in — never the default. Ref: A1 / PAR-714.
    allowInternalHosts: z.boolean({ invalid_type_error: "must be a boolean" }).optional(),
    // PAR-854/D-90 — see this schema's own doc comment above. `registry.ts`'s `normaliseLayer`
    // no longer strips this; it is what the cross-layer merge keys PEP 503 folding on.
    ecosystem: z.enum(["npm", "pypi"], { invalid_type_error: 'must be "npm" or "pypi"' }).optional(),
    // PAR-854/D-90 — the explicit, disclosed opt-in `registry.ts`'s cross-layer merge requires
    // before it will let a config entry silently replace an existing npm/undeclared entry whose
    // name is only a PUNCTUATION (PEP 503) spelling apart from this one (`next_js` vs `next.js`):
    // names the entry (by its OWN, i.e. pre-override, canonical name) this one supersedes. Not
    // needed for an exact-name override (unchanged, pre-existing "last layer wins" behaviour) or
    // for a genuine PyPI twin (registry.ts still auto-collapses those — same PyPI project, two
    // spellings, D-78's original rule, unaffected). See registry.ts's `applyLayer`.
    replaces: z.custom<string>(isNonEmptyString, "must be a non-empty string").optional(),
  })
  .superRefine((entry, ctx) => {
    // Belt-and-braces: `urls`'s own shape check above aborts the object parse on anything but
    // a non-empty array of non-empty strings (z.custom defaults to fatal:true), so this
    // superRefine never runs against a malformed `urls` today — but that guarantee lives in
    // zod's abort semantics, not in this file, so don't let a future change turn a rejection
    // into an uncaught TypeError.
    if (!Array.isArray(entry.urls)) return;
    entry.urls.forEach((raw, i) => {
      try {
        validateLibraryUrl(raw, { allowInternalHosts: entry.allowInternalHosts });
      } catch (err) {
        const why = whyUrlRefused(err, raw);
        // code-reviewer B1 / security-architect S2 (Phase 4 round 2) — a rejected config URL is
        // echoed into a Zod issue message that reaches `ConfigError`/`LayerFailure.reason`, which
        // in turn reaches `list_libraries`' "NOT LOADED: ..." header (rendered into the agent's
        // context) and `doctor --json`'s `configIssues[].reason`. Before this fix, `shown` was the
        // RAW, unredacted url — the sharpest case being a URL rejected specifically FOR carrying
        // userinfo (`user:pass@host`, exactly the shape this whole phase strips everywhere else),
        // which put the password straight into agent-visible output. Redacted here so this
        // diagnostic still names which entry failed and why (host and path survive in full; only
        // the query string, fragment and userinfo are gone).
        const shown = clipText(redactUrlForDisplay(raw), MAX_CONFIG_VALUE_CHARS);
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["urls", i], message: `"${shown}" ${why}` });
      }
    });
    // PAR-1269 (D6): the same URL trust decision, the same redacted diagnostic.
    for (const [major, list] of Object.entries(entry.versionUrls ?? {})) {
      list.forEach((raw, i) => {
        try {
          validateLibraryUrl(raw, { allowInternalHosts: entry.allowInternalHosts });
        } catch (err) {
          const shown = clipText(redactUrlForDisplay(raw), MAX_CONFIG_VALUE_CHARS);
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["versionUrls", major, i], message: `"${shown}" ${whyUrlRefused(err, raw)}` });
        }
      });
    }
  });

/** Unknown TOP-LEVEL keys (`$comment`, `$schema`) are ignored the same way. D-21: `libraries`
 *  itself is OPTIONAL — `{}` (and an explicit `null`) load as "no entries", which is how a
 *  0.1.3 config with the key commented out behaved. Any other type is still an error. */
const ConfigSchema = z.object(
  {
    libraries: z.array(EntrySchema, { required_error: LIBRARIES_MESSAGE, invalid_type_error: LIBRARIES_MESSAGE }).nullish(),
    /** Global network policy, deliberately opt-in. It applies to every fetch made from this
     * discovered configuration, including defaults and entries resolved at runtime. */
    strictDns: z.boolean({ invalid_type_error: "must be a boolean" }).optional(),
    /** C5: opt-in read of public GitHub Releases; absent means off. */
    checkUpdates: z.boolean({ invalid_type_error: "must be a boolean" }).optional(),
    /** PAR-1039: archives the activity log keeps. Checked where it is used, not here: a bad
     *  value prints one line and keeps 5 (Tom's decision), it must not make the file fail. */
    logArchives: z.unknown().optional(),
    /** PAR-1048: `"all"` opts the server's autowarm back into every configured library. Checked
     *  where it is used: a bad value prints one line and keeps `"project"`. */
    autowarm: z.unknown().optional(),
  },
  { invalid_type_error: 'must be an object with a "libraries" array', required_error: 'must be an object with a "libraries" array' },
);

/**
 * The D-22 locator for a zod issue path: `libraries` for a top-level failure,
 * `libraries[2].urls ("acme")` for an entry field — the entry's own name is read back out
 * of the parsed JSON when the file supplies a usable one. `""` when the whole document is
 * the wrong shape (path `[]`), which needs no locator at all.
 */
function issueLocator(path: readonly (string | number)[], json: unknown): string {
  if (path.length === 0) return "";
  if (path.length < 3 || typeof path[1] !== "number" || typeof path[2] !== "string") {
    return path.map((seg, i) => (typeof seg === "number" ? `[${seg}]` : i === 0 ? seg : `.${seg}`)).join("");
  }
  const [, index, field] = path;
  const entry = (json as { libraries?: unknown[] } | null)?.libraries?.[index] as { name?: unknown } | undefined;
  return configLocator(index, String(field), entry?.name);
}

/** `EACCES`, `EIO`, … — the errno alone, never the system message (which repeats the path). */
function errnoOf(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && code.length > 0 ? clipText(code, 32) : "unknown error";
}


/**
 * `invalid JSON at line L column C` — the position, and NOTHING from the file (S1). Every
 * V8 syntax-error message quotes a run of the offending source ("Unexpected token 'S',
 * \"SECRET=hun\"... is not valid JSON"), so the message itself is discarded: a config path
 * is user-supplied and may name a `.env`, an id_rsa or any other file whose bytes must not
 * reach a log. Line/column come from the parser's own position when it reports one (every
 * supported Node does; Node 20+ also prints them itself).
 */
function jsonErrorMessage(text: string, err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const at = /at position (\d+)/.exec(raw);
  if (!at) return "invalid JSON";
  const pos = Math.min(Number(at[1]), text.length);
  const before = text.slice(0, pos);
  const lastBreak = before.lastIndexOf("\n");
  return `invalid JSON at line ${before.split("\n").length} column ${pos - lastBreak}`;
}

/**
 * Read and validate one config file. `display` is what the message names it (the caller may
 * pass a cwd-relative form); everything it throws is a single line safe to print.
 */
export function readConfigFile(path: string, display: string = path): { libraries: LibraryEntry[]; strictDns?: boolean; checkUpdates?: boolean; logArchives?: unknown; autowarm?: unknown } {
  let st;
  try {
    st = statSync(path, { throwIfNoEntry: false });
  } catch (e) {
    throw new ConfigError(display, `cannot be read (${errnoOf(e)})`);
  }
  if (st === undefined) throw new ConfigError(display, "not found");
  if (!st.isFile()) throw new ConfigError(display, "not a regular file");
  if (st.size > MAX_CONFIG_BYTES) throw new ConfigError(display, "larger than 1 MiB");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    // Permissions, a vanished file, an I/O error: the errno is the whole story, and the
    // system message would repeat the path (S1 keeps the line to one copy of it).
    throw new ConfigError(display, `cannot be read (${errnoOf(e)})`);
  }
  const text = stripBom(raw);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(display, jsonErrorMessage(text, e));
  }
  const parsed = ConfigSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issueLocator(issue!.path, json);
    throw new ConfigError(display, `${where === "" ? "" : `${where}: `}${issue!.message}`);
  }
  return {
    libraries: (parsed.data.libraries ?? []) as LibraryEntry[],
    ...(parsed.data.strictDns !== undefined ? { strictDns: parsed.data.strictDns } : {}),
    ...(parsed.data.checkUpdates !== undefined ? { checkUpdates: parsed.data.checkUpdates } : {}),
    ...(parsed.data.logArchives !== undefined ? { logArchives: parsed.data.logArchives } : {}),
    ...(parsed.data.autowarm !== undefined ? { autowarm: parsed.data.autowarm } : {}),
  };
}
