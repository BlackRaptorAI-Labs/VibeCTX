import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * PAR-659 — the search index's write discipline and its failure paths, with `node:fs`
 * instrumented (the pattern test/cache-atomic.test.ts established). Two things are proved
 * here that a real filesystem cannot show: that the file is written through a temp file and
 * a rename (S4), and that every filesystem failure on this path is a NOTE, never a throw and
 * never a failed search (D-13).
 */

const calls: { op: "write" | "rename"; path: string; to?: string }[] = [];
const faults = { mkdir: false, rename: false, size: undefined as number | undefined };

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    mkdirSync: (path: string, opts: unknown) => {
      if (faults.mkdir) throw new Error("EACCES: permission denied, mkdir");
      return fs.mkdirSync(path, opts as never);
    },
    // PAR-859: `readIndex` now uses `lstatSync`, never `statSync` (which follows a symlink) —
    // the fault injection below moved to match, so this fixture still exercises the same
    // "index file over the byte limit" path through the function's real code path, not a stale
    // mock of a call `readIndex` no longer makes.
    lstatSync: (path: string, opts: unknown) => {
      // Mutated in place, not spread into a plain object (`{ ...real, size }`) — `Stats.isFile`
      // etc. live on the prototype, not as own enumerable properties, so a spread silently drops
      // them and `readIndex`'s own `stat.isFile()` call would throw. `fs.lstatSync` returns a
      // fresh object per call, so mutating it here is safe.
      const real = fs.lstatSync(path, opts as never);
      if (faults.size !== undefined) real.size = faults.size;
      return real as never;
    },
    writeFileSync: (path: string, data: string, enc: string) => {
      calls.push({ op: "write", path: String(path) });
      return fs.writeFileSync(path, data, enc as BufferEncoding);
    },
    renameSync: (from: string, to: string) => {
      calls.push({ op: "rename", path: String(from), to: String(to) });
      if (faults.rename) throw new Error("EXDEV: cross-device link");
      return fs.renameSync(from, to);
    },
  };
});

const { indexDocument, indexCachedDocument, readIndex, resetSearchIndexMemo, searchIndexPath, writeIndex, MAX_INDEX_FILE_BYTES } =
  await import("../src/search-index.js");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-index-atomic-"));
  process.env.VIBECTX_CACHE_DIR = dir;
  calls.length = 0;
  faults.mkdir = false;
  faults.rename = false;
  faults.size = undefined;
  resetSearchIndexMemo();
});
afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const URL_ = "https://hono.dev/llms.txt";
const AT = "2026-09-06T06:00:00.000Z";
const DOC = "# Hono\n\n## Streaming\n\nUse streamSSE to send server-sent events.";
const one = () => new Map([["hono", indexDocument(URL_, DOC, AT)!]]);

describe("search index write discipline (PAR-659, S4)", () => {
  it("writes a temp file in the cache root and renames it over index.json — never in place", () => {
    expect(writeIndex(one())).toBe(true);
    expect(calls.map((c) => c.op)).toEqual(["write", "rename"]);
    expect(calls[0].path).toMatch(/\.tmp$/);
    expect(calls[1].to).toBe(searchIndexPath());
    // rename is atomic only within one filesystem: the temp file must be a sibling of its target
    expect(join(calls[1].path, "..")).toBe(join(calls[1].to!, ".."));
  });

  it("a failed rename leaves the previous file intact and no temp file behind (D-13)", () => {
    writeIndex(one());
    const before = readFileSync(searchIndexPath(), "utf8");
    faults.rename = true;
    calls.length = 0;
    const notes: string[] = [];
    expect(writeIndex(new Map(), (m) => notes.push(m))).toBe(false);
    expect(readFileSync(searchIndexPath(), "utf8")).toBe(before);
    expect(existsSync(calls[0].path)).toBe(false); // writeAtomic removed its own temp file
    expect(notes.join("")).toMatch(/EXDEV/);
  });

  it("an unwritable cache root is a note, never a throw", () => {
    faults.mkdir = true;
    const notes: string[] = [];
    expect(writeIndex(one(), (m) => notes.push(m))).toBe(false);
    expect(notes.join("")).toMatch(/EACCES/);
    expect(existsSync(searchIndexPath())).toBe(false);
  });

  it("D-36: an index file over MAX_INDEX_FILE_BYTES is refused whole, with a problem note", () => {
    writeIndex(one());
    expect(readIndex().libraries.size).toBe(1);
    faults.size = MAX_INDEX_FILE_BYTES + 1;
    const { libraries, problem } = readIndex();
    expect(libraries.size).toBe(0);
    expect(problem).toMatch(/over the/);
  });

  it("the incremental hook writes once for a document and never again for the same text (D-34)", () => {
    indexCachedDocument("hono", URL_, DOC, AT);
    expect(calls.filter((c) => c.op === "rename")).toHaveLength(1);
    calls.length = 0;
    indexCachedDocument("hono", URL_, DOC, AT);
    indexCachedDocument("hono", URL_, DOC, AT);
    expect(calls).toEqual([]);
  });

  it("the incremental hook re-uses an entry another process already wrote, without rewriting it", () => {
    indexCachedDocument("hono", URL_, DOC, AT);
    resetSearchIndexMemo(); // a fresh process, same cache
    calls.length = 0;
    indexCachedDocument("hono", URL_, DOC, AT);
    expect(calls).toEqual([]);
  });

  it("an unwritable cache leaves the caller's own work untouched: no throw, index simply absent", () => {
    faults.mkdir = true;
    const notes: string[] = [];
    expect(() => indexCachedDocument("hono", URL_, DOC, AT, (m) => notes.push(m))).not.toThrow();
    expect(existsSync(searchIndexPath())).toBe(false);
    expect(notes.join("")).toMatch(/EACCES/);
  });
});
