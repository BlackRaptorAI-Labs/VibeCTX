import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { normalisePyPiName, npmNameError, pypiNameError, VERSION_SHAPE } from "./package-names.js";
import { cleanText, clipText, stripBom } from "./text.js";

// Re-exported so existing importers (test/project-deps.test.ts among them) keep pinning the
// live implementation, now defined in text.ts (A8 / PAR-721, Move 3).
export { cleanText };

/**
 * Dependency discovery for `vibectx warm` (PAR-656): read a project directory's
 * manifests and return the package names it depends on, per ecosystem. Pure parsing
 * over local files — no network, no registry, no cache. The parsers are exported
 * one by one so each format is unit-tested on its own.
 *
 * What is read, in this order (each file once; names de-duplicated per ecosystem,
 * first occurrence wins):
 *   1. `package.json`      — `dependencies` then `devDependencies` (not peer / optional /
 *                            bundled). `npm:<real>@<range>` alias specs are unwrapped;
 *                            `file:` / `link:` / `workspace:` / `portal:` specs are local
 *                            packages and are skipped.
 *   2. `pyproject.toml`    — `[project].dependencies`, every `[project.optional-dependencies]`
 *                            group, every `[dependency-groups]` group (PEP 735),
 *                            `[tool.poetry.dependencies]`, `[tool.poetry.dev-dependencies]`,
 *                            `[tool.poetry.group.<g>.dependencies]` (`python` excluded; an
 *                            inline table with `path`, `git` or `url` is a local / VCS source
 *                            and is skipped, like package.json `file:` — R2).
 *   3. `requirements*.txt` — `requirements.txt` first, then the others sorted; versions,
 *                            extras, markers, comments and `\` continuations stripped; `-r` /
 *                            `--requirement` includes followed ONE level, relative to the
 *                            including file, and only inside the project directory;
 *                            `-c`, `-e`, options, URLs and paths skipped.
 *   4. Lockfiles, ONLY when the ecosystem's manifest is absent, for exact names:
 *                            `package-lock.json` v2/v3 (`packages[""]`; v1 has no root
 *                            list and is reported), `pnpm-lock.yaml` (`importers['.']`, or
 *                            the v5 top-level blocks). `yarn.lock`, `uv.lock` and
 *                            `poetry.lock` list every package with no cheap root marker and
 *                            are reported, not read.
 *
 * Trust boundary. A manifest is a file anyone with write access to the repo can edit, so:
 *   - Symlinks are refused (decision D-09, 2026-09-06). Containment is checked
 *     first: every manifest and every `-r` target's REAL path must lie under the project
 *     root's real path, so the project directory itself may live behind a symlink but
 *     nothing it links OUT to is read — a path that lands outside is reported `is outside
 *     the project directory; skipped`. A path that lands inside is then `lstat`ed component
 *     by component under the root, and a symlink anywhere in it is `skipped (symlink)`.
 *   - Only names that pass the package-name rules (npm grammar / PEP 508) are kept; the rest
 *     are counted in a note, never echoed.
 *   - Every note, manifest name and `source` passes through `cleanText`, which strips C0 / C1
 *     control characters and bidi / zero-width code points, so a hostile file name cannot
 *     carry a terminal escape into the table (S3).
 *   - Manifests over MANIFEST_MAX_BYTES are not read.
 *   - No regular expression here runs over an unbounded character class followed by more
 *     pattern (S1): the TOML header, pnpm key, requirement and include parsers are hand
 *     written linear scans; the few remaining regexes are anchored and fixed-width or a
 *     single character class applied with /g.
 *
 * The TOML reader is deliberately minimal: table headers, `key = value` lines, string
 * arrays (multi-line), inline tables on one line, `#` comments outside strings. Not
 * handled (documented limit): dotted keys inside a table (`tool.poetry.dependencies.x = …`),
 * multi-line basic strings, and arrays of inline tables beyond `{ include-group = … }`
 * entries, which are skipped.
 *
 * PyPI names are returned in their PEP 503 form (`Typing_Extensions` → `typing-extensions`);
 * npm names as written (npm names are already lowercase).
 */

/** Largest manifest or lockfile read. pnpm-lock.yaml of a large monorepo runs to a few MB;
 *  ASSUMED headroom. */
export const MANIFEST_MAX_BYTES = 32 * 1024 * 1024;

export type DependencyEcosystem = "npm" | "pypi";

export interface ProjectDependency {
  name: string;
  ecosystem: DependencyEcosystem;
  /** Manifest the name came from, relative to the project directory (forward slashes). */
  source: string;
  /** A11/PAR-724 — the exact version this manifest pins, when it names one UNAMBIGUOUSLY: a
   *  bare semver (`"1.2.3"`) or PEP 508 `==` pin (`django==4.2.3`), never a range's lower bound
   *  or any other guess. Absent whenever only a range is declared (`^1.2.3`, `>=1.2.3`) — `warm`
   *  and `get_docs` have no single version to match docs against in that case, and inventing one
   *  would be exactly the silent substitution D-50 forbids. See `parsePackageJsonVersions` /
   *  `requirementVersion` for the exact rule per manifest format. */
  version?: string;
}

export interface ProjectDiscovery {
  /** The directory as given (resolved to an absolute path by the caller when it matters). */
  dir: string;
  /** Manifests read, in read order, relative to `dir`. */
  manifests: string[];
  dependencies: ProjectDependency[];
  /** Files present but not read, includes skipped, parse failures — one plain line each. */
  notes: string[];
}

/**
 * Names `warm` reports as `denied (noise list)` and never fetches: build / lint / format
 * tooling nobody asks an agent for docs about, which would otherwise spend resolution
 * budget and network on every run. A trailing `*` is a prefix rule (`eslint*` covers
 * `eslint-config-next`); a bare entry is an exact match. PyPI entries are compared in
 * PEP 503 form. Kept deliberately: `typescript`, `pytest*`, `ruff`, `mypy` — people do ask
 * about those. Everything not listed here is attempted.
 */
export const DEPENDENCY_DENYLIST: Readonly<Record<DependencyEcosystem, readonly string[]>> = {
  npm: [
    "@types/*",
    "eslint*",
    "@eslint/*",
    "prettier*",
    "@typescript-eslint/*",
    "tslib",
    "@babel/*",
    "postcss",
    "autoprefixer",
    "husky",
    "lint-staged",
  ],
  pypi: ["setuptools*", "wheel", "pip", "build", "twine", "black"],
};

/** True when `name` matches a DEPENDENCY_DENYLIST rule for its ecosystem. */
export function isDeniedDependency(name: string, ecosystem: DependencyEcosystem): boolean {
  const key = ecosystem === "pypi" ? normalisePyPiName(name) : name.trim().toLowerCase();
  return DEPENDENCY_DENYLIST[ecosystem].some((rule) => (rule.endsWith("*") ? key.startsWith(rule.slice(0, -1)) : key === rule));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}


const isWs = (c: string): boolean => c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v";
const isAlnum = (c: string): boolean => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9");
const isNameChar = (c: string): boolean => isAlnum(c) || c === "." || c === "_" || c === "-";
const isSchemeChar = (c: string): boolean => isAlnum(c) || c === "+" || c === "." || c === "-";

function pushUnique(list: string[], seen: Set<string>, name: string): void {
  if (name.length === 0 || seen.has(name)) return;
  seen.add(name);
  list.push(name);
}

/* ------------------------------------------------------------------------- */
/* package.json                                                               */
/* ------------------------------------------------------------------------- */

const LOCAL_SPEC_PREFIXES = ["file:", "link:", "workspace:", "portal:"];

/** `npm:<name>@<range>` → `<name>` (scoped names keep their leading `@`); undefined otherwise. */
function npmAliasTarget(spec: string): string | undefined {
  if (!spec.startsWith("npm:")) return undefined;
  const rest = spec.slice(4);
  const at = rest.indexOf("@", rest.startsWith("@") ? 1 : 0);
  const name = at === -1 ? rest : rest.slice(0, at);
  return name.length > 0 ? name : undefined;
}

/** package.json → npm names from `dependencies` then `devDependencies`. Throws on invalid JSON. */
export function parsePackageJsonDeps(text: string): string[] {
  const json: unknown = JSON.parse(stripBom(text));
  const out: string[] = [];
  const seen = new Set<string>();
  if (!isRecord(json)) return out;
  for (const field of ["dependencies", "devDependencies"]) {
    const table = json[field];
    if (!isRecord(table)) continue;
    for (const [rawName, spec] of Object.entries(table)) {
      let name = rawName.trim();
      if (typeof spec === "string") {
        const s = spec.trim();
        if (LOCAL_SPEC_PREFIXES.some((p) => s.startsWith(p))) continue;
        name = npmAliasTarget(s) ?? name;
      }
      pushUnique(out, seen, name);
    }
  }
  return out;
}

/** A bare semver with no range operator, no wildcard, no build-metadata-only oddity — the
 *  ONLY shape package-deps.ts treats as an unambiguous pin (A11/PAR-724). */
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** A11/PAR-724 — the exact version a package.json dependency spec pins, when it unambiguously
 *  does: a bare semver (`"1.2.3"`, not `"^1.2.3"` / `"~1.2.3"` / `"*"` / `"1.2.x"`). A range is
 *  not a pin — there is no single version to match docs against, so this leaves the name out
 *  of the map rather than guessing (the range's lower bound, say). Aliased (`npm:`) and local
 *  (`file:` / `link:` / `workspace:` / `portal:`) specs are excluded the same way
 *  `parsePackageJsonDeps` excludes them from names — neither is a version of the name itself.
 *  `dependencies` then `devDependencies`, first occurrence wins, matching `parsePackageJsonDeps`'s
 *  own de-duplication order exactly. */
export function parsePackageJsonVersions(text: string): Map<string, string> {
  const json: unknown = JSON.parse(stripBom(text));
  const out = new Map<string, string>();
  if (!isRecord(json)) return out;
  for (const field of ["dependencies", "devDependencies"]) {
    const table = json[field];
    if (!isRecord(table)) continue;
    for (const [rawName, spec] of Object.entries(table)) {
      const name = rawName.trim();
      if (out.has(name) || typeof spec !== "string") continue;
      const s = spec.trim();
      if (LOCAL_SPEC_PREFIXES.some((p) => s.startsWith(p)) || s.startsWith("npm:")) continue;
      if (EXACT_SEMVER.test(s)) out.set(name, s);
    }
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* requirements.txt                                                           */
/* ------------------------------------------------------------------------- */

/** Drop a `#` comment that is not inside a quoted string. */
function stripComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function looksLikePath(s: string): boolean {
  if (s.startsWith("/") || s.startsWith("\\")) return true;
  if (s.startsWith("./") || s.startsWith(".\\") || s.startsWith("../") || s.startsWith("..\\")) return true;
  // Windows drive: `C:\` / `C:/`
  return s.length >= 3 && isAlnum(s[0]!) && s[1] === ":" && (s[2] === "/" || s[2] === "\\");
}

/** `<scheme>://…` where scheme is `[a-z][a-z0-9+.-]*` — https, git+https, file, … */
function looksLikeUrl(s: string): boolean {
  const at = s.indexOf("://");
  if (at <= 0) return false;
  if (!((s[0]! >= "a" && s[0]! <= "z") || (s[0]! >= "A" && s[0]! <= "Z"))) return false;
  for (let i = 1; i < at; i++) if (!isSchemeChar(s[i]!)) return false;
  return true;
}

/** PEP 508 project name (PEP 503 normalised) from one requirement string; undefined for
 *  anything that is not a plain requirement: blank, comment, option, path, URL, `-e`.
 *  Linear scan: the name is the leading run of `[A-Za-z0-9._-]`, which must start and end
 *  with a letter or digit and be followed by end of line, whitespace, or one of `[<>=!~;@(`. */
export function requirementName(spec: string): string | undefined {
  const s = stripComment(spec).trim();
  if (s.length === 0 || s.startsWith("-")) return undefined; // options: -r -c -e --index-url …
  if (looksLikePath(s) || looksLikeUrl(s)) return undefined;
  let i = 0;
  while (i < s.length && isNameChar(s[i]!)) i++;
  if (i === 0 || !isAlnum(s[0]!) || !isAlnum(s[i - 1]!)) return undefined;
  if (i < s.length) {
    const c = s[i];
    if (!isWs(c!) && !"[<>=!~;@(".includes(c!)) return undefined;
  }
  return normalisePyPiName(s.slice(0, i));
}

/** Internal to this module — the ONE scan `requirementVersion` and
 *  `requirementVersionRejection` (below) both build on, so the two never drift on where the
 *  name/extras/`==`/marker parsing stops (D-48). `undefined`: not a plain `==` pin at all (a
 *  range, an unpinned name, not a requirement line). Otherwise the raw candidate version TOKEN,
 *  exactly as captured (BEFORE the `VERSION_SHAPE` shape check) — the caller decides what a
 *  shape failure means. */
function exactVersionToken(spec: string): string | undefined {
  const s = stripComment(spec).trim();
  if (requirementName(s) === undefined) return undefined;
  let i = 0;
  while (i < s.length && isNameChar(s[i]!)) i++;
  if (s[i] === "[") {
    // Extras (`pkg[extra]`) sit between the name and the version constraint; skip past them.
    const close = s.indexOf("]", i);
    if (close === -1) return undefined;
    i = close + 1;
  }
  const rest = s.slice(i).trim();
  if (!rest.startsWith("==")) return undefined;
  let v = rest.slice(2).trim();
  const semi = v.indexOf(";"); // an environment marker follows the version, not part of it
  if (semi !== -1) v = v.slice(0, semi).trim();
  // PAR-824 (item 3) — a `pip-compile`-generated, hash-pinned line (`django==4.2.3 \` continued
  // onto `    --hash=sha256:…`) is already joined into ONE logical line by the `\` continuation
  // join above, by design — but that leaves `--hash=sha256:…` (and any further `--hash=…`
  // options) trailing the version, separated by whitespace. The version token itself never
  // contains whitespace (PEP 440), so the first whitespace-delimited token is the actual
  // version and everything after it is options, not part of the version — take only that token
  // BEFORE the shape check below, rather than testing (and rejecting) the whole combined string.
  v = v.split(/\s+/)[0]!; // split always yields at least one element
  if (v.length === 0 || v.includes(",")) return undefined;
  return v;
}

/** A11/PAR-724 — the exact version an `==` pin names (`django==4.2.3`), or undefined for
 *  anything else: a range (`>=`, `~=`, `!=`, …), an unpinned name, a spec with a SECOND
 *  comma-separated constraint after the `==` (`=="4.2.3,!=4.2.5"` is not exact once a second
 *  clause exists), or (PAR-824 item 4) a captured token that fails the
 *  shared `VERSION_SHAPE` gate. A following environment marker is stripped before capturing
 *  the exact pin; discovery does not evaluate the marker's condition. */
export function requirementVersion(spec: string): string | undefined {
  const v = exactVersionToken(spec);
  if (v === undefined) return undefined;
  // PAR-824 (item 4) — this used to be its own ad-hoc regex (`/^[A-Za-z0-9][A-Za-z0-9.+!_-]*$/`),
  // which both allowed a bare `!` outside PEP 440's epoch syntax (`N!version` — a lone `!`, or
  // more than one, is not a real epoch marker but this shape let it through) AND had no length
  // cap, unlike the shared `VERSION_SHAPE` gate this file's OWN Poetry parser already tests
  // captured versions against (below). `VERSION_SHAPE` does not accept `!` at all, so a
  // legitimate PEP 440 epoch pin (`pkg==1!2.0`) is excluded from capture HERE rather than being
  // captured and then silently mis-flagged "not a valid version/ref" once it reaches
  // `resolvePackage`'s own `VERSION_SHAPE` check — the honest outcome for an unsupported form is
  // "no version was captured for this pin" (`warm` proceeds as if unpinned, the same outcome an
  // unparseable range already produces), not a confusing false "invalid" verdict on a name that
  // is, in fact, valid PEP 440. Using the SAME shared gate the Poetry parser already uses also
  // closes the missing-length-cap gap for free — one definition, not a second regex that could
  // silently drift from it (D-48).
  return VERSION_SHAPE.test(v) ? v : undefined;
}

/** code-reviewer round 2, S4 — companion to `requirementVersion`: the raw, captured version
 *  token when a `==` pin EXISTS but fails `VERSION_SHAPE` (today, only a PEP 440 epoch pin like
 *  `1!2.0` — see that function's own PAR-824 item 4 comment for why it is excluded from
 *  capture, deliberately, rather than widening the shared shape gate). Undefined whenever
 *  `requirementVersion` itself would return a value, or whenever there is no `==` pin at all —
 *  a caller uses this ONLY to distinguish "no pin" (silence is correct: nothing to check) from
 *  "a pin exists but this parser cannot check it" (silence would be the exact PAR-821 defect
 *  this whole phase closes, reintroduced by PAR-824 item 4 in the same phase: an epoch-pinned
 *  dependency would otherwise get no note at all, instead of an honest "pin not checked"). */
export function requirementVersionRejection(spec: string): string | undefined {
  const v = exactVersionToken(spec);
  if (v === undefined || VERSION_SHAPE.test(v)) return undefined;
  return v;
}

/** `-r <path>` / `--requirement <path>` / `--requirement=<path>` → the path; undefined otherwise. */
function includeTarget(line: string): string | undefined {
  let rest: string;
  if (line.startsWith("--requirement")) rest = line.slice("--requirement".length);
  else if (line.startsWith("-r")) rest = line.slice(2);
  else return undefined;
  if (rest.length === 0) return undefined;
  if (rest[0] === "=") rest = rest.slice(1);
  else if (isWs(rest[0]!)) rest = rest.trimStart();
  else return undefined;
  let end = 0;
  while (end < rest.length && !isWs(rest[end]!)) end++;
  return end > 0 ? rest.slice(0, end) : undefined;
}

/** requirements.txt → names plus the `-r` / `--requirement` includes (paths as written).
 *
 *  `rejectedVersions` (code-reviewer round 2, S4) — name → the raw pin token, for a `==` pin
 *  that EXISTS but `requirementVersion` could not capture (today: only a PEP 440 epoch pin,
 *  `pkg==1!2.0` — see `requirementVersion`'s own PAR-824 item 4 comment for why that is
 *  excluded rather than widening the shared `VERSION_SHAPE` gate). Lets a caller distinguish
 *  "no pin at all" (silence is correct) from "a pin exists but was not checked" (silence would
 *  be the exact PAR-821 defect this phase closes, reintroduced by PAR-824 item 4 in the same
 *  phase) — see `discoverProjectDependencies`'s own use of this field for the disclosed note. */
export function parseRequirementsTxt(
  text: string,
): { names: string[]; includes: string[]; versions: Map<string, string>; rejectedVersions: Map<string, string> } {
  const names: string[] = [];
  const includes: string[] = [];
  const versions = new Map<string, string>(); // A11/PAR-724 — first `==` pin per name wins
  const rejectedVersions = new Map<string, string>();
  const seen = new Set<string>();
  // Join `\` continuations first (anchored on the literal backslash-newline: linear).
  const logical = stripBom(text).replace(/\r\n?/g, "\n").replace(/\\\n\s*/g, " ").split("\n");
  for (const raw of logical) {
    const line = stripComment(raw).trim();
    const inc = includeTarget(line);
    if (inc !== undefined) {
      includes.push(inc);
      continue;
    }
    const name = requirementName(line);
    if (name) {
      pushUnique(names, seen, name);
      const version = requirementVersion(line);
      if (version !== undefined && !versions.has(name)) {
        versions.set(name, version);
      } else if (version === undefined && !versions.has(name) && !rejectedVersions.has(name)) {
        const rejected = requirementVersionRejection(line);
        if (rejected !== undefined) rejectedVersions.set(name, rejected);
      }
    }
  }
  return { names, includes, versions, rejectedVersions };
}

/* ------------------------------------------------------------------------- */
/* Minimal TOML                                                               */
/* ------------------------------------------------------------------------- */

interface TomlKeyValue {
  table: string;
  key: string;
  /** Raw value text with comments removed, joined across lines for arrays. */
  value: string;
}

/** Count `[` minus `]` outside quoted strings — used to join multi-line arrays. */
function bracketBalance(s: string): number {
  let depth = 0;
  let quote: string | undefined;
  for (const c of s) {
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "[") depth += 1;
    else if (c === "]") depth -= 1;
  }
  return depth;
}

function unquoteKey(key: string): string {
  const k = key.trim();
  if (k.length >= 2 && ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'")))) return k.slice(1, -1);
  return k;
}

/** `[a.b]` / `[[a.b]]` → `a.b` (segments unquoted); undefined when the line is not a header. */
function tableHeader(line: string): string | undefined {
  if (!line.startsWith("[") || !line.endsWith("]")) return undefined;
  let inner = line.slice(1, -1);
  if (inner.startsWith("[") && inner.endsWith("]")) inner = inner.slice(1, -1);
  inner = inner.trim();
  if (inner.length === 0 || inner.includes("[") || inner.includes("]")) return undefined;
  return inner.split(".").map(unquoteKey).join(".");
}

/** Scan a TOML document into `(table, key, value)` triples; tables from `[a.b]` / `[[a.b]]`
 *  headers; values kept as raw text (arrays joined across lines). Anything unparseable is skipped. */
function scanToml(text: string): TomlKeyValue[] {
  const out: TomlKeyValue[] = [];
  const lines = stripBom(text).replace(/\r\n?/g, "\n").split("\n");
  let table = "";
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]!).trim();
    if (line.length === 0) continue;
    const header = tableHeader(line);
    if (header !== undefined) {
      table = header;
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = unquoteKey(line.slice(0, eq));
    let value = line.slice(eq + 1).trim();
    let balance = bracketBalance(value);
    while (balance > 0 && i + 1 < lines.length) {
      i += 1;
      const next = stripComment(lines[i]!).trim();
      value += ` ${next}`;
      balance += bracketBalance(next);
    }
    out.push({ table, key, value });
  }
  return out;
}

/** Every quoted string in a TOML array literal, in order (inline tables inside are ignored). */
function tomlStringArray(value: string): string[] {
  if (!value.startsWith("[")) return [];
  const items: string[] = [];
  let depth = 0; // inline-table depth: strings inside `{ … }` are not requirement specs
  let quote: string | undefined;
  let current = "";
  for (const c of value) {
    if (quote !== undefined) {
      if (c === quote) {
        quote = undefined;
        if (depth === 0) items.push(current);
        current = "";
      } else current += c;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "{") depth += 1;
    else if (c === "}") depth -= 1;
  }
  return items;
}

/** Top-level keys of a one-line inline table `{ k = v, k2 = v2 }`; [] for anything else. */
function inlineTableKeys(value: string): string[] {
  if (!value.startsWith("{")) return [];
  const keys: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let expectKey = true;
  let key = "";
  for (let i = 1; i < value.length; i++) {
    const c = value[i];
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      if (expectKey) key += c;
      continue;
    }
    if (c === "[" || c === "{") depth += 1;
    else if (c === "]" || c === "}") depth -= 1;
    if (depth < 0) break; // the closing brace of the table
    if (depth === 0 && c === ",") {
      expectKey = true;
      key = "";
      continue;
    }
    if (expectKey) {
      if (c === "=") {
        keys.push(unquoteKey(key));
        expectKey = false;
      } else key += c;
    }
  }
  return keys;
}

const POETRY_SOURCE_KEYS = new Set(["path", "git", "url"]);

function isPoetryDependencyTable(table: string): boolean {
  if (table === "tool.poetry.dependencies" || table === "tool.poetry.dev-dependencies") return true;
  return table.startsWith("tool.poetry.group.") && table.endsWith(".dependencies") && table.length > "tool.poetry.group.".length + ".dependencies".length;
}

/** pyproject.toml → PyPI names (PEP 503) from the dependency tables listed in the module comment. */
export function parsePyprojectDeps(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (spec: string) => {
    const name = requirementName(spec);
    if (name) pushUnique(out, seen, name);
  };
  for (const { table, key, value } of scanToml(text)) {
    if (table === "project" && key === "dependencies") tomlStringArray(value).forEach(add);
    else if (table === "project.optional-dependencies" || table === "dependency-groups") tomlStringArray(value).forEach(add);
    else if (isPoetryDependencyTable(table)) {
      if (key.toLowerCase() === "python") continue;
      if (inlineTableKeys(value).some((k) => POETRY_SOURCE_KEYS.has(k))) continue; // R2: local / VCS source
      add(key);
    }
  }
  return out;
}

/** A quoted TOML string's contents, or undefined for anything else (an inline table, an array,
 *  a bare number). */
function unquoteTomlString(value: string): string | undefined {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) return v.slice(1, -1);
  return undefined;
}

/** A11/PAR-724 — the exact version pyproject.toml pins per dependency, from the same dependency
 *  tables `parsePyprojectDeps` reads: PEP 508 `==` pins (via `requirementVersion`) for
 *  `[project].dependencies` / optional-dependencies / dependency-groups, and a plain quoted
 *  string matching `VERSION_SHAPE` for Poetry's own table syntax. `VERSION_SHAPE`
 *  (`package-names.ts`) is both the range check (`django = "4.2.3"`, not `django = "^4.2"` —
 *  none of Poetry's range operators `^ ~ < > = * ,` are in its allowed alphabet) and the
 *  security gate every version/ref is held to before it can reach a URL or a rendered response
 *  (security-architect, A11/PAR-724 round 1, S-2): before this, the ONLY check here was a
 *  range-operator denylist that did not exclude `/`, so a Poetry version string of
 *  `"../../../../evil/repo/HEAD"` passed it and reached `resolvePackage`'s GitHub tag-URL
 *  builder as a literal path segment. One shared shape check closes both gaps at once. First
 *  occurrence across all tables wins, matching `parsePyprojectDeps`'s own de-duplication order. */
export interface PyprojectVersionInfo {
  versions: Map<string, string>;
  rejectedVersions: Map<string, string>;
}

/** Parse exact and explicitly unsupported PEP 508 pins from pyproject.toml. */
export function parsePyprojectVersionInfo(text: string): PyprojectVersionInfo {
  const out = new Map<string, string>();
  const rejected = new Map<string, string>();
  const addPep508 = (spec: string) => {
    const name = requirementName(spec);
    const version = requirementVersion(spec);
    if (name && !out.has(name) && !rejected.has(name)) {
      if (version !== undefined) out.set(name, version);
      else {
        const rawRejected = requirementVersionRejection(spec);
        if (rawRejected !== undefined) rejected.set(name, rawRejected);
      }
    }
  };
  for (const { table, key, value } of scanToml(text)) {
    if (table === "project" && key === "dependencies") tomlStringArray(value).forEach(addPep508);
    else if (table === "project.optional-dependencies" || table === "dependency-groups") tomlStringArray(value).forEach(addPep508);
    else if (isPoetryDependencyTable(table)) {
      if (key.toLowerCase() === "python") continue;
      if (inlineTableKeys(value).some((k) => POETRY_SOURCE_KEYS.has(k))) continue; // R2: local / VCS source
      const name = requirementName(key);
      const str = unquoteTomlString(value);
      if (name && str !== undefined && VERSION_SHAPE.test(str) && !out.has(name)) out.set(name, str);
    }
  }
  return { versions: out, rejectedVersions: rejected };
}

/** Compatibility wrapper for callers interested only in supported exact pins. */
export function parsePyprojectVersions(text: string): Map<string, string> {
  return parsePyprojectVersionInfo(text).versions;
}

/* ------------------------------------------------------------------------- */
/* Lockfiles                                                                  */
/* ------------------------------------------------------------------------- */

/** package-lock.json v2/v3 → the root package's dependencies + devDependencies; [] for v1
 *  (no root list) or anything unexpected. Throws on invalid JSON. */
export function parsePackageLockDeps(text: string): string[] {
  const json: unknown = JSON.parse(stripBom(text));
  const out: string[] = [];
  const seen = new Set<string>();
  if (!isRecord(json) || !isRecord(json.packages) || !isRecord(json.packages[""])) return out;
  const root = json.packages[""];
  for (const field of ["dependencies", "devDependencies"]) {
    const table = root[field];
    if (!isRecord(table)) continue;
    for (const name of Object.keys(table)) pushUnique(out, seen, name.trim());
  }
  return out;
}

const indentOf = (l: string): number => l.length - l.trimStart().length;

/** `dependencies:` / `devDependencies:` (surrounding whitespace allowed). */
function isPnpmBlockHeader(line: string): boolean {
  const t = line.trim();
  if (!t.endsWith(":")) return false;
  const name = t.slice(0, -1).trimEnd();
  return name === "dependencies" || name === "devDependencies";
}

/** A YAML map key at the start of `line` (`name:`, `'@scope/name':`, `"x":`); undefined when the
 *  line is not `key:`. Linear: one indexOf for the closing quote or the colon. */
function pnpmKey(line: string): string | undefined {
  const s = line.trim();
  if (s.length === 0) return undefined;
  const q = s[0];
  if (q === "'" || q === '"') {
    const end = s.indexOf(q, 1);
    if (end === -1) return undefined;
    const rest = s.slice(end + 1).trimStart();
    if (!rest.startsWith(":")) return undefined;
    const key = s.slice(1, end);
    return key.length > 0 ? key : undefined;
  }
  const colon = s.indexOf(":");
  if (colon <= 0) return undefined;
  const key = s.slice(0, colon).trimEnd();
  if (key.length === 0 || key.includes("'") || key.includes('"')) return undefined;
  return key;
}

/** pnpm-lock.yaml → names under `importers: '.': dependencies / devDependencies` (v6+),
 *  or the top-level `dependencies:` / `devDependencies:` blocks (v5). Line-based: keys are
 *  the lines exactly one indentation step under the block header; quotes stripped. */
export function parsePnpmLockDeps(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const lines = stripBom(text).replace(/\r\n?/g, "\n").split("\n");
  const collect = (start: number, blockIndent: number) => {
    let keyIndent = -1;
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i];
      if (l!.trim().length === 0) continue;
      const ind = indentOf(l!);
      if (ind <= blockIndent) return;
      if (keyIndent === -1) keyIndent = ind;
      if (ind !== keyIndent) continue;
      const key = pnpmKey(l!);
      if (key !== undefined) pushUnique(out, seen, key.trim());
    }
  };
  const importersAt = lines.findIndex((l) => indentOf(l) === 0 && l.trim() === "importers:");
  if (importersAt !== -1) {
    for (let i = importersAt + 1; i < lines.length; i++) {
      const l = lines[i];
      if (l!.trim().length === 0) continue;
      if (indentOf(l!) === 0) break; // left the importers map
      const t = l!.trim();
      if (t === ".:" || t === "'.':" || t === '".":') {
        const dot = indentOf(l!);
        let childIndent = -1;
        for (let j = i + 1; j < lines.length; j++) {
          const lj = lines[j];
          if (lj!.trim().length === 0) continue;
          const ind = indentOf(lj!);
          if (ind <= dot) break;
          if (childIndent === -1) childIndent = ind;
          if (ind === childIndent && isPnpmBlockHeader(lj!)) collect(j, ind); // direct children of '.' only
        }
        break;
      }
    }
    return out;
  }
  for (let i = 0; i < lines.length; i++) {
    if (indentOf(lines[i]!) === 0 && isPnpmBlockHeader(lines[i]!)) collect(i, 0);
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* Discovery                                                                  */
/* ------------------------------------------------------------------------- */

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

type PathVerdict = "ok" | "symlink" | "outside" | "missing";

/**
 * D-09: may `rel` (relative to `root`) be read? Two independent refusals, containment first
 * (Q-1, PAR-656):
 *
 *   1. Where the path REALLY lands decides. `realpathSync` follows every symlink, in the
 *      root prefix and in `rel` alike, and the result must lie under the root's real path
 *      (`rootReal + sep`). Anything else is `outside` — so a manifest or `-r` target that is
 *      lexically inside the project but links out of it is reported as what it is, rather
 *      than as a bare symlink. This is the branch that keeps a hostile repo from reading
 *      /etc or a sibling checkout, and it is the one the Q-1 test pins.
 *   2. Only for a path that DOES land inside: every component under the root is `lstat`ed,
 *      and a symlink anywhere is refused as `symlink`. The root itself may be reached
 *      through a symlink — only what is under it is checked.
 *
 * A path that cannot be resolved at all is `symlink` when a component is a dangling link
 * (that is the more specific fact) and `missing` otherwise.
 */
function checkPath(root: string, rootReal: string, rel: string): PathVerdict {
  let real: string | undefined;
  try {
    real = realpathSync(join(root, rel));
  } catch {
    real = undefined; // does not exist, or a dangling symlink: the component walk decides
  }
  if (real !== undefined && !real.startsWith(rootReal + sep)) return "outside";
  let cur = root;
  for (const part of rel.split("/")) {
    cur = join(cur, part);
    try {
      if (lstatSync(cur).isSymbolicLink()) return "symlink";
    } catch {
      return "missing";
    }
  }
  return real === undefined ? "missing" : "ok";
}

/** Read every manifest in `dir` (see the module comment for the order and the rules).
 *  Throws only when `dir` is not a directory; every per-file problem becomes a note. */
export function discoverProjectDependencies(dir: string): ProjectDiscovery {
  if (!isDirectory(dir)) throw new Error(`${cleanText(dir)} is not a directory`);
  const root = resolve(dir);
  const rootReal = realpathSync(root);
  const manifests: string[] = [];
  const dependencies: ProjectDependency[] = [];
  const notes: string[] = [];
  const seen = { npm: new Set<string>(), pypi: new Set<string>() };
  const readRels = new Set<string>();
  const seenNotes = new Set<string>();
  const includeTargets = new Set<string>();
  let includeLimitNoted = false;
  let notesOmitted = false;
  const note = (s: string) => {
    const text = clipText(s, 300);
    if (seenNotes.has(text)) return;
    if (notes.length >= 100) { notesOmitted = true; return; }
    seenNotes.add(text);
    notes.push(text);
  };

  // A11/PAR-724 — `versions` is keyed by whatever `names` itself holds: the raw package.json
  // key for npm, but the PEP 503-FOLDED name for PyPI (both `parseRequirementsTxt` and
  // `parsePyprojectVersions` build their maps from `requirementName`'s own folded output, the
  // same value `names` carries) — so the lookup below always agrees with what `names` holds,
  // per ecosystem, rather than needing its own fold.
  const addAll = (names: string[], ecosystem: DependencyEcosystem, source: string, versions?: Map<string, string>) => {
    let invalid = 0;
    for (const raw of names) {
      const name = ecosystem === "pypi" ? normalisePyPiName(raw) : raw;
      const bad = ecosystem === "pypi" ? pypiNameError(name) : npmNameError(name);
      if (bad !== undefined) {
        invalid += 1;
        continue;
      }
      if (seen[ecosystem].has(name)) continue;
      seen[ecosystem].add(name);
      const version = versions?.get(raw);
      dependencies.push(version !== undefined ? { name, ecosystem, source: cleanText(source), version } : { name, ecosystem, source: cleanText(source) });
    }
    if (invalid > 0) {
      const label = ecosystem === "pypi" ? "PyPI project" : "npm package";
      note(`${source}: skipped ${invalid} ${invalid === 1 ? `name that is not a valid ${label} name` : `names that are not valid ${label} names`}`);
    }
  };
  /** The file's text when it may be read (exists, no symlink, inside the root, under the size cap); notes otherwise. */
  const read = (rel: string, label = rel): string | undefined => {
    const verdict = checkPath(root, rootReal, rel);
    if (verdict === "symlink") {
      note(`${label}: skipped (symlink)`);
      return undefined;
    }
    if (verdict === "outside") {
      note(`${label}: is outside the project directory; skipped`);
      return undefined;
    }
    if (verdict === "missing") return undefined;
    try {
      if (statSync(join(root, rel)).size > MANIFEST_MAX_BYTES) {
        note(`${label}: larger than ${MANIFEST_MAX_BYTES / (1024 * 1024)} MiB; not read`);
        return undefined;
      }
      return readFileSync(join(root, rel), "utf8");
    } catch (e) {
      note(`${label}: could not read (${e instanceof Error ? e.message : String(e)})`);
      return undefined;
    }
  };
  /** Every parser runs through here (N-3), so a throw from any of them is one `could not
   *  parse` note and a skipped manifest — never a failed discovery. */
  const parseWith = <T>(rel: string, text: string, parse: (t: string) => T): T | undefined => {
    try {
      return parse(text);
    } catch (e) {
      note(`${rel}: could not parse (${e instanceof Error ? e.message : String(e)})`);
      return undefined;
    }
  };
  const record = (rel: string) => {
    readRels.add(rel);
    manifests.push(cleanText(rel));
  };
  const present = (rel: string): boolean => {
    try {
      lstatSync(join(root, rel));
      return true;
    } catch {
      return false;
    }
  };

  // 1. package.json
  let npmManifest = false;
  if (present("package.json")) {
    const text = read("package.json");
    const names = text === undefined ? undefined : parseWith("package.json", text, parsePackageJsonDeps);
    if (names) {
      npmManifest = true;
      record("package.json");
      // A11/PAR-724: a version-map parse failure (malformed enough to throw, though the name
      // parse above already succeeded on the same text) degrades to "no versions found" rather
      // than dropping the manifest — the names are the load-bearing result here.
      const versions = text !== undefined ? parseWith("package.json", text, parsePackageJsonVersions) : undefined;
      addAll(names, "npm", "package.json", versions);
    }
  }

  // 2. pyproject.toml
  let pypiManifest = false;
  if (present("pyproject.toml")) {
    const text = read("pyproject.toml");
    if (text !== undefined) {
      const names = parseWith("pyproject.toml", text, parsePyprojectDeps);
      if (names) {
        pypiManifest = true;
        record("pyproject.toml");
        const versionInfo = parseWith("pyproject.toml", text, parsePyprojectVersionInfo);
        addAll(names, "pypi", "pyproject.toml", versionInfo?.versions);
        for (const [name, rejected] of versionInfo?.rejectedVersions ?? []) {
          note(`pyproject.toml: ${name}==${rejected} pin not checked (unsupported version shape); warm proceeds as if unpinned`);
        }
      }
    }
  }

  // 3. requirements*.txt (+ one level of -r includes, inside the project only)
  const reqFiles = readdirSync(root)
    .filter((f) => f.toLowerCase().startsWith("requirements") && f.toLowerCase().endsWith(".txt"))
    .sort((a, b) => (a === "requirements.txt" ? -1 : b === "requirements.txt" ? 1 : a.localeCompare(b)));
  const readRequirements = (rel: string, depth: number, label = rel) => {
    if (readRels.has(rel)) return;
    const text = read(rel, label);
    if (text === undefined) return;
    const parsed = parseWith(rel, text, parseRequirementsTxt);
    if (parsed === undefined) return; // N-3: a parse failure is a note, not a recorded manifest
    pypiManifest = true;
    record(rel);
    const { names, includes, versions, rejectedVersions } = parsed;
    addAll(names, "pypi", rel, versions);
    // code-reviewer round 2, S4 — an epoch-pinned dependency (`pkg==1!2.0`) has no `versions`
    // entry (PAR-824 item 4 excludes it from capture) and would otherwise get NO note at all —
    // the exact silent-drop behaviour PAR-821 (this same phase) exists to eliminate, reintroduced
    // for this one shape. Named per dependency, once, the same discipline every other skip in
    // this function already follows.
    for (const [name, rejected] of rejectedVersions) {
      note(`${rel}: ${name}==${rejected} pin not checked (unsupported version shape); warm proceeds as if unpinned`);
    }
    for (const inc of includes) {
      const identity = `${rel}\0${inc}`;
      if (includeTargets.has(identity)) continue;
      if (includeTargets.size >= 100) {
        if (!includeLimitNoted) { note("Requirements include limit reached (100 distinct targets); additional includes omitted"); includeLimitNoted = true; }
        break;
      }
      includeTargets.add(identity);
      const incLabel = `${rel}: -r ${inc}`;
      if (depth >= 1) {
        note(`${incLabel} is nested more than one level; skipped`);
        continue;
      }
      if (isAbsolute(inc)) {
        note(`${incLabel} is outside the project directory; skipped`);
        continue;
      }
      const target = resolve(root, dirname(rel), inc);
      const relTarget = relative(root, target);
      if (relTarget.length === 0 || relTarget.startsWith("..") || isAbsolute(relTarget)) {
        note(`${incLabel} is outside the project directory; skipped`);
        continue;
      }
      const posixRel = toPosix(relTarget);
      const verdict = checkPath(root, rootReal, posixRel);
      if (verdict === "missing") {
        note(`${incLabel} not found; skipped`);
        continue;
      }
      if (verdict === "symlink") {
        note(`${incLabel} skipped (symlink)`);
        continue;
      }
      if (verdict === "outside") {
        note(`${incLabel} is outside the project directory; skipped`);
        continue;
      }
      if (!isFile(target)) {
        note(`${incLabel} not found; skipped`);
        continue;
      }
      readRequirements(posixRel, depth + 1);
    }
  };
  for (const f of reqFiles) readRequirements(f, 0);

  // 4. Lockfiles — exact names only, and only when the manifest is absent.
  if (!npmManifest) {
    if (present("package-lock.json")) {
      const text = read("package-lock.json");
      const json = text === undefined ? undefined : parseWith("package-lock.json", text, (t) => JSON.parse(t) as unknown);
      if (isRecord(json) && json.lockfileVersion === 1) {
        note("package-lock.json: lockfileVersion 1 has no root dependency list; skipped");
      } else if (text !== undefined && json !== undefined) {
        const names = parseWith("package-lock.json", text, parsePackageLockDeps);
        if (names) {
          record("package-lock.json");
          addAll(names, "npm", "package-lock.json");
        }
      }
    }
    if (present("pnpm-lock.yaml")) {
      const text = read("pnpm-lock.yaml");
      if (text !== undefined) {
        const names = parseWith("pnpm-lock.yaml", text, parsePnpmLockDeps);
        if (names) {
          record("pnpm-lock.yaml");
          addAll(names, "npm", "pnpm-lock.yaml");
        }
      }
    }
    if (present("yarn.lock")) {
      note("yarn.lock: not read (it lists every package with no root marker); add a package.json");
    }
  }
  if (!pypiManifest) {
    const found = ["uv.lock", "poetry.lock"].filter((f) => present(f));
    if (found.length > 0) {
      note(`${found.join(", ")}: not read (Python lockfiles list every package); add a pyproject.toml or requirements.txt`);
    }
  }

  if (notesOmitted || includeLimitNoted) notes.push("Additional discovery notes or requirements includes omitted (limit reached)");
  return { dir, manifests, dependencies, notes };
}

/** Exported for the CLI's usage text and the README: the files discovery looks at. */
export const MANIFEST_FILES = ["package.json", "pyproject.toml", "requirements*.txt", "package-lock.json", "pnpm-lock.yaml"] as const;
