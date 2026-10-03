import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { mockOpenSync } = vi.hoisted(() => ({ mockOpenSync: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, openSync: mockOpenSync };
});

const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
const { readBoundedRegularFile } = await import("../src/cache.js");

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), "vibectx-read-layers-"));
  mockOpenSync.mockImplementation((...args: Parameters<typeof fs.openSync>) => fs.openSync(...args));
});

afterEach(() => {
  mockOpenSync.mockReset();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("AUDIT-20260920-01 — each descriptor-read layer independently discriminates", () => {
  it.skipIf(process.platform === "win32")("passes O_NOFOLLOW to the atomic open even when inode validation would also refuse", () => {
    const content = join(dir, "cached.md");
    const saved = join(dir, "cached.saved");
    const secret = join(dir, "secret.txt");
    fs.writeFileSync(content, "cached document");
    fs.writeFileSync(secret, "not for the cache");

    mockOpenSync.mockImplementationOnce((path: string, flags: number, mode?: number) => {
      fs.renameSync(content, saved);
      fs.symlinkSync(secret, content);
      return fs.openSync(path, flags, mode);
    });

    expect(readBoundedRegularFile(content, 1024)).toBeUndefined();
    const flags = mockOpenSync.mock.calls[0]?.[1];
    expect(typeof flags).toBe("number");
    expect(Number(flags) & fs.constants.O_NOFOLLOW).not.toBe(0);
  });

  it("rejects a different regular file opened after the lstat, by descriptor identity", () => {
    const content = join(dir, "cached.md");
    const saved = join(dir, "cached.saved");
    const replacement = join(dir, "replacement.md");
    fs.writeFileSync(content, "the lstat-bound document");
    fs.writeFileSync(replacement, "replacement document");

    mockOpenSync.mockImplementationOnce((path: string, flags: number, mode?: number) => {
      fs.renameSync(content, saved);
      fs.renameSync(replacement, content);
      return fs.openSync(path, flags, mode);
    });

    expect(readBoundedRegularFile(content, 1024)).toBeUndefined();
  });
});
