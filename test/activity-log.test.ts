import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, readdirSync, statSync, symlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordActivity,
  readActivityEntries,
  readActivityLog,
  toActivityEntry,
  formatActivityLogTable,
  activityLogPath,
  shouldLog,
  ACTIVITY_LOG_SCHEMA_VERSION,
  ACTIVITY_LOG_OFF_ENV,
  ACTIVITY_TOOLS,
  ACTIVITY_OUTCOMES,
  type ActivityEntry,
} from "../src/activity-log.js";
import { ACTIVITY_LOG_MAX_ENTRIES, MAX_ACTIVITY_FILE_BYTES } from "../src/limits.js";
import { writeAtomic } from "../src/atomic-store.js";

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "vibectx-activity-log-")));
  process.env.VIBECTX_CACHE_DIR = dir;
});

afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  delete process.env[ACTIVITY_LOG_OFF_ENV];
  rmSync(dir, { recursive: true, force: true });
});

const base: Omit<ActivityEntry, "timestamp"> = {
  tool: "get_docs",
  library: "react",
  query: "useEffect cleanup",
  url: "https://react.dev/llms-full.txt",
  contentHash: "0123456789abcdef",
  fresh: true,
  outcome: "matched",
};

describe("PAR-794: README's `vibectx log` example table matches formatActivityLogTable's real output", () => {
  it("regenerates byte-for-byte from the same four entries README documents", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const entries: ActivityEntry[] = [
      { tool: "get_docs", library: "next.js", query: "app router layout", outcome: "matched", timestamp: "2026-09-17T18:00:00Z" },
      { tool: "search", query: "server actions streaming", outcome: "matched", timestamp: "2026-09-17T18:00:03Z" },
      { tool: "resolve_library", library: "elysia", outcome: "matched", timestamp: "2026-09-17T18:00:07Z" },
      { tool: "refresh", library: "hono", outcome: "not-cached", timestamp: "2026-09-17T18:00:11Z" },
    ];
    const rendered = formatActivityLogTable(entries);
    expect(
      readme.includes("```\n" + rendered + "\n```"),
      "README's 'Activity log' example table must be formatActivityLogTable's real, current output for these four entries — regenerate it rather than hand-editing column widths",
    ).toBe(true);
  });
});

describe("shouldLog (D-51: off switch, mirrors shouldAutowarm exactly)", () => {
  it("on by default; off only for an explicit truthy value; '0'/'false'/'' stay on", () => {
    expect(shouldLog({})).toBe(true);
    expect(shouldLog({ VIBECTX_NO_LOG: "1" })).toBe(false);
    expect(shouldLog({ VIBECTX_NO_LOG: "true" })).toBe(false);
    expect(shouldLog({ VIBECTX_NO_LOG: "yes" })).toBe(false);
    expect(shouldLog({ VIBECTX_NO_LOG: "0" })).toBe(true);
    expect(shouldLog({ VIBECTX_NO_LOG: "false" })).toBe(true);
    expect(shouldLog({ VIBECTX_NO_LOG: "" })).toBe(true);
  });
});

describe("activity log (<cacheRoot>/activity.json)", () => {
  it("lives under the cache root and reads as empty when absent", () => {
    expect(activityLogPath()).toBe(join(dir, "activity.json"));
    expect(readActivityEntries()).toEqual([]);
  });

  it("B-24: migrates a legacy JSON log and appends one self-contained record per later entry", () => {
    const legacy = { ...base, library: "legacy", timestamp: "2026-09-17T18:00:00.000Z" };
    writeFileSync(activityLogPath(), JSON.stringify({ schemaVersion: 1, entries: [legacy] }), "utf8");

    recordActivity({ ...base, library: "new" }, { now: () => new Date("2026-09-17T18:00:01.000Z") });
    recordActivity({ ...base, library: "later" }, { now: () => new Date("2026-09-17T18:00:02.000Z") });

    const lines = readFileSync(activityLogPath(), "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => JSON.parse(line).library)).toEqual(["legacy", "new", "later"]);
    expect(readActivityEntries().map((entry) => entry.library)).toEqual(["legacy", "new", "later"]);
  });

  /**
   * PAR-805 (mutation target: readActivityEntries's isRegularFile guard) — before this,
   * `readActivityEntries` called a bare `readFileSync(activityLogPath(), "utf8")` with no
   * `lstat` guard at all, so a symlink planted at `activity.json`'s own path was followed and
   * its target's bytes parsed as if they were the log. `isRegularFile` (`atomic-store.ts`)
   * refuses it the same way a missing or corrupt file already reads: as `[]`, never a throw.
   */
  it("PAR-805: readActivityEntries refuses a symlink planted at activity.json's own path — reads back empty, not through the link", () => {
    recordActivity(base, { now: () => new Date("2026-09-17T18:00:00.000Z") });
    expect(readActivityEntries()).toHaveLength(1); // the real file round-trips first
    const sibling = join(dir, "sibling.json");
    writeFileSync(sibling, JSON.stringify({ schemaVersion: ACTIVITY_LOG_SCHEMA_VERSION, entries: [{ ...base, timestamp: "2020-01-01T00:00:00.000Z" }] }), "utf8");
    rmSync(activityLogPath(), { force: true });
    symlinkSync(sibling, activityLogPath());

    let entries: ReturnType<typeof readActivityEntries>;
    expect(() => {
      entries = readActivityEntries();
    }).not.toThrow();
    expect(entries!).toEqual([]);
  });

  /**
   * Round-3 review finding (BLOCKING, security) — the leaf-only guard above never sees a
   * symlinked cache ROOT: `lstat` on the full joined path resolves an intermediate symlinked
   * component for ordinary traversal and finds a real regular file at the far end, the same gap
   * `resolved-store.ts`/`project-store.ts`/`doctor-store.ts`/`search-index.ts` each closed with
   * their own `isRealDirectory(cacheRoot())` guard — `activity-log.ts` never had the equivalent.
   */
  it("readActivityEntries refuses even when only the cache ROOT is a symlink, whose target genuinely holds a valid activity.json", () => {
    const target = mkdtempSync(join(tmpdir(), "vibectx-activity-root-symlink-target-"));
    const parent = mkdtempSync(join(tmpdir(), "vibectx-activity-root-symlink-parent-"));
    const linked = join(parent, "root");
    writeFileSync(join(target, "activity.json"), JSON.stringify({ schemaVersion: ACTIVITY_LOG_SCHEMA_VERSION, entries: [{ ...base, timestamp: "2020-01-01T00:00:00.000Z" }] }), "utf8");
    symlinkSync(target, linked);
    process.env.VIBECTX_CACHE_DIR = linked;
    try {
      let entries: ReturnType<typeof readActivityEntries>;
      expect(() => {
        entries = readActivityEntries();
      }).not.toThrow();
      expect(entries!).toEqual([]);
    } finally {
      process.env.VIBECTX_CACHE_DIR = dir;
      rmSync(target, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });

  /**
   * PAR-790 (mutation target: readActivityEntries's size bound) — before this, `readActivityEntries`
   * was the one cache-directory reader with no size check at all: a bare `readFileSync` +
   * `JSON.parse`, unlike `readMetaFile`/`readIndex`/`readConfigFile`'s own `lstatSync`-then-size
   * pattern. A file over `MAX_ACTIVITY_FILE_BYTES` is refused (read as empty) before it is ever
   * read or parsed — proven here by a file whose declared size the assertion checks first (so a
   * change to the bound's VALUE, not just its existence, would be caught too), then confirming
   * the oversized file reads as `[]`, and a file just at the boundary still round-trips.
   */
  it("PAR-790: refuses a file over MAX_ACTIVITY_FILE_BYTES, checked with lstat BEFORE any parse — a file at the boundary still reads", () => {
    // VALID JSON, deliberately oversized (not merely too big to parse, which would read as []
    // for an unrelated reason and prove nothing about the size check specifically): without the
    // size check this parses fine and `toActivityEntry` clips `query` down to MAX_QUERY_CHARS,
    // returning one entry — the size check must refuse it before that ever happens.
    const oversizedQuery = "A".repeat(MAX_ACTIVITY_FILE_BYTES + 1);
    const planted = { schemaVersion: ACTIVITY_LOG_SCHEMA_VERSION, entries: [{ ...base, query: oversizedQuery, timestamp: "2026-01-01T00:00:00.000Z" }] };
    writeFileSync(activityLogPath(), JSON.stringify(planted), "utf8");
    expect(statSync(activityLogPath()).size).toBeGreaterThan(MAX_ACTIVITY_FILE_BYTES);
    expect(readActivityEntries()).toEqual([]);

    // A real, validly-shaped file whose total size is comfortably under the cap still works —
    // this is a size ceiling on a hostile/corrupt file, not a second entry-count cap in disguise.
    recordActivity(base, { now: () => new Date("2026-09-17T18:00:00.000Z") });
    expect(statSync(activityLogPath()).size).toBeLessThan(MAX_ACTIVITY_FILE_BYTES);
    expect(readActivityEntries()).toHaveLength(1);
  });

  it("round-trips an entry, creating the cache root, in the documented key order, and leaves no temp file behind", () => {
    recordActivity(base, { now: () => new Date("2026-09-17T18:00:00.000Z") });
    expect(readdirSync(dir)).toEqual(["activity.json"]);
    const raw = JSON.parse(readFileSync(join(dir, "activity.json"), "utf8").trim());
    expect(raw.schemaVersion).toBe(ACTIVITY_LOG_SCHEMA_VERSION);
    // PAR-813/PAR-807 (Phase 4) — `finalUrl` and `urlHadQuery` are new keys APPENDED after
    // `url` (K1, amended): `base` here has neither a redirect nor a query string, so both are
    // correctly absent from this particular entry — see the dedicated PAR-813/PAR-807 tests
    // below for the case where they are present.
    expect(Object.keys(raw)).toEqual(["schemaVersion", "tool", "library", "query", "url", "contentHash", "fresh", "outcome", "timestamp"]);
    expect(readActivityEntries()).toEqual([{ ...base, timestamp: "2026-09-17T18:00:00.000Z" }]);
  });

  /**
   * PAR-798 — the existing key-order test just above only exercises the WRITE path (it reads
   * the raw bytes off disk with `JSON.parse`), and only with several optional fields UNSET. A
   * prior bug (now fixed) had the read path and the write path produce a DIFFERENT key order for
   * the same logical entry; this test pins the READ path specifically (`readActivityEntries`,
   * not a raw `JSON.parse` of the file), with EVERY optional field `ActivityEntry` has actually
   * set, so there is no unexercised field left for the two paths to still disagree about.
   *
   * `toActivityEntry` is documented as the ONE place an `ActivityEntry` is ever built — on a
   * fresh write AND on a read-back — so today this cannot actually diverge; this test is the
   * regression guard that keeps it that way, independent of that comment being true.
   */
  it("PAR-798: readActivityEntries produces the exact, fully-specified key order with every optional field set", () => {
    const full: Omit<ActivityEntry, "timestamp"> = {
      tool: "get_docs",
      library: "react",
      query: "useEffect cleanup",
      url: "https://react.dev/llms-full.txt?token=secret#frag",
      finalUrl: "https://react.dev/reference/llms-full.txt",
      urlHadQuery: true,
      contentHash: "0123456789abcdef",
      version: "18.3.1",
      fresh: true,
      thin: true,
      refusedReason: "curated",
      libraries: ["react", "hono"],
      outcome: "matched",
    };
    recordActivity(full, { now: () => new Date("2026-09-17T18:00:00.000Z") });
    const entries = readActivityEntries();
    expect(entries).toHaveLength(1);
    // The exact, fully-specified key order — read via readActivityEntries, not a raw JSON.parse
    // of the file, so this pins the READ path specifically, independent of the write path.
    expect(Object.keys(entries[0])).toEqual([
      "tool",
      "library",
      "query",
      "url",
      "finalUrl",
      "urlHadQuery",
      "contentHash",
      "version",
      "fresh",
      "thin",
      "refusedReason",
      "libraries",
      "outcome",
      "timestamp",
    ]);
  });

  it("PAR-791: activity.json is written owner-only (0600), and the cache root it creates is 0700", () => {
    recordActivity(base);
    expect(statSync(join(dir, "activity.json")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("PAR-791: the 0700 mode is really applied by recordActivity's own mkdirSync, not merely true of a temp directory that already happened to be 0700", () => {
    // `dir` (this file's beforeEach fixture) is an mkdtempSync directory, already 0700 by
    // Node's own default — asserting against it alone cannot tell "recordActivity passed
    // mode: 0o700" apart from "the directory was 0700 anyway". A nested directory ONLY
    // recordActivity's mkdirSync can create proves the option is live, not merely believed.
    const nested = join(dir, "nested-root");
    process.env.VIBECTX_CACHE_DIR = nested;
    try {
      expect(existsSync(nested)).toBe(false);
      recordActivity(base);
      expect(statSync(nested).mode & 0o777).toBe(0o700);
    } finally {
      process.env.VIBECTX_CACHE_DIR = dir;
    }
  });

  it("PAR-791: a file left world-readable by an older version is corrected to 0600 on its next append", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "activity.json"), JSON.stringify({ schemaVersion: ACTIVITY_LOG_SCHEMA_VERSION, ...base, timestamp: "2026-09-17T18:00:00.000Z" }) + "\n", "utf8");
    chmodSync(join(dir, "activity.json"), 0o644);
    expect(statSync(join(dir, "activity.json")).mode & 0o777).toBe(0o644);
    recordActivity(base);
    expect(statSync(join(dir, "activity.json")).mode & 0o777).toBe(0o600);
  });

  it("writeAtomic (atomic-store.ts): an explicit mode is applied to the file; omitting it now defaults to 0600 (PAR-862 — supersedes this test's own PAR-791-era version, which pinned that omitting `mode` kept whatever the platform default was; every actual caller in this codebase already passes 0o600 explicitly, so this default only protects a FUTURE caller that forgets to)", () => {
    const withMode = join(dir, "with-mode.json");
    writeAtomic(withMode, "{}", { mode: 0o600 });
    expect(statSync(withMode).mode & 0o777).toBe(0o600);
    const withoutMode = join(dir, "without-mode.json");
    writeAtomic(withoutMode, "{}");
    expect(statSync(withoutMode).mode & 0o777).toBe(0o600);
  });

  it("appends in call order (oldest first)", () => {
    recordActivity({ ...base, library: "one" }, { now: () => new Date("2026-09-17T18:00:00.000Z") });
    recordActivity({ ...base, library: "two" }, { now: () => new Date("2026-09-17T18:00:01.000Z") });
    recordActivity({ ...base, library: "three" }, { now: () => new Date("2026-09-17T18:00:02.000Z") });
    expect(readActivityEntries().map((e) => e.library)).toEqual(["one", "two", "three"]);
  });

  it("`vibectx log`'s VIBECTX_NO_LOG=1 costs nothing — the directory is never even created", () => {
    process.env[ACTIVITY_LOG_OFF_ENV] = "1";
    recordActivity(base);
    expect(existsSync(dir)).toBe(true); // the temp dir itself exists (mkdtempSync made it)
    expect(existsSync(join(dir, "activity.json"))).toBe(false);
  });

  it("ignores a corrupt file on read and overwrites it on the next write", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "activity.json"), "{ not json", "utf8");
    expect(readActivityEntries()).toEqual([]);
    recordActivity(base);
    expect(readActivityEntries()).toHaveLength(1);
  });

  it("ignores a file of the wrong shape", () => {
    writeFileSync(join(dir, "activity.json"), JSON.stringify([base]), "utf8");
    expect(readActivityEntries()).toEqual([]);
  });

  it("K2: a file of a NEWER schemaVersion is never read from and never overwritten; a note is warned", () => {
    const future = JSON.stringify({ schemaVersion: ACTIVITY_LOG_SCHEMA_VERSION + 1, entries: [{ future: true }] });
    writeFileSync(join(dir, "activity.json"), future, "utf8");
    expect(readActivityEntries()).toEqual([]);
    const notes: string[] = [];
    recordActivity(base, { warn: (m) => notes.push(m) });
    expect(readFileSync(join(dir, "activity.json"), "utf8")).toBe(future);
    expect(notes.join("")).toMatch(new RegExp(`newer schemaVersion ${ACTIVITY_LOG_SCHEMA_VERSION + 1}`));
  });

  /**
   * Round-3 review finding (BLOCKING): PAR-795's single-read collapse put the size check BEFORE
   * the schema-version probe — `readActivityFile` returns `schemaVersionOnDisk: undefined`
   * whenever the file is over `MAX_ACTIVITY_FILE_BYTES`, so `recordActivity`'s newer-version
   * guard can never fire for an oversized file: it silently overwrites an oversized, NEWER
   * schemaVersion file with a fresh v1 log instead of refusing and warning the way K2 (above)
   * proves it does for an undersized one.
   */
  it("K2 (oversized variant): an OVERSIZED file of a NEWER schemaVersion is refused and warned, not silently overwritten", () => {
    const oversizedQuery = "A".repeat(MAX_ACTIVITY_FILE_BYTES + 1);
    const future = JSON.stringify({
      schemaVersion: ACTIVITY_LOG_SCHEMA_VERSION + 1,
      entries: [{ ...base, query: oversizedQuery, timestamp: "2020-01-01T00:00:00.000Z" }],
    });
    writeFileSync(join(dir, "activity.json"), future, "utf8");
    expect(statSync(join(dir, "activity.json")).size).toBeGreaterThan(MAX_ACTIVITY_FILE_BYTES);
    const notes: string[] = [];
    recordActivity(base, { warn: (m) => notes.push(m) });
    // Refused: the file on disk is untouched (still the oversized, future-schema original), and
    // a note is warned — the same outcome K2 already proves for an undersized future file.
    expect(readFileSync(join(dir, "activity.json"), "utf8")).toBe(future);
    expect(notes.join("")).toMatch(new RegExp(`newer schemaVersion ${ACTIVITY_LOG_SCHEMA_VERSION + 1}`));
  });

  it("D-13: never throws, even when the cache directory is unwritable — the retrieval that triggered it is unaffected", () => {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o500);
    try {
      const notes: string[] = [];
      expect(() => recordActivity(base, { warn: (m) => notes.push(m) })).not.toThrow();
      expect(notes.join("")).toMatch(/activity not logged/);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  /**
   * PAR-794 (mirrors `debug.ts`'s own `debugEvent` fix, `test/debug.test.ts`'s "a diagnostic
   * can never change what a caller sees"): `recordActivity`'s outer `catch` block calls `warn`
   * to report the failure — but `warn` itself is caller-suppliable (production's own default is
   * `process.stderr.write`, which throws on a closed/full pipe, e.g. a piped MCP client that
   * went away). Before this fix, that second `warn` call was NOT itself guarded, so a `warn`
   * that throws escaped `recordActivity` entirely — violating this very function's own "NEVER
   * THROWS (D-13)" doc-comment promise, the same class of bug `debugEvent` was fixed for.
   */
  it("PAR-794: never throws even when the failure-reporting `warn` callback itself throws", () => {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o500);
    try {
      expect(() =>
        recordActivity(base, {
          warn: () => {
            throw new Error("EPIPE: broken pipe");
          },
        }),
      ).not.toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  describe("D-51/K3: closed vocabularies and per-field validation on read (mirroring project-store.ts's toWarmRow)", () => {
    it("an unknown tool or outcome drops the ROW", () => {
      expect(toActivityEntry({ ...base, timestamp: "2026-09-17T18:00:00.000Z", tool: "delete_everything" })).toBeUndefined();
      expect(toActivityEntry({ ...base, timestamp: "2026-09-17T18:00:00.000Z", outcome: "definitely-matched" })).toBeUndefined();
    });

    it("every declared tool and outcome is individually accepted", () => {
      for (const tool of ACTIVITY_TOOLS) {
        expect(toActivityEntry({ tool, outcome: "matched", timestamp: "2026-09-17T18:00:00.000Z" })?.tool).toBe(tool);
      }
      for (const outcome of ACTIVITY_OUTCOMES) {
        expect(toActivityEntry({ tool: "search", outcome, timestamp: "2026-09-17T18:00:00.000Z" })?.outcome).toBe(outcome);
      }
    });

    it("a missing or malformed timestamp drops the ROW; a strict ISO instant is required", () => {
      for (const timestamp of [undefined, "", "not a date", "2026-09-17", "2026-09-17T18:00:00", "2026-09-17 (‮evil)"]) {
        expect(toActivityEntry({ tool: "get_docs", outcome: "matched", timestamp }), String(timestamp)).toBeUndefined();
      }
      expect(toActivityEntry({ tool: "get_docs", outcome: "matched", timestamp: "2026-09-17T18:00:00.123Z" })).toBeDefined();
    });

    it("security-architect B1: an unbounded fractional-seconds timestamp is REJECTED, not merely validated by Date.parse — the one field nothing else here length-bounds", () => {
      // Date.parse alone is not a length backstop (MEASURED, cache-meta.ts's own comment):
      // Date.parse("2020-01-01T00:00:00." + "1".repeat(10_000) + "Z") returns a finite
      // timestamp. ISO_INSTANT's shape check must reject the length before Date.parse ever
      // runs, matching cache-meta.ts's bounded (\.\d{1,9})? — not project-store.ts's or
      // search-index.ts's still-unbounded copies, which this file must not become a third of.
      const hostile = `2026-09-17T18:00:00.${"1".repeat(10_000)}Z`;
      expect(Number.isFinite(Date.parse(hostile))).toBe(true); // the trap: Date.parse alone accepts it
      expect(toActivityEntry({ tool: "get_docs", outcome: "matched", timestamp: hostile })).toBeUndefined();
      // Nanosecond precision (9 digits) still passes; a 10th digit is already past anything
      // real `toISOString` produces and is refused.
      expect(toActivityEntry({ tool: "get_docs", outcome: "matched", timestamp: "2026-09-17T18:00:00.123456789Z" })).toBeDefined();
      expect(toActivityEntry({ tool: "get_docs", outcome: "matched", timestamp: "2026-09-17T18:00:00.1234567890Z" })).toBeUndefined();
    });

    it("PAR-794: a field that is EMPTY AFTER CLEANING (e.g. entirely control/bidi characters) falls back to absent, not an empty string", () => {
      // A raw string of only zero-width/control characters has non-zero RAW length, so the old
      // `cleanField` (which checked `value.length === 0` on the raw string, before cleaning)
      // let it through to `clipText`, which strips everything and returns "" — an empty string
      // stored and rendered as a field's value, rather than the field being correctly treated
      // as absent, the same way an entirely-empty input already is.
      const hostileButNonEmpty = "​​​"; // three zero-width spaces: length 3, cleans to ""
      const e = toActivityEntry({
        tool: "get_docs",
        outcome: "matched",
        timestamp: "2026-09-17T18:00:00.000Z",
        library: hostileButNonEmpty,
        query: hostileButNonEmpty,
        version: hostileButNonEmpty,
      });
      expect(e).toBeDefined();
      expect(e!.library).toBeUndefined();
      expect(e!.query).toBeUndefined();
      expect(e!.version).toBeUndefined();
    });

    it("an oversized library/query/url/version is CLIPPED, not dropped; the row survives", () => {
      const e = toActivityEntry({
        tool: "search",
        outcome: "matched",
        timestamp: "2026-09-17T18:00:00.000Z",
        library: "l".repeat(500),
        query: "q".repeat(500),
        url: `https://example.com/${"u".repeat(500)}`,
        version: "v".repeat(500),
      });
      expect(e).toBeDefined();
      expect(e!.library!.length).toBeLessThanOrEqual(214);
      expect(e!.query!.length).toBeLessThanOrEqual(200);
      expect(e!.url!.length).toBeLessThanOrEqual(300);
      expect(e!.version!.length).toBeLessThanOrEqual(100);
    });

    it("a non-https or malformed url drops only that FIELD", () => {
      for (const url of ["http://insecure.example.com/x", "not a url at all", "https://u:p@example.com/x", "ftp://example.com/x", ""]) {
        expect(toActivityEntry({ tool: "get_docs", outcome: "matched", timestamp: "2026-09-17T18:00:00.000Z", url })?.url, url).toBeUndefined();
      }
    });

    it("PAR-792: an internal/forbidden-host url is KEPT — validated by shape only, not the fetch-time host allow-list, so an allowInternalHosts entry's consultation is still evidenced", () => {
      const e = toActivityEntry({
        tool: "get_docs",
        outcome: "matched",
        timestamp: "2026-09-17T18:00:00.000Z",
        url: "https://169.254.169.254/x",
      });
      expect(e?.url).toBe("https://169.254.169.254/x");
      const e2 = toActivityEntry({
        tool: "get_docs",
        outcome: "matched",
        timestamp: "2026-09-17T18:00:00.000Z",
        url: "https://docs.internal/llms.txt",
      });
      expect(e2?.url).toBe("https://docs.internal/llms.txt");
    });

    it("PAR-792: the url's query string is stripped (may carry a token/secret); the fragment is stripped too", () => {
      const e = toActivityEntry({
        tool: "get_docs",
        outcome: "matched",
        timestamp: "2026-09-17T18:00:00.000Z",
        url: "https://example.com/docs/llms.txt?token=super-secret&x=1#section",
      });
      expect(e?.url).toBe("https://example.com/docs/llms.txt");
      expect(e?.url).not.toContain("token");
      expect(e?.url).not.toContain("super-secret");
    });

    /** PAR-813 (Phase 4) — `finalUrl` (PAR-776's redirect provenance) reaches the activity log,
     *  redacted and bounded exactly like `url`. */
    it("PAR-813: finalUrl is redacted the same way url is, and is absent when not given", () => {
      const withRedirect = toActivityEntry({
        tool: "get_docs",
        outcome: "matched",
        timestamp: "2026-09-17T18:00:00.000Z",
        url: "https://example.com/old?token=super-secret",
        finalUrl: "https://example.com/new?token=also-secret",
      });
      expect(withRedirect?.finalUrl).toBe("https://example.com/new");
      expect(withRedirect?.finalUrl).not.toContain("also-secret");
      const withoutRedirect = toActivityEntry({
        tool: "get_docs",
        outcome: "matched",
        timestamp: "2026-09-17T18:00:00.000Z",
        url: "https://example.com/x",
      });
      expect(withoutRedirect?.finalUrl).toBeUndefined();
    });

    /** PAR-807 (Phase 4) — two documents differing only by query string must not render as
     *  identical activity-log entries with no marker that anything was elided. */
    describe("PAR-807: urlHadQuery marks a query/fragment that was stripped from url", () => {
      it("is true when the raw url carried a query string or a fragment", () => {
        const withQuery = toActivityEntry({ tool: "get_docs", outcome: "matched", timestamp: "2026-09-17T18:00:00.000Z", url: "https://example.com/x?v=2" });
        expect(withQuery?.urlHadQuery).toBe(true);
        const withFragment = toActivityEntry({ tool: "get_docs", outcome: "matched", timestamp: "2026-09-17T18:00:00.000Z", url: "https://example.com/x#section" });
        expect(withFragment?.urlHadQuery).toBe(true);
      });

      it("is absent (not false) when the raw url carried neither", () => {
        const plain = toActivityEntry({ tool: "get_docs", outcome: "matched", timestamp: "2026-09-17T18:00:00.000Z", url: "https://example.com/x" });
        expect(plain?.urlHadQuery).toBeUndefined();
      });

      it("is absent when url itself is absent", () => {
        const noUrl = toActivityEntry({ tool: "resolve_library", outcome: "unresolved", timestamp: "2026-09-17T18:00:00.000Z" });
        expect(noUrl?.urlHadQuery).toBeUndefined();
      });

      /** The bug this test guards against: `toActivityEntry` is called BOTH to build a fresh
       *  entry (where `url` is still raw) AND to re-validate an entry already read back off
       *  disk (where `url` in the parsed JSON is already redacted) — recomputing `hadQuery`
       *  from the STORED (already query-less) `url` on that second call would always read
       *  false, silently losing the very fact this field exists to preserve. */
      it("survives a round trip: re-validating an already-persisted entry (via recordActivity + readActivityEntries) keeps urlHadQuery true", () => {
        recordActivity(
          { tool: "get_docs", library: "acme", url: "https://example.com/llms.txt?token=super-secret", outcome: "matched" },
          { now: () => new Date("2026-09-17T18:00:00.000Z") },
        );
        const [entry] = readActivityEntries();
        expect(entry.url).toBe("https://example.com/llms.txt");
        expect(entry.urlHadQuery).toBe(true);
      });

      it("two documents differing only by query string are distinguishable in the log by urlHadQuery + contentHash, not identical", () => {
        recordActivity(
          { tool: "get_docs", library: "acme", url: "https://example.com/llms.txt?version=v2", contentHash: "0000000000000002", outcome: "matched" },
          { now: () => new Date("2026-09-17T18:00:00.000Z") },
        );
        recordActivity(
          { tool: "get_docs", library: "acme", url: "https://example.com/llms.txt?version=v3", contentHash: "0000000000000003", outcome: "matched" },
          { now: () => new Date("2026-09-17T18:00:01.000Z") },
        );
        const entries = readActivityEntries();
        expect(entries).toHaveLength(2);
        expect(entries[0].url).toBe(entries[1].url); // the identical-looking string PAR-807 is about
        expect(entries[0].urlHadQuery).toBe(true);
        expect(entries[1].urlHadQuery).toBe(true);
        expect(entries[0].contentHash).not.toBe(entries[1].contentHash); // still distinguishable
      });
    });

    /** PAR-804 — a thin match (real content matched, nothing rendered under budget) must be
     *  visibly distinct from a full "matched" outcome, without a schema-version bump: a new,
     *  purely-additive sibling field, same shape as `urlHadQuery`. */
    describe("PAR-804: thin marks a match that rendered nothing under budget", () => {
      it("is true when explicitly set true", () => {
        const entry = toActivityEntry({ tool: "get_docs", outcome: "matched", timestamp: "2026-09-17T18:00:00.000Z", thin: true });
        expect(entry?.thin).toBe(true);
        expect(entry?.outcome).toBe("matched"); // the outcome vocabulary itself is unchanged
      });

      it("is absent (not false) when unset, and a non-boolean value is dropped", () => {
        const unset = toActivityEntry({ tool: "get_docs", outcome: "matched", timestamp: "2026-09-17T18:00:00.000Z" });
        expect(unset?.thin).toBeUndefined();
        const explicitFalse = toActivityEntry({ tool: "get_docs", outcome: "matched", timestamp: "2026-09-17T18:00:00.000Z", thin: false });
        expect(explicitFalse?.thin).toBeUndefined();
        const bogus = toActivityEntry({ tool: "get_docs", outcome: "matched", timestamp: "2026-09-17T18:00:00.000Z", thin: "yes" });
        expect(bogus?.thin).toBeUndefined();
      });

      it("survives a round trip through recordActivity + readActivityEntries", () => {
        recordActivity(
          { tool: "get_docs", library: "fastify", query: "request hostname", outcome: "matched", thin: true },
          { now: () => new Date("2026-09-17T18:00:00.000Z") },
        );
        const [entry] = readActivityEntries();
        expect(entry.thin).toBe(true);
        expect(entry.outcome).toBe("matched");
      });

      it("renders visibly in formatActivityLogTable as \"matched (thin)\", not indistinguishable from a real match", () => {
        const table = formatActivityLogTable([
          { tool: "get_docs", library: "fastify", outcome: "matched", thin: true, timestamp: "2026-01-01T00:00:00.000Z" },
          { tool: "get_docs", library: "react", outcome: "matched", timestamp: "2026-01-01T00:00:01.000Z" },
        ]);
        expect(table).toContain("matched (thin)");
        const lines = table.split("\n").filter((l) => l.includes("react"));
        expect(lines[0]).not.toContain("(thin)");
      });
    });

    /** PAR-796 (review round 2, code-reviewer S4) — a rate-limited refusal and a
     *  curated-override-declined refusal both log `{outcome: "refused"}` with no other
     *  distinguishing field before this — `refusedReason` is what tells them apart. */
    describe("PAR-796 (round 2): refusedReason distinguishes the two refresh refusals sharing outcome=refused", () => {
      it("accepts exactly the two closed values", () => {
        const rateLimited = toActivityEntry({ tool: "refresh", outcome: "refused", timestamp: "2026-09-17T18:00:00.000Z", refusedReason: "rate-limited" });
        expect(rateLimited?.refusedReason).toBe("rate-limited");
        const curated = toActivityEntry({ tool: "refresh", outcome: "refused", timestamp: "2026-09-17T18:00:00.000Z", refusedReason: "curated" });
        expect(curated?.refusedReason).toBe("curated");
      });

      it("is absent (not a made-up value) when unset or bogus", () => {
        const unset = toActivityEntry({ tool: "refresh", outcome: "refused", timestamp: "2026-09-17T18:00:00.000Z" });
        expect(unset?.refusedReason).toBeUndefined();
        const bogus = toActivityEntry({ tool: "refresh", outcome: "refused", timestamp: "2026-09-17T18:00:00.000Z", refusedReason: "because" });
        expect(bogus?.refusedReason).toBeUndefined();
      });

      it("survives a round trip through recordActivity + readActivityEntries", () => {
        recordActivity({ tool: "refresh", outcome: "refused", refusedReason: "curated" }, { now: () => new Date("2026-09-17T18:00:00.000Z") });
        const [entry] = readActivityEntries();
        expect(entry.refusedReason).toBe("curated");
      });
    });

    /** PAR-797 — a multi-library `search` call's entry used to record only the query and
     *  outcome, unlike every other tool call. */
    describe("PAR-797: libraries names the groups a multi-library search actually returned", () => {
      it("keeps a bounded array of the raw library names, cleaned the same way library is", () => {
        const entry = toActivityEntry({ tool: "search", outcome: "matched", timestamp: "2026-09-17T18:00:00.000Z", libraries: ["react", "hono"] });
        expect(entry?.libraries).toEqual(["react", "hono"]);
      });

      it("is absent (not []) when unset", () => {
        const entry = toActivityEntry({ tool: "search", outcome: "no-match", timestamp: "2026-09-17T18:00:00.000Z" });
        expect(entry?.libraries).toBeUndefined();
      });

      it("truncates rather than drops when a planted file claims more than MAX_LOGGED_LIBRARIES names", () => {
        const many = Array.from({ length: 20 }, (_, i) => `lib-${i}`);
        const entry = toActivityEntry({ tool: "search", outcome: "matched", timestamp: "2026-09-17T18:00:00.000Z", libraries: many });
        expect(entry?.libraries).toHaveLength(8);
        expect(entry?.libraries).toEqual(many.slice(0, 8));
      });

      it("drops non-string elements rather than failing the whole field", () => {
        const entry = toActivityEntry({ tool: "search", outcome: "matched", timestamp: "2026-09-17T18:00:00.000Z", libraries: ["react", 42, null, "hono"] });
        expect(entry?.libraries).toEqual(["react", "hono"]);
      });

      it("a non-array value is dropped entirely, not coerced", () => {
        const entry = toActivityEntry({ tool: "search", outcome: "matched", timestamp: "2026-09-17T18:00:00.000Z", libraries: "react" });
        expect(entry?.libraries).toBeUndefined();
      });

      it("survives a round trip through recordActivity + readActivityEntries", () => {
        recordActivity({ tool: "search", query: "streaming", outcome: "matched", libraries: ["react", "hono"] }, { now: () => new Date("2026-09-17T18:00:00.000Z") });
        const [entry] = readActivityEntries();
        expect(entry.libraries).toEqual(["react", "hono"]);
      });
    });

    it("contentHash must match documentHash's exact 16-hex shape, or is dropped", () => {
      expect(toActivityEntry({ tool: "get_docs", outcome: "matched", timestamp: "2026-09-17T18:00:00.000Z", contentHash: "not-hex-at-all!!" })?.contentHash).toBeUndefined();
      expect(toActivityEntry({ tool: "get_docs", outcome: "matched", timestamp: "2026-09-17T18:00:00.000Z", contentHash: "0123456789ABCDEF" })?.contentHash).toBeUndefined(); // uppercase: documentHash never emits this
      expect(toActivityEntry({ tool: "get_docs", outcome: "matched", timestamp: "2026-09-17T18:00:00.000Z", contentHash: "0123456789abcdef" })?.contentHash).toBe("0123456789abcdef");
    });

    it("a non-boolean fresh is dropped", () => {
      expect(toActivityEntry({ tool: "get_docs", outcome: "matched", timestamp: "2026-09-17T18:00:00.000Z", fresh: "yes" })?.fresh).toBeUndefined();
    });

    it("every surviving string is cleaned of control/bidi characters (S3)", () => {
      const e = toActivityEntry({
        tool: "search",
        outcome: "matched",
        timestamp: "2026-09-17T18:00:00.000Z",
        library: "re​act",
        query: "hooks‮evil",
      });
      expect(e?.library).toBe("react");
      expect(e?.query).toBe("hooksevil");
    });

    it("not a record, or missing required fields, drops the row entirely", () => {
      expect(toActivityEntry(null)).toBeUndefined();
      expect(toActivityEntry("a string")).toBeUndefined();
      expect(toActivityEntry([])).toBeUndefined();
      expect(toActivityEntry({})).toBeUndefined();
    });

    it("skips malformed records and keeps the valid ones, from a hand-written file", () => {
      writeFileSync(
        join(dir, "activity.json"),
        JSON.stringify({
          schemaVersion: 1,
          entries: [
            { tool: "get_docs", outcome: "matched", timestamp: "2026-09-17T18:00:00.000Z", library: "good" },
            null,
            "string",
            { tool: "bogus", outcome: "matched", timestamp: "2026-09-17T18:00:00.000Z" },
            { tool: "get_docs", outcome: "bogus", timestamp: "2026-09-17T18:00:00.000Z" },
            { tool: "get_docs", outcome: "matched" }, // no timestamp
          ],
        }),
        "utf8",
      );
      expect(readActivityEntries().map((e) => e.library)).toEqual(["good"]);
    });
  });

  describe("D-51: bounded — oldest dropped first once the cap is exceeded", () => {
    /** Seeds the file directly (one write, not ACTIVITY_LOG_MAX_ENTRIES real ones) with a
     *  full-length, already-valid entry list, so this test exercises exactly the same
     *  `recordActivity` trim logic a real fill-up would without paying its real cost:
     *  ACTIVITY_LOG_MAX_ENTRIES real read-modify-write cycles is precisely the O(n) per-call
     *  cost this module's own top comment discloses, and paying it 2,000 times over in a
     *  test is minutes, not milliseconds — a property of the design being tested, not a
     *  test bug, so the fix is to seed once rather than to shrink what is being proven. */
    function seedFull(): void {
      const entries = Array.from({ length: ACTIVITY_LOG_MAX_ENTRIES }, (_, i) => ({
        ...base,
        library: `lib-${i}`,
        timestamp: new Date(2026, 0, 1, 0, 0, i).toISOString(),
      }));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "activity.json"), JSON.stringify({ schemaVersion: ACTIVITY_LOG_SCHEMA_VERSION, entries }), "utf8");
    }

    it("a write past the cap drops the single oldest entry and appends the new one", () => {
      seedFull();
      expect(readActivityEntries()).toHaveLength(ACTIVITY_LOG_MAX_ENTRIES);
      recordActivity({ ...base, library: "newest" }, { now: () => new Date(2026, 0, 1, 1, 0, 0) });
      const entries = readActivityEntries();
      expect(entries).toHaveLength(ACTIVITY_LOG_MAX_ENTRIES);
      expect(entries[0].library).toBe("lib-1"); // lib-0, the oldest, is gone
      expect(entries[entries.length - 1].library).toBe("newest");
    });

    /** PAR-790 — this cap used to be enforced ONLY on write: a file already over it (hand-edited,
     *  or from a pre-cap version) was read back IN FULL, then trimmed only once something wrote
     *  to it next. `readActivityEntries` now applies the same "oldest dropped first" rule the
     *  write path already used, so an over-cap file on disk is never handed to a caller whole —
     *  the read-side proof this test now pins; the write-side trim (already covered by the test
     *  above) still holds unchanged afterward. */
    it("a file already OVER the cap (hand-edited, or from an older version with no cap) is trimmed to it on READ, oldest dropped first — and stays trimmed after the next write", () => {
      seedFull();
      const over = JSON.parse(readFileSync(join(dir, "activity.json"), "utf8"));
      over.entries.push({ ...base, library: "extra-1", timestamp: "2026-01-01T00:33:20.000Z" }, { ...base, library: "extra-2", timestamp: "2026-01-01T00:33:21.000Z" });
      writeFileSync(join(dir, "activity.json"), JSON.stringify(over), "utf8");
      const read = readActivityEntries();
      expect(read).toHaveLength(ACTIVITY_LOG_MAX_ENTRIES); // capped on READ, not merely on the next write
      expect(read.map((e) => e.library)).not.toContain("lib-0"); // the two OLDEST are gone
      expect(read.map((e) => e.library)).not.toContain("lib-1");
      expect(read[read.length - 1].library).toBe("extra-2"); // the two NEWEST (just planted) survive
      expect(read[read.length - 2].library).toBe("extra-1");
      recordActivity({ ...base, library: "newest" }, { now: () => new Date(2026, 0, 2, 0, 0, 0) });
      expect(readActivityEntries()).toHaveLength(ACTIVITY_LOG_MAX_ENTRIES);
    });
  });

  describe("D-33's own boundary, reused: no document TEXT is representable at all", () => {
    it("ActivityInput has no field a caller could pour document content into — every string field is bounded and hashed, not held whole", () => {
      // Not a runtime assertion (TypeScript already enforces the shape) — this pins the CONTRACT
      // in a test that fails loudly if a future edit ever adds a `text`/`content`/`body` field.
      const e = toActivityEntry({ ...base, timestamp: "2026-09-17T18:00:00.000Z" })!;
      expect(Object.keys(e).sort()).toEqual(["contentHash", "fresh", "library", "outcome", "query", "timestamp", "tool", "url"].sort());
    });
  });

  describe("readActivityLog / formatActivityLogTable (`vibectx log`'s own data and render)", () => {
    it("readActivityLog wraps the entries in the shared schemaVersion envelope", () => {
      recordActivity(base, { now: () => new Date("2026-09-17T18:00:00.000Z") });
      expect(readActivityLog()).toEqual({ schemaVersion: ACTIVITY_LOG_SCHEMA_VERSION, entries: [{ ...base, timestamp: "2026-09-17T18:00:00.000Z" }] });
    });

    describe("PAR-793: readActivityLog states WHY a read came back empty or partial, mirroring search-index.ts's own readIndex/problem", () => {
      it("no file yet: no problem key — this is the ordinary first-run state, not an anomaly", () => {
        expect(readActivityLog()).toEqual({ schemaVersion: ACTIVITY_LOG_SCHEMA_VERSION, entries: [] });
        expect(readActivityLog()).not.toHaveProperty("problem");
      });

      it("a corrupt (unparsable) file states the parser's position, never the file's own content", () => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "activity.json"), '{ "entries": [ "SUPERSECRET-DO-NOT-LEAK', "utf8");
        const { problem } = readActivityLog();
        expect(problem).toMatch(/^activity log unreadable \(invalid JSON( at position \d+)?\)/);
        expect(problem).not.toContain("SUPERSECRET");
      });

      it("does not mistake a forged 'at position N' inside invalid JSON for the parser position", () => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "activity.json"), "x at position 123", "utf8");
        const { problem } = readActivityLog();
        expect(problem).toMatch(/invalid JSON/);
        expect(problem).not.toContain("position 123");
      });

      it("a file of the wrong shape (a JSON array, not an object) states a problem", () => {
        writeFileSync(join(dir, "activity.json"), JSON.stringify([base]), "utf8");
        expect(readActivityLog().problem).toMatch(/not a valid log file/);
      });

      it("a foreign schemaVersion states which version it is and which this build reads", () => {
        writeFileSync(join(dir, "activity.json"), JSON.stringify({ schemaVersion: ACTIVITY_LOG_SCHEMA_VERSION + 1, entries: [] }), "utf8");
        expect(readActivityLog().problem).toBe(`activity log ignored: schemaVersion ${ACTIVITY_LOG_SCHEMA_VERSION + 1} (this version reads ${ACTIVITY_LOG_SCHEMA_VERSION})`);
      });

      it("an oversized file states its size against the limit", () => {
        const oversized = { schemaVersion: ACTIVITY_LOG_SCHEMA_VERSION, entries: [{ ...base, query: "q".repeat(MAX_ACTIVITY_FILE_BYTES + 1), timestamp: "2026-01-01T00:00:00.000Z" }] };
        writeFileSync(join(dir, "activity.json"), JSON.stringify(oversized), "utf8");
        expect(readActivityLog().problem).toMatch(new RegExp(`over the ${MAX_ACTIVITY_FILE_BYTES}-byte limit`));
      });

      it("a symlink at activity.json's own path states that it was ignored, not followed", () => {
        recordActivity(base, { now: () => new Date("2026-09-17T18:00:00.000Z") });
        const sibling = join(dir, "sibling.json");
        writeFileSync(sibling, JSON.stringify({ schemaVersion: ACTIVITY_LOG_SCHEMA_VERSION, entries: [] }), "utf8");
        rmSync(activityLogPath(), { force: true });
        symlinkSync(sibling, activityLogPath());
        try {
          expect(readActivityLog().problem).toMatch(/not a regular file/);
        } finally {
          rmSync(activityLogPath(), { force: true });
        }
      });

      it("PAR-1030: a planted activity.json symlink is replaced by a fresh log; the file it points at is never chmod'd or appended to", () => {
        const victim = join(dir, "victim.txt");
        writeFileSync(victim, "SYNTH-MARKER-123 not a log\n", "utf8");
        chmodSync(victim, 0o644);
        const before = readFileSync(victim);
        symlinkSync(victim, activityLogPath());
        const warnings: string[] = [];
        const warn = (m: string) => void warnings.push(m);

        recordActivity(base, { warn, now: () => new Date("2026-09-27T18:00:00.000Z") });
        recordActivity(base, { warn, now: () => new Date("2026-09-27T18:00:01.000Z") });

        expect(statSync(victim).mode & 0o777).toBe(0o644);
        expect(readFileSync(victim).equals(before)).toBe(true);
        expect(lstatSync(activityLogPath()).isSymbolicLink()).toBe(false);
        expect(lstatSync(activityLogPath()).isFile()).toBe(true);
        expect(statSync(activityLogPath()).mode & 0o777).toBe(0o600);
        expect(readActivityEntries().map((e) => e.timestamp)).toEqual(["2026-09-27T18:00:00.000Z", "2026-09-27T18:00:01.000Z"]);
        expect(warnings).toEqual([]);
      });

      it("PAR-1030: a directory at activity.json is reported as blocking the log, not as a fresh log on the next write", () => {
        mkdirSync(activityLogPath());
        const warnings: string[] = [];

        recordActivity(base, { warn: (m) => void warnings.push(m), now: () => new Date("2026-09-27T18:00:00.000Z") });

        const problem = readActivityLog().problem ?? "";
        expect(problem).toMatch(/activity\.json is a directory/);
        expect(problem).not.toMatch(/fresh log/);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(/^vibectx: activity not logged: EISDIR/);
        expect(lstatSync(activityLogPath()).isDirectory()).toBe(true);
      });

      it("some entries valid and some invalid: the valid ones survive, and the count dropped is stated (mutation target: the `dropped` counter)", () => {
        const mixed = {
          schemaVersion: ACTIVITY_LOG_SCHEMA_VERSION,
          entries: [
            { ...base, timestamp: "2026-09-17T18:00:00.000Z" },
            { tool: "not-a-real-tool", outcome: "matched", timestamp: "2026-09-17T18:00:01.000Z" }, // dropped: closed vocabulary
          ],
        };
        writeFileSync(join(dir, "activity.json"), JSON.stringify(mixed), "utf8");
        const report = readActivityLog();
        expect(report.entries).toHaveLength(1);
        expect(report.problem).toBe("activity log: 1 invalid entry dropped");
      });
    });

    it("formats a header, one row per entry and a summary count", () => {
      const entries: ActivityEntry[] = [
        { tool: "get_docs", library: "react", query: "hooks", outcome: "matched", timestamp: "2026-09-17T18:00:00.000Z" },
        { tool: "search", outcome: "no-match", timestamp: "2026-09-17T18:00:01.000Z" },
      ];
      const table = formatActivityLogTable(entries);
      expect(table).toContain("timestamp");
      expect(table).toContain("react");
      expect(table).toContain("2 entries");
    });

    it("cleans control/bidi characters at the render boundary even for an entry that bypassed validation", () => {
      const hostile: ActivityEntry = {
        tool: "get_docs",
        library: "re​act",
        outcome: "matched",
        timestamp: "2026-09-17T18:00:00.000Z",
      };
      expect(formatActivityLogTable([hostile])).not.toMatch(/[​‮]/);
    });

    it("security-architect B1: clips an oversized timestamp at the render boundary too, even for an entry that bypassed validation — an unclipped one would widen every OTHER row's cell to match it", () => {
      const hostile: ActivityEntry = {
        tool: "get_docs",
        outcome: "matched",
        timestamp: `2026-01-01T00:00:00.${"1".repeat(50_000)}Z`,
      };
      const table = formatActivityLogTable([hostile, { tool: "search", outcome: "no-match", timestamp: "2026-01-01T00:00:01.000Z" }]);
      expect(table.length).toBeLessThan(1000); // not tens of KB padded to the hostile row's width
    });

    it("an empty log formats to a header and a zero-entry summary", () => {
      expect(formatActivityLogTable([])).toContain("0 entries");
    });

    /** PAR-800 — the timestamp-only clip generalized: `library` (a PADDED column, unlike
     *  `detail`) is bounded exactly the same way `timestamp` already was, not left as a second
     *  special case the function's own doc comment claims does not exist. Mirrors the B1 test
     *  above structurally (a hostile row next to a normal one, asserting the table stays small
     *  and the SECOND row's own cell is not widened to match the first). */
    it("PAR-800: clips an oversized library at the render boundary too — the timestamp-only fix generalized to every padded column", () => {
      const hostile: ActivityEntry = {
        tool: "get_docs",
        library: "a".repeat(50_000),
        outcome: "matched",
        timestamp: "2026-01-01T00:00:00.000Z",
      };
      const table = formatActivityLogTable([hostile, { tool: "search", outcome: "no-match", timestamp: "2026-01-01T00:00:01.000Z" }]);
      expect(table.length).toBeLessThan(1000); // not tens of KB padded to the hostile row's width
    });

    /** PAR-790/PAR-800 — `Math.max(...rows.map(...))` throws `RangeError: Maximum call stack
     *  size exceeded` once the argument list V8 must build is large enough (MEASURED on this
     *  Node build: `Math.max(...new Array(100_000))` is fine, `Math.max(...new Array(131_072))`
     *  throws — the exact threshold is a V8 implementation detail, not something to pin
     *  precisely, so this test uses 150,000 rows for comfortable margin above it). A
     *  loop/reduce has no such ceiling regardless of row count. `detail` (the last column,
     *  never padded) is deliberately excluded from the clip and can stay unique per row without
     *  defeating the point of this test (the crash comes from the SPREAD argument count, not
     *  from long strings). */
    it("PAR-790/PAR-800: formats far more rows than V8's Math.max(...spread) argument ceiling without a RangeError", () => {
      const entries: ActivityEntry[] = Array.from({ length: 150_000 }, (_, i) => ({
        tool: "get_docs",
        library: `lib-${i}`,
        outcome: "matched",
        timestamp: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
      }));
      let table = "";
      expect(() => {
        table = formatActivityLogTable(entries);
      }).not.toThrow();
      expect(table).toContain("150000 entries");
    });
  });
});
