import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import semver from "semver";

/**
 * R-1/PAR-829, D-80: `package.json`'s `engines.node` is the INTERSECTION of `vite`'s and
 * `vitest`'s own declared ranges, hand-derived, not read from either at build time — nothing
 * else would catch either dependency narrowing its range out from under it.
 *
 * A prior version of this test compared `engines.node` to `vite`'s range by STRING EQUALITY
 * alone. That passed even after `vitest` bumped to a version whose own range (`^20.0.0 ||
 * ^22.0.0 || >=24.0.0`) is narrower than `vite`'s in the 22.x/23.x band — because the test
 * never looked at `vitest`'s range at all. A range can be a false claim of support without
 * ever equalling the wrong thing: `>=22.12.0` (no upper bound) legitimately equals nothing
 * `vite` didn't say, yet still admits Node 23.x, which `vitest` does not support (`^22.0.0`
 * stops before 23.0.0; the next band starts at `>=24.0.0` — nothing covers 23.x). Equality
 * against one dependency cannot catch a violation of the other's constraint.
 *
 * SUBSET, checked against BOTH dependencies independently, catches that direction of drift
 * (a range that over-claims support) — using a real semver range library rather than
 * hand-rolled interval math, since `semver.subset()` handles `^`/`||`/prerelease-boundary
 * normalization correctly and a hand-written check would not (the exact class of bug this item
 * exists to prevent, one level up). It does NOT catch the other direction: `subset` alone would
 * pass just as happily for `">=24.0.0"` alone, or any other needlessly narrow range still fully
 * inside both dependencies' bounds (code-reviewer round 4, S-2) — so the COVERAGE check below
 * asserts `ours` is not narrower than the true intersection either, by requiring one version
 * from each of the three known-supported bands to satisfy it.
 */
function readEnginesNode(relativePath: string): string {
  const url = fileURLToPath(new URL(relativePath, import.meta.url));
  let raw: string;
  try {
    raw = readFileSync(url, "utf8");
  } catch (e) {
    throw new Error(`${relativePath}: could not read this package.json (${e instanceof Error ? e.message : String(e)})`);
  }
  const pkg = JSON.parse(raw) as { engines?: { node?: string } };
  const node = pkg.engines?.node;
  if (!node) throw new Error(`${relativePath}: engines.node is missing — nothing to compare against`);
  return node;
}

describe("engines.node is exactly the intersection of vite's and vitest's declared ranges", () => {
  const ours = readEnginesNode("../package.json");

  it("is a subset of vite's own engines.node", () => {
    const vite = readEnginesNode("../node_modules/vite/package.json");
    expect(semver.subset(ours, vite)).toBe(true);
  });

  it("is a subset of vitest's own engines.node", () => {
    const vitest = readEnginesNode("../node_modules/vitest/package.json");
    expect(semver.subset(ours, vitest)).toBe(true);
  });

  it("actually excludes a version outside the intersection — the check isn't vacuously true", () => {
    // Node 23.x: inside vite's `>=22.12.0` (no upper bound) but outside vitest's `^22.0.0 ||
    // >=24.0.0` (nothing covers 23.x) — a bare `>=22.12.0` in `engines.node` would silently
    // admit it. If this ever starts failing because 23.x becomes valid, the fixture is stale,
    // not the invariant — update the probed version, don't delete the test.
    expect(semver.satisfies("23.0.0", ours)).toBe(false);
  });

  it("covers every band of the intersection — not narrower than it should be", () => {
    // Deliberately NOT `process.version`: `engines` is advisory here (no `.npmrc` sets
    // `engine-strict`), so a contributor on an excluded version is a warning, never a hard
    // failure — this suite must not turn that into one. These three are the low edge of each
    // band the intersection actually has today (`^20.19.0`, `^22.12.0`, `>=24.0.0`); a `subset`
    // check alone would pass just as well if `ours` silently dropped one of them.
    for (const v of ["20.19.0", "22.12.0", "24.0.0"]) {
      expect(semver.satisfies(v, ours)).toBe(true);
    }
  });
});
