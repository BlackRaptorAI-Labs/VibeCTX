import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, symlinkSync, lstatSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readResolvedEntries,
  saveResolvedEntry,
  resolvedStorePath,
  toResolvedEntry,
  cleanDescription,
  RESOLVED_SCHEMA_VERSION,
} from "../src/resolved-store.js";
import { MAX_URLS_PER_ENTRY, MAX_LLMS_CANDIDATES, MAX_README_CANDIDATES, MAX_VERSIONED_README_CANDIDATES } from "../src/limits.js";
import type { LibraryEntry } from "../src/registry.js";

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "vibectx-resolved-")));
  process.env.VIBECTX_CACHE_DIR = dir;
});

afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const hono: LibraryEntry = {
  name: "hono",
  urls: ["https://hono.dev/llms-full.txt", "https://hono.dev/llms.txt", "https://raw.githubusercontent.com/honojs/hono/main/README.md"],
  description: "Web framework built on Web Standards",
  allowedHosts: ["hono.dev", "docs.hono.dev"],
  resolved: {
    source: "npm",
    resolvedAt: "2026-09-06T05:00:00.000Z",
    metadataUrl: "https://registry.npmjs.org/hono/latest",
    homepage: "https://hono.dev/",
  },
};

const httpx: LibraryEntry = {
  name: "httpx",
  urls: ["https://www.python-httpx.org/llms.txt", "https://raw.githubusercontent.com/encode/httpx/master/README.md"],
  allowedHosts: ["github.com", "www.python-httpx.org", "docs.github.com"],
  resolved: {
    source: "pypi",
    resolvedAt: "2026-09-06T05:00:00.000Z",
    metadataUrl: "https://pypi.org/pypi/httpx/json",
    homepage: "https://github.com/encode/httpx",
    docsUrl: "https://www.python-httpx.org/",
  },
};

describe("resolved store (<cacheRoot>/resolved.json)", () => {
  it("lives under the cache root and reads as empty when absent", () => {
    expect(resolvedStorePath()).toBe(join(dir, "resolved.json"));
    expect(readResolvedEntries()).toEqual([]);
  });

  it("round-trips an entry, creating the cache root, and leaves no temp file behind", () => {
    saveResolvedEntry(hono);
    expect(readdirSync(dir)).toEqual(["resolved.json"]);
    const raw = JSON.parse(readFileSync(join(dir, "resolved.json"), "utf8"));
    expect(raw.schemaVersion).toBe(RESOLVED_SCHEMA_VERSION);
    expect(raw.entries).toHaveLength(1);
    expect(raw.entries[0].allowedHosts).toBeUndefined(); // derived on load, never persisted
    expect(readResolvedEntries()).toEqual([hono]);
  });

  it("merges entries by name (last save wins) and keeps the others", () => {
    saveResolvedEntry(hono);
    saveResolvedEntry(httpx);
    saveResolvedEntry({ ...hono, urls: ["https://hono.dev/llms.txt"] });
    const entries = readResolvedEntries();
    expect(entries.map((e) => e.name)).toEqual(["hono", "httpx"]);
    expect(entries[0].urls).toEqual(["https://hono.dev/llms.txt"]);
    expect(entries[1]).toEqual(httpx);
  });

  it("PAR-825/D-90: two PEP-503-twin PyPI spellings collapse to ONE persisted record (last save wins), an npm/arbitrary twin pair correctly stays as two", () => {
    const httpxHyphen: LibraryEntry = { ...httpx, name: "typing-extensions" };
    const httpxUnderscore: LibraryEntry = { ...httpx, name: "typing_extensions", urls: ["https://pypi.org/typing-extensions-v2.txt"] };
    saveResolvedEntry(httpxHyphen);
    saveResolvedEntry(httpxUnderscore);
    const pypiEntries = readResolvedEntries().filter((e) => e.name.includes("typing"));
    expect(pypiEntries).toHaveLength(1); // collapsed — same PyPI project, two spellings
    expect(pypiEntries[0].name).toBe("typing_extensions"); // the LAST save's spelling wins
    expect(pypiEntries[0].urls).toEqual(["https://pypi.org/typing-extensions-v2.txt"]);

    const npmHyphen: LibraryEntry = { ...hono, name: "foo-bar" };
    const npmUnderscore: LibraryEntry = { ...hono, name: "foo_bar", urls: ["https://npm.example.com/foo-underscore.txt"] };
    saveResolvedEntry(npmHyphen);
    saveResolvedEntry(npmUnderscore);
    const npmEntries = readResolvedEntries().filter((e) => e.name.includes("foo"));
    expect(npmEntries.map((e) => e.name).sort()).toEqual(["foo-bar", "foo_bar"]); // NOT collapsed — two different npm packages
  });

  it("ignores a corrupt file on read and overwrites it on the next save", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "resolved.json"), "{ not json", "utf8");
    expect(readResolvedEntries()).toEqual([]);
    saveResolvedEntry(hono);
    expect(readResolvedEntries()).toEqual([hono]);
  });

  it("ignores a file of the wrong shape and one with a future schema version", () => {
    writeFileSync(join(dir, "resolved.json"), JSON.stringify([hono]), "utf8");
    expect(readResolvedEntries()).toEqual([]);
    writeFileSync(join(dir, "resolved.json"), JSON.stringify({ schemaVersion: 99, entries: [hono] }), "utf8");
    expect(readResolvedEntries()).toEqual([]);
  });

  it("skips malformed records and keeps the valid ones", () => {
    const record = (e: LibraryEntry) => ({ name: e.name, urls: e.urls, description: e.description, resolved: e.resolved });
    writeFileSync(
      join(dir, "resolved.json"),
      JSON.stringify({
        schemaVersion: RESOLVED_SCHEMA_VERSION,
        entries: [
          record(hono),
          null,
          "string",
          { ...record(httpx), name: "https://evil.example/x" }, // invalid package name
          { ...record(httpx), name: "no-urls", urls: [] },
          { ...record(httpx), name: "http-url", urls: ["http://x.example.com/llms.txt"] },
          { ...record(httpx), name: "ip-url", urls: ["https://169.254.169.254/llms.txt"] },
          { ...record(httpx), name: "no-resolved", resolved: undefined },
          { ...record(httpx), name: "bad-source", resolved: { ...httpx.resolved, source: "gem" } },
          { ...record(httpx), name: "bad-meta", resolved: { ...httpx.resolved, metadataUrl: "https://evil.example/pypi/httpx/json" } },
          { ...record(httpx), name: "bad-date", resolved: { ...httpx.resolved, resolvedAt: "yesterday" } },
        ],
      }),
      "utf8",
    );
    expect(readResolvedEntries().map((e) => e.name)).toEqual(["hono"]);
  });

  it("never trusts persisted allowedHosts: they are re-derived from the homepage / docs URL", () => {
    writeFileSync(
      join(dir, "resolved.json"),
      JSON.stringify({
        schemaVersion: RESOLVED_SCHEMA_VERSION,
        entries: [{ name: "hono", urls: hono.urls, allowedHosts: ["*.internal", "169.254.169.254", "evil.example.net"], resolved: hono.resolved }],
      }),
      "utf8",
    );
    expect(readResolvedEntries()[0].allowedHosts).toEqual(["hono.dev", "docs.hono.dev"]);
  });

  it("PAR-1031: reads valid schema-1 records without rewriting and still validates untrusted fields", () => {
    const path = resolvedStorePath();
    const raw = JSON.stringify({ schemaVersion: 1, entries: [
      { ...hono, allowedHosts: ["*.internal", "evil.example.net"] },
      { ...httpx, urls: ["https://127.0.0.1/private.txt"] },
    ] });
    writeFileSync(path, raw, "utf8");
    expect(readResolvedEntries()).toEqual([hono]);
    expect(readFileSync(path, "utf8")).toBe(raw);
  });

  it("PAR-1031: saving a pinned record upgrades schema 1 while retaining other valid resolutions", () => {
    const path = resolvedStorePath();
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, entries: [hono, httpx] }), "utf8");
    const pinned = { ...hono, versionedDocuments: [
      { version: "1.0.0", url: "https://raw.githubusercontent.com/honojs/hono/refs/tags/v1.0.0/README.md" },
    ] };
    expect(saveResolvedEntry(pinned)).toBe(true);
    expect(readResolvedEntries()).toEqual([pinned, httpx]);
    expect(JSON.parse(readFileSync(path, "utf8")).schemaVersion).toBe(RESOLVED_SCHEMA_VERSION);
  });

  it("PAR-1031: validates persisted versioned documents and retains distinct exact pins across saves", () => {
    const v1 = "https://raw.githubusercontent.com/honojs/hono/refs/tags/v1.0.0/README.md";
    const v2 = "https://raw.githubusercontent.com/honojs/hono/refs/tags/v2.0.0/README.md";
    expect(toResolvedEntry({ ...hono, versionedDocuments: [{ version: "../../escape", url: v1 }] })).toBeUndefined();
    expect(toResolvedEntry({ ...hono, versionedDocuments: [{ version: "1.0.0", url: "https://127.0.0.1/README.md" }] })).toBeUndefined();
    saveResolvedEntry({ ...hono, versionedDocuments: [{ version: "1.0.0", url: v1 }] });
    saveResolvedEntry({ ...hono, versionedDocuments: [{ version: "2.0.0", url: v2 }] });
    expect(readResolvedEntries()[0].versionedDocuments).toEqual([
      { version: "1.0.0", url: v1 },
      { version: "2.0.0", url: v2 },
    ]);
  });

  it("PAR-988: strips query-bearing metadata URLs when loading an older resolved record", () => {
    const entry = toResolvedEntry({
      ...hono,
      resolved: {
        ...hono.resolved,
        homepage: "https://hono.dev/guide?token=QUERY_MARKER",
        docsUrl: "https://docs.hono.dev/ref?token=QUERY_MARKER",
      },
    });
    expect(entry?.resolved?.homepage).toBe("https://hono.dev/guide");
    expect(entry?.resolved?.docsUrl).toBe("https://docs.hono.dev/ref");
  });

  it("PAR-991: reading legacy query tokens warns once without rewriting or losing valid entries", () => {
    const path = resolvedStorePath();
    const raw = JSON.stringify({ schemaVersion: RESOLVED_SCHEMA_VERSION, entries: [
      { ...hono, resolved: { ...hono.resolved, homepage: "https://hono.dev/guide?token=QUERY_MARKER", docsUrl: "https://docs.hono.dev/ref?token=QUERY_MARKER" } },
      httpx,
    ] });
    writeFileSync(path, raw, { mode: 0o644 });
    const beforeMode = statSync(path).mode & 0o777;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const entries = readResolvedEntries();
      expect(entries.map((entry) => entry.name)).toEqual(["hono", "httpx"]);
      expect(entries[0].resolved?.homepage).toBe("https://hono.dev/guide");
      expect(entries[0].resolved?.docsUrl).toBe("https://docs.hono.dev/ref");
      expect(readResolvedEntries()).toHaveLength(2);
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("delete resolved.json from the VibeCTX cache directory"));
      expect(String(stderr.mock.calls[0][0])).not.toContain(dir);
      expect(String(stderr.mock.calls[0][0])).not.toContain("QUERY_MARKER");
    } finally {
      stderr.mockRestore();
    }
    expect(readFileSync(path, "utf8")).toBe(raw);
    expect(statSync(path).mode & 0o777).toBe(beforeMode);
  });

  it("PAR-991: homepage-only legacy query triggers the cleanup warning", () => {
    const path = resolvedStorePath();
    const raw = JSON.stringify({ schemaVersion: RESOLVED_SCHEMA_VERSION, entries: [
      { ...hono, resolved: { ...hono.resolved, homepage: "https://hono.dev/guide?token=QUERY_MARKER" } },
    ] });
    writeFileSync(path, raw, "utf8");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(readResolvedEntries()).toHaveLength(1);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("delete resolved.json from the VibeCTX cache directory"));
      expect(String(stderr.mock.calls[0][0])).not.toContain("QUERY_MARKER");
      expect(readFileSync(path, "utf8")).toBe(raw);
    } finally {
      stderr.mockRestore();
    }
  });

  it("PAR-991: docsUrl-only legacy query triggers the cleanup warning", () => {
    const path = resolvedStorePath();
    const raw = JSON.stringify({ schemaVersion: RESOLVED_SCHEMA_VERSION, entries: [
      { ...httpx, resolved: { ...httpx.resolved, docsUrl: "https://www.python-httpx.org/guide?token=QUERY_MARKER" } },
    ] });
    writeFileSync(path, raw, "utf8");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(readResolvedEntries()).toHaveLength(1);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("delete resolved.json from the VibeCTX cache directory"));
      expect(String(stderr.mock.calls[0][0])).not.toContain("QUERY_MARKER");
      expect(readFileSync(path, "utf8")).toBe(raw);
    } finally {
      stderr.mockRestore();
    }
  });

  it("PAR-991: a newer-schema resolved file is never rewritten by legacy query scrubbing", () => {
    const path = resolvedStorePath();
    const raw = JSON.stringify({ schemaVersion: RESOLVED_SCHEMA_VERSION + 1, entries: [
      { ...hono, resolved: { ...hono.resolved, homepage: "https://hono.dev/?token=QUERY_MARKER" } },
    ] });
    writeFileSync(path, raw, "utf8");
    expect(readResolvedEntries()).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(raw);
  });

  it("PAR-991: a symlinked resolved file is not followed or rewritten by legacy query scrubbing", () => {
    const target = join(dir, "target.json");
    const raw = JSON.stringify({ schemaVersion: RESOLVED_SCHEMA_VERSION, entries: [
      { ...hono, resolved: { ...hono.resolved, homepage: "https://hono.dev/?token=QUERY_MARKER" } },
    ] });
    writeFileSync(target, raw, "utf8");
    symlinkSync(target, resolvedStorePath());
    expect(readResolvedEntries()).toEqual([]);
    expect(lstatSync(resolvedStorePath()).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(raw);
  });

  it("PAR-991: operator cleanup instructions name every supported cache location", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const guidance = readme.split("Older `resolved.json` files may contain")[1]?.split("When `get_docs` resolves")[0];
    expect(guidance).toBeDefined();
    for (const location of ["VIBECTX_CACHE_DIR", "DOCS_CACHE_DIR", "~/.vibectx/", "~/.docs-cache-mcp/"]) {
      expect(guidance).toContain(location);
    }
    expect(guidance).toContain("delete **only** `resolved.json`");
  });

  it("drops a hostile homepage / docsUrl from the record instead of rejecting it, and drops ttlHours / aliases / probeQueries", () => {
    writeFileSync(
      join(dir, "resolved.json"),
      JSON.stringify({
        schemaVersion: RESOLVED_SCHEMA_VERSION,
        entries: [
          {
            name: "hono",
            urls: hono.urls,
            ttlHours: 0,
            aliases: ["react"],
            probeQueries: ["x"],
            resolved: { ...hono.resolved, homepage: "http://hono.dev", docsUrl: "https://u:p@hono.dev/docs" },
          },
        ],
      }),
      "utf8",
    );
    const [e] = readResolvedEntries();
    expect(e.resolved?.homepage).toBeUndefined();
    expect(e.resolved?.docsUrl).toBeUndefined();
    expect(e.allowedHosts).toEqual([]);
    expect(e.ttlHours).toBeUndefined();
    expect(e.aliases).toBeUndefined();
    expect(e.probeQueries).toBeUndefined();
  });

  it("caps and single-lines the description, and caps the number of urls at the resolver bound (K1)", () => {
    // A11/PAR-724: MAX_URLS_PER_ENTRY grew to reserve room for version-tag README candidates too.
    expect(MAX_URLS_PER_ENTRY).toBe(MAX_LLMS_CANDIDATES + MAX_README_CANDIDATES + MAX_VERSIONED_README_CANDIDATES);
    const e = toResolvedEntry({
      name: "hono",
      urls: Array.from({ length: MAX_URLS_PER_ENTRY + 1 }, (_, i) => `https://hono.dev/${i}.txt`),
      description: `line one\nline two ${"x".repeat(500)}`,
      resolved: hono.resolved,
    });
    expect(e?.urls).toHaveLength(MAX_URLS_PER_ENTRY);
    expect(e?.description).not.toContain("\n");
    expect(e?.description?.length).toBeLessThanOrEqual(200);
  });

  it("round-trips an entry with the full MAX_URLS_PER_ENTRY candidate list intact (K1)", () => {
    const urls = Array.from({ length: MAX_URLS_PER_ENTRY }, (_, i) => `https://hono.dev/c${i}/llms.txt`);
    saveResolvedEntry({ ...hono, urls });
    expect(readResolvedEntries()[0].urls).toEqual(urls);
    expect(urls).toHaveLength(MAX_URLS_PER_ENTRY);
  });

  it("S2: rejects a record whose name is not already trimmed and lower-cased (a planted `React` cannot shadow `react`)", () => {
    for (const name of ["React", "NextJS", " hono", "hono ", "Next.js", "HTTPX"]) {
      expect(toResolvedEntry({ name, urls: hono.urls, resolved: hono.resolved }), name).toBeUndefined();
    }
    expect(toResolvedEntry({ name: "next.js", urls: hono.urls, resolved: hono.resolved })?.name).toBe("next.js");
  });

  it("K2: does not overwrite a resolved.json of another schema version; the save is refused with a note", () => {
    const foreign = JSON.stringify({ schemaVersion: RESOLVED_SCHEMA_VERSION + 1, entries: [{ future: true }] });
    writeFileSync(join(dir, "resolved.json"), foreign, "utf8");
    const notes: string[] = [];
    expect(saveResolvedEntry(hono, (m) => notes.push(m))).toBe(false);
    expect(readFileSync(join(dir, "resolved.json"), "utf8")).toBe(foreign);
    expect(notes.join("")).toContain(`schemaVersion ${RESOLVED_SCHEMA_VERSION + 1}`);
    // A corrupt (unparseable) file is not "another version": it is replaced.
    writeFileSync(join(dir, "resolved.json"), "{{{", "utf8");
    expect(saveResolvedEntry(hono, (m) => notes.push(m))).toBe(true);
    expect(readResolvedEntries()).toEqual([hono]);
  });

  it("L1: cleanDescription strips bidi and zero-width characters as well as control characters", () => {
    expect(cleanDescription("\u202Eevil\u200B text\u2066\u2069\u200F\u200D ok\u0007")).toBe("evil text ok");
    expect(cleanDescription("\u200B\u200B")).toBeUndefined();
  });

  it("refuses to save an entry that is not a resolved entry", () => {
    expect(() => saveResolvedEntry({ name: "hono", urls: ["https://hono.dev/llms.txt"] })).toThrow(/resolved/);
    expect(existsSync(join(dir, "resolved.json"))).toBe(false);
  });
});

describe("PAR-859 — resolved.json is symlink-safe on both read and the write-side merge", () => {
  it("readResolvedEntries refuses a symlink planted at resolved.json's own path — reads back empty, not through the link (mutation target: readResolvedEntries's isRegularFile guard)", () => {
    saveResolvedEntry(hono);
    expect(readResolvedEntries()).toHaveLength(1); // the real file round-trips first
    const sibling = join(dir, "sibling.json");
    writeFileSync(sibling, JSON.stringify({ schemaVersion: RESOLVED_SCHEMA_VERSION, entries: [{ name: "evil", urls: hono.urls, resolved: hono.resolved }] }), "utf8");
    rmSync(resolvedStorePath(), { force: true });
    symlinkSync(sibling, resolvedStorePath());

    let entries: ReturnType<typeof readResolvedEntries>;
    expect(() => {
      entries = readResolvedEntries();
    }).not.toThrow();
    expect(entries!).toEqual([]);
    expect(lstatSync(resolvedStorePath()).isSymbolicLink()).toBe(true); // the link itself is untouched by the read
  });

  /**
   * PAR-859 — the exposure `readResolvedEntries`'s own guard actually closes is worse than
   * "served and discarded": `saveResolvedEntry` calls `readResolvedEntries()` internally to merge
   * a new entry into the existing list before writing back. Before this guard, a symlink planted
   * at `resolved.json` pointing at a file holding one attacker-authored entry had that entry
   * READ, MERGED, and PERSISTED into the real file on the very next save — proved here by saving
   * a DIFFERENT, legitimate library and then reading the REAL bytes that landed on disk (through
   * the symlink's own target, which `saveResolvedEntry`'s rename replaces with a real file) and
   * asserting the planted entry is specifically ABSENT, not merely that the save "worked".
   */
  it("a planted entry behind a resolved.json symlink is never adopted into the real file on the next save", () => {
    const plantedTarget = join(dir, "planted.json");
    const poisoned: LibraryEntry = { ...hono, name: "evil-planted-library" };
    writeFileSync(
      plantedTarget,
      JSON.stringify({ schemaVersion: RESOLVED_SCHEMA_VERSION, entries: [{ name: poisoned.name, urls: poisoned.urls, resolved: poisoned.resolved }] }),
      "utf8",
    );
    mkdirSync(dir, { recursive: true });
    symlinkSync(plantedTarget, resolvedStorePath());

    expect(saveResolvedEntry(httpx)).toBe(true);

    // The symlink is gone — `writeAtomic`'s rename replaced it with a real file — so read the
    // REAL bytes that landed on disk directly, not merely through `readResolvedEntries` (which
    // would itself refuse a symlink, but by now there is no symlink left to refuse).
    expect(lstatSync(resolvedStorePath()).isSymbolicLink()).toBe(false);
    const onDisk = JSON.parse(readFileSync(resolvedStorePath(), "utf8"));
    const names: string[] = onDisk.entries.map((e: { name: string }) => e.name);
    expect(names).toEqual(["httpx"]); // only the legitimate save landed
    expect(names).not.toContain(poisoned.name); // the planted entry was never adopted
    // The symlink's own target is untouched — the poisoned data still sits exactly where it was,
    // proving nothing was written THROUGH the link either.
    expect(JSON.parse(readFileSync(plantedTarget, "utf8")).entries[0].name).toBe(poisoned.name);
  });

  /**
   * code-reviewer (Phase 1b review round, BLOCKING) PROVED with an executed probe that the two
   * tests above are not the whole story: `isRegularFile`/`lstat` only inspects the LEAF
   * (`resolved.json` itself). With `VIBECTX_CACHE_DIR` pointed at a symlink whose TARGET holds a
   * genuinely real, valid `resolved.json`, the leaf check never sees a symlink at all — `lstat` on
   * the full joined path resolves the ROOT (an intermediate component) for ordinary directory
   * traversal and finds a real regular file at the far end. This is a DIFFERENT scenario from
   * either test above (neither of which symlinks the root) and needs its own proof:
   * `readResolvedEntries` must refuse even when only the root is symlinked.
   */
  it("readResolvedEntries refuses even when only the cache ROOT is a symlink, whose target genuinely holds a valid resolved.json", () => {
    const target = mkdtempSync(join(tmpdir(), "vibectx-resolved-root-symlink-target-"));
    const parent = mkdtempSync(join(tmpdir(), "vibectx-resolved-root-symlink-parent-"));
    const linked = join(parent, "root");
    writeFileSync(
      join(target, "resolved.json"),
      JSON.stringify({ schemaVersion: RESOLVED_SCHEMA_VERSION, entries: [{ name: hono.name, urls: hono.urls, resolved: hono.resolved }] }),
      "utf8",
    );
    symlinkSync(target, linked);
    process.env.VIBECTX_CACHE_DIR = linked;
    try {
      let entries: ReturnType<typeof readResolvedEntries>;
      expect(() => {
        entries = readResolvedEntries();
      }).not.toThrow();
      expect(entries!).toEqual([]); // must NOT return the entry sitting at the far end of the root symlink
    } finally {
      process.env.VIBECTX_CACHE_DIR = dir;
      rmSync(parent, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe("K2 (PAR-656) — resolved.json upgrade policy aligned with the project store", () => {
  it("a LOWER schemaVersion is replaced on save without a note; a HIGHER one stays protected", () => {
    writeFileSync(join(dir, "resolved.json"), JSON.stringify({ schemaVersion: 0, entries: [] }), "utf8");
    const notes: string[] = [];
    expect(saveResolvedEntry(hono, (m) => notes.push(m))).toBe(true);
    expect(notes).toEqual([]);
    expect(readResolvedEntries()).toEqual([hono]);
    const future = JSON.stringify({ schemaVersion: RESOLVED_SCHEMA_VERSION + 1, entries: [] });
    writeFileSync(join(dir, "resolved.json"), future, "utf8");
    expect(saveResolvedEntry(hono, (m) => notes.push(m))).toBe(false);
    expect(readFileSync(join(dir, "resolved.json"), "utf8")).toBe(future);
    expect(notes.join("")).toContain(`newer schemaVersion ${RESOLVED_SCHEMA_VERSION + 1}`);
  });
});
