import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * AUDIT-20260921-01 — `pinConfiguredCacheRoot` canonicalises only the EXISTING prefix of a
 * configured cache root and rebuilds the missing tail with `join`. Every tail component except
 * the last is therefore pinned uncanonicalised AND unchecked: `ensureCacheRoot`'s `isSymlinkAt`
 * guards the root leaf only.
 *
 * Consequence: when two or more components of `VIBECTX_CACHE_DIR` do not yet exist, a local
 * process that can write to the nearest existing ancestor can CREATE an intermediate component
 * as a symlink and redirect every cache write outside the pinned root. Unlike the residual
 * recorded for AUDIT-20260920-03, this needs no race: the component never existed, so there is
 * no check-then-act window to win and nothing to swap.
 *
 * These three cases are red before the fix except the one-missing-component case, which the
 * existing leaf check already covers.
 */

const { cacheRoot, resetCacheRootState, writeCache, libDirName, urlSlug, sweepCacheRootTempFiles } = await import("../src/cache.js");

const URL = "https://docs.example.test/doc";
let home: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "vibectx-tail-")));
  saved = { HOME: process.env.HOME, VIBECTX_CACHE_DIR: process.env.VIBECTX_CACHE_DIR };
  process.env.HOME = home;
  resetCacheRootState();
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  resetCacheRootState();
  rmSync(home, { recursive: true, force: true });
});

/** Pin a configured root whose tail does not exist, then create `plant` as a symlink to a
 *  directory outside it. Returns true when a cache write landed on the far side of the link. */
function writesEscapeVia(configuredTail: string[], plant: string): boolean {
  const outside = join(home, "outside");
  mkdirSync(outside);
  process.env.VIBECTX_CACHE_DIR = join(home, ...configuredTail);
  cacheRoot(); // pin while nothing in the tail exists
  symlinkSync(outside, join(home, plant));
  try {
    writeCache("lib", URL, "sensitive document");
  } catch {
    // A refusal is the desired outcome, not an escape.
  }
  const below = configuredTail.slice(configuredTail.indexOf(plant) + 1);
  return existsSync(join(outside, ...below, libDirName("lib"), `${urlSlug(URL)}.md`));
}

describe("AUDIT-20260921-01 — a configured cache root whose tail does not yet exist", () => {
  it("one missing component: the root leaf itself is already guarded by isSymlinkAt", () => {
    expect(writesEscapeVia(["cache"], "cache")).toBe(false);
  });

  it("two missing components: the intermediate component must not redirect writes", () => {
    expect(writesEscapeVia(["a", "cache"], "a")).toBe(false);
  });

  it("three missing components: the first intermediate must not redirect writes", () => {
    expect(writesEscapeVia(["a", "b", "cache"], "a")).toBe(false);
  });
});

describe("PAR-1034 (M-4) — the startup temp sweep honours the same pinned-tail refusal", () => {
  it("PAR-1034: an intermediate tail component planted as a symlink after pinning stops the sweep; temp-shaped files beyond it survive", () => {
    const outside = join(home, "outside");
    mkdirSync(join(outside, "cache"), { recursive: true });
    const canary = join(outside, "cache", "canary.1.1757000000000.tmp");
    writeFileSync(canary, "not the cache's to delete", "utf8");
    process.env.VIBECTX_CACHE_DIR = join(home, "a", "cache");
    cacheRoot(); // pin while nothing in the tail exists
    symlinkSync(outside, join(home, "a")); // home/a/cache now resolves to outside/cache, a real directory

    sweepCacheRootTempFiles();

    expect(existsSync(canary)).toBe(true);
  });
});
