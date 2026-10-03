import * as instrumentedFs from "node:fs";
vi.mock("node:fs", async (original) => { const actual = await original<typeof import("node:fs")>(); return { ...actual, default: actual, openSync: vi.fn(actual.openSync), fstatSync: vi.fn(actual.fstatSync) }; });
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import {
  readCache,
  readBoundedRegularFile,
  writeCache,
  touchCache,
  cacheRoot,
  toCacheMeta,
  dropFollowedPageCache,
  urlSlug,
  libDirName,
  resetCacheRootState,
  MAX_CACHED_CONTENT_BYTES,
} from "../src/cache.js";
import { sweepTempFiles, sweepCacheTempFiles, tempPathFor, SWEEP_MIN_AGE_MS } from "../src/atomic-store.js";
import { urlHashFor, MAX_META_FILE_BYTES } from "../src/cache-meta.js";
import { MAX_REMOTE_URL_LENGTH } from "../src/link-policy.js";

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "docs-cache-test-")));
  process.env.VIBECTX_CACHE_DIR = dir;
});

afterEach(() => {
  vi.resetAllMocks();
  delete process.env.VIBECTX_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("cache", () => {
  it("honors VIBECTX_CACHE_DIR", () => {
    expect(cacheRoot()).toBe(dir);
  });

  it("round-trips content with metadata", () => {
    writeCache("fastify", "https://fastify.dev/llms.txt", "# Fastify docs");
    const hit = readCache("fastify", "https://fastify.dev/llms.txt", 168);
    expect(hit?.content).toBe("# Fastify docs");
    expect(hit?.meta.url).toBe("https://fastify.dev/llms.txt");
    expect(hit?.stale).toBe(false);
  });

  it("misses for unknown urls", () => {
    expect(readCache("fastify", "https://nope.example/x", 168)).toBeUndefined();
  });

  it("marks entries stale past TTL", () => {
    writeCache("react", "https://react.dev/llms.txt", "# React");
    // TTL of zero hours: anything already written is instantly stale.
    const hit = readCache("react", "https://react.dev/llms.txt", 0);
    expect(hit?.stale).toBe(true);
    expect(hit?.content).toBe("# React"); // stale content still served
  });
});

describe("N-6, superseded by A4 — a hostile or missing fetchedAt reads as UNCACHED, not stale-but-served", () => {
  // N-6 originally made an unparsable fetchedAt read as stale (ageMs went NaN, and
  // `!(NaN < x)` is true) rather than fresh forever — better than the alternative, but it
  // still served content under a meta this process could not trust. A4's toCacheMeta
  // supersedes it: any of the four corruption classes (truncated, invalid JSON, wrong
  // shape, hostile fetchedAt) now drops the WHOLE meta, so readCache reports the entry
  // uncached, matching every other corrupt-file case (a torn content/meta pair, PAR-656 S4).
  const URL_ = "https://react.dev/llms.txt";
  const metaPath = () => join(dir, libDirName("react"), `${urlSlug(URL_)}.meta.json`);

  it.each(["yesterday", "", "not-a-date"])("fetchedAt %j → uncached (readCache returns undefined), not silently served", (bad) => {
    writeCache("react", URL_, "# React");
    writeFileSync(metaPath(), JSON.stringify({ url: URL_, fetchedAt: bad }), "utf8");
    expect(readCache("react", URL_, 168)).toBeUndefined();
  });

  it("a missing fetchedAt is uncached too, and a good one is still fresh", () => {
    writeCache("react", URL_, "# React");
    writeFileSync(metaPath(), JSON.stringify({ url: URL_ }), "utf8");
    expect(readCache("react", URL_, 168)).toBeUndefined();
    writeCache("react", URL_, "# React");
    expect(readCache("react", URL_, 168)?.stale).toBe(false);
  });
});

describe("A4 (PAR-717) — toCacheMeta, the four corruption classes", () => {
  const URL_ = "https://react.dev/llms.txt";
  const metaPath = () => join(dir, libDirName("react"), `${urlSlug(URL_)}.meta.json`);
  const contentPath = () => join(dir, libDirName("react"), `${urlSlug(URL_)}.md`);

  it("truncated .meta.json: readCache reports the entry uncached, never throws", () => {
    writeCache("react", URL_, "# React");
    const original = readFileSync(metaPath(), "utf8");
    writeFileSync(metaPath(), original.slice(0, Math.floor(original.length / 2)), "utf8");
    let hit: ReturnType<typeof readCache>;
    expect(() => {
      hit = readCache("react", URL_, 168);
    }).not.toThrow();
    expect(hit).toBeUndefined();
  });

  it("invalid JSON: readCache reports the entry uncached, never throws", () => {
    writeCache("react", URL_, "# React");
    writeFileSync(metaPath(), "{ not json", "utf8");
    let hit: ReturnType<typeof readCache>;
    expect(() => {
      hit = readCache("react", URL_, 168);
    }).not.toThrow();
    expect(hit).toBeUndefined();
  });

  it("wrong shape (valid JSON, wrong type for url/fetchedAt): readCache reports the entry uncached", () => {
    writeCache("react", URL_, "# React");
    writeFileSync(metaPath(), JSON.stringify({ url: 12345, fetchedAt: ["not", "a", "string"] }), "utf8");
    expect(readCache("react", URL_, 168)).toBeUndefined();
    // The content file is untouched — only the meta was corrupted; a fresh write repairs it.
    expect(readFileSync(contentPath(), "utf8")).toBe("# React");
  });

  it("hostile fetchedAt (well-shaped, impossible date): readCache reports the entry uncached", () => {
    writeCache("react", URL_, "# React");
    writeFileSync(metaPath(), JSON.stringify({ url: URL_, fetchedAt: "2026-13-45T06:00:00Z" }), "utf8");
    expect(readCache("react", URL_, 168)).toBeUndefined();
  });

  it("a valid meta with an oversized etag drops only the etag field, not the whole record", () => {
    writeCache("react", URL_, "# React");
    writeFileSync(metaPath(), JSON.stringify({ url: URL_, fetchedAt: new Date().toISOString(), etag: "x".repeat(600) }), "utf8");
    const hit = readCache("react", URL_, 168);
    expect(hit?.content).toBe("# React");
    expect(hit?.meta.etag).toBeUndefined();
  });

  it("a valid meta with a hostile etag (control character) drops only the etag field, not the whole record", () => {
    // S1 (code-reviewer A4 round 2): an etag containing a byte fetch's Headers refuses makes
    // fetchUrl throw at header construction; without a shape check the corrupt etag would be
    // re-read from this same file on every following attempt and pin the entry stale forever.
    writeCache("react", URL_, "# React");
    writeFileSync(metaPath(), JSON.stringify({ url: URL_, fetchedAt: new Date().toISOString(), etag: '"abc\ndef"' }), "utf8");
    const hit = readCache("react", URL_, 168);
    expect(hit?.content).toBe("# React");
    expect(hit?.meta.etag).toBeUndefined();
  });

  it("touchCache on a corrupt meta is a no-op, not a throw — the next readCache still reports it uncached", () => {
    writeCache("react", URL_, "# React");
    writeFileSync(metaPath(), "{ not json", "utf8");
    expect(() => touchCache("react", URL_)).not.toThrow();
    expect(readCache("react", URL_, 168)).toBeUndefined();
  });
});

describe("toCacheMeta — field-level boundaries (S5, code-reviewer A4 round 2)", () => {
  const AT = "2026-09-06T07:00:00.000Z";
  const valid = { url: "https://react.dev/llms.txt", fetchedAt: AT };
  const rejects = (mutate: Record<string, unknown>): void => {
    expect(toCacheMeta({ ...valid, ...mutate })).toBeUndefined();
  };

  it("accepts the valid shape, and only the three documented fields survive", () => {
    const meta = toCacheMeta({ ...valid, etag: '"v1"', extra: "dropped" })!;
    expect(meta).toEqual({ url: valid.url, fetchedAt: AT, etag: '"v1"' });
  });

  it("an own __proto__ key (what JSON.parse produces, unlike an object literal) is data, never a prototype write", () => {
    // Computed-property syntax, matching search-index.test.ts's equivalent regression: this
    // creates an OWN property literally named "__proto__", the shape JSON.parse('{"__proto__":…}')
    // actually produces — a plain `{ __proto__: {...} }` object literal would set the
    // prototype instead and prove nothing.
    const raw = { ...valid, ["__proto__"]: { polluted: true } };
    const meta = toCacheMeta(raw);
    expect(meta).toEqual({ url: valid.url, fetchedAt: AT });
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it("rejects a non-object, an array, or null", () => {
    expect(toCacheMeta(null)).toBeUndefined();
    expect(toCacheMeta("a string")).toBeUndefined();
    expect(toCacheMeta(["array"])).toBeUndefined();
    expect(toCacheMeta(42)).toBeUndefined();
  });

  it("rejects a url that is missing, wrong type, empty, oversized, or unparseable — accepts at exactly the length cap", () => {
    rejects({ url: undefined });
    rejects({ url: 42 });
    rejects({ url: "" });
    rejects({ url: "not a url" });
    const atCap = `https://a.example/${"x".repeat(2048 - "https://a.example/".length)}`;
    expect(atCap.length).toBe(2048);
    expect(toCacheMeta({ ...valid, url: atCap })?.url).toBe(atCap);
    rejects({ url: `${atCap}x` }); // one over
  });

  it("rejects a fetchedAt that is missing, wrong type, or not a strict ISO-8601 UTC instant — accepts at exactly the 9-digit fraction cap", () => {
    rejects({ fetchedAt: undefined });
    rejects({ fetchedAt: 1_757_000_000_000 });
    rejects({ fetchedAt: "2026-09-06" });
    rejects({ fetchedAt: "2026-13-45T06:00:00Z" }); // well-shaped, impossible
    rejects({ fetchedAt: `2020-01-01T00:00:00.${"1".repeat(10)}Z` }); // fraction over 9 digits
    // Both sides of the boundary pinned (security-architect A4 round 2): every other field's
    // cap in this describe block is tested accept-at and reject-past — this one previously
    // tested only the reject side.
    const atCap = `2020-01-01T00:00:00.${"1".repeat(9)}Z`;
    expect(toCacheMeta({ ...valid, fetchedAt: atCap })?.fetchedAt).toBe(atCap);
  });

  it("etag: dropped alone (not the whole record) when empty, oversized, or carrying a byte outside HTTP field-value characters — accepted at exactly the length cap", () => {
    expect(toCacheMeta({ ...valid, etag: "" })?.etag).toBeUndefined();
    const atCap = "x".repeat(512);
    expect(toCacheMeta({ ...valid, etag: atCap })?.etag).toBe(atCap);
    expect(toCacheMeta({ ...valid, etag: `${atCap}x` })?.etag).toBeUndefined(); // one over
    // S1 (code-reviewer A4 round 2): a newline (or any non-printable-ASCII byte) makes `fetch`
    // throw when the etag is next sent as If-None-Match — well inside the length cap, so length
    // alone does not catch it.
    expect(toCacheMeta({ ...valid, etag: '"abc\ndef"' })?.etag).toBeUndefined();
    expect(toCacheMeta({ ...valid, etag: "café" })?.etag).toBeUndefined(); // non-ASCII
    // The rest of the record still survives an etag rejection.
    expect(toCacheMeta({ ...valid, etag: '"abc\ndef"' })).toEqual({ url: valid.url, fetchedAt: AT });
  });
});

describe("A4 security gate, round 1 (security-architect: CONCERNS → fixed)", () => {
  const URL_ = "https://react.dev/llms.txt";
  const metaPath = () => join(dir, libDirName("react"), `${urlSlug(URL_)}.meta.json`);
  const contentPath = () => join(dir, libDirName("react"), `${urlSlug(URL_)}.md`);

  it("F1: a directory where the content file should be reads as uncached, not a throw (existsSync is true for a directory too)", () => {
    writeCache("react", URL_, "# React");
    rmSync(contentPath(), { force: true });
    mkdirSync(contentPath());
    let hit: ReturnType<typeof readCache>;
    expect(() => {
      hit = readCache("react", URL_, 168);
    }).not.toThrow();
    expect(hit).toBeUndefined();
  });

  it("F2: an absurdly long fetchedAt fractional-seconds group is rejected — Date.parse alone is not a length backstop", () => {
    writeCache("react", URL_, "# React");
    // MEASURED: Date.parse("2020-01-01T00:00:00." + "1".repeat(10_000) + "Z") returns a finite
    // timestamp, so an unbounded (\.\d+)? group would let this straight past the old regex,
    // through to the unclipped list_libraries footer and every STALE: note.
    const hostile = `2020-01-01T00:00:00.${"1".repeat(10_000)}Z`;
    writeFileSync(metaPath(), JSON.stringify({ url: URL_, fetchedAt: hostile }), "utf8");
    expect(readCache("react", URL_, 168)).toBeUndefined();
  });

  it("a plain millisecond fetchedAt (what writeCache actually produces) still passes", () => {
    writeCache("react", URL_, "# React");
    expect(readCache("react", URL_, 168)?.stale).toBe(false);
  });

  // D-47's allowInternalHosts case: meta.url is accepted even for an internal-host URL,
  // deliberately not held to sanitizeRemoteUrl's forbidden-host check. That is safe ONLY
  // because CacheHit.meta.url has no consumer anywhere in src/ (see toCacheMeta's docstring,
  // MEASURED by security-architect via grep) — if a future change ever renders or dereferences
  // it, this exemption must be revisited.
  it("accepts meta.url for an internal-host URL (D-47) rather than applying the fetch-time host policy", () => {
    writeCache("internal-lib", "https://127.0.0.1:9999/llms.txt", "# Internal doc");
    const hit = readCache("internal-lib", "https://127.0.0.1:9999/llms.txt", 168);
    expect(hit?.meta.url).toBe("https://127.0.0.1:9999/llms.txt");
  });

  /**
   * Source tripwire (test-auditor B, A4 round 3): no `src/` file dereferences a returned
   * `CacheHit`'s `meta.url` (e.g. `hit.meta.url`) — the invariant the D-47 exemption above
   * rests on: an internal-host `meta.url` is safe to accept ONLY as long as nothing outside
   * this file's own read path renders or re-fetches it.
   *
   * D-71 (PAR-749, security-architect round 2, S3) added two NEW `meta.url` accesses
   * (`cache.ts`'s `readCache`/`touchCache`, comparing a local `CacheMeta`'s own `url` against
   * the URL actually requested) — deliberately NOT matched by the regex below, and correctly
   * so: those are `meta.url` on a bare `CacheMeta` local, not `hit.meta.url` on a `CacheHit`,
   * an equality comparison rather than a dereference, and live inside the same read path this
   * invariant is ABOUT, not a new external consumer of it. The regex still requires a literal
   * `.meta.url` (a leading dot, i.e. property access off SOME object) specifically to exclude
   * that shape.
   */
  it("source tripwire (test-auditor B, A4 round 3): no src/ file reads CacheHit.meta.url as a property — the invariant the D-47 exemption above rests on", () => {
    const srcDir = new URL("../src/", import.meta.url);
    const offenders: string[] = [];
    for (const name of readdirSync(srcDir).filter((f) => f.endsWith(".ts"))) {
      const text = readFileSync(new URL(name, srcDir), "utf8");
      // `.meta.url` as a property access (e.g. `hit.meta.url`) — never `import.meta.url`,
      // which is unrelated JS syntax that happens to share the substring.
      if (/(?<!import)\.meta\.url\b/.test(text)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});

describe("cache — atomic writes (PAR-656 S4)", () => {
  const URL_ = "https://react.dev/llms.txt";
  const paths = () => {
    const d = join(dir, libDirName("react"));
    const slug = urlSlug(URL_);
    return { dir: d, content: join(d, `${slug}.md`), meta: join(d, `${slug}.meta.json`) };
  };

  it("writes content then meta, each via a temp file + rename in the same directory, leaving no temp file behind", () => {
    writeCache("react", URL_, "# React", '"v1"');
    const p = paths();
    expect(readdirSync(p.dir).sort()).toEqual([basename(p.content), basename(p.meta)]);
    expect(readCache("react", URL_, 168)?.meta.etag).toBe('"v1"');
  });

  it("write-side asymmetry, closed (security-architect A4 round 2): a hostile or oversized etag is never written to disk, not merely dropped again on the next read", () => {
    writeCache("react", URL_, "# React", '"abc\ndef"');
    const p = paths();
    expect(readFileSync(p.meta, "utf8")).not.toContain("\\n"); // no escaped newline landed in the file at all
    expect(readCache("react", URL_, 168)?.meta.etag).toBeUndefined();
    writeCache("hono", "https://hono.dev/llms.txt", "# Hono", "x".repeat(600));
    const honoMeta = join(dir, libDirName("hono"), `${urlSlug("https://hono.dev/llms.txt")}.meta.json`);
    expect(JSON.parse(readFileSync(honoMeta, "utf8")).etag).toBeUndefined();
  });

  it("a reader never sees a torn pair: content present with meta missing is a miss; meta present with content missing is a miss", () => {
    writeCache("react", URL_, "# React");
    const p = paths();
    const meta = readFileSync(p.meta, "utf8");
    rmSync(p.meta);
    expect(readCache("react", URL_, 168)).toBeUndefined(); // crash after content rename, before meta rename
    writeFileSync(p.meta, meta, "utf8");
    rmSync(p.content);
    expect(readCache("react", URL_, 168)).toBeUndefined();
  });

  it("a failed write (the library dir is a file) throws and leaves no temp file where the dir should be", () => {
    writeFileSync(join(dir, libDirName("react")), "not a dir", "utf8");
    expect(() => writeCache("react", URL_, "# React")).toThrow();
    expect(readdirSync(dir)).toEqual([libDirName("react")]);
  });

  it("an overwrite replaces the old content in one step: after the write there is exactly one content file and it is the new one", () => {
    writeCache("react", URL_, "# old");
    writeCache("react", URL_, "# new");
    const p = paths();
    expect(readdirSync(p.dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(readFileSync(p.content, "utf8")).toBe("# new");
  });

  it("touchCache rewrites meta via rename too (no temp file left) and refreshes fetchedAt", async () => {
    writeCache("react", URL_, "# React");
    const before = readCache("react", URL_, 168)!.meta.fetchedAt;
    await new Promise((r) => setTimeout(r, 5));
    touchCache("react", URL_);
    const p = paths();
    expect(readdirSync(p.dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(readCache("react", URL_, 168)!.meta.fetchedAt > before).toBe(true);
  });

  it("touchCache preserves a valid etag across the toCacheMeta round-trip (N4, test-auditor A4) — a 304 must not cost the next If-None-Match", () => {
    // MEASURED by mutation reasoning (test-auditor): dropping the etag in touchCache turned
    // no test in the suite red before this one existed — every other touchCache/304 test
    // seeds no etag, or seeds one but never re-reads meta.etag afterward.
    writeCache("react", URL_, "# React", '"v1"');
    touchCache("react", URL_);
    expect(readCache("react", URL_, 168)?.meta.etag).toBe('"v1"');
  });
});

describe("S-C — orphan temp files are swept from the cache directories", () => {
  const URL_ = "https://react.dev/llms.txt";
  const orphan = (dirPath: string, base: string) => join(dirPath, `${base}.4242.1757000000000.tmp`);

  it("sweepTempFiles removes only names the atomic writers produce, and never throws on a missing directory", () => {
    mkdirSync(join(dir, "projects"), { recursive: true });
    writeFileSync(orphan(dir, "resolved.json"), "{}", "utf8");
    writeFileSync(orphan(join(dir, "projects"), "abc.json"), "{}", "utf8");
    writeFileSync(join(dir, "notes.tmp"), "mine", "utf8"); // not our shape: untouched
    writeFileSync(join(dir, "resolved.json"), "{}", "utf8");
    sweepTempFiles(dir);
    sweepTempFiles(join(dir, "projects"));
    expect(() => sweepTempFiles(join(dir, "does-not-exist"))).not.toThrow();
    expect(readdirSync(dir).sort()).toEqual(["notes.tmp", "projects", "resolved.json"]);
    expect(readdirSync(join(dir, "projects"))).toEqual([]);
  });

  it("leaves a temp file younger than SWEEP_MIN_AGE_MS alone — it is another process's write in flight, not an orphan", () => {
    expect(SWEEP_MIN_AGE_MS).toBe(60_000);
    const inFlight = tempPathFor(join(dir, "resolved.json")); // stamped with Date.now()
    const justInside = join(dir, `resolved.json.4242.${Date.now() - (SWEEP_MIN_AGE_MS - 5_000)}.tmp`);
    const justOutside = join(dir, `resolved.json.4242.${Date.now() - (SWEEP_MIN_AGE_MS + 5_000)}.tmp`);
    const skewed = join(dir, `resolved.json.4242.${Date.now() + 5_000}.tmp`); // a clock that ran ahead
    for (const p of [inFlight, justInside, justOutside, skewed]) writeFileSync(p, "half a file", "utf8");
    sweepTempFiles(dir);
    expect(existsSync(inFlight)).toBe(true);
    expect(existsSync(justInside)).toBe(true);
    expect(existsSync(skewed)).toBe(true);
    expect(existsSync(justOutside)).toBe(false);
  });

  it("sweepCacheTempFiles reaches the per-library document directories too, and leaves real files alone", () => {
    writeCache("react", URL_, "# React");
    const libDir = join(dir, libDirName("react"));
    writeFileSync(orphan(libDir, "page.md"), "half a document", "utf8");
    writeFileSync(orphan(join(dir, libDirName("react")), "page.meta.json"), "{", "utf8");
    const before = readdirSync(libDir).filter((f) => !f.endsWith(".tmp")).sort();
    sweepCacheTempFiles(dir);
    expect(readdirSync(libDir).sort()).toEqual(before);
    expect(readCache("react", URL_, 168)?.content).toBe("# React");
  });

  it("PAR-1034 (M-4): a symlinked cache root is not swept at all; temp-shaped files in the link target survive", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "docs-cache-outside-")));
    const linkedRoot = join(dir, "linked-root");
    try {
      mkdirSync(join(outside, "sub"));
      const canary = orphan(outside, "canary");
      const subCanary = orphan(join(outside, "sub"), "canary");
      writeFileSync(canary, "not the cache's to delete", "utf8");
      writeFileSync(subCanary, "not the cache's to delete", "utf8");
      symlinkSync(outside, linkedRoot);

      sweepCacheTempFiles(linkedRoot);

      expect(existsSync(canary)).toBe(true);
      expect(existsSync(subCanary)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("PAR-1034 (L-7): a user file shaped like name.<n>.<n>.tmp without a 13-digit ms stamp is not swept", () => {
    // 1 digit (the audit's case), a date stamp, and 12 and 14 digits on either side of the width.
    const userFiles = ["backup.1.2.tmp", "backup.1.20240101.tmp", "backup.1.175700000000.tmp", "backup.1.17570000000000.tmp"].map((n) => join(dir, n));
    for (const f of userFiles) writeFileSync(f, "a person's own backup", "utf8");
    writeFileSync(orphan(dir, "resolved.json"), "{}", "utf8"); // a genuine orphan beside them

    sweepCacheTempFiles(dir);

    for (const f of userFiles) expect(readFileSync(f, "utf8"), f).toBe("a person's own backup");
    expect(existsSync(orphan(dir, "resolved.json"))).toBe(false);
  });

  it("S-C symlink safety: the sweep never descends a symlinked directory and never removes a symlink's target", () => {
    // The cache directory is a trust boundary: anything that can write there could plant a
    // symlink to have the startup sweep delete a file outside the cache. lstat, never stat.
    const outside = mkdtempSync(join(tmpdir(), "docs-cache-outside-"));
    try {
      // (a) a symlinked SUBDIRECTORY of the cache root whose target holds a temp-shaped file
      const outsideTemp = join(outside, "user.9.1757000000000.tmp"); // sweepable shape (PAR-1034 L-7)
      writeFileSync(outsideTemp, "not the cache's to delete", "utf8");
      symlinkSync(outside, join(dir, "linked-lib"));
      // (b) a symlink inside the cache root NAMED like a temp file, pointing at a real file
      const outsideVictim = join(outside, "victim.txt");
      writeFileSync(outsideVictim, "precious", "utf8");
      symlinkSync(outsideVictim, orphan(dir, "victim"));
      // a genuine orphan beside them is still swept
      writeFileSync(orphan(dir, "resolved.json"), "{}", "utf8");

      sweepCacheTempFiles(dir);

      expect(existsSync(outsideTemp)).toBe(true); // not descended
      expect(readFileSync(outsideVictim, "utf8")).toBe("precious"); // not followed
      expect(existsSync(orphan(dir, "resolved.json"))).toBe(false); // real orphan still gone
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

/**
 * A3 (PAR-716), round 1 (code-reviewer, B1) — `dropFollowedPageCache` must prove the cache
 * ROOT is a real directory before it deletes anything, the same D-46 rule `cache-evict.ts`
 * carries for eviction (see its own "the cache root is refused unless it is a real directory"
 * suite, mirrored here). `libDir()` alone does not give this: `lstat` on
 * `<symlinked-root>/<library>` answers `isDirectory() === true` because it stats the target,
 * so checking only the library directory let a symlink planted at the root position aim every
 * `rmSync` in this function wherever the link pointed.
 */
describe("A3 (PAR-716) · dropFollowedPageCache", () => {
  it("D-46: deletes nothing through a symlinked cache root", () => {
    const home = mkdtempSync(join(tmpdir(), "vibectx-userfiles-"));
    const parent = mkdtempSync(join(tmpdir(), "vibectx-linkroot-"));
    try {
      mkdirSync(join(home, "react"), { recursive: true });
      const victim = join(home, "react", "thesis.md");
      writeFileSync(victim, "# My thesis, not vibectx's to delete", "utf8");
      writeFileSync(join(home, "react", "thesis.meta.json"), JSON.stringify({ url: "https://example.com/thesis.md", fetchedAt: "1999-01-01T00:00:00.000Z" }), "utf8");

      const linked = join(parent, "root");
      symlinkSync(home, linked);
      process.env.VIBECTX_CACHE_DIR = linked;

      dropFollowedPageCache("react", ["https://react.dev/llms.txt"]);

      expect(existsSync(victim)).toBe(true); // zero unlinks through the symlinked root
      expect(existsSync(join(home, "react", "thesis.meta.json"))).toBe(true);
    } finally {
      process.env.VIBECTX_CACHE_DIR = dir;
      rmSync(parent, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("drops every cached page for the library except the ones in keepUrls", () => {
    const PRIMARY = "https://react.dev/llms.txt";
    const FOLLOWED = "https://react.dev/streaming.md";
    const SIBLING = "https://react.dev/llms-full.txt";
    writeCache("react", PRIMARY, "# React");
    writeCache("react", FOLLOWED, "# Streaming");
    writeCache("react", SIBLING, "# React full");
    writeCache("hono", "https://hono.dev/llms.txt", "# Hono"); // another library: untouched

    dropFollowedPageCache("react", [PRIMARY, SIBLING]);

    expect(readCache("react", PRIMARY, 168)?.content).toBe("# React");
    expect(readCache("react", SIBLING, 168)?.content).toBe("# React full"); // a kept candidate, not a followed page
    expect(readCache("react", FOLLOWED, 168)).toBeUndefined(); // dropped
    expect(readCache("hono", "https://hono.dev/llms.txt", 168)?.content).toBe("# Hono");
  });

  /**
   * D-71 (PAR-749) — REPLACES the old CHARACTERIZATION test of this same finding (round 3,
   * test-auditor, F8), which pinned the disclosed, destructive collision this fix closes:
   * `libDirIn`'s fold used to map any character outside `[a-z0-9_-]` to `_`, so two DISTINCT,
   * independently valid npm names — `foo.bar` and `foo_bar` — shared one cache directory, and
   * the C2/SF-C provenance checks (which compare a `.meta.json`'s own `url` against the slug,
   * not the library name against anything) could not catch it: the deleted pair genuinely was
   * one vibectx wrote, just for the sibling library sharing the folded name. `libDirName` now
   * appends a short hash of the FULL library name to the fold, so the two names resolve to
   * different directories and neither's cache is touched by the other's refresh.
   */
  it("two library names that fold to the same characters no longer collide — refreshing one leaves the other's cached primary alone", () => {
    const fooBarPrimary = "https://foo-bar.example.com/dot/llms.txt";
    const fooUnderscoreBarPrimary = "https://foo-bar.example.com/underscore/llms.txt";
    writeCache("foo.bar", fooBarPrimary, "# foo.bar's own primary");
    writeCache("foo_bar", fooUnderscoreBarPrimary, "# foo_bar's own primary"); // same fold as "foo.bar", different hash suffix
    expect(readCache("foo.bar", fooBarPrimary, 168)?.content).toBe("# foo.bar's own primary");
    expect(readCache("foo_bar", fooUnderscoreBarPrimary, 168)?.content).toBe("# foo_bar's own primary");
    // The two names now resolve to distinct directories entirely.
    expect(libDirName("foo.bar")).not.toBe(libDirName("foo_bar"));

    // "foo.bar" refreshes: its own drop call only keeps ITS OWN new candidate URL.
    const fooBarNewUrl = "https://foo-bar.example.com/dot/llms-full.txt";
    dropFollowedPageCache("foo.bar", [fooBarNewUrl]);

    // "foo_bar" was never refreshed and lives in its own directory now — its cache survives.
    expect(readCache("foo_bar", fooUnderscoreBarPrimary, 168)?.content).toBe("# foo_bar's own primary");
  });

  /**
   * PAR-787 — the library-NAME dimension's own second, independent check, mirroring D-71's
   * URL-dimension design: a `.meta.json` now also records which LIBRARY it belongs to, and
   * `readCache`/`touchCache` verify it. A genuine `libDirName` hash collision cannot be
   * constructed in a test (that is the whole point of a collision-resistant hash) — this
   * SIMULATES what one would produce: two libraries' files hand-planted in the SAME directory,
   * exactly as a forced collision would leave them, one with `library` recorded as the other
   * name entirely.
   */
  it("a forced libDirName collision between two different libraries is now caught by the library field, not silently served", () => {
    const aliceUrl = "https://x.example.com/alice.txt";
    const bobUrl = "https://x.example.com/bob.txt";
    writeCache("alice", aliceUrl, "# Alice's real content");
    const aliceDir = join(dir, libDirName("alice"));
    // Simulate the forced collision: bob's own file, planted directly inside alice's directory
    // (what libDirName("bob") === libDirName("alice") would produce), with its OWN, correct
    // `library: "bob"` recorded — exactly what writeCache("bob", bobUrl, ...) would have written,
    // had bob's hash actually collided with alice's.
    const bobSlug = urlSlug(bobUrl);
    writeFileSync(join(aliceDir, `${bobSlug}.md`), "# Bob's content, landed here by a forced collision", "utf8");
    writeFileSync(
      join(aliceDir, `${bobSlug}.meta.json`),
      JSON.stringify({ url: bobUrl, urlHash: urlHashFor(bobUrl), library: "bob", fetchedAt: new Date().toISOString() }),
      "utf8",
    );
    // alice's own entry is unaffected.
    expect(readCache("alice", aliceUrl, 168)?.content).toBe("# Alice's real content");
    // But a read for bob's URL under ALICE's library name — which is what a caller would see if
    // the two names really did share a directory — is refused: the meta says "bob", not "alice".
    expect(readCache("alice", bobUrl, 168)).toBeUndefined();
    // The same file, read under its OWN (correct) library name, is fine — proving the refusal
    // above is specifically about the library mismatch, not about the file being unreadable.
    // (`bob` has no directory of its own in this simulation, so this call finds nothing to read —
    // it demonstrates readCache still requires the library's OWN directory, not that this
    // specific planted file is independently readable.)
    expect(readCache("bob", bobUrl, 168)).toBeUndefined();
  });

  /** PAR-814 (item 3) — no test previously pinned `MAX_META_FILE_BYTES` (8192) at a realistic
   *  maximum-size record; this is that pin. */
  it("MAX_META_FILE_BYTES: a url, etag and finalUrl each near their individual max length still round-trips", () => {
    const url = `https://example.com/${"a".repeat(MAX_REMOTE_URL_LENGTH - "https://example.com/".length)}`;
    expect(url.length).toBe(MAX_REMOTE_URL_LENGTH);
    const finalUrl = `https://redirected.example.com/${"b".repeat(MAX_REMOTE_URL_LENGTH - "https://redirected.example.com/".length)}`;
    expect(finalUrl.length).toBe(MAX_REMOTE_URL_LENGTH);
    const etag = `"${"c".repeat(510)}"`; // 512 chars total — MAX_META_ETAG's own max (cache-meta.ts, not exported)
    expect(etag.length).toBe(512);
    writeCache("react", url, "# React", etag, finalUrl);
    const metaPath = join(dir, libDirName("react"), `${urlSlug(url)}.meta.json`);
    const bytesOnDisk = readFileSync(metaPath, "utf8").length;
    expect(bytesOnDisk).toBeLessThanOrEqual(MAX_META_FILE_BYTES);
    const hit = readCache("react", url, 168);
    expect(hit?.content).toBe("# React");
    expect(hit?.meta.etag).toBe(etag);
    expect(hit?.meta.finalUrl).toBeDefined();
  });

  it("backward compatibility: an old-format .meta.json with no `library` field is still read correctly", () => {
    const url = "https://x.example.com/old-format.txt";
    writeCache("react", url, "# Old format content");
    const metaPath = join(dir, libDirName("react"), `${urlSlug(url)}.meta.json`);
    const raw = JSON.parse(readFileSync(metaPath, "utf8"));
    delete raw.library; // simulate a .meta.json written before this item
    writeFileSync(metaPath, JSON.stringify(raw), "utf8");
    expect(readCache("react", url, 168)?.content).toBe("# Old format content");
    expect(touchCache("react", url)).toBeDefined();
  });

  it("touchCache leaves a mismatched-library record byte-for-byte unchanged", () => {
    const url = "https://x.example.com/touch-library.txt";
    writeCache("react", url, "# React");
    const metaPath = join(dir, libDirName("react"), `${urlSlug(url)}.meta.json`);
    const mismatched = JSON.stringify({ url, urlHash: urlHashFor(url), library: "other", fetchedAt: "2020-01-01T00:00:00.000Z" });
    writeFileSync(metaPath, mismatched, "utf8");

    expect(touchCache("react", url)).toBeUndefined();
    expect(readFileSync(metaPath, "utf8")).toBe(mismatched);
  });

  it("never follows or removes a symlinked file inside a real library directory", () => {
    const outside = mkdtempSync(join(tmpdir(), "docs-cache-outside-"));
    try {
      writeCache("react", "https://react.dev/llms.txt", "# React");
      const outsideVictim = join(outside, "victim.md");
      writeFileSync(outsideVictim, "precious", "utf8");
      const planted = join(dir, libDirName("react"), "planted.md");
      symlinkSync(outsideVictim, planted);

      dropFollowedPageCache("react", ["https://react.dev/llms.txt"]);

      expect(readFileSync(outsideVictim, "utf8")).toBe("precious"); // not followed
      // Round 2 (test-auditor, F4): the SYMLINK ITSELF must also survive — asserting only the
      // target's content cannot fail regardless of the guard, because `rmSync` on a plain path
      // never resolves a final-component symlink, so the target is unreachable either way.
      expect(existsSync(planted)).toBe(true); // not removed
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("is best-effort: an entry with no cache directory at all is a silent no-op", () => {
    expect(() => dropFollowedPageCache("never-cached", ["https://example.com/llms.txt"])).not.toThrow();
  });

  /**
   * Round 2 (security-architect, C2; test-auditor, F1) — the provenance clamp that bounds this
   * function's blast radius against a `VIBECTX_CACHE_DIR` aimed at a directory vibectx does not
   * own. Every case here must leave the file(s) in place: the clamp exists precisely so a
   * planted or corrupt file is NOT deleted on name shape alone.
   */
  describe("round 2 (security-architect, C2) · only a proven <slug>.md/<slug>.meta.json pair is deleted", () => {
    it("a lone .md with no .meta.json companion survives", () => {
      writeCache("react", "https://react.dev/llms.txt", "# React");
      writeFileSync(join(dir, libDirName("react"), "orphan.md"), "not vibectx's to delete", "utf8");

      dropFollowedPageCache("react", ["https://react.dev/llms.txt"]);

      expect(existsSync(join(dir, libDirName("react"), "orphan.md"))).toBe(true);
    });

    it("a lone .meta.json with no .md companion survives", () => {
      writeCache("react", "https://react.dev/llms.txt", "# React");
      writeFileSync(join(dir, libDirName("react"), "orphan.meta.json"), JSON.stringify({ url: "https://example.com/x", fetchedAt: "2026-01-01T00:00:00.000Z" }), "utf8");

      dropFollowedPageCache("react", ["https://react.dev/llms.txt"]);

      expect(existsSync(join(dir, libDirName("react"), "orphan.meta.json"))).toBe(true);
    });

    it("a .md whose .meta.json fails validation (truncated JSON) survives with both halves intact", () => {
      writeCache("react", "https://react.dev/llms.txt", "# React");
      writeCache("react", "https://react.dev/streaming.md", "# Streaming");
      const slug = urlSlug("https://react.dev/streaming.md");
      writeFileSync(join(dir, libDirName("react"), `${slug}.meta.json`), "{ not json", "utf8");

      dropFollowedPageCache("react", ["https://react.dev/llms.txt"]);

      expect(existsSync(join(dir, libDirName("react"), `${slug}.md`))).toBe(true);
      expect(existsSync(join(dir, libDirName("react"), `${slug}.meta.json`))).toBe(true);
    });

    it("a .md whose .meta.json exceeds the size bound survives, without being parsed", () => {
      writeCache("react", "https://react.dev/llms.txt", "# React");
      writeCache("react", "https://react.dev/streaming.md", "# Streaming");
      const slug = urlSlug("https://react.dev/streaming.md");
      // Oversized but otherwise well-formed JSON, so a failure here can only be the size guard.
      const oversized = JSON.stringify({ url: "https://react.dev/streaming.md", fetchedAt: "2026-01-01T00:00:00.000Z", etag: "x".repeat(9000) });
      writeFileSync(join(dir, libDirName("react"), `${slug}.meta.json`), oversized, "utf8");

      dropFollowedPageCache("react", ["https://react.dev/llms.txt"]);

      expect(existsSync(join(dir, libDirName("react"), `${slug}.md`))).toBe(true);
    });

    it("round 3 (code-reviewer, SF-A): a foreign pair literally named .md / .meta.json (empty slug) is never deleted", () => {
      writeCache("react", "https://react.dev/llms.txt", "# React");
      // A pair this tool did not write, whose slug happens to be empty — urlSlug() can never
      // produce "" for a non-empty URL, so no legitimate followed page ever has this name.
      writeFileSync(join(dir, libDirName("react"), ".md"), "not vibectx's, empty slug", "utf8");
      writeFileSync(join(dir, libDirName("react"), ".meta.json"), JSON.stringify({ url: "https://example.com/x", fetchedAt: "2026-01-01T00:00:00.000Z" }), "utf8");

      dropFollowedPageCache("react", ["https://react.dev/llms.txt"]);

      expect(existsSync(join(dir, libDirName("react"), ".md"))).toBe(true);
      expect(existsSync(join(dir, libDirName("react"), ".meta.json"))).toBe(true);
    });

    it("round 4 (code-reviewer, SF-C; security-architect, N1): a foreign pair with a NON-EMPTY, name-shaped slug whose meta names a DIFFERENT URL is never deleted", () => {
      writeCache("react", "https://react.dev/llms.txt", "# React");
      // A pair this tool did not write, named plausibly (not the empty-slug case above) but
      // whose .meta.json's own `url` field does not map back to this filename via urlSlug —
      // proof this file was not produced by writeCache for the URL it claims to describe.
      writeFileSync(join(dir, libDirName("react"), "my-notes.md"), "not vibectx's, foreign slug", "utf8");
      writeFileSync(join(dir, libDirName("react"), "my-notes.meta.json"), JSON.stringify({ url: "https://example.com/totally-different", fetchedAt: "2026-01-01T00:00:00.000Z" }), "utf8");

      dropFollowedPageCache("react", ["https://react.dev/llms.txt"]);

      expect(existsSync(join(dir, libDirName("react"), "my-notes.md"))).toBe(true);
      expect(existsSync(join(dir, libDirName("react"), "my-notes.meta.json"))).toBe(true);
    });

    it("round 4: dropFollowedPageCache(\"\", ...) is a no-op — an empty library never collapses the scan to the cache root", () => {
      writeCache("react", "https://react.dev/llms.txt", "# React");
      writeCache("react", "https://react.dev/streaming.md", "# Streaming");
      // Round 3 (test-auditor, F12): plant a REAL, C2/SF-C-proven pair DIRECTLY at the cache
      // ROOT — the only shape that actually exercises `library.length === 0`'s guard. Without
      // this, `readdirSync(root)` finds nothing ending in `.md`/`.meta.json` (only the "react"
      // subdirectory) and the test passes whether or not the guard exists.
      const rootUrl = "https://example.com/planted-at-root.md";
      const rootSlug = urlSlug(rootUrl);
      writeFileSync(join(dir, `${rootSlug}.md`), "planted directly at the cache root", "utf8");
      writeFileSync(join(dir, `${rootSlug}.meta.json`), JSON.stringify({ url: rootUrl, fetchedAt: "2026-01-01T00:00:00.000Z" }), "utf8");

      dropFollowedPageCache("", ["https://react.dev/llms.txt"]);

      expect(readCache("react", "https://react.dev/streaming.md", 168)?.content).toBe("# Streaming");
      expect(existsSync(join(dir, `${rootSlug}.md`))).toBe(true); // the root-level pair survives too
    });

    it("C3: a successful drop reports the count once, through the injected warn", () => {
      writeCache("react", "https://react.dev/llms.txt", "# React");
      writeCache("react", "https://react.dev/streaming.md", "# Streaming");
      writeCache("react", "https://react.dev/guide.md", "# Guide");
      const said: string[] = [];

      dropFollowedPageCache("react", ["https://react.dev/llms.txt"], (m) => said.push(m));

      expect(said).toHaveLength(1);
      expect(said[0]).toContain("dropped 2 stale followed-pages");
      expect(said[0]).toContain("react");
      expect(readCache("react", "https://react.dev/streaming.md", 168)).toBeUndefined();
      expect(readCache("react", "https://react.dev/guide.md", 168)).toBeUndefined();
    });

    it("nothing to drop: warn is never called", () => {
      writeCache("react", "https://react.dev/llms.txt", "# React");
      const said: string[] = [];

      dropFollowedPageCache("react", ["https://react.dev/llms.txt"], (m) => said.push(m));

      expect(said).toHaveLength(0);
    });
  });
});

/**
 * D-71 (PAR-749, Root 1) — the read-side verification `readCache` and `touchCache` never did:
 * a meta whose own `url` does not match the URL actually requested is not this entry, however
 * the file got there (a foreign file planted under a name-shaped slug; before this item, also
 * a genuine `urlSlug` fold collision — now impossible, since `urlSlug` is injective).
 */
describe("D-71 (PAR-749, Root 1) — readCache/touchCache verify the record's own url against the request", () => {
  const REQUESTED = "https://react.dev/llms.txt";
  const metaPath = () => join(dir, libDirName("react"), `${urlSlug(REQUESTED)}.meta.json`);

  it("readCache reports a miss, not the foreign content, when the meta's own url does not match the URL requested", () => {
    writeCache("react", REQUESTED, "# Not the requested document");
    // Overwrite the meta as if this exact file name had been produced for a DIFFERENT URL —
    // the shape `toCacheMeta` fully accepts (valid url, valid fetchedAt), so only the new
    // url-match check can catch this, not A4's validator.
    writeFileSync(metaPath(), JSON.stringify({ url: "https://react.dev/other-page.md", fetchedAt: new Date().toISOString() }), "utf8");
    expect(readCache("react", REQUESTED, 168)).toBeUndefined();
  });

  it("touchCache is a no-op, not a throw, when the meta's own url does not match the URL being refreshed", () => {
    writeCache("react", REQUESTED, "# Not the requested document");
    const mismatched = JSON.stringify({ url: "https://react.dev/other-page.md", fetchedAt: "2020-01-01T00:00:00.000Z" });
    writeFileSync(metaPath(), mismatched, "utf8");
    expect(() => touchCache("react", REQUESTED)).not.toThrow();
    // Not refreshed: the file on disk is untouched, byte for byte.
    expect(readFileSync(metaPath(), "utf8")).toBe(mismatched);
  });

  it("a genuine round trip (writeCache's own meta) still matches, so this check costs the good case nothing", () => {
    writeCache("react", REQUESTED, "# React");
    expect(readCache("react", REQUESTED, 168)?.content).toBe("# React");
  });
});

/**
 * PAR-806 (Phase 4) — the cache-filename design gate: a token in a configured URL must appear
 * at no disk surface, including the cache FILENAME itself as read from a directory listing, and
 * D-71's own collision/mismatch guarantees must survive the change. See docs/decisions.md for the
 * full design (redacted prefix, raw-url hash suffix, cold-miss-and-orphan upgrade behaviour).
 */
describe("PAR-806 — a token-bearing config URL leaves no trace in the cache filename or .meta.json", () => {
  const TOKEN_URL = "https://docs.example.test/guide?token=SECRET#fragment";
  const libDir = () => join(dir, libDirName("acme"));

  it("no filename in a directory listing of the cache root contains the token", () => {
    writeCache("acme", TOKEN_URL, "# Acme guide");
    const names = readdirSync(libDir());
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name).not.toContain("SECRET");
      expect(name).not.toContain("token");
      expect(name).not.toContain("fragment");
    }
  });

  it("the .meta.json file's own CONTENT contains no secret either (not just the filename)", () => {
    writeCache("acme", TOKEN_URL, "# Acme guide");
    const [metaName] = readdirSync(libDir()).filter((n) => n.endsWith(".meta.json"));
    const raw = readFileSync(join(libDir(), metaName), "utf8");
    expect(raw).not.toContain("SECRET");
    expect(raw).not.toContain("token");
    expect(raw).not.toContain("fragment");
    const parsed = JSON.parse(raw);
    expect(parsed.url).toBe("https://docs.example.test/guide"); // redacted, but still legible
    // Security-architect, Phase 4 round 2, B1 — this MUST be the full 64-character digest, not
    // urlSlug's own 12-character filename suffix; see cache-meta.ts's urlHashFor comment for why.
    expect(parsed.urlHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("proves the fix actually changed behaviour: the OLD (pre-fix) slug formula for the same URL is a genuinely different, token-bearing string", () => {
    // The pre-fix formula this item replaced: prefix AND hash both from the raw url.
    const oldFormulaSlug = `${TOKEN_URL.replace(/[^a-z0-9]/gi, "_").slice(0, 120)}_${urlSlug(TOKEN_URL).slice(-12)}`;
    expect(oldFormulaSlug).toContain("SECRET");
    writeCache("acme", TOKEN_URL, "# Acme guide");
    const names = readdirSync(libDir());
    expect(names.some((n) => n.startsWith(oldFormulaSlug))).toBe(false); // the new code never produces the old name
  });

  it("cold-miss-and-refetch: a cache entry written under the OLD slug formula is not found by the new readCache — a clean miss, not an error, not a wrong document", () => {
    mkdirSync(libDir(), { recursive: true });
    const oldSlug = `${TOKEN_URL.replace(/[^a-z0-9]/gi, "_").slice(0, 120)}_${urlSlug(TOKEN_URL).slice(-12)}`;
    writeFileSync(join(libDir(), `${oldSlug}.md`), "# Stale old-format content", "utf8");
    writeFileSync(join(libDir(), `${oldSlug}.meta.json`), JSON.stringify({ url: TOKEN_URL, fetchedAt: new Date().toISOString() }), "utf8");
    expect(() => readCache("acme", TOKEN_URL, 168)).not.toThrow();
    expect(readCache("acme", TOKEN_URL, 168)).toBeUndefined(); // orphaned, not served
    // The orphan is harmless dead weight, not read again, but proves this test constructed a
    // real old-format file rather than one the new code would have produced anyway.
    expect(existsSync(join(libDir(), `${oldSlug}.md`))).toBe(true);
  });

  /**
   * security-architect S3 (Phase 4 round 2) — verifies, rather than assumes, a real residual:
   * an OLD-format followed-page file for a URL whose redacted form differs from its raw one is
   * NOT reachable by `dropFollowedPageCache`'s own refresh-triggered cleanup, because
   * `metaMatchesSlug`'s old-format fallback (`urlSlug(meta.url) === slug`) now recomputes the
   * slug under the NEW formula against a filename written under the OLD one — they no longer
   * match, so the file is left in place "for eviction" (its own stated policy for anything it
   * cannot prove) rather than deleted. This is a real, disclosed gap in this specific cleanup
   * path, not a security hole (D-71's own guarantee — never wrong content served — is
   * unaffected either way; this is about disk hygiene, not correctness).
   */
  it("security-architect S3: dropFollowedPageCache cannot reclaim an OLD-format followed-page file for a query-bearing URL — it is left in place, not deleted", () => {
    mkdirSync(libDir(), { recursive: true });
    const oldSlug = `${TOKEN_URL.replace(/[^a-z0-9]/gi, "_").slice(0, 120)}_${urlSlug(TOKEN_URL).slice(-12)}`;
    const contentPath = join(libDir(), `${oldSlug}.md`);
    const metaPath = join(libDir(), `${oldSlug}.meta.json`);
    writeFileSync(contentPath, "# Stale old-format followed page", "utf8");
    writeFileSync(metaPath, JSON.stringify({ url: TOKEN_URL, fetchedAt: new Date().toISOString() }), "utf8");
    // A refresh that keeps some OTHER url should, in the old (pre-Phase-4) world, have swept
    // this stale followed page away. It does not:
    dropFollowedPageCache("acme", ["https://docs.example.test/guide?token=a-completely-different-url"]);
    expect(existsSync(contentPath)).toBe(true);
    expect(existsSync(metaPath)).toBe(true);
  });

  it("D-71 preserved: two URLs differing ONLY by query string still produce distinct cache entries, and a read for one never hits the other's", () => {
    const v2 = "https://docs.example.test/llms.txt?version=v2";
    const v3 = "https://docs.example.test/llms.txt?version=v3";
    writeCache("acme", v2, "# v2 content");
    writeCache("acme", v3, "# v3 content");
    expect(readCache("acme", v2, 168)?.content).toBe("# v2 content");
    expect(readCache("acme", v3, 168)?.content).toBe("# v3 content");
    // Genuinely two files, not one overwriting the other.
    expect(readdirSync(libDir()).filter((n) => n.endsWith(".md"))).toHaveLength(2);
  });

  it("a token-bearing url still round-trips correctly for the ordinary case (write, then read, same url)", () => {
    writeCache("acme", TOKEN_URL, "# Acme guide");
    expect(readCache("acme", TOKEN_URL, 168)?.content).toBe("# Acme guide");
  });

  it("a genuinely different url (same host, different query) is correctly treated as a miss, never a false hit off a hash collision on the query-stripped prefix", () => {
    writeCache("acme", TOKEN_URL, "# Acme guide");
    const differentToken = "https://docs.example.test/guide?token=OTHER-SECRET";
    expect(readCache("acme", differentToken, 168)).toBeUndefined();
  });
});

describe("PAR-776 (D-74) — writeCache/touchCache's finalUrl", () => {
  const CANDIDATE = "https://react.dev/llms.txt";
  const FINAL = "https://docs.react.dev/llms.txt";
  const metaPath = () => join(dir, libDirName("react"), `${urlSlug(CANDIDATE)}.meta.json`);

  it("writeCache stores finalUrl only when it actually differs from the candidate url", () => {
    writeCache("react", CANDIDATE, "# React", undefined, FINAL);
    expect(readCache("react", CANDIDATE, 168)?.meta.finalUrl).toBe(FINAL);
  });

  it("writeCache stores no finalUrl at all when it equals the candidate url — same file shape as a plain write", () => {
    writeCache("react", CANDIDATE, "# React", undefined, CANDIDATE);
    expect(readCache("react", CANDIDATE, 168)?.meta.finalUrl).toBeUndefined();
    expect(JSON.parse(readFileSync(metaPath(), "utf8"))).not.toHaveProperty("finalUrl");
  });

  it("writeCache stores no finalUrl when the caller never passed one", () => {
    writeCache("react", CANDIDATE, "# React");
    expect(readCache("react", CANDIDATE, 168)?.meta.finalUrl).toBeUndefined();
  });

  it("touchCache sets finalUrl on an existing entry that redirects for the first time", () => {
    writeCache("react", CANDIDATE, "# React");
    touchCache("react", CANDIDATE, FINAL);
    expect(readCache("react", CANDIDATE, 168)?.meta.finalUrl).toBe(FINAL);
  });

  it("touchCache clears a stale finalUrl once a revalidation stops redirecting", () => {
    writeCache("react", CANDIDATE, "# React", undefined, FINAL);
    touchCache("react", CANDIDATE, CANDIDATE);
    expect(readCache("react", CANDIDATE, 168)?.meta.finalUrl).toBeUndefined();
  });

  it("touchCache leaves finalUrl untouched when called without one (unrelated refresh path)", () => {
    writeCache("react", CANDIDATE, "# React", undefined, FINAL);
    touchCache("react", CANDIDATE);
    expect(readCache("react", CANDIDATE, 168)?.meta.finalUrl).toBe(FINAL);
  });

  /**
   * code-reviewer B1 / security-architect S2 (Phase 4 round 2) — `.meta.json`'s `finalUrl` is a
   * SECOND plaintext-secret site right next to `url`, closed the same way: redacted at write
   * (both `writeCache` and `touchCache`) and again at read (`toCacheMeta`, for a pre-fix file).
   */
  describe("PAR-806 (Phase 4 round 2) — finalUrl is redacted, not stored/read raw", () => {
    const TOKEN_CANDIDATE = "https://docs.internal.example.com/old.txt?token=super-secret-candidate";
    const TOKEN_FINAL = "https://docs.internal.example.com/new.txt?token=super-secret-final";
    const tokenMetaPath = () => join(dir, libDirName("acme"), `${urlSlug(TOKEN_CANDIDATE)}.meta.json`);

    it("writeCache: the .meta.json bytes on disk contain no token, in url OR finalUrl", () => {
      writeCache("acme", TOKEN_CANDIDATE, "# Acme", undefined, TOKEN_FINAL);
      const raw = readFileSync(tokenMetaPath(), "utf8");
      expect(raw).not.toContain("super-secret-candidate");
      expect(raw).not.toContain("super-secret-final");
      expect(raw).not.toContain("token");
      const parsed = JSON.parse(raw);
      expect(parsed.finalUrl).toBe("https://docs.internal.example.com/new.txt");
      expect(readCache("acme", TOKEN_CANDIDATE, 168)?.meta.finalUrl).toBe("https://docs.internal.example.com/new.txt");
    });

    it("touchCache: the .meta.json bytes on disk contain no token in a finalUrl set on revalidation", () => {
      writeCache("acme", TOKEN_CANDIDATE, "# Acme");
      touchCache("acme", TOKEN_CANDIDATE, TOKEN_FINAL);
      const raw = readFileSync(tokenMetaPath(), "utf8");
      expect(raw).not.toContain("super-secret-final");
      expect(JSON.parse(raw).finalUrl).toBe("https://docs.internal.example.com/new.txt");
    });

    /** code-reviewer's own explicit warning: redacting the STORED value while leaving the
     *  "did it redirect" gate comparing raw-to-raw would let a finalUrl differing from the
     *  candidate only by query collapse to the SAME string as `url` once redacted — stored
     *  anyway, it would render as a confusing "(redirected from X)" for identical X. The gate
     *  itself must compare redacted-to-redacted, so nothing is stored in that case at all. */
    it("a finalUrl differing from the candidate ONLY by query string redacts to the same value — nothing is stored, not a confusing self-referential finalUrl", () => {
      const candidate = "https://docs.internal.example.com/x?v=1";
      const finalOnlyQueryDiffers = "https://docs.internal.example.com/x?v=2";
      writeCache("acme2", candidate, "# Acme", undefined, finalOnlyQueryDiffers);
      expect(readCache("acme2", candidate, 168)?.meta.finalUrl).toBeUndefined();
      const path = join(dir, libDirName("acme2"), `${urlSlug(candidate)}.meta.json`);
      expect(JSON.parse(readFileSync(path, "utf8"))).not.toHaveProperty("finalUrl");

      // Same property for touchCache's revalidation path.
      touchCache("acme2", candidate, finalOnlyQueryDiffers);
      expect(readCache("acme2", candidate, 168)?.meta.finalUrl).toBeUndefined();
    });

    it("toCacheMeta redacts a raw finalUrl on READ too, for a pre-fix .meta.json already on disk", () => {
      writeCache("acme3", TOKEN_CANDIDATE, "# Acme");
      // Simulate a pre-fix file: hand-write a meta whose finalUrl is still raw (unredacted).
      const path = join(dir, libDirName("acme3"), `${urlSlug(TOKEN_CANDIDATE)}.meta.json`);
      const raw = JSON.parse(readFileSync(path, "utf8"));
      raw.finalUrl = TOKEN_FINAL; // raw, as an old version of this code would have stored it
      writeFileSync(path, JSON.stringify(raw), "utf8");
      const hit = readCache("acme3", TOKEN_CANDIDATE, 168);
      expect(hit?.meta.finalUrl).toBe("https://docs.internal.example.com/new.txt");
      expect(hit?.meta.finalUrl).not.toContain("super-secret-final");
    });
  });

  /** security-architect, PAR-776 round 1, B-1: an oversized `finalUrl` (a long redirect
   *  `Location`) must never reach disk raw — large enough (well past MAX_META_FILE_BYTES,
   *  8192, on its own), it would push this single entry's `.meta.json` past that bound,
   *  making `readMetaFile` refuse to even PARSE the file — the WHOLE entry, not just its
   *  redirect awareness, permanently unreadable, `readCache` reporting it uncached forever and
   *  defeating offline fallback for it. `writeCache`/`touchCache` drop the oversized value
   *  before it ever reaches disk instead: the entry still caches, just without the
   *  redirect-aware extra — the same degradation an invalid `etag` already gets. Sized well
   *  past 8192 alone (not just past finalUrl's own 2048-char bound) so this test actually
   *  proves the file-size DoS is closed, not merely that an over-2048 value is rejected. */
  it("(security-architect, PAR-776 round 1, B-1) writeCache drops a finalUrl too large to ever fit in .meta.json, rather than writing an entry too large to read back", () => {
    const oversized = "https://docs.react.dev/" + "a".repeat(9000);
    writeCache("react", CANDIDATE, "# React", undefined, oversized);
    const hit = readCache("react", CANDIDATE, 168);
    expect(hit?.content).toBe("# React"); // the entry itself is still readable — not lost entirely
    expect(hit?.meta.finalUrl).toBeUndefined();
  });

  it("(security-architect, PAR-776 round 1, B-1) touchCache drops the same oversized finalUrl on a revalidation, not just on first write", () => {
    writeCache("react", CANDIDATE, "# React");
    const oversized = "https://docs.react.dev/" + "a".repeat(9000);
    touchCache("react", CANDIDATE, oversized);
    const hit = readCache("react", CANDIDATE, 168);
    expect(hit?.content).toBe("# React");
    expect(hit?.meta.finalUrl).toBeUndefined();
  });

  it("(code-reviewer/security-architect, PAR-776 round 1, B1/B-1) writeCache/touchCache drop a finalUrl carrying userinfo or a forbidden host, not just an oversized one", () => {
    writeCache("react", CANDIDATE, "# React", undefined, "https://user:pass@docs.react.dev/llms.txt");
    expect(readCache("react", CANDIDATE, 168)?.meta.finalUrl).toBeUndefined();
    touchCache("react", CANDIDATE, "https://127.0.0.1/llms.txt");
    expect(readCache("react", CANDIDATE, 168)?.meta.finalUrl).toBeUndefined();
  });
});

/**
 * D-71 (PAR-749) Done-when: "A test enumerates those call sites so a new one cannot be added
 * without failing." Two complementary checks, both needed (code-reviewer, round 1, B2 — the
 * first version of this test only enumerated FILES, and skipped the three files every one of
 * the six named call sites actually lives in, so it could not have caught the bug it exists to
 * prevent):
 *
 *   1. No `src/*.ts` file OUTSIDE `cache-meta.ts`/`cache.ts`/`cache-evict.ts` so much as
 *      mentions the `.meta.json` suffix — a new reader in some other file is caught here.
 *   2. INSIDE those two consumer files, `readMetaFile` (`cache-meta.ts`) is the ONLY thing
 *      that ever parses one — asserted by requiring the six named functions to still exist by
 *      name (a call site silently renamed or removed without updating this test fails) AND
 *      requiring neither file to contain its own `JSON.parse` (a new ad hoc reader added
 *      BESIDE `readMetaFile`, Root 2's original defect, fails here instead of shipping as a
 *      fifth trust level).
 */
describe("D-71 (PAR-749) — call-site enumeration: every `.meta.json` reader is exactly this list", () => {
  const stripComments = (code: string): string => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const srcDir = new URL("../src/", import.meta.url);
  const read = (name: string): string => readFileSync(new URL(name, srcDir), "utf8");

  it("no src/ file outside cache-meta.ts/cache.ts/cache-evict.ts mentions the .meta.json suffix", () => {
    const offenders: string[] = [];
    for (const name of readdirSync(srcDir).filter((f) => f.endsWith(".ts"))) {
      if (name === "cache-meta.ts" || name === "cache.ts" || name === "cache-evict.ts") continue;
      if (read(name).includes(".meta.json")) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  it("readCache, writeCache, touchCache and dropFollowedPageCache still exist by name in cache.ts, and neither cache.ts nor cache-evict.ts parses a .meta.json itself", () => {
    const cacheSrc = stripComments(read("cache.ts"));
    for (const name of ["readCache", "writeCache", "touchCache", "dropFollowedPageCache"]) {
      expect(cacheSrc).toMatch(new RegExp(`function ${name}\\(`));
    }
    expect(cacheSrc).not.toMatch(/JSON\.parse/);
  });

  it("cache-evict.ts's recency reader and enforceCacheSizeCap still exist by name, and cache-evict.ts parses a .meta.json nowhere itself", () => {
    const evictSrc = stripComments(read("cache-evict.ts"));
    for (const name of ["resolveRecency", "enforceCacheSizeCap"]) {
      expect(evictSrc).toMatch(new RegExp(`function ${name}\\(`));
    }
    expect(evictSrc).not.toMatch(/JSON\.parse/);
  });
});

/**
 * PAR-786 — the cache root, the per-library directory, and the `.md` content file are each
 * hardened against a symlink planted at that exact position, for the per-library DOCUMENTATION
 * cache reached through `readCache`/`writeCache`/`touchCache` specifically — mirroring the D-46
 * leaf-`lstat` policy `cache-evict.ts`'s `rootIsSweepable` and this file's own
 * `dropFollowedPageCache` already apply to DELETION, now applied to ordinary reads and writes of
 * this one cache too (not the rest of the cache directory — see the README's own scope note and
 * D-83 in docs/decisions.md for what is and is not covered). Independently verified (PAR-786's own
 * investigation, findings F-2a/F-2b/F-10): before this, `readCache`'s content half had no
 * `lstat` guard at all (F-2a: a symlinked `.md` was followed and its target's content returned
 * verbatim) and no size ceiling (F-10: a planted 31 MB `.md` was read wholesale), `writeCache`
 * could be made to write through a symlinked root with no warning until a much later, unrelated
 * eviction sweep happened to fire, by which point the sweep's own wording ("the link was not
 * followed") was already false (N-b1), and `touchCache` (reachable on every 304 revalidation)
 * had no root/library-directory guard at all, only a symlink-safe `.meta.json` read.
 *
 * The size-ceiling PROOF that `readFileSync` is never even called for an oversized file, and the
 * `MAX_CACHED_CONTENT_BYTES >= PRIMARY_DOC_MAX_BYTES` drift tripwire, live in
 * `test/cache-content-size.test.ts`, in its own file: it needs to mock `node:fs`'s
 * `readFileSync` to count calls, and `vi.mock` applies file-wide, so keeping it separate avoids
 * wrapping every `readFileSync` call this (much larger) file's ~800 other lines of tests make.
 */
describe("PAR-786 — cache root/content-file symlink and size hardening", () => {
  const URL_ = "https://react.dev/llms.txt";

  describe("Attack 1 (F-2a): readCache never follows a symlinked content file", () => {
    it("a .md replaced with a symlink to a sibling secret file is refused, not served", () => {
      writeCache("react", URL_, "# React, the real cached document");
      const libraryDir = join(dir, libDirName("react"));
      const contentPath = join(libraryDir, `${urlSlug(URL_)}.md`);
      const secret = join(libraryDir, "secret-sibling.txt");
      writeFileSync(secret, "LOCAL_SECRET_NOT_DOCUMENTATION", "utf8");
      rmSync(contentPath, { force: true });
      symlinkSync(secret, contentPath);

      const hit = readCache("react", URL_, 168);

      // The real assertion: a symlinked content file must never be followed and served as this
      // entry's content — `readBoundedRegularFile`'s `isFile()` check (not `stat`, which would
      // follow the link) is what makes this `undefined` rather than the secret's own bytes.
      expect(hit).toBeUndefined();
    });
  });

  describe("readCache refuses a symlinked cache ROOT (mutation target: readCache's root-lstat check)", () => {
    it("returns undefined rather than reading through a symlinked root, even when the target holds a genuinely matching entry", () => {
      const home = mkdtempSync(join(tmpdir(), "vibectx-userfiles-"));
      const parent = mkdtempSync(join(tmpdir(), "vibectx-linkroot-"));
      try {
        process.env.VIBECTX_CACHE_DIR = home;
        writeCache("react", URL_, "# Genuinely cached, but behind a link");

        const linked = join(parent, "root");
        symlinkSync(home, linked);
        process.env.VIBECTX_CACHE_DIR = linked;

        expect(readCache("react", URL_, 168)).toBeUndefined();
      } finally {
        process.env.VIBECTX_CACHE_DIR = dir;
        rmSync(parent, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    });
  });

  describe("library-directory symlink on the READ path (mutation target: readCache's library-directory-lstat check)", () => {
    it("readCache refuses when the library's own directory is a symlink, even to a directory holding a same-named, valid pair", () => {
      const outside = mkdtempSync(join(tmpdir(), "vibectx-outside-"));
      try {
        const slug = urlSlug(URL_);
        writeFileSync(join(outside, `${slug}.md`), "# Foreign content behind the link", "utf8");
        writeFileSync(
          join(outside, `${slug}.meta.json`),
          JSON.stringify({ url: URL_, fetchedAt: new Date().toISOString() }),
          "utf8",
        );
        symlinkSync(outside, join(dir, libDirName("react")));

        expect(readCache("react", URL_, 168)).toBeUndefined();
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  describe("touchCache gets the same root/library-directory guard as readCache (security-architect finding, PAR-786 follow-up)", () => {
    it("touchCache is a no-op, not a throw, through a symlinked cache root, even when the target holds a genuinely matching entry", () => {
      const home = mkdtempSync(join(tmpdir(), "vibectx-userfiles-"));
      const parent = mkdtempSync(join(tmpdir(), "vibectx-linkroot-"));
      try {
        process.env.VIBECTX_CACHE_DIR = home;
        writeCache("react", URL_, "# Genuinely cached, but behind a link");
        const metaPath = join(home, libDirName("react"), `${urlSlug(URL_)}.meta.json`);
        const before = readFileSync(metaPath, "utf8");

        const linked = join(parent, "root");
        symlinkSync(home, linked);
        process.env.VIBECTX_CACHE_DIR = linked;

        expect(() => touchCache("react", URL_)).not.toThrow();
        expect(touchCache("react", URL_)).toBeUndefined();
        // Not refreshed: the file on the real, unlinked path is untouched, byte for byte.
        expect(readFileSync(metaPath, "utf8")).toBe(before);
      } finally {
        process.env.VIBECTX_CACHE_DIR = dir;
        rmSync(parent, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    });

    it("touchCache refuses when the library's own directory is a symlink, even to a directory holding a same-named, valid pair", () => {
      const outside = mkdtempSync(join(tmpdir(), "vibectx-outside-"));
      try {
        const slug = urlSlug(URL_);
        const foreignMeta = join(outside, `${slug}.meta.json`);
        writeFileSync(join(outside, `${slug}.md`), "# Foreign content behind the link", "utf8");
        writeFileSync(foreignMeta, JSON.stringify({ url: URL_, fetchedAt: "2020-01-01T00:00:00.000Z" }), "utf8");
        symlinkSync(outside, join(dir, libDirName("react")));
        const before = readFileSync(foreignMeta, "utf8");

        expect(touchCache("react", URL_)).toBeUndefined();
        // Not refreshed: the foreign file behind the link is untouched, byte for byte.
        expect(readFileSync(foreignMeta, "utf8")).toBe(before);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  describe("library-directory symlink on the WRITE path (mutation target: writeCache's leaf-symlink pre-check, isSymlinkAt)", () => {
    it("does not throw, writes nothing inside the symlink's target, and warns", () => {
      const outside = mkdtempSync(join(tmpdir(), "vibectx-outside-"));
      try {
        symlinkSync(outside, join(dir, libDirName("react")));
        const said: string[] = [];

        let fetchedAt: string | undefined;
        expect(() => {
          fetchedAt = writeCache("react", URL_, "# Should never land here", undefined, undefined, (m) => said.push(m));
        }).not.toThrow();

        expect(fetchedAt).toBeDefined();
        expect(readdirSync(outside)).toEqual([]); // nothing was written inside the symlink's target
        expect(said).toHaveLength(1);
        expect(said[0]).toContain("symlink");
        expect(said[0]).not.toContain("was not followed"); // must not claim something false
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  describe("Attack 2 (F-2b/N-b1): writeCache refuses a symlinked cache root, before writing anything (mutation target: writeCache's root-lstat check, existsAsNonDirectory)", () => {
    it("creates nothing inside the symlink's target, and warns with text that is true at the moment it is printed", () => {
      const target = mkdtempSync(join(tmpdir(), "vibectx-target-"));
      const parent = mkdtempSync(join(tmpdir(), "vibectx-linkroot-"));
      try {
        const linked = join(parent, "root");
        symlinkSync(target, linked);
        process.env.VIBECTX_CACHE_DIR = linked;
        const said: string[] = [];

        let fetchedAt: string | undefined;
        expect(() => {
          fetchedAt = writeCache("react", URL_, "# Should never land in target", undefined, undefined, (m) => said.push(m));
        }).not.toThrow();

        expect(fetchedAt).toBeDefined();
        expect(readdirSync(target)).toEqual([]); // (a) nothing created inside the symlink's target
        // (b) nothing at the symlink path's own listing either — it IS a symlink to elsewhere,
        // so "listing the symlink path" is exactly "listing the target", already asserted above.
        expect(readCache("react", URL_, 168)).toBeUndefined(); // nothing was cached at all
        expect(said).toHaveLength(1);
        // The warning must say something TRUE and SPECIFIC — not the sweep-time wording this
        // finding (N-b1) was filed against ("the link was not followed"), which was false by the
        // time it was printed there because the write had already gone through. Here the check
        // runs BEFORE any write is attempted, so "nothing was written" is actually true.
        expect(said[0]).toContain("symlink");
        expect(said[0]).toContain("Nothing was written");
        expect(said[0]).not.toContain("was not followed");
      } finally {
        process.env.VIBECTX_CACHE_DIR = dir;
        rmSync(parent, { recursive: true, force: true });
        rmSync(target, { recursive: true, force: true });
      }
    });

    it("dedupes PER DISTINCT ROOT, not with a single process-global flag: repeats to the same bad root print nothing new, but a second, genuinely different bad root still gets its own warning", () => {
      // code-reviewer, S3: a test that only ever exercises ONE bad root cannot tell a per-root
      // `Set` apart from a single global boolean — both suppress every repeat equally. Only a
      // SECOND, distinct root proves the dedupe is keyed by root: a global-boolean
      // implementation would (wrongly) suppress the warning for root B too, once root A had
      // already fired one, failing the `toHaveLength(2)` assertion below.
      const targetA = mkdtempSync(join(tmpdir(), "vibectx-target-a-"));
      const targetB = mkdtempSync(join(tmpdir(), "vibectx-target-b-"));
      const parent = mkdtempSync(join(tmpdir(), "vibectx-linkroot-"));
      try {
        const linkedA = join(parent, "root-a");
        const linkedB = join(parent, "root-b");
        symlinkSync(targetA, linkedA);
        symlinkSync(targetB, linkedB);
        const said: string[] = [];
        const warn = (m: string) => said.push(m);

        process.env.VIBECTX_CACHE_DIR = linkedA;
        writeCache("react", URL_, "# a1", undefined, undefined, warn);
        writeCache("hono", "https://hono.dev/llms.txt", "# a2", undefined, undefined, warn); // same root again: no new line
        writeCache("react", URL_, "# a3", undefined, undefined, warn); // same root, again: still no new line

        process.env.VIBECTX_CACHE_DIR = linkedB;
        writeCache("react", URL_, "# b1", undefined, undefined, warn); // a genuinely DIFFERENT root: its own line

        expect(said).toHaveLength(2);
        expect(said[0]).toContain(linkedA);
        expect(said[1]).toContain(linkedB);
      } finally {
        process.env.VIBECTX_CACHE_DIR = dir;
        rmSync(parent, { recursive: true, force: true });
        rmSync(targetA, { recursive: true, force: true });
        rmSync(targetB, { recursive: true, force: true });
      }
    });

    it("resetCacheRootState() clears the per-root dedupe, for test isolation", () => {
      const target = mkdtempSync(join(tmpdir(), "vibectx-target-"));
      const parent = mkdtempSync(join(tmpdir(), "vibectx-linkroot-"));
      try {
        const linked = join(parent, "root");
        symlinkSync(target, linked);
        process.env.VIBECTX_CACHE_DIR = linked;
        const said: string[] = [];
        const warn = (m: string) => said.push(m);

        writeCache("react", URL_, "# a", undefined, undefined, warn);
        resetCacheRootState();
        writeCache("react", URL_, "# b", undefined, undefined, warn);

        expect(said).toHaveLength(2);
      } finally {
        resetCacheRootState();
        process.env.VIBECTX_CACHE_DIR = dir;
        rmSync(parent, { recursive: true, force: true });
        rmSync(target, { recursive: true, force: true });
      }
    });

    /**
     * code-reviewer, S2 — swapping `existsAsNonDirectory(root)` for `isSymlinkAt(root)` at the
     * ROOT check left every other test in this suite green, because nothing else ever set
     * `VIBECTX_CACHE_DIR` to a plain (non-symlink) file. Pins the CURRENT, deliberately broader
     * behaviour directly: ANY non-directory at the root is refused the same way a symlink is —
     * see the comment on `writeCache`'s own root check for why this is allowed to differ from
     * the library-directory check, which still throws for a plain file at that narrower
     * position (unchanged, pre-existing behaviour pinned by the "library dir is a file" case).
     */
    it("a plain file (not a symlink) at the root position is refused the same way, not thrown", () => {
      const parent = mkdtempSync(join(tmpdir(), "vibectx-fileroot-"));
      try {
        const asFile = join(parent, "root");
        writeFileSync(asFile, "not a cache", "utf8");
        process.env.VIBECTX_CACHE_DIR = asFile;
        const said: string[] = [];

        let fetchedAt: string | undefined;
        expect(() => {
          fetchedAt = writeCache("react", URL_, "# should never be written", undefined, undefined, (m) => said.push(m));
        }).not.toThrow();

        expect(fetchedAt).toBeDefined();
        expect(readFileSync(asFile, "utf8")).toBe("not a cache"); // untouched
        expect(said).toHaveLength(1);
        expect(said[0]).toContain("not a real directory");
      } finally {
        process.env.VIBECTX_CACHE_DIR = dir;
        rmSync(parent, { recursive: true, force: true });
      }
    });
  });

  describe("dangling symlink as the content file", () => {
    it("readCache refuses cleanly, no throw", () => {
      writeCache("react", URL_, "# React");
      const contentPath = join(dir, libDirName("react"), `${urlSlug(URL_)}.md`);
      rmSync(contentPath, { force: true });
      symlinkSync(join(dir, "does-not-exist-anywhere"), contentPath);

      let hit: ReturnType<typeof readCache>;
      expect(() => {
        hit = readCache("react", URL_, 168);
      }).not.toThrow();
      expect(hit).toBeUndefined();
    });
  });

  describe("symlink-to-directory where the content file is expected", () => {
    it("readCache refuses when the .md path is a symlink pointing at a directory, not a file", () => {
      writeCache("react", URL_, "# React");
      const contentPath = join(dir, libDirName("react"), `${urlSlug(URL_)}.md`);
      const outsideDir = mkdtempSync(join(tmpdir(), "vibectx-outside-dir-"));
      try {
        rmSync(contentPath, { force: true });
        symlinkSync(outsideDir, contentPath);

        expect(readCache("react", URL_, 168)).toBeUndefined();
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });
  });

  describe("size ceiling on read (F-10) (mutation target: readBoundedRegularFile's isFile()/size check)", () => {
    it("a content file at exactly MAX_CACHED_CONTENT_BYTES still reads normally", () => {
      writeCache("react", URL_, "x".repeat(MAX_CACHED_CONTENT_BYTES));

      const hit = readCache("react", URL_, 168);
      expect(hit?.content.length).toBe(MAX_CACHED_CONTENT_BYTES);
    });

    it("a content file one byte over MAX_CACHED_CONTENT_BYTES is refused, not truncated — see test/cache-content-size.test.ts for the proof it is never even read", () => {
      writeCache("react", URL_, "# React");
      const contentPath = join(dir, libDirName("react"), `${urlSlug(URL_)}.md`);
      writeFileSync(contentPath, "x".repeat(MAX_CACHED_CONTENT_BYTES + 1), "utf8");

      expect(readCache("react", URL_, 168)).toBeUndefined();
    });
  });

  describe("a cache root that does not exist yet behaves exactly as before (no regression)", () => {
    it("readCache is a miss and writeCache creates a fresh, real directory", () => {
      const freshParent = mkdtempSync(join(tmpdir(), "vibectx-fresh-"));
      const freshRoot = join(freshParent, "not-created-yet");
      process.env.VIBECTX_CACHE_DIR = freshRoot;
      try {
        expect(readCache("react", URL_, 168)).toBeUndefined();
        writeCache("react", URL_, "# React");
        expect(readCache("react", URL_, 168)?.content).toBe("# React");
        expect(lstatSync(freshRoot).isDirectory()).toBe(true);
      } finally {
        process.env.VIBECTX_CACHE_DIR = dir;
        rmSync(freshParent, { recursive: true, force: true });
      }
    });
  });
});


describe("PAR-1045: sibling-covered descriptor controls also have direct cache assertions", () => {
  it("PAR-1045: no-follow open refuses a swapped symlink before reading", async () => {
    if (process.platform === "win32") return;
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const path = join(dir, "content.md"); const outside = join(dir, "target.md"); writeFileSync(path, "original"); writeFileSync(outside, "target");
    expect(readBoundedRegularFile(path, 100)).toBe("original");
    const open = vi.mocked(instrumentedFs.openSync); let flagsSeen = 0;
    open.mockImplementationOnce(((file, flags) => { flagsSeen = Number(flags); rmSync(path); symlinkSync(outside, path); return actual.openSync(file, flags); }) as typeof instrumentedFs.openSync);
    expect(readBoundedRegularFile(path, 100)).toBeUndefined(); expect(flagsSeen & actual.constants.O_NOFOLLOW).not.toBe(0);
  });
  it("PAR-1045: descriptor identity rejects a different regular file", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs"); const path = join(dir, "first.md"); const other = join(dir, "other.md"); writeFileSync(path, "first"); writeFileSync(other, "other");
    expect(readBoundedRegularFile(path, 100)).toBe("first"); vi.mocked(instrumentedFs.openSync).mockImplementationOnce(((_file, flags) => actual.openSync(other, flags)) as typeof instrumentedFs.openSync);
    expect(readBoundedRegularFile(path, 100)).toBeUndefined();
  });
  it("PAR-1045: descriptor regular-file guard runs after a valid lstat", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs"); const path = join(dir, "content.md"); writeFileSync(path, "body"); expect(readBoundedRegularFile(path, 100)).toBe("body");
    vi.mocked(instrumentedFs.fstatSync).mockImplementationOnce(((fd) => { const stat = actual.fstatSync(fd); stat.isFile = () => false; return stat; }) as typeof instrumentedFs.fstatSync);
    expect(readBoundedRegularFile(path, 100)).toBeUndefined();
  });
  it("PAR-1045: descriptor byte ceiling refuses growth after a valid lstat", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs"); const path = join(dir, "content.md"); writeFileSync(path, "1234567890"); expect(readBoundedRegularFile(path, 20)).toBe("1234567890");
    vi.mocked(instrumentedFs.openSync).mockImplementationOnce(((file, flags) => { writeFileSync(path, "x".repeat(21)); return actual.openSync(file, flags); }) as typeof instrumentedFs.openSync);
    expect(readBoundedRegularFile(path, 20)).toBeUndefined();
  });
});
