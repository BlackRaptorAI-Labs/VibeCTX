import { REPO_URL } from "./repository.js";
import { createRequire } from "node:module";

/**
 * One source of truth for the product's version: the package manifest.
 *
 * It was written down twice before this (the `McpServer` name/version in `src/server.ts`
 * and the user-agent in `src/fetcher.ts`), which is one place too many — a release bumps
 * `package.json` and the two literals drift silently, so a client asking the server what it
 * is talking to gets an answer that used to be true.
 *
 * `createRequire(import.meta.url)` resolves `../package.json` relative to THIS module, and
 * the layout makes that the same file in both places it has to work:
 *   - installed from npm, `dist/version.js` sits one level under the package root, beside
 *     which `package.json` always ships (npm includes it regardless of `files`);
 *   - in a source checkout under vitest, `src/version.ts` is one level under the repo root.
 * A JSON import assertion would be the modern spelling, but its syntax is still unstable
 * across the Node versions this package supports (>=18), and `createRequire` is not.
 *
 * The fallback exists so a manifest that somehow cannot be read degrades to an obviously
 * wrong version rather than throwing at import time and taking the server down with it.
 *
 * The comment used to promise that and the code did not deliver it (PAR-652c, review R2): the
 * `require` was unguarded, so a missing or unparsable manifest threw `MODULE_NOT_FOUND` at
 * IMPORT time — before any caller could catch it — and killed the server rather than
 * degrading it. A version string is the least important thing this process does; it must
 * never be the reason it fails to start. Hence `versionFrom`: one seam, one `try`, and a test
 * that loads it against a directory with no sibling manifest rather than against a mock.
 */

/** What a manifest that cannot be read degrades to. Obviously wrong on sight, by design. */
export const UNKNOWN_VERSION = "0.0.0-unknown";

/**
 * Read the version out of `../package.json` using `load`, or fall back.
 *
 * `load` is the seam: production passes `createRequire(import.meta.url)`, and a test passes a
 * `createRequire` rooted somewhere with no manifest above it — so the guard is proven against
 * a real `MODULE_NOT_FOUND`, not against a stubbed thrower.
 */
export function versionFrom(load: (specifier: string) => unknown): string {
  let manifest: { version?: unknown };
  try {
    manifest = load("../package.json") as { version?: unknown };
  } catch {
    return UNKNOWN_VERSION; // unreadable, unparsable, or simply not there
  }
  const version = manifest?.version;
  return typeof version === "string" && version.length > 0 ? version : UNKNOWN_VERSION;
}

export const VERSION: string = versionFrom(createRequire(import.meta.url));

/** The user-agent every outbound request carries. Same version, by construction. */
export const USER_AGENT = `vibectx/${VERSION} (+${REPO_URL})`;
