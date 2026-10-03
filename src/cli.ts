import { ISSUE_NEW_URL } from "./repository.js";
import { loadDiscoveredRegistry, type Registry } from "./registry.js";
import { ConfigError } from "./config.js";
import { runDoctor, formatDoctorTable, doctorExitCode } from "./doctor.js";
import { resolveToolText, type Ecosystem } from "./resolve.js";
import { runWarm, formatWarmTable, warmExitCode } from "./warm.js";
import { formatSearchResults, runSearch, searchExitCode, MAX_QUERY_CHARS, MAX_TOKENS_BUDGET, type SearchOutcome } from "./search.js";
import { configureActivityLog, readActivityLog, readActivityTrail, formatActivityLogTable, formatActivityTrailTable } from "./activity-log.js";
import { cacheRoot } from "./cache.js";
import { MAX_NAME_LENGTH } from "./package-names.js";
import { clipText, stripControlBidi } from "./text.js";
import { readConsent, resetConsent, saveConsent } from "./consent.js";
import { VERSION } from "./version.js";
import { buildBugPreview, isPublicTechName, issueLinkAfterConfirmation, type BugFacts, type BugOperation, type BugWhere, type BugErrorClass, type TechKind } from "./bug-report.js";

/**
 * Subcommand dispatch for the `vibectx` binary: `doctor`, `resolve`, `warm`, `search`,
 * `log`, and `consent`; no command starts the MCP stdio server in index.ts, while an unknown first
 * command exits 2. Kept transport- and process-free so the dispatcher is unit-testable.
 */

export interface DoctorCliArgs {
  json: boolean;
  /** Explicit opt-in to the full cache path in JSON output. */
  showCachePath?: true;
  offline: boolean;
  library?: string;
  config?: string;
  /** PAR-858 — restores the pre-PAR-858 full per-library listing (every row, one `✗ lib:
   *  reason` line per unhealthy library) instead of the default grouped-by-cause summary.
   *  Ignored (has no effect) with `--json`, which has always been fully unabridged. */
  verbose: boolean;
}

export interface ResolveCliArgs {
  name: string;
  ecosystem?: Ecosystem;
  config?: string;
}

export interface WarmCliArgs {
  json: boolean;
  offline: boolean;
  /** Retry names the project record marks unresolved within the last 24 h (R3). */
  force?: true;
  dir?: string;
  config?: string;
}

export interface SearchCliArgs {
  json: boolean;
  query: string;
  /** Repeatable `--library <name>`; empty means every cached library. */
  libraries: string[];
  maxTokens?: number;
  config?: string;
  /** D-41: the query was longer than MAX_QUERY_CHARS and was cut to it. */
  clipped?: true;
}

/** A20/PAR-729: `vibectx log` reads `<cacheRoot>/activity.json` directly — it takes no
 *  `--config` because it names no registry entry and resolves nothing; the log records
 *  what other commands already resolved. */
export interface LogCliArgs {
  json: boolean;
  /** PAR-1039: show the rotation trail instead of the entries. */
  trail: boolean;
}

export interface CliIo {
  stdout(s: string): void;
  stderr(s: string): void;
  /** Human confirmation after the preview; absent means no link can be generated. */
  confirm?(question: string): Promise<boolean>;
}

export const DOCTOR_USAGE = "usage: vibectx doctor [--json] [--show-cache-path] [--library <name>] [--config <path>] [--offline] [--verbose]";
export const RESOLVE_USAGE = "usage: vibectx resolve <package> [--npm | --pypi] [--config <path>]";
export const WARM_USAGE = "usage: vibectx warm [dir] [--offline] [--force] [--json] [--config <path>]";
export const LOG_USAGE = "usage: vibectx log [--json] [--trail]";
export const CONSENT_USAGE = "usage: vibectx consent [reset | allow | deny]";
export const BUG_REPORT_USAGE = "usage: vibectx report-bug --operation <tool> --where <component> --error-class <class> [--tech <kind:name>]…";
export const SEARCH_USAGE =
  "usage: vibectx search <query> [--library <name>]… [--max-tokens <n>] [--json] [--config <path>]";

/** Parse the arguments after `doctor`. Throws on anything not in DOCTOR_USAGE. */
export function parseDoctorArgs(args: string[]): DoctorCliArgs {
  const parsed: DoctorCliArgs = { json: false, offline: false, verbose: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--json":
        parsed.json = true;
        break;
      case "--show-cache-path":
        parsed.showCachePath = true;
        break;
      case "--offline":
        parsed.offline = true;
        break;
      case "--verbose":
        parsed.verbose = true;
        break;
      case "--library":
      case "--config": {
        const value = args[i + 1];
        if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
        if (arg === "--library") parsed.library = value;
        else parsed.config = value;
        i += 1;
        break;
      }
      default:
        if (arg!.startsWith("-")) throw new Error(`Unknown option "${arg}"`);
        throw new Error(`Unexpected argument "${arg}"`);
    }
  }
  if (parsed.showCachePath && !parsed.json) throw new Error("--show-cache-path requires --json");
  return parsed;
}

/** Parse the arguments after `resolve`: one package name, `--npm` or `--pypi`, `--config`. */
export function parseResolveArgs(args: string[]): ResolveCliArgs {
  let name: string | undefined;
  let ecosystem: Ecosystem | undefined;
  let config: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--npm":
      case "--pypi": {
        const eco: Ecosystem = arg === "--npm" ? "npm" : "pypi";
        if (ecosystem !== undefined && ecosystem !== eco) throw new Error("--npm and --pypi are mutually exclusive");
        ecosystem = eco;
        break;
      }
      case "--config": {
        const value = args[i + 1];
        if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
        config = value;
        i += 1;
        break;
      }
      default:
        if (arg!.startsWith("-")) throw new Error(`Unknown option "${arg}"`);
        if (name !== undefined) throw new Error(`Unexpected argument "${arg}"`);
        name = arg;
    }
  }
  if (name === undefined) throw new Error("resolve requires a package name");
  const parsed: ResolveCliArgs = { name };
  if (ecosystem !== undefined) parsed.ecosystem = ecosystem;
  if (config !== undefined) parsed.config = config;
  return parsed;
}

/** Parse the arguments after `warm`: an optional directory, `--offline`, `--json`, `--config`. */
export function parseWarmArgs(args: string[]): WarmCliArgs {
  const parsed: WarmCliArgs = { json: false, offline: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--json":
        parsed.json = true;
        break;
      case "--offline":
        parsed.offline = true;
        break;
      case "--force":
        parsed.force = true;
        break;
      case "--config": {
        const value = args[i + 1];
        if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
        parsed.config = value;
        i += 1;
        break;
      }
      default:
        if (arg!.startsWith("-")) throw new Error(`Unknown option "${arg}"`);
        if (parsed.dir !== undefined) throw new Error(`Unexpected argument "${arg}"`);
        parsed.dir = arg;
    }
  }
  return parsed;
}

/**
 * Parse the arguments after `search` (PAR-659): one query — the words may be quoted as one
 * argument or left as several, because `vibectx search server-sent events streaming` is what a
 * person actually types — plus a repeatable `--library`, `--max-tokens`, `--json`, `--config`.
 *
 * A bare word is query text, never a flag: `--library` is the only way to name a library, so a
 * package called `warm` or `--json`-shaped text cannot be misread as one.
 */
export function parseSearchArgs(args: string[]): SearchCliArgs {
  const words: string[] = [];
  const parsed: SearchCliArgs = { json: false, query: "", libraries: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--json":
        parsed.json = true;
        break;
      case "--library":
      case "--max-tokens":
      case "--config": {
        const value = args[i + 1];
        if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
        if (arg === "--library") parsed.libraries.push(value);
        else if (arg === "--config") parsed.config = value;
        else {
          const n = Number(value);
          // A2 (PAR-715): the accepted RANGE is exactly the MCP schemas' — the integers in
          // (0, MAX_TOKENS_BUDGET] — so this path cannot admit a value get_docs/search would
          // reject. (Number() itself is looser than zod's — it reads "0x30" or "  4000  " —
          // but nothing outside that range gets through either way.)
          if (!Number.isInteger(n) || n <= 0 || n > MAX_TOKENS_BUDGET)
            throw new Error(`--max-tokens requires a positive whole number no greater than ${MAX_TOKENS_BUDGET}, not "${value}"`);
          parsed.maxTokens = n;
        }
        i += 1;
        break;
      }
      default:
        if (arg!.startsWith("-")) throw new Error(`Unknown option "${arg}"`);
        words.push(arg!);
    }
  }
  parsed.query = words.join(" ").trim();
  if (parsed.query.length === 0) throw new Error("search requires a query");
  // D-41: a shell can paste a megabyte. Clip rather than refuse — the first MAX_QUERY_CHARS
  // characters are still a searchable question — and say so, so nobody wonders why the tail
  // of what they typed had no effect. (`runSearch` bounds it again; this is what tells the
  // person at the terminal.)
  if (parsed.query.length > MAX_QUERY_CHARS) {
    parsed.query = parsed.query.slice(0, MAX_QUERY_CHARS);
    parsed.clipped = true;
  }
  return parsed;
}

/** Parse the arguments after `log` (A20/PAR-729): the one flag, `--json`. */
export function parseLogArgs(args: string[]): LogCliArgs {
  const parsed: LogCliArgs = { json: false, trail: false };
  for (const arg of args) {
    if (arg === "--json") parsed.json = true;
    else if (arg === "--trail") parsed.trail = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option "${arg}"`);
    else throw new Error(`Unexpected argument "${arg}"`);
  }
  return parsed;
}

/** Every control and bidi character except the newlines and tabs that give text its shape. */
function terminalSafe(text: string): string {
  return text.replace(/[^\n\t]+/g, (run) => stripControlBidi(run));
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** PAR-780: `--help`/`-h` anywhere in a command's own arguments short-circuits parsing — the
 *  same "help always wins" convention git/npm follow — so it wins over a missing flag value or
 *  an unknown option rather than being rejected as one. Position-blind (checked before any
 *  option-with-value pairing is resolved), so a value slot that happens to hold the literal
 *  text "-h" (e.g. `--config -h`) also triggers help rather than being read as that value —
 *  harmless in practice (nothing is ever really named "-h") but worth knowing when reading
 *  the callers below. */
function isHelpFlag(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

/**
 * Every subcommand resolves its config the same way the stdio server does (PAR-657 D-14):
 * `--config` when given, else `VIBECTX_CONFIG`, else the project file found by walking up to
 * the git root, layered over the user file. Deprecation notes go to stderr, once.
 */
function registryFor(flag: string | undefined, io: CliIo): Registry {
  const registry = loadDiscoveredRegistry({
    cwd: process.cwd(),
    env: process.env,
    flag,
    warn: (note) => io.stderr(`${note}\n`),
  });
  configureActivityLog({ logArchives: registry.logArchives, warn: (note) => io.stderr(`${note}\n`) }); // PAR-1039
  return registry;
}

/**
 * The one config-failure line (D-22, R1). A `ConfigError` already IS that line — file,
 * locator, message — so it is printed as it stands; printing the path again produced
 * `Could not load config ./x.json: ./x.json: …`. Anything else that escapes the loader
 * gets the prefix, because it may not name a file at all.
 */
function configError(e: unknown): string {
  return `${e instanceof ConfigError ? e.message : `could not load config: ${message(e)}`}\n`;
}

/** Run `vibectx doctor <args>`; returns the process exit code:
 *  0 all healthy · 1 something unhealthy · 2 usage / config / unknown-library error. */
export async function runDoctorCli(args: string[], io: CliIo): Promise<number> {
  if (isHelpFlag(args)) {
    io.stdout(`${DOCTOR_USAGE}\n`);
    return 0;
  }
  let parsed: DoctorCliArgs;
  try {
    parsed = parseDoctorArgs(args);
  } catch (e) {
    io.stderr(`${message(e)}\n${DOCTOR_USAGE}\n`);
    return 2;
  }
  let registry;
  try {
    registry = registryFor(parsed.config, io);
  } catch (e) {
    io.stderr(configError(e));
    return 2;
  }
  let report;
  try {
    if (!parsed.offline) noteCliNetwork(io);
    report = await runDoctor(registry, { library: parsed.library, offline: parsed.offline, warn: io.stderr });
  } catch (e) {
    io.stderr(`${message(e)}\n`);
    return 2;
  }
  const presented = parsed.showCachePath && report.cacheRoot
    ? { ...report, cacheRoot: { ...report.cacheRoot, path: cacheRoot() } }
    : report;
  io.stdout(parsed.json ? `${JSON.stringify(presented, null, 2)}\n` : `${formatDoctorTable(report, { verbose: parsed.verbose })}\n`);
  return doctorExitCode(report);
}

/** Run `vibectx resolve <package>`; prints the same report the MCP tool returns.
 *  Exit 0 resolved (or already in the registry) · 1 could not resolve · 2 usage / config error. */
export async function runResolveCli(args: string[], io: CliIo): Promise<number> {
  if (isHelpFlag(args)) {
    io.stdout(`${RESOLVE_USAGE}\n`);
    return 0;
  }
  let parsed: ResolveCliArgs;
  try {
    parsed = parseResolveArgs(args);
  } catch (e) {
    io.stderr(`${message(e)}\n${RESOLVE_USAGE}\n`);
    return 2;
  }
  let registry;
  try {
    registry = registryFor(parsed.config, io);
  } catch (e) {
    io.stderr(configError(e));
    return 2;
  }
  // A5 (PAR-718): the same defensive wrap runDoctorCli/runWarmCli already carry — the MCP
  // transport catches a thrown tool handler on its own, but this dispatch loop does not, and
  // index.ts's top-level await turns an uncaught throw here into an unhandled rejection with
  // a stack trace, not a clean exit 2. resolveToolText is now backed by a resolvePackage that
  // no longer throws for a disk failure it can catch (see resolve.ts), so this is defense in
  // depth for any other error class, not a fix for one specific known throw.
  let text: string;
  try {
    noteCliNetwork(io);
    text = await resolveToolText(registry, parsed.name, parsed.ecosystem, false);
  } catch (e) {
    io.stderr(`${message(e)}\n`);
    return 2;
  }
  io.stdout(`${text}\n`);
  return text.startsWith("Could not resolve") ? 1 : 0;
}

/** Run `vibectx warm [dir]`; prints the table (or `--json`) on stdout.
 *  Exit 0 every attempted dependency cached · 1 something not cached · 2 usage / config / no-manifest error. */
export async function runWarmCli(args: string[], io: CliIo): Promise<number> {
  if (isHelpFlag(args)) {
    io.stdout(`${WARM_USAGE}\n`);
    return 0;
  }
  let parsed: WarmCliArgs;
  try {
    parsed = parseWarmArgs(args);
  } catch (e) {
    io.stderr(`${message(e)}\n${WARM_USAGE}\n`);
    return 2;
  }
  let registry;
  try {
    registry = registryFor(parsed.config, io);
  } catch (e) {
    io.stderr(configError(e));
    return 2;
  }
  let report;
  try {
    if (!parsed.offline) noteCliNetwork(io);
    report = await runWarm(registry, { dir: parsed.dir, offline: parsed.offline, force: parsed.force === true, warn: io.stderr });
  } catch (e) {
    io.stderr(`${message(e)}\n`);
    return 2;
  }
  io.stdout(parsed.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatWarmTable(report)}\n`);
  return warmExitCode(report);
}

/** A typed online command is explicit user action; it never silently changes an MCP decline. */
function noteCliNetwork(io: CliIo): void {
  const stored = readConsent();
  if (stored?.network === "declined") {
    io.stderr("VibeCTX network access was declined in MCP; this explicitly typed CLI command will proceed online. Run vibectx consent reset to change the stored answer.\n");
  } else if (stored === undefined) {
    io.stderr("Network access disclosure: this command may download public docs from configured and package-provided documentation sites (including GitHub). Resolving an unknown package or warming a project sends requested package and dependency names and pinned versions to npm/PyPI registries; those names may be private. Results are cached locally. Run vibectx consent reset to change this answer.\n");
    saveConsent("disclosed", "cli");
  }
}

export function runConsentCli(args: string[], io: CliIo): number {
  if (args.length === 0) {
    const stored = readConsent();
    io.stdout(stored === undefined ? "none\n" : `${stored.network} · ${stored.decidedAt} · via ${stored.via}\n`);
    return 0;
  }
  if (args.length !== 1) {
    io.stderr(`${CONSENT_USAGE}\n`);
    return 2;
  }
  if (args[0] === "reset") {
    if (!resetConsent()) { io.stderr("consent reset refused: consent.json is not a regular file or could not be removed\n"); return 1; }
    io.stdout("none\n");
    return 0;
  }
  if (args[0] === "allow" || args[0] === "deny") {
    const next = args[0] === "allow" ? "allowed" : "declined";
    if (!saveConsent(next, "cli")) { io.stderr("consent decision could not be stored; no file was replaced\n"); return 1; }
    io.stdout(`${next}\n`);
    return 0;
  }
  io.stderr(`${CONSENT_USAGE}\n`);
  return 2;
}

/** A terminal-only, explicit preview → human confirmation → link flow; no HTTP submission. */
export async function runBugReportCli(args: string[], io: CliIo): Promise<number> {
  if (isHelpFlag(args)) { io.stdout(`${BUG_REPORT_USAGE}\n`); return 0; }
  const values = new Map<string, string>();
  const techStack: { kind: TechKind; name: string }[] = [];
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (value === undefined || !["--operation", "--where", "--error-class", "--tech"].includes(flag!)) {
      io.stderr(`${BUG_REPORT_USAGE}\n`); return 2;
    }
    if (flag === "--tech") {
      const colon = value.indexOf(":");
      const kind = value.slice(0, colon);
      const name = value.slice(colon + 1);
      if (colon < 0 || !["app", "service", "language", "hosting"].includes(kind) || !isPublicTechName(kind as TechKind, name)) {
        io.stderr(`Invalid --tech value: ${clipText(value, 80)}\n${BUG_REPORT_USAGE}\n`); return 2;
      }
      techStack.push({ kind: kind as TechKind, name });
      if (techStack.length > 100) { io.stderr(`${BUG_REPORT_USAGE}\n`); return 2; }
    } else {
      if (values.has(flag!)) { io.stderr(`${BUG_REPORT_USAGE}\n`); return 2; }
      values.set(flag!, value);
    }
  }
  const operation = values.get("--operation");
  const where = values.get("--where");
  const errorClass = values.get("--error-class");
  if (!operation || !["get_docs", "refresh", "resolve_library", "warm_project", "doctor", "search", "list_libraries", "startup"].includes(operation)
    || !where || !["network", "cache", "configuration", "retrieval", "startup"].includes(where)
    || !errorClass || !["NetworkError", "CacheError", "ConfigError", "ParseError", "TypeError", "RangeError", "UnknownError"].includes(errorClass)) {
    io.stderr(`${BUG_REPORT_USAGE}\n`); return 2;
  }
  const facts: BugFacts = {
    operation: operation as BugOperation, where: where as BugWhere, errorClass: errorClass as BugErrorClass,
    version: VERSION, platform: process.platform, nodeVersion: process.version, techStack,
  };
  // Keep preview beside the interactive prompt even when stdout is redirected.
  io.stderr(`${buildBugPreview(facts)}\n`);
  const confirmed = await io.confirm?.("Generate a GitHub issue link from exactly this report? Type yes to continue: ") ?? false;
  const result = issueLinkAfterConfirmation(facts, confirmed);
  if (result.kind === "declined") io.stdout("No link generated; nothing was submitted.\n");
  else if (result.kind === "copy") io.stdout(`Issue URL exceeds the safe length. Copy this report into ${ISSUE_NEW_URL} yourself:\n${result.value}\n`);
  else io.stdout(`Review and submit on GitHub yourself: ${result.value}\n`);
  return 0;
}

/**
 * Run `vibectx search <query>`; prints the grouped results (or `--json`) on stdout.
 * Exit 0 at least one section returned · 1 nothing matched · 2 usage / config error.
 * Never touches the network (D-35), so there is no offline flag: it is always offline.
 */
export async function runSearchCli(args: string[], io: CliIo): Promise<number> {
  if (isHelpFlag(args)) {
    io.stdout(`${SEARCH_USAGE}\n`);
    return 0;
  }
  let parsed: SearchCliArgs;
  try {
    parsed = parseSearchArgs(args);
  } catch (e) {
    io.stderr(`${message(e)}\n${SEARCH_USAGE}\n`);
    return 2;
  }
  let registry;
  try {
    registry = registryFor(parsed.config, io);
  } catch (e) {
    io.stderr(configError(e));
    return 2;
  }
  if (parsed.clipped) io.stderr(`vibectx: the query was clipped to its first ${MAX_QUERY_CHARS} UTF-16 units\n`);
  // A5 (PAR-718): same defensive wrap as runResolveCli, for the same reason — this dispatch
  // loop has no catch of its own, unlike the MCP transport. `runSearch`'s own index write
  // (`search-index.ts`'s `writeIndex`) already never throws (MEASURED: a real read-only cache
  // directory answers the query by tokenizing at query time and exits 0/1 normally); this is
  // defense in depth for any other error class, not a fix for a live throw found here.
  let outcome: SearchOutcome;
  try {
    outcome = runSearch(registry, {
      query: parsed.query,
      maxTokens: parsed.maxTokens,
      libraries: parsed.libraries.length > 0 ? parsed.libraries : undefined,
      // The clip happened at parse time, so `runSearch` cannot see it: the query it receives is
      // exactly at the bound. Carried in so the note lands in `outcome.notes` — a `--json`
      // consumer reads stdout and would otherwise have no way to know its tail was dropped, and
      // the stderr line above is for the person at the terminal, not for the machine.
      queryClipped: parsed.clipped,
      warn: io.stderr,
    });
  } catch (e) {
    io.stderr(`${message(e)}\n`);
    return 2;
  }
  // PAR-1044 (final audit L-4): the terminal is this printer's render boundary. Cached document
  // text can carry ESC/OSC sequences (OSC 52 writes the clipboard) and bidi overrides; strip
  // them here only. The MCP body is fenced data (D-30) and `--json` escapes control characters.
  io.stdout(parsed.json ? `${JSON.stringify(outcome, null, 2)}\n` : `${terminalSafe(formatSearchResults(outcome))}\n`);
  return searchExitCode(outcome);
}

/** Run `vibectx log`; prints the activity log (or `--json`) on stdout. Exit 0 always — a log
 *  with zero or many entries is equally healthy; `2` only on a usage error. No registry and
 *  no `--config`: the log names no entries to resolve, it reads back what other commands
 *  already resolved (A20/PAR-729). */
export async function runLogCli(args: string[], io: CliIo): Promise<number> {
  if (isHelpFlag(args)) {
    io.stdout(`${LOG_USAGE}\n`);
    return 0;
  }
  let parsed: LogCliArgs;
  try {
    parsed = parseLogArgs(args);
  } catch (e) {
    io.stderr(`${message(e)}\n${LOG_USAGE}\n`);
    return 2;
  }
  if (parsed.trail) {
    // PAR-1039: the rotation trail — each file, its counts and dates, and whether each
    // archive's bytes still match the hash its successor recorded.
    const trail = readActivityTrail();
    io.stdout(parsed.json ? `${JSON.stringify(trail, null, 2)}\n` : `${formatActivityTrailTable(trail)}\n`);
    return 0;
  }
  const report = readActivityLog();
  if (parsed.json) {
    io.stdout(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    // PAR-793 — a corrupt/oversized/foreign-schema file used to read back as a silent,
    // healthy-looking "0 entries" table, indistinguishable from the ordinary "nothing logged
    // yet" state. `report.problem` (absent for that ordinary state) states why, the same
    // "state the fallback, never leave it silent" rule this project's other stores follow.
    const problemLine = report.problem !== undefined ? `\n${report.problem}\n` : "";
    io.stdout(`${formatActivityLogTable(report.entries)}\n${problemLine}`);
  }
  return 0;
}

/** One line per command for the top-level `--help`/`-h` listing (PAR-780) — the single source
 *  both `GLOBAL_USAGE` and `SUBCOMMANDS` build from, so a command can't be added to one and
 *  forgotten in the other. Order and wording matches the README's "Command line" section. */
const COMMANDS: readonly { name: string; summary: string }[] = [
  { name: "doctor", summary: "prove retrieval works per library" },
  { name: "resolve", summary: "turn a package name into a docs source" },
  { name: "warm", summary: "cache a project's dependency docs" },
  { name: "search", summary: "search every cached library at once" },
  { name: "log", summary: "show recorded tool activity" },
  { name: "consent", summary: "show or change network access consent" },
  { name: "report-bug", summary: "preview a safe bug report and choose whether to make an issue link" },
];

const SUBCOMMANDS = new Set(COMMANDS.map((c) => c.name));

const MAX_COMMAND_NAME_LEN = Math.max(...COMMANDS.map((c) => c.name.length));

export const GLOBAL_USAGE = [
  "usage: vibectx <command> [options]",
  "",
  "Commands:",
  ...COMMANDS.map(({ name, summary }) => `  ${name.padEnd(MAX_COMMAND_NAME_LEN)}  ${summary}`),
  "",
  "Run 'vibectx <command> --help' for that command's usage.",
  "Run 'vibectx --version' to print the installed version.",
  "Run with no command to start the MCP stdio server.",
].join("\n");

/** Options whose VALUE must be skipped when looking for the subcommand token, so a library,
 *  package, directory or config path named "doctor" / "resolve" / "warm" / "search" / "log"
 *  is not mistaken for one. */
const OPTIONS_WITH_VALUES = new Set(["--config", "--library", "--max-tokens"]);

/** Index of the first non-option token in argv, skipping option VALUES; -1 when absent.
 *  The first token wins even when unknown: `refresh warm` is not a request to run warm. */
function findSubcommand(argv: string[]): number {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (OPTIONS_WITH_VALUES.has(arg!)) {
      i += 1;
      continue;
    }
    if (!arg!.startsWith("-")) return i;
  }
  return -1;
}

/** `argv` is process.argv. Returns an exit code when a subcommand ran, or
 *  undefined when the caller should start the MCP server as before. The subcommand
 *  token may come before or after `--config <path>` (the README shows `--config`
 *  leading); without one anywhere, argv is left to the server path. */
export async function dispatchCli(argv: string[], io: CliIo): Promise<number | undefined> {
  const at = findSubcommand(argv);
  if (at === -1) {
    if (argv.slice(2).includes("--version")) {
      io.stdout(`${VERSION}\n`);
      return 0;
    }
    // PAR-780: `vibectx --help` / `vibectx -h` with no command — a command's own --help is
    // handled inside its runXCli, once findSubcommand has located it below.
    if (isHelpFlag(argv.slice(2))) {
      io.stdout(`${GLOBAL_USAGE}\n`);
      return 0;
    }
    return undefined;
  }
  if (!SUBCOMMANDS.has(argv[at]!)) {
    io.stderr(`vibectx: unknown command "${clipText(argv[at]!, MAX_NAME_LENGTH)}". Run 'vibectx --help'. To update a library, call the MCP refresh tool or run 'vibectx warm --force' in a project that depends on it.\n`);
    return 2;
  }
  const rest = [...argv.slice(2, at), ...argv.slice(at + 1)];
  switch (argv[at]) {
    case "doctor":
      return runDoctorCli(rest, io);
    case "resolve":
      return runResolveCli(rest, io);
    case "search":
      return runSearchCli(rest, io);
    case "log":
      return runLogCli(rest, io);
    case "consent":
      return runConsentCli(rest, io);
    case "report-bug":
      return runBugReportCli(rest, io);
    default:
      return runWarmCli(rest, io);
  }
}
