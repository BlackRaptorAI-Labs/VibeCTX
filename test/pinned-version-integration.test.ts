import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCache, writeCache } from "../src/cache.js";
import { getDocsToolText } from "../src/get-docs.js";
import { loadRegistry, type Registry } from "../src/registry.js";
import { readResolvedEntries } from "../src/resolved-store.js";
import { refreshToolText } from "../src/refresh.js";
import { resetResolutionWindow, resolveToolText } from "../src/resolve.js";
import { stubPublicDns } from "./helpers/public-dns.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-pin-integration-"));
  process.env.VIBECTX_CACHE_DIR = dir;
  resetResolutionWindow(); stubPublicDns();
});
afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});
function routes(pages: Record<string, string | object>) {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const body = pages[String(input)];
    return new Response(body === undefined ? "absent" : typeof body === "string" ? body : JSON.stringify(body), {
      status: body === undefined ? 404 : 200,
      headers: { "content-type": typeof body === "string" ? "text/plain" : "application/json" },
    });
  }));
}
it("PAR-1031: explicit npm resolution preserves a differently spelled PyPI package in live memory and disk", async () => {
  const py = "https://raw.githubusercontent.com/fixture-org/python-fixture/HEAD/README.md";
  const npm = "https://raw.githubusercontent.com/fixture-org/npm-fixture/HEAD/README.md";
  routes({
    "https://pypi.org/pypi/mixed-fixture/json": { info: { project_urls: { Repository: "https://github.com/fixture-org/python-fixture" } } },
    "https://registry.npmjs.org/mixed_fixture/latest": { repository: "https://github.com/fixture-org/npm-fixture" },
    [py]: "# Python Fixture\n\n## Middleware\n\nPython middleware API.",
    [npm]: "# npm Fixture\n\n## Middleware\n\nnpm middleware API.",
  });
  const reg: Registry = { entries: new Map() };
  await resolveToolText(reg, "mixed-fixture", "pypi");
  expect(reg.entries.get("mixed-fixture")?.resolved?.source).toBe("pypi");
  await resolveToolText(reg, "mixed_fixture", "npm");
  expect(readResolvedEntries().map(e => [e.name, e.resolved?.source])).toEqual([["mixed-fixture", "pypi"], ["mixed_fixture", "npm"]]);
  const spy = vi.fn(() => { throw new Error("offline network"); }); vi.stubGlobal("fetch", spy);
  for (const registry of [reg, loadRegistry()]) {
    expect(registry.entries.get("mixed-fixture")?.resolved?.source).toBe("pypi");
    expect(registry.entries.get("mixed_fixture")?.resolved?.source).toBe("npm");
    expect(await getDocsToolText(registry, { library: "mixed-fixture", topic: "middleware", offline: true })).toContain("Python middleware API.");
    expect(await getDocsToolText(registry, { library: "mixed_fixture", topic: "middleware", offline: true })).toContain("npm middleware API.");
  }
  expect(spy).not.toHaveBeenCalled();
});
it("PAR-1031: latest refresh preserves every cached pin and still deletes an unrelated followed page", async () => {
  const latest = "https://elysiajs.com/llms.txt";
  const tag = (version: string) => `https://raw.githubusercontent.com/elysiajs/elysia/refs/tags/v${version}/README.md`;
  const meta = { homepage: "https://elysiajs.com", repository: "https://github.com/elysiajs/elysia" };
  routes({
    "https://registry.npmjs.org/elysia/latest": meta,
    "https://registry.npmjs.org/elysia/1.2.3": meta,
    "https://registry.npmjs.org/elysia/2.0.0": meta,
    [tag("1.2.3")]: "# Pin one\n\n## Middleware\n\nPIN_ONE middleware.",
    [tag("2.0.0")]: "# Pin two\n\n## Middleware\n\nPIN_TWO middleware.",
    [latest]: "# Latest\n\n## Middleware\n\nLATEST middleware.",
  });
  const reg: Registry = { entries: new Map() };
  expect(await getDocsToolText(reg, { library: "elysia", version: "1.2.3", topic: "middleware" })).toContain("PIN_ONE");
  expect(await getDocsToolText(reg, { library: "elysia", version: "2.0.0", topic: "middleware" })).toContain("PIN_TWO");
  const followed = "https://elysiajs.com/old-followed-page";
  writeCache("elysia", followed, "# Old followed page");
  expect(readCache("elysia", followed)).toBeDefined();
  expect(await refreshToolText(reg, "elysia")).toContain("refreshed from");
  expect(readCache("elysia", latest)?.content).toContain("LATEST");
  expect(readCache("elysia", followed)).toBeUndefined();
  const spy = vi.fn(() => { throw new Error("offline network"); }); vi.stubGlobal("fetch", spy);
  for (const registry of [reg, loadRegistry()]) {
    expect(await getDocsToolText(registry, { library: "elysia", version: "1.2.3", topic: "middleware", offline: true })).toContain("PIN_ONE");
    expect(await getDocsToolText(registry, { library: "elysia", version: "2.0.0", topic: "middleware", offline: true })).toContain("PIN_TWO");
  }
  expect(spy).not.toHaveBeenCalled();
});
