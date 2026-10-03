import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, lstatSync, existsSync, chmodSync, symlinkSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeCache, touchCache, ensureCacheRoot, resetCacheRootState, libDirName, urlSlug } from "../src/cache.js";
import { saveResolvedEntry, resolvedStorePath } from "../src/resolved-store.js";
import { indexCachedDocument, searchIndexPath, resetSearchIndexMemo } from "../src/search-index.js";
import { writeProjectRecord, projectRecordPath, PROJECT_RECORD_SCHEMA_VERSION, type ProjectRecord } from "../src/project-store.js";
import { saveDoctorVerdicts, doctorStorePath, type DoctorVerdict } from "../src/doctor-store.js";
import { recordActivity, activityLogPath } from "../src/activity-log.js";
import type { LibraryEntry } from "../src/registry.js";

/**
 * PAR-805 — permission consistency across every site that may create the cache root, and the
 * file-mode half (F-7) of the same finding. Nothing here is mocked: every write is a real file
 * under a real temporary cache root, and every mode assertion reads it back with `lstatSync`
 * (never `statSync`, so a symlink would answer with ITS OWN mode, not the target's — not the
 * concern this file tests, but the same discipline this whole cache layer holds elsewhere).
 */

let dir: string;
let project: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-perms-"));
  project = mkdtempSync(join(tmpdir(), "vibectx-perms-proj-"));
  process.env.VIBECTX_CACHE_DIR = dir;
  resetCacheRootState();
  resetSearchIndexMemo();
});

afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  resetCacheRootState();
  rmSync(dir, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

const hono: LibraryEntry = {
  name: "hono",
  urls: ["https://hono.dev/llms-full.txt"],
  allowedHosts: ["hono.dev"],
  resolved: {
    source: "npm",
    resolvedAt: "2026-09-06T05:00:00.000Z",
    metadataUrl: "https://registry.npmjs.org/hono/latest",
  },
};

function verdict(): DoctorVerdict {
  return { name: "fastify", kind: "index-only", healthy: false, reasons: ["index-only"], checkedAt: "2026-09-17T00:00:00.000Z" };
}

function projectRecord(): ProjectRecord {
  return {
    schemaVersion: PROJECT_RECORD_SCHEMA_VERSION,
    dir: project,
    manifests: ["package.json"],
    dependencies: [],
    warmedAt: "2026-09-06T06:00:00.000Z",
  };
}

/** `lstat`, never `stat`: the mode of the ENTRY at this exact path, not whatever it resolves to
 *  (moot for every path this file writes — none is a symlink — but the consistent rule). */
const mode = (p: string) => lstatSync(p).mode & 0o777;

const URL_ = "https://react.dev/llms.txt";

/** Each of the SIX sites PAR-805 identified that may create the cache root — a bare `mkdirSync`
 *  under `cacheRoot()` with no `mode`, before this item, except `activity-log.ts` (already
 *  `0o700`, but not yet routed through the shared `ensureCacheRoot`). `touchCache` is
 *  deliberately NOT one of these six: it never creates a directory (it only rewrites an
 *  EXISTING `.meta.json`), so it has no `ensureCacheRoot` call of its own — its contribution to
 *  this item is the FILE-mode fix on its own `writeAtomic` call, tested separately below. */
const rootCreators: Record<string, () => void> = {
  "cache.ts writeCache": () => {
    writeCache("react", URL_, "# React");
  },
  "resolved-store.ts saveResolvedEntry": () => {
    saveResolvedEntry(hono);
  },
  "search-index.ts writeIndex (via indexCachedDocument)": () => {
    indexCachedDocument("hono", "https://hono.dev/llms.txt", "# Hono docs, long enough to index", "2026-09-06T05:00:00.000Z");
  },
  "project-store.ts writeProjectRecord": () => {
    writeProjectRecord(projectRecord());
  },
  "doctor-store.ts saveDoctorVerdicts": () => {
    saveDoctorVerdicts([verdict()]);
  },
  "activity-log.ts recordActivity": () => {
    recordActivity({ tool: "get_docs", outcome: "matched" });
  },
};

describe("PAR-805 — creation-order independence: whichever of the six sites creates the cache root first, it ends at 0700 (mutation target: ensureCacheRoot's mode argument)", () => {
  for (const [label, run] of Object.entries(rootCreators)) {
    it(`${label} creates a fresh, not-yet-existing root at 0700`, () => {
      const freshParent = mkdtempSync(join(tmpdir(), "vibectx-order-"));
      const freshRoot = join(freshParent, "not-created-yet");
      process.env.VIBECTX_CACHE_DIR = freshRoot;
      resetCacheRootState();
      try {
        expect(existsSync(freshRoot)).toBe(false);
        run();
        expect(mode(freshRoot)).toBe(0o700);
      } finally {
        process.env.VIBECTX_CACHE_DIR = dir;
        resetCacheRootState();
        rmSync(freshParent, { recursive: true, force: true });
      }
    });
  }
});

describe("PAR-805 — umask independence: a permissive umask cannot loosen what ensureCacheRoot/writeAtomic create", () => {
  it("root, library directory, .md and .meta.json are all still exactly 0700/0600 under umask 0", () => {
    // umask 0 is the WORST case for the pre-PAR-805 bug: a bare mkdirSync/writeFileSync with no
    // explicit mode would have produced 0777/0666 here, not merely "looser than ideal" — the
    // most permissive possible outward proof that the explicit `mode` option, not an
    // accommodating ambient CI umask, is what makes this pass.
    const oldUmask = process.umask(0);
    try {
      writeCache("react", URL_, "# React");
      const libDir = join(dir, libDirName("react"));
      const slug = urlSlug(URL_);
      expect(mode(dir)).toBe(0o700);
      expect(mode(libDir)).toBe(0o700);
      expect(mode(join(libDir, `${slug}.md`))).toBe(0o600);
      expect(mode(join(libDir, `${slug}.meta.json`))).toBe(0o600);
    } finally {
      process.umask(oldUmask);
    }
  });

  it("a store file (activity.json) is still exactly 0600 under umask 0", () => {
    const oldUmask = process.umask(0);
    try {
      recordActivity({ tool: "get_docs", outcome: "matched" });
      expect(mode(activityLogPath())).toBe(0o600);
    } finally {
      process.umask(oldUmask);
    }
  });
});

describe("PAR-805 — per-artifact mode, one assertion per artifact (the issue's own warning: 'a single spot-check is what let this drift')", () => {
  it("cache root: 0700 (a FRESH root, not this file's own mkdtempSync fixture — that directory is already 0700 by Node's own default, which would let this pass even with the mode argument removed, exactly the confound test/activity-log.test.ts's own comment warns about)", () => {
    const freshParent = mkdtempSync(join(tmpdir(), "vibectx-artifact-"));
    const freshRoot = join(freshParent, "not-created-yet");
    process.env.VIBECTX_CACHE_DIR = freshRoot;
    resetCacheRootState();
    try {
      writeCache("react", URL_, "# React");
      expect(mode(freshRoot)).toBe(0o700);
    } finally {
      process.env.VIBECTX_CACHE_DIR = dir;
      resetCacheRootState();
      rmSync(freshParent, { recursive: true, force: true });
    }
  });

  it("a library directory: 0700", () => {
    writeCache("react", URL_, "# React");
    expect(mode(join(dir, libDirName("react")))).toBe(0o700);
  });

  it(".md content file: 0600 (mutation target: writeCache's contentTmp writeFileSync mode)", () => {
    writeCache("react", URL_, "# React");
    expect(mode(join(dir, libDirName("react"), `${urlSlug(URL_)}.md`))).toBe(0o600);
  });

  it(".meta.json, immediately after writeCache: 0600 (mutation target: writeCache's metaTmp writeFileSync mode)", () => {
    writeCache("react", URL_, "# React");
    expect(mode(join(dir, libDirName("react"), `${urlSlug(URL_)}.meta.json`))).toBe(0o600);
  });

  it(".meta.json, after a touchCache revalidation: still 0600 (mutation target: touchCache's own writeAtomic mode — a DIFFERENT call from writeCache's)", () => {
    writeCache("react", URL_, "# React");
    const metaPath = join(dir, libDirName("react"), `${urlSlug(URL_)}.meta.json`);
    chmodSync(metaPath, 0o644); // simulate a file left loose by an older vibectx
    touchCache("react", URL_);
    expect(mode(metaPath)).toBe(0o600); // touchCache's own write must have corrected it
  });

  it("index.json: 0600 (mutation target: writeIndex's writeAtomic mode)", () => {
    indexCachedDocument("hono", "https://hono.dev/llms.txt", "# Hono docs, long enough to index", "2026-09-06T05:00:00.000Z");
    expect(mode(searchIndexPath())).toBe(0o600);
  });

  it("a project record: 0600 (mutation target: writeProjectRecord's writeAtomic mode)", () => {
    writeProjectRecord(projectRecord());
    expect(mode(projectRecordPath(project))).toBe(0o600);
  });

  it("activity.json: 0600 (already required by PAR-791; now also routed through ensureCacheRoot for the directory)", () => {
    recordActivity({ tool: "get_docs", outcome: "matched" });
    expect(mode(activityLogPath())).toBe(0o600);
  });

  it("resolved.json: 0600 (mutation target: saveResolvedEntry's writeAtomic mode)", () => {
    saveResolvedEntry(hono);
    expect(mode(resolvedStorePath())).toBe(0o600);
  });

  it("doctor.json: 0600 (mutation target: saveDoctorVerdicts's writeAtomic mode — the sixth site, found by grep, not named in the original issue text)", () => {
    saveDoctorVerdicts([verdict()]);
    expect(mode(doctorStorePath())).toBe(0o600);
  });
});

describe("PAR-805 — a pre-existing, looser-than-0700 cache root is disclosed, never tightened or refused (mutation target: ensureCacheRoot's pre-existing-mode warning)", () => {
  it("mode is left exactly as it was, exactly one warning names the actual mode, and a second call in the same process says nothing more", () => {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o777); // deterministic regardless of the running process's own umask
    expect(mode(dir)).toBe(0o777);
    const said: string[] = [];

    writeCache("react", URL_, "# React", undefined, undefined, (m) => said.push(m));

    expect(mode(dir)).toBe(0o777); // NOT tightened
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(dir);
    expect(said[0]).toContain("0777"); // names the ACTUAL mode, not a generic "looser than 0700"

    // A second write in the SAME process, same root: no second warning.
    writeCache("react", "https://react.dev/other.txt", "# Other", undefined, undefined, (m) => said.push(m));
    expect(said).toHaveLength(1);
  });

  it("using the cache is not refused either — the write still succeeds through a looser root", () => {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o777);

    // A no-op warn, not the real default (`toStderr`): this test's own 0o777 root is deliberate
    // and expected to trigger the loose-root warning, which is noise in CI output for a case
    // that isn't testing the warning itself — its sibling below already does that correctly.
    writeCache("react", URL_, "# React", undefined, undefined, () => {});

    expect(existsSync(join(dir, libDirName("react"), `${urlSlug(URL_)}.md`))).toBe(true);
  });

  it("a NEWLY created library directory under the looser root still gets 0700 — the warning is about the ROOT'S OWN mode, not a refusal to harden anything new", () => {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o777);

    writeCache("react", URL_, "# React", undefined, undefined, () => {});

    expect(mode(join(dir, libDirName("react")))).toBe(0o700);
  });

  it("does not warn at all for a root that is already 0700", () => {
    // `dir` is already 0700 here, unmodified: mkdtempSync's own default mode (confirmed by
    // `test/activity-log.test.ts`'s identical observation) — no explicit chmod/mkdir needed to
    // set up this precondition, only to prove it.
    expect(mode(dir)).toBe(0o700);
    const said: string[] = [];

    writeCache("react", URL_, "# React", undefined, undefined, (m) => said.push(m));

    expect(said).toEqual([]);
  });

  /**
   * A real gap this file's own review caught (not merely a hypothetical): `writeProjectRecord`
   * calls `ensureCacheRoot` on `join(cacheRoot(), "projects")`, never on the root itself — the
   * IDENTICAL shape `writeCache`'s own per-library-directory call has, and the identical bug an
   * earlier version of THAT fix had (see `writeCache`'s own comment). VERIFIED directly (a
   * standalone script against the built package) before fixing: a root pre-existing at 0777
   * produced ZERO warnings through `writeProjectRecord` alone, with `writeCache`'s own two-call
   * fix already in place — the two call sites are independent, and fixing one does not fix the
   * other.
   */
  it("writeProjectRecord ALSO warns about a pre-existing looser root, not only writeCache (mutation target: project-store.ts's own two ensureCacheRoot calls)", () => {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o777);
    const said: string[] = [];

    writeProjectRecord(projectRecord(), (m) => said.push(m));

    expect(mode(dir)).toBe(0o777); // NOT tightened, same rule as writeCache's own case
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(dir);
    expect(said[0]).toContain("0777");
    expect(mode(join(dir, "projects"))).toBe(0o700); // the subdirectory itself still gets 0700
  });

  /**
   * PAR-859 — supersedes this test's own PAR-805-era version, which pinned that `ensureCacheRoot`
   * said NOTHING about a symlinked root, deferring the whole question to a not-yet-started
   * PAR-859. code-reviewer/security-architect, PAR-805 review round, found the underlying bug an
   * earlier version of this function had: `lstat` on a symlink reports the LINK's own mode (an
   * ordinary default, e.g. 0755), never the target's, so a symlinked root used to be compared
   * against 0700 as if that number meant anything, then told to `chmod` a path that `chmod` would
   * silently retarget through the link, never fixing what was actually wrong. PAR-859 closes the
   * question that finding deferred: `ensureCacheRoot` now refuses a symlinked `dir` outright,
   * BEFORE it ever reaches that mode comparison — one warning naming it a symlink, `false`
   * returned, no `mkdirSync` attempted, no crash.
   */
  it("a SYMLINKED root is refused by ensureCacheRoot itself — one symlink warning, false returned, no mode diagnosis, no crash (mutation target: the isSymlinkAt(dir) check)", () => {
    const target = mkdtempSync(join(tmpdir(), "vibectx-perms-symlink-target-"));
    const parent = mkdtempSync(join(tmpdir(), "vibectx-perms-symlink-parent-"));
    try {
      const linked = join(parent, "root");
      symlinkSync(target, linked);
      process.env.VIBECTX_CACHE_DIR = linked;
      resetCacheRootState();
      const said: string[] = [];

      // writeCache's own PAR-786 symlink check refuses the write before ever reaching
      // ensureCacheRoot — so it cannot, on its own, prove ensureCacheRoot itself refuses a
      // symlink. Calling ensureCacheRoot directly is the only way to isolate this guard.
      let result: boolean | undefined;
      expect(() => {
        result = ensureCacheRoot(linked, (m: string) => said.push(m));
      }).not.toThrow();

      expect(result).toBe(false);
      expect(said).toHaveLength(1);
      expect(said[0]).toContain("symlink");
      expect(said[0]).toContain(linked);
      expect(said[0]).not.toContain("mode"); // no mode diagnosis — this is a symlink refusal, not a permission warning
      expect(existsSync(linked)).toBe(true); // still exactly the symlink it was — nothing created, nothing removed
      expect(lstatSync(linked).isSymbolicLink()).toBe(true);

      // A second call in the same process says nothing more (deduped, mirroring the loose-root
      // warning's own dedup).
      result = ensureCacheRoot(linked, (m: string) => said.push(m));
      expect(result).toBe(false);
      expect(said).toHaveLength(1);
    } finally {
      process.env.VIBECTX_CACHE_DIR = dir;
      resetCacheRootState();
      rmSync(parent, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  /**
   * code-reviewer, PAR-805 review round — asserted through a call site OTHER than `writeCache`
   * on purpose: `writeCache`'s own default `warn` is `toStderr`, which already appends a
   * newline correctly, so a test only through `writeCache` cannot tell "ensureCacheRoot's
   * message is newline-terminated" apart from "toStderr always was". `saveResolvedEntry`'s own
   * default `warn` (`process.stderr.write(m)`, no newline) is exactly the shape that used to
   * run this message into whatever the process wrote to stderr next.
   */
  it("the loose-root warning ends in a newline even through a call site whose own default warn does not append one (saveResolvedEntry)", () => {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o777);
    const said: string[] = [];

    saveResolvedEntry(hono, (m) => said.push(m));

    expect(said).toHaveLength(1);
    expect(said[0].endsWith("\n")).toBe(true);
  });
});

/**
 * code-reviewer (Phase 1b review round) — corrected: this describe block's title originally
 * credited all six cases to the same mutation target, `ensureCacheRoot`'s `isSymlinkAt(dir)`
 * check. That is true for five of the six (`resolved-store.ts`, `search-index.ts`,
 * `project-store.ts`, `doctor-store.ts`, `activity-log.ts`) but NOT for `cache.ts`'s own
 * `writeCache` — confirmed both by reasoning (`writeCache`'s own `existsAsNonDirectory` check on
 * the root, D-83/PAR-786, runs and refuses BEFORE `ensureCacheRoot` is ever reached) and by this
 * suite's own stderr output, which shows `writeCache`'s distinct refusal wording ("refusing to
 * cache into... it is a symlink or another non-directory"), never `ensureCacheRoot`'s ("refusing
 * to use... it is a symlink"). The `writeCache` case below is therefore a REGRESSION GUARD on the
 * OLDER, already-shipped D-83 control, not evidence for the NEW PAR-859 mutation target — kept in
 * this same sweep for completeness (all six writers, one loop), not because it exercises the new
 * check.
 */
describe("PAR-859 — every one of the six write sites refuses a symlinked cache root, writing nothing through it (mutation target for five of six: ensureCacheRoot's isSymlinkAt(dir) check; writeCache is a regression guard on its own, older D-83/PAR-786 check — see this block's own comment)", () => {
  for (const [label, run] of Object.entries(rootCreators)) {
    const note = label.startsWith("cache.ts writeCache") ? " (regression guard on writeCache's own D-83/PAR-786 check, not the new PAR-859 one — see this describe block's comment)" : "";
    it(`${label} refuses a symlinked root — no throw, nothing written through the link${note}`, () => {
      const target = mkdtempSync(join(tmpdir(), "vibectx-write-symlink-target-"));
      const parent = mkdtempSync(join(tmpdir(), "vibectx-write-symlink-parent-"));
      const linked = join(parent, "root");
      symlinkSync(target, linked);
      process.env.VIBECTX_CACHE_DIR = linked;
      resetCacheRootState();
      resetSearchIndexMemo();
      try {
        // None of the six writers throw on a refused root: `writeCache`'s own PAR-786 checks
        // return a fallback timestamp; every other writer here returns `false` (or, for
        // `recordActivity`, is `void` and swallows everything, D-13).
        expect(() => run()).not.toThrow();
        expect(lstatSync(linked).isSymbolicLink()).toBe(true); // the link itself is untouched
        expect(readdirSync(target)).toEqual([]); // nothing was created through the link at all
      } finally {
        process.env.VIBECTX_CACHE_DIR = dir;
        resetCacheRootState();
        resetSearchIndexMemo();
        rmSync(parent, { recursive: true, force: true });
        rmSync(target, { recursive: true, force: true });
      }
    });
  }
});

describe('PAR-860 — writeCache\'s own two direct writeFileSync calls (contentTmp/metaTmp) each independently refuse a pre-planted symlink at their own predictable temp path (flag: "wx")', () => {
  it("contentTmp: refuses, throws, and touches neither the real target path nor the symlink's own target", () => {
    const elsewhere = join(dir, "elsewhere.md");
    writeFileSync(elsewhere, "ORIGINAL ELSEWHERE CONTENT", "utf8");
    mkdirSync(join(dir, libDirName("react")), { recursive: true, mode: 0o700 });
    const contentPath = join(dir, libDirName("react"), `${urlSlug(URL_)}.md`);

    const fixedNow = 1_700_000_000_000;
    const nowSpy = () => fixedNow;
    const dateNowSpy = Date.now;
    Date.now = nowSpy;
    try {
      const predictedTmp = `${contentPath}.${process.pid}.${fixedNow}.tmp`;
      symlinkSync(elsewhere, predictedTmp);

      expect(() => writeCache("react", URL_, "# React")).toThrow();

      expect(existsSync(contentPath)).toBe(false); // nothing was ever renamed into place
      // `rmSync`'s cleanup on the caught error removes the symlink itself, never its target.
      expect(existsSync(predictedTmp)).toBe(false);
      expect(readFileSync(elsewhere, "utf8")).toBe("ORIGINAL ELSEWHERE CONTENT"); // the link's own target is untouched
    } finally {
      Date.now = dateNowSpy;
    }
  });

  /**
   * Independent of the `contentTmp` case above: nothing is planted at `contentTmp`'s own temp
   * path here, so its `writeFileSync` succeeds — but `writeCache` writes BOTH temp files before
   * renaming EITHER one (see its own body: two `writeFileSync` calls, then two `renameSync`
   * calls), so `contentTmp`'s own RENAME never runs either — `metaTmp`'s write throws first,
   * jumping straight to the `catch` block. CORRECTED (code-reviewer, Phase 1b review round,
   * verified with an executed probe): an earlier version of this test's title and inline comment
   * claimed `contentTmp`'s write AND rename both succeeded, inventing a "content persisted with no
   * meta" hazard that cannot occur on this code path — the rename step is never reached for
   * either file. What this test actually proves is narrower and correct: `metaTmp`'s `flag: "wx"`
   * refuses independently of `contentTmp`'s own outcome — a mutation that removed only `metaTmp`'s
   * flag was FOUND, during this item's own mutation-check pass, to make no other test in the suite
   * fail before this one was added.
   */
  it("metaTmp: refuses independently, even though contentTmp's own write succeeds first (its rename never runs either, since writeCache renames only after BOTH writes succeed)", () => {
    const elsewhere = join(dir, "elsewhere.json");
    writeFileSync(elsewhere, "ORIGINAL ELSEWHERE CONTENT", "utf8");
    mkdirSync(join(dir, libDirName("react")), { recursive: true, mode: 0o700 });
    const contentPath = join(dir, libDirName("react"), `${urlSlug(URL_)}.md`);
    const metaPath = join(dir, libDirName("react"), `${urlSlug(URL_)}.meta.json`);

    const fixedNow = 1_700_000_000_001;
    const dateNowSpy = Date.now;
    Date.now = () => fixedNow;
    try {
      const predictedMetaTmp = `${metaPath}.${process.pid}.${fixedNow}.tmp`;
      symlinkSync(elsewhere, predictedMetaTmp);

      expect(() => writeCache("react", URL_, "# React")).toThrow();

      // Neither file was ever renamed into place — the assertion an earlier version of this
      // test's own wrong comment would have caught, had it been here from the start.
      expect(existsSync(contentPath)).toBe(false);
      expect(existsSync(metaPath)).toBe(false);
      expect(existsSync(predictedMetaTmp)).toBe(false); // the symlink itself was removed by cleanup
      expect(readFileSync(elsewhere, "utf8")).toBe("ORIGINAL ELSEWHERE CONTENT");
    } finally {
      Date.now = dateNowSpy;
    }
  });
});

describe("PAR-862 — a recursive whole-cache-tree invariant: every directory 0700, every file 0600, after all six writers run", () => {
  /**
   * Deliberately NOT per-artifact name-matching (contrast the "per-artifact mode" describe block
   * above, which checks specific, already-known paths) — this walks EVERYTHING `readdirSync`
   * finds under the cache root, recursively, so it would catch a hypothetical future SEVENTH
   * store that forgot to pass a mode, which a test that only knows six artifact names by name
   * cannot. `lstatSync`, never `statSync`, at every level of the walk: a symlink found anywhere
   * in the tree is neither a file nor a directory as far as this walk is concerned, and this test
   * fails loudly (via the `else` branch) rather than silently skipping it or following it.
   */
  it("walks the entire cache root recursively, not just the artifacts this suite already knows by name", () => {
    for (const run of Object.values(rootCreators)) run();

    const walk = (p: string): void => {
      for (const name of readdirSync(p)) {
        const full = join(p, name);
        const stat = lstatSync(full);
        if (stat.isDirectory()) {
          expect(mode(full)).toBe(0o700);
          walk(full);
        } else if (stat.isFile()) {
          expect(mode(full)).toBe(0o600);
        } else {
          throw new Error(`unexpected non-file, non-directory entry in the cache tree: ${full}`);
        }
      }
    };

    expect(mode(dir)).toBe(0o700); // the root itself
    walk(dir);
  });
});
