import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * PAR-786 (finding F-10) — the size ceiling on a cached `.md` content file must be checked
 * BEFORE any `readFileSync`, not merely reflected in the return value. A test that only asserts
 * `readCache(...)` returns `undefined` for an oversized file cannot tell "refused before
 * reading" apart from "read fully into memory, then discarded" — both produce the identical
 * `undefined`, and the acceptance criterion this item closes is specifically "without being
 * fully read into memory" (F-10: a planted 31,457,287-byte `.md` was previously read wholesale
 * and served in full, MEASURED at 58 ms).
 *
 * `node:fs`'s descriptor `readSync` is mocked here (recording every call, then delegating to
 * the real implementation) so the oversized-file test can assert zero content reads, not just
 * its outcome — the same one-function mocking style `test/cache-root.test.ts` already uses
 * for `renameSync`, kept in its OWN file rather than folded into the much larger
 * `test/cache.test.ts`: `vi.mock` applies for the whole file it is declared in, and wrapping
 * every `readFileSync` call that file's ~800 other, unrelated lines of tests make would be a
 * needless blast radius for one guard's proof.
 */
let readCalls = 0;
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    readSync: ((fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null) => {
      readCalls += 1;
      return actual.readSync(fd, buffer, offset, length, position);
    }) as typeof actual.readSync,
  };
});

const { readCache, writeCache, libDirName, urlSlug, MAX_CACHED_CONTENT_BYTES } = await import("../src/cache.js");
const { PRIMARY_DOC_MAX_BYTES } = await import("../src/fetcher.js");

let dir: string;
const URL_ = "https://react.dev/llms.txt";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-content-size-"));
  process.env.VIBECTX_CACHE_DIR = dir;
  readCalls = 0;
});

afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("PAR-786 (F-10) — the size ceiling runs before any read, not just before serving", () => {
  it("an oversized .md file is never read through its descriptor at all", () => {
    writeCache("react", URL_, "# React");
    const contentPath = join(dir, libDirName("react"), `${urlSlug(URL_)}.md`);
    writeFileSync(contentPath, "x".repeat(MAX_CACHED_CONTENT_BYTES + 1), "utf8");
    readCalls = 0; // clear whatever writeCache/setup itself triggered (none, but be explicit)

    const hit = readCache("react", URL_, 168);

    expect(hit).toBeUndefined();
    expect(readCalls).toBe(0);
  });

  it("a content file at the ceiling is still actually read (the guard is not simply always refusing)", () => {
    writeCache("react", URL_, "x".repeat(MAX_CACHED_CONTENT_BYTES));
    readCalls = 0;

    const hit = readCache("react", URL_, 168);

    expect(hit?.content.length).toBe(MAX_CACHED_CONTENT_BYTES);
    expect(readCalls).toBeGreaterThan(0);
  });
});

/**
 * Both reviewers (code-reviewer, security-architect) independently flagged the silent-drift
 * risk between these two constants: `MAX_CACHED_CONTENT_BYTES` (`cache.ts`, this file's
 * read-side ceiling) is a SEPARATE constant from `PRIMARY_DOC_MAX_BYTES` (`fetcher.ts`, the
 * write-side bound `fetchUrl` applies before a document ever reaches `writeCache`), kept apart
 * only to avoid a circular import (`fetcher.ts` imports `cache.ts`, not the other way). If
 * `PRIMARY_DOC_MAX_BYTES` is ever raised without raising this one to match, every document at
 * the new, larger size becomes permanently uncacheable with no warning and no `STALE:` fallback
 * — a real regression class this same file's history already warns about elsewhere
 * (`dropFollowedPageCache`'s own comments name several self-inflicted bounds of exactly this
 * shape). This test is the tripwire: it fails the moment the two constants disagree, in either
 * direction.
 */
describe("MAX_CACHED_CONTENT_BYTES must never fall below PRIMARY_DOC_MAX_BYTES", () => {
  it("the read-side ceiling is at least as large as the write-side fetch bound", () => {
    expect(MAX_CACHED_CONTENT_BYTES).toBeGreaterThanOrEqual(PRIMARY_DOC_MAX_BYTES);
  });
});
