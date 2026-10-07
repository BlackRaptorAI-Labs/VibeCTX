import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// Dependabot alerts #4 and #6 on 9e28dcb (plan D26, decided 2026-10-06), both runtime and shipped
// in the npm tarball through bundleDependencies:
// - @modelcontextprotocol/sdk < 1.31.0: GHSA-6qxp-vccf-f47h (high).
// - proxy-addr < 2.0.8: GHSA-jqcg-44mw-7w3h (critical), through sdk -> express -> proxy-addr.
// The override keeps a fresh install from resolving a vulnerable proxy-addr.
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as { packages: Record<string, { version?: string }> };
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies?: Record<string, string>; overrides?: Record<string, string>;
};
const atLeast = (version: string, floor: string) => {
  const [a, b] = [version, floor].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (a![i] !== b![i]) return a![i]! > b![i]!;
  return true;
};
const installed = (name: string) => Object.entries(lock.packages)
  .filter(([path]) => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`))
  .map(([path, entry]) => ({ path, version: entry.version ?? "" }));

it("D26: the locked @modelcontextprotocol/sdk is at least 1.31.0 (GHSA-6qxp-vccf-f47h)", () => {
  const copies = installed("@modelcontextprotocol/sdk");
  expect(copies.length, "the SDK is in the lockfile").toBeGreaterThan(0);
  expect(copies.filter(({ version }) => !atLeast(version, "1.31.0"))).toEqual([]);
  expect(pkg.dependencies?.["@modelcontextprotocol/sdk"]).toBe("1.31.0");
});

it("D26: every locked proxy-addr is at least 2.0.8, and package.json overrides it (GHSA-jqcg-44mw-7w3h)", () => {
  const copies = installed("proxy-addr");
  expect(copies.length, "proxy-addr is in the lockfile").toBeGreaterThan(0);
  expect(copies.filter(({ version }) => !atLeast(version, "2.0.8"))).toEqual([]);
  expect(pkg.overrides?.["proxy-addr"]).toBe("^2.0.8");
});
