import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Records every writeFileSync / renameSync the cache performs, in order (S4, PAR-656). */
const calls: { op: "write" | "rename"; path: string; to?: string }[] = [];
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    writeFileSync: (path: string, data: string, enc: string) => {
      calls.push({ op: "write", path: String(path) });
      return fs.writeFileSync(path, data, enc as BufferEncoding);
    },
    renameSync: (from: string, to: string) => {
      calls.push({ op: "rename", path: String(from), to: String(to) });
      return fs.renameSync(from, to);
    },
  };
});

const { writeCache, touchCache, readCache } = await import("../src/cache.js");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "docs-cache-atomic-"));
  process.env.VIBECTX_CACHE_DIR = dir;
  calls.length = 0;
});
afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const URL_ = "https://react.dev/llms.txt";

describe("cache write discipline (temp file + rename, content before meta)", () => {
  it("N-5: writeCache stages BOTH temp files, then renames content and meta back to back — nothing but a rename sits in the new-content/old-meta window", () => {
    writeCache("react", URL_, "# React", '"v1"');
    expect(calls.map((c) => c.op)).toEqual(["write", "write", "rename", "rename"]);
    for (const c of calls.filter((c) => c.op === "write")) expect(c.path).toMatch(/\.tmp$/);
    expect(calls[2].to).toMatch(/\.md$/);
    expect(calls[3].to).toMatch(/\.meta\.json$/);
    // temp files live in the same directory as their target (rename is atomic only within a filesystem)
    for (const c of calls.filter((c) => c.op === "rename")) expect(join(c.path, "..")).toBe(join(c.to!, ".."));
    expect(readCache("react", URL_, 168)?.content).toBe("# React");
    expect(readCache("react", URL_, 168)?.meta.etag).toBe('"v1"');
  });

  it("touchCache rewrites meta through a temp file + rename as well", () => {
    writeCache("react", URL_, "# React");
    calls.length = 0;
    touchCache("react", URL_);
    expect(calls.map((c) => c.op)).toEqual(["write", "rename"]);
    expect(calls[0].path).toMatch(/\.tmp$/);
    expect(calls[1].to).toMatch(/\.meta\.json$/);
  });
});
