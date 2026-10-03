import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * PAR-652b (security-gate note, low) — the under-cap sweep must not parse the world.
 *
 * A sweep runs on the first write of every process and every 16 MiB after that, and the
 * overwhelming majority of them find the cache under the cap and evict nothing. Reaching
 * that answer used to cost one `readFileSync` + `JSON.parse` per cached document, because
 * `scanCache` resolved `meta.fetchedAt` while it walked — 103 ms of JSON for 10,000
 * documents that needed no work at all.
 *
 * The size total needs only `lstat`. Recency is needed ONLY once the cap is exceeded. This
 * file pins that ordering by counting the meta reads rather than by timing anything, so it
 * cannot go flaky on a loaded machine and cannot pass by accident on a fast one.
 *
 * `readFileSync` is the only thing mocked, and only to count; it does the real read.
 */
let metaReads: string[] = [];
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    readFileSync: (path: unknown, ...rest: unknown[]) => {
      if (typeof path === "string" && path.endsWith(".meta.json")) metaReads.push(path);
      return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
    },
  };
});

const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
const { writeCache, urlSlug, libDirName } = await import("../src/cache.js");
const { enforceCacheSizeCap, resetCacheEvictionState } = await import("../src/cache-evict.js");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-evict-perf-"));
  process.env.VIBECTX_CACHE_DIR = dir;
  delete process.env.VIBECTX_CACHE_MAX_MB;
  resetCacheEvictionState();
  metaReads = [];
});
afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  delete process.env.VIBECTX_CACHE_MAX_MB;
  resetCacheEvictionState();
  rmSync(dir, { recursive: true, force: true });
});

const DOCS = 25;
function seedDocs(): void {
  for (let i = 0; i < DOCS; i++) writeCache("react", `https://example.com/${i}.md`, "x".repeat(400));
  resetCacheEvictionState(); // a later run: none of these belong to "this" one
  metaReads = [];
}

describe("the under-cap sweep reads no meta files", () => {
  it("parses nothing to decide the cache is under the cap", () => {
    seedDocs();
    process.env.VIBECTX_CACHE_MAX_MB = "1"; // far over what DOCS × 400 B needs
    const summary = enforceCacheSizeCap(dir, { warn: () => {} })!;
    expect(summary.evicted).toEqual([]);
    expect(metaReads).toEqual([]); // the whole point: zero JSON parsed for zero work done
  });

  it("reads them only once the cap is actually exceeded, and still evicts oldest-first", () => {
    seedDocs();
    // Back-date one document by hand so "oldest" is unambiguous, then forget that read.
    const metaPath = join(dir, libDirName("react"), `${urlSlug("https://example.com/7.md")}.meta.json`);
    writeFileSync(
      metaPath,
      JSON.stringify({ url: "https://example.com/7.md", fetchedAt: "1999-01-01T00:00:00.000Z" }),
      "utf8",
    );

    // Ask the (meta-free) under-cap sweep for the exact total, then set a cap one byte under
    // it, so exactly one document has to go and the count below is unambiguous.
    process.env.VIBECTX_CACHE_MAX_MB = "1";
    const total = enforceCacheSizeCap(dir, { warn: () => {} })!.totalBytesBefore;
    expect(metaReads).toEqual([]);
    metaReads = [];

    process.env.VIBECTX_CACHE_MAX_MB = String((total - 1) / (1024 * 1024));
    const summary = enforceCacheSizeCap(dir, { warn: () => {} })!;

    expect(summary.evicted).toHaveLength(1);
    expect(summary.evicted[0].document).toBe(urlSlug("https://example.com/7.md"));
    expect(summary.evicted[0].fetchedAt).toBe("1999-01-01T00:00:00.000Z");
    // Recency is resolved for the candidates, once, at the point it is needed.
    expect(metaReads).toHaveLength(DOCS);
    expect(new Set(metaReads).size).toBe(DOCS);
  });
});
