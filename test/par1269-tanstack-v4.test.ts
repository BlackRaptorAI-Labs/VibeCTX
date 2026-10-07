import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDocsToolText } from "../src/get-docs.js";
import { writeCache } from "../src/cache.js";
import { DEFAULT_REGISTRY, type Registry } from "../src/registry.js";

// PAR-1269, plan D9(c): explicit TanStack Query v4 requests use its v4 index.
const V4 = "https://tanstack.com/query/v4/llms.txt";
const LATEST = "https://tanstack.com/query/latest/llms.txt";
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-tanstack-v4-"));
  process.env.VIBECTX_CACHE_DIR = dir;
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("unexpected network request"); }));
  writeCache("tanstack-query", V4, "# TanStack Query v4\n\n## Query invalidation\n\nV4_INVALIDATION: invalidateQueries marks matching queries stale.");
  writeCache("tanstack-query", LATEST, "# TanStack Query latest\n\n## Query invalidation\n\nLATEST_INVALIDATION: the latest documentation.");
});
afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function registry(): Registry {
  const entry = DEFAULT_REGISTRY.find((e) => e.name === "tanstack-query");
  expect(entry).toBeDefined();
  return { entries: new Map([["tanstack-query", entry!]]) };
}

describe("PAR-1269 B4: shipped TanStack Query v4 source", () => {
  it("ships exactly the v4 index as its sole per-major source", () => {
    expect(registry().entries.get("tanstack-query")?.versionUrls).toEqual({ "4": [V4] });
  });

  it("an explicit v4 request serves cached v4 documentation and names the matched major", async () => {
    const out = await getDocsToolText(registry(), { library: "tanstack-query", version: "4.41.0", topic: "query invalidation", offline: true });
    expect(out).toContain(`Source: ${V4}`);
    expect(out).toContain(`Version-matched: major 4 (from ${V4})`);
    expect(out).toContain("V4_INVALIDATION");
    expect(out).not.toContain("LATEST_INVALIDATION");
    expect(out).not.toContain("· version 4.41.0");
    expect(out).not.toContain("not version-matched");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("without a version, the existing latest index remains first", async () => {
    const out = await getDocsToolText(registry(), { library: "tanstack-query", topic: "query invalidation", offline: true });
    expect(out).toContain(`Source: ${LATEST}`);
    expect(out).toContain("LATEST_INVALIDATION");
    expect(out).not.toContain("V4_INVALIDATION");
    expect(out).not.toContain("Version-matched:");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("an unlisted major retains the latest source and unmatched-version note", async () => {
    const out = await getDocsToolText(registry(), { library: "tanstack-query", version: "5.0.0", topic: "query invalidation", offline: true });
    expect(out).toContain(`Source: ${LATEST}`);
    expect(out).toContain("LATEST_INVALIDATION");
    expect(out).toContain("Check APIs against 5.0.0.");
    expect(out).toContain("· not version-matched");
    expect(out).not.toContain("V4_INVALIDATION");
    expect(fetch).not.toHaveBeenCalled();
  });
});
