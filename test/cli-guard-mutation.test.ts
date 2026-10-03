import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliIo } from "../src/cli.js";

/**
 * A5 (PAR-718) — mutation coverage for the defensive try/catch `runResolveCli` and
 * `runSearchCli` (`src/cli.ts`) gained in this item, mirroring the pattern their siblings
 * `runDoctorCli`/`runWarmCli` already had.
 *
 * Neither guard is reachable by the real read-only-cache-directory scenario this item
 * actually fixes: `resolve.ts`'s own two new guards, and `search-index.ts`'s pre-existing
 * one, both catch that failure BEFORE it would ever reach these CLI-level catches — see the
 * A5 tests in `test/resolve.test.ts`, `test/cli.test.ts` and `test/index-stdio.test.ts`, all
 * of which measure exit 0 or 1, never 2, for that real scenario (test-auditor, A5 round 1:
 * neither guard has a test that would fail if it were deleted).
 *
 * So this file proves something narrower and still real: the CLI-level catch is itself
 * correct MECHANISM — for whatever OTHER error class might one day reach it — by making the
 * collaborator throw directly (mocking the LEAF module `resolveToolText`/`runSearch` comes
 * from, `resolve.js`/`search.js`, the same technique `test/search-retrieval-version.test.ts`
 * uses), rather than trying to fabricate a different real disk failure that also happens to
 * evade both existing lower-level guards.
 */

let dir: string;
let sandbox: string;
const ENV_KEYS = ["HOME", "XDG_CONFIG_HOME", "VIBECTX_CONFIG"] as const;
let previousEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-cli-mutation-"));
  process.env.VIBECTX_CACHE_DIR = dir;
  sandbox = join(dir, "sandbox");
  mkdirSync(sandbox, { recursive: true });
  previousEnv = {};
  for (const key of ENV_KEYS) {
    previousEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.HOME = join(dir, "home");
  process.env.XDG_CONFIG_HOME = join(dir, "xdg");
  vi.spyOn(process, "cwd").mockReturnValue(sandbox);
  vi.resetModules();
});

afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  for (const key of ENV_KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  vi.doUnmock("../src/resolve.js");
  vi.doUnmock("../src/search.js");
  vi.resetModules();
});

function io(): CliIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (s) => out.push(s), stderr: (s) => err.push(s) };
}

describe("runResolveCli / runSearchCli — the defensive catch itself (A5, PAR-718)", () => {
  it("runResolveCli: any throw from resolveToolText exits 2, one stderr line, no stack trace", async () => {
    vi.resetModules();
    vi.doMock("../src/resolve.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/resolve.js")>();
      return { ...actual, resolveToolText: async () => { throw new Error("simulated: unexpected failure"); } };
    });
    const { dispatchCli } = await import("../src/cli.js");
    const a = io();
    const code = await dispatchCli(["node", "dist/index.js", "resolve", "whatever"], a);
    expect(code).toBe(2);
    expect(a.err).toEqual([
      "Network access disclosure: this command may download public docs from configured and package-provided documentation sites (including GitHub). Resolving an unknown package or warming a project sends requested package and dependency names and pinned versions to npm/PyPI registries; those names may be private. Results are cached locally. Run vibectx consent reset to change this answer.\n",
      "simulated: unexpected failure\n",
    ]);
    expect(a.err.join("")).not.toMatch(/\n\s+at\s/); // a Node stack trace's own line shape
    expect(a.out).toEqual([]);
  });

  it("runSearchCli: any throw from runSearch exits 2, one stderr line, no stack trace", async () => {
    vi.resetModules();
    vi.doMock("../src/search.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/search.js")>();
      return { ...actual, runSearch: () => { throw new Error("simulated: unexpected failure"); } };
    });
    const { dispatchCli } = await import("../src/cli.js");
    const a = io();
    const code = await dispatchCli(["node", "dist/index.js", "search", "anything"], a);
    expect(code).toBe(2);
    expect(a.err).toEqual(["simulated: unexpected failure\n"]);
    expect(a.err.join("")).not.toMatch(/\n\s+at\s/); // a Node stack trace's own line shape
    expect(a.out).toEqual([]);
  });
});
