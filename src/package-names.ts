/**
 * Package-name validation for the resolver (PAR-655). Names come from agents and
 * the command line and are interpolated into registry URLs, so anything that is
 * not a plausible package name is refused before any network call.
 */

// PAR-822 (security-audit #1-ranked finding) — exported so `resolve.ts` and `registry.ts` can
// bound and clip a caller-supplied `library`/`name` argument (an MCP tool argument, echoed
// into response text on a resolution failure) with the SAME constant this file already uses
// to validate a real package name's length, mirroring `MAX_VERSION_LENGTH`'s own precedent
// (A11/PAR-724) for the identical defect class on the `version` field. Since L-33 this is the
// one place the 214 bound is written; `search.ts`, `activity-log.ts`, `search-index.ts` and
// `project-store.ts` import it.
export const MAX_NAME_LENGTH = 214;

/** npm: lowercase; optional `@scope/`; each part starts with `[a-z0-9~-]` and continues
 *  with `[a-z0-9._~-]` (no leading `.` or `_`; nothing that needs URL encoding). */
const NPM_PART = "[a-z0-9~-][a-z0-9._~-]*";
const NPM_NAME_RE = new RegExp(`^(@${NPM_PART}/)?${NPM_PART}$`);

/** PEP 508 name grammar (case-insensitive): starts and ends with a letter or digit,
 *  `-`, `_` and `.` allowed inside. */
const PYPI_NAME_RE = /^([a-z0-9]|[a-z0-9][a-z0-9._-]*[a-z0-9])$/i;

/** Why `name` is not a valid npm package name, or undefined when it is. */
export function npmNameError(name: string): string | undefined {
  if (name.length === 0 || name.trim() !== name) return "npm package names cannot be empty or padded";
  if (name.length > MAX_NAME_LENGTH) return `npm package names are at most ${MAX_NAME_LENGTH} characters`;
  if (name !== name.toLowerCase()) return "npm package names are lowercase";
  if (!NPM_NAME_RE.test(name)) return "not a valid npm package name (letters, digits, - _ . ~, optional @scope/)";
  return undefined;
}

/** PEP 503 normalisation: runs of `-`, `_`, `.` become one `-`; lowercase. */
export function normalisePyPiName(name: string): string {
  return name.trim().replace(/[-_.]+/g, "-").toLowerCase();
}

/** Why `name` is not a valid PyPI project name, or undefined when it is. */
export function pypiNameError(name: string): string | undefined {
  if (name.length === 0 || name.trim() !== name) return "PyPI project names cannot be empty or padded";
  if (name.length > MAX_NAME_LENGTH) return `PyPI project names are at most ${MAX_NAME_LENGTH} characters`;
  if (!PYPI_NAME_RE.test(name)) return "not a valid PyPI project name (letters, digits, - _ . ; PEP 508)";
  return undefined;
}

/** Undefined when either ecosystem would accept the name; otherwise one combined reason. */
export function packageNameError(name: string): string | undefined {
  if (npmNameError(name) === undefined || pypiNameError(name) === undefined) return undefined;
  return `"${name}" is not a valid npm or PyPI package name`;
}

/** Longest `version` any caller trusts — matches VERSION_SHAPE's own cap. */
export const MAX_VERSION_LENGTH = 128;

/** A11/PAR-724 (security-architect finding S-1/S-2) — the ONE shape a version/ref is trusted
 *  in, shared by every module that either builds a URL from one (`resolve.ts`'s
 *  `versionReadmeCandidates`/`metadataUrlFor`) or captures one out of an untrusted file
 *  (`project-deps.ts`'s manifest version parsers): alphanumeric first, then letters, digits,
 *  `.`, `+`, `_` or `-`, up to MAX_VERSION_LENGTH. No `/`, `\`, control character or whitespace
 *  can ever appear in a shape-valid version — the property that makes both a forged response
 *  line (needs a newline) and a path escape out of a GitHub `refs/tags/<tag>/` URL (needs a
 *  `/` or a bare `..` segment) structurally impossible, not merely encoded or cleaned away
 *  after the fact. One definition (D-48's lesson: a shared fact belongs in exactly one place,
 *  every caller uses it, never a local variant) rather than one regex per module that happens
 *  to agree today. */
export const VERSION_SHAPE = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/;

/** Why `version` is not a trusted version/ref shape, or undefined when it is. */
export function versionShapeError(version: string): string | undefined {
  if (!VERSION_SHAPE.test(version)) {
    return `not a valid version/ref (letters, digits, "." "+" "_" "-" only, up to ${MAX_VERSION_LENGTH} characters)`;
  }
  return undefined;
}

/** A persisted exact-pin document must identify the same explicit GitHub tag as the
 * resolver's version candidates, rather than HEAD, a branch, or a different version. */
export function isExactVersionTagUrl(version: string, value: string): boolean {
  if (versionShapeError(version) !== undefined) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.hostname !== "raw.githubusercontent.com"
    || url.port || url.username || url.password || url.search || url.hash) return false;
  const parts = url.pathname.split("/");
  return parts.length === 7 && parts[0] === ""
    && /^[A-Za-z0-9_.-]+$/.test(parts[1]!) && /^[A-Za-z0-9_.-]+$/.test(parts[2]!)
    && parts[3] === "refs" && parts[4] === "tags"
    && (parts[5] === version || parts[5] === `v${version}`)
    && /^(?:README\.md|readme\.md|Readme\.md|README\.rst)$/.test(parts[6]!);
}
