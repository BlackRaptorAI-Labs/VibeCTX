import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// Dependabot alerts #1-#3 (runtime, transitive through @modelcontextprotocol/sdk):
// ip-address <= 10.7.0 (GHSA-h3mg-xc3c-68pw, GHSA-j6r3-76f7-8jcv) and fast-uri < 3.1.8
// (GHSA-hrr3-gc8f-f4qj). Overrides keep a fresh install from resolving a vulnerable copy.
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as { packages: Record<string, { version?: string }> };
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { overrides?: Record<string, string> };
const atLeast = (version: string, floor: string) => {
  const [a, b] = [version, floor].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (a![i] !== b![i]) return a![i]! > b![i]!;
  return true;
};
const installed = (name: string) => Object.entries(lock.packages)
  .filter(([path]) => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`))
  .map(([path, entry]) => ({ path, version: entry.version ?? "" }));

it.each([["ip-address", "10.7.1"], ["fast-uri", "3.1.8"]])("security: every locked %s is at least %s, and package.json overrides it", (name, floor) => {
  const copies = installed(name);
  expect(copies.length, `${name} is in the lockfile`).toBeGreaterThan(0);
  expect(copies.filter(({ version }) => !atLeast(version, floor))).toEqual([]);
  expect(pkg.overrides?.[name]).toBe(`^${floor}`);
});
