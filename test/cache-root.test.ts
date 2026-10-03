import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * PAR-652 item 5 — the cache location's rebrand: `~/.docs-cache-mcp` → `~/.vibectx`,
 * `DOCS_CACHE_DIR` → `VIBECTX_CACHE_DIR` (D-45: the old env name retired at 0.3.0).
 *
 * `renameSync` and (PAR-859/PAR-805 gate decision) `chmodSync` are the only things mocked, and
 * only so "the rename fails" / "the chmod fails" cases can be exercised without a second
 * filesystem: every other fs call in this file is the real one. `renameImpl`/`chmodImpl` are
 * what `node:fs.renameSync`/`chmodSync` do for the duration of one test.
 */
let renameImpl: ((from: string, to: string) => void) | undefined;
let chmodImpl: ((path: string, mode: number) => void) | undefined;
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    renameSync: (from: string, to: string) => (renameImpl ?? actual.renameSync)(from, to),
    chmodSync: (path: string, mode: number) => (chmodImpl ?? actual.chmodSync)(path, mode),
  };
});

const { cacheRoot, ensureCacheRoot, resetCacheRootState, writeCache, libDirName, urlSlug, LEGACY_CACHE_DIR_NAME, CACHE_DIR_NAME } = await import("../src/cache.js");

let home: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  // A configured root is now canonical by contract. macOS exposes its temp directory through
  // `/var` → `/private/var`, so keep fixtures canonical too rather than making host spelling an
  // accidental part of D-45's precedence assertions.
  home = realpathSync(mkdtempSync(join(tmpdir(), "vibectx-home-")));
  saved = {
    HOME: process.env.HOME,
    VIBECTX_CACHE_DIR: process.env.VIBECTX_CACHE_DIR,
    DOCS_CACHE_DIR: process.env.DOCS_CACHE_DIR,
  };
  process.env.HOME = home;
  delete process.env.VIBECTX_CACHE_DIR;
  delete process.env.DOCS_CACHE_DIR;
  renameImpl = undefined;
  chmodImpl = undefined;
  resetCacheRootState();
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  renameImpl = undefined;
  chmodImpl = undefined;
  resetCacheRootState();
  rmSync(home, { recursive: true, force: true });
});

const legacy = () => join(home, LEGACY_CACHE_DIR_NAME);
const current = () => join(home, CACHE_DIR_NAME);

/** A legacy cache with one recognisable file in it, so "the cache survived" is checkable. */
function seedLegacy(): string {
  mkdirSync(join(legacy(), "react"), { recursive: true });
  const marker = join(legacy(), "react", "doc.md");
  writeFileSync(marker, "# react", "utf8");
  return marker;
}

describe("D-45 env selection: current override or default", () => {
  it("VIBECTX_CACHE_DIR selects the root even when the retired variable is set", () => {
    process.env.VIBECTX_CACHE_DIR = join(home, "new");
    process.env.DOCS_CACHE_DIR = join(home, "old");
    const notes: string[] = [];
    expect(cacheRoot({ warn: (m) => notes.push(m) })).toBe(join(home, "new"));
    expect(notes).toEqual([]);
  });

  it("DOCS_CACHE_DIR no longer selects a cache root in 0.3.0", () => {
    process.env.DOCS_CACHE_DIR = join(home, "old");
    expect(cacheRoot({ warn: () => {} })).toBe(current());
  });

  it("with neither set, the default is ~/.vibectx", () => {
    expect(cacheRoot({ warn: () => {} })).toBe(current());
  });

  it("an empty value is not a cache directory — it reads as unset", () => {
    process.env.VIBECTX_CACHE_DIR = "";
    process.env.DOCS_CACHE_DIR = join(home, "old");
    expect(cacheRoot({ warn: () => {} })).toBe(current());
  });
});

/** AUDIT-20260920-03 — an ancestor symlink is allowed in a configured cache path: its target is
 * the configured root. The first resolution is pinned, so changing that ancestor later cannot
 * redirect a later cache write. This preserves D-84: no ownership or mode refusal is involved. */
describe("configured cache-root canonical pinning (AUDIT-20260920-03)", () => {
  it("pins the canonical root before an ancestor-symlink swap, so a later write never reaches the swapped-in target", () => {
    const firstTarget = join(home, "first-target");
    const swappedTarget = join(home, "swapped-target");
    const ancestor = join(home, "configured-parent");
    mkdirSync(firstTarget);
    mkdirSync(swappedTarget);
    symlinkSync(firstTarget, ancestor);
    process.env.VIBECTX_CACHE_DIR = join(ancestor, "cache");
    const firstRoot = join(firstTarget, "cache");
    expect(cacheRoot()).toBe(firstRoot); // pin while the original ancestor target is in force

    const firstUrl = "https://docs.example.test/first";
    writeCache("first", firstUrl, "first document");
    unlinkSync(ancestor);
    symlinkSync(swappedTarget, ancestor);

    const secondUrl = "https://docs.example.test/second";
    writeCache("second", secondUrl, "must stay in the pinned root");

    expect(existsSync(join(firstRoot, libDirName("second"), `${urlSlug(secondUrl)}.md`))).toBe(true);
    expect(existsSync(join(swappedTarget, "cache", libDirName("second"), `${urlSlug(secondUrl)}.md`))).toBe(false);
  });

  it("keeps a benign /var-style ancestor symlink working through its canonical root", () => {
    const physical = join(home, "private-var");
    const varStyle = join(home, "var");
    mkdirSync(physical);
    symlinkSync(physical, varStyle);
    process.env.VIBECTX_CACHE_DIR = join(varStyle, "vibectx");
    const url = "https://docs.example.test/platform";

    expect(cacheRoot()).toBe(join(physical, "vibectx"));
    writeCache("platform", url, "platform-compatible cache");
    expect(existsSync(join(physical, "vibectx", libDirName("platform"), `${urlSlug(url)}.md`))).toBe(true);
  });
});

describe("D-45 retired environment variable", () => {
  it("does not select the old root or emit a stale deprecation note", () => {
    process.env.DOCS_CACHE_DIR = join(home, "old");
    const notes: string[] = [];
    const warn = (m: string) => notes.push(m);
    cacheRoot({ warn });
    cacheRoot({ warn });
    cacheRoot({ warn });
    expect(cacheRoot({ warn })).toBe(current());
    expect(notes).toEqual([]);
  });

  it("does not fire when the new name is set, even if the old one is too", () => {
    process.env.VIBECTX_CACHE_DIR = join(home, "new");
    process.env.DOCS_CACHE_DIR = join(home, "old");
    const notes: string[] = [];
    cacheRoot({ warn: (m) => notes.push(m) });
    expect(notes).toEqual([]);
  });
});

describe("D-45 one-time migration of ~/.docs-cache-mcp", () => {
  it("renames the old directory once and keeps its contents", () => {
    const marker = seedLegacy();
    const notes: string[] = [];
    expect(cacheRoot({ warn: (m) => notes.push(m) })).toBe(current());
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(current(), "react", "doc.md"), "utf8")).toBe("# react");
    expect(existsSync(legacy())).toBe(false);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(legacy());
    expect(notes[0]).toContain(current());
  });

  it("says it once, however many times cacheRoot is called", () => {
    seedLegacy();
    const notes: string[] = [];
    const warn = (m: string) => notes.push(m);
    cacheRoot({ warn });
    cacheRoot({ warn });
    expect(notes).toHaveLength(1);
  });

  it("is skipped when ~/.vibectx already exists — the new cache is never overwritten", () => {
    const marker = seedLegacy();
    mkdirSync(current(), { recursive: true });
    writeFileSync(join(current(), "keep.md"), "new", "utf8");
    const notes: string[] = [];
    expect(cacheRoot({ warn: (m) => notes.push(m) })).toBe(current());
    expect(readFileSync(join(current(), "keep.md"), "utf8")).toBe("new");
    expect(existsSync(marker)).toBe(true); // the old cache is left exactly where it was
    expect(notes).toEqual([]);
  });

  it("does nothing at all when there is no legacy directory", () => {
    const notes: string[] = [];
    expect(cacheRoot({ warn: (m) => notes.push(m) })).toBe(current());
    expect(notes).toEqual([]);
  });

  it("a failed rename degrades to the old path for this run rather than throwing", () => {
    const marker = seedLegacy();
    renameImpl = () => {
      const e = new Error("EXDEV: cross-device link not permitted") as NodeJS.ErrnoException;
      e.code = "EXDEV";
      throw e;
    };
    const notes: string[] = [];
    expect(() => cacheRoot({ warn: (m) => notes.push(m) })).not.toThrow();
    expect(cacheRoot({ warn: (m) => notes.push(m) })).toBe(legacy());
    expect(existsSync(marker)).toBe(true); // nothing copied, nothing lost
    expect(existsSync(current())).toBe(false); // and no empty new directory left behind
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("EXDEV");
    expect(notes[0]).toContain(legacy());
  });
});

/**
 * D-46 — the legacy path must be PROVEN a real directory before it is
 * renamed.
 *
 * `existsSync` follows symlinks, so at HEAD a symlinked `~/.docs-cache-mcp` passed rule 2 and
 * rule 3 renamed THE LINK: `~/.vibectx` became a symlink aiming wherever the link aimed, and
 * from then on every cached document — and every eviction — landed in the user's own
 * directory. `renameSync` operates on the link itself, which is exactly why nothing about the
 * target being someone's `Documents` folder stopped it.
 *
 * The refusal degrades the same way a failed rename does (rule 4): keep using the legacy path
 * for this run and say so once. RESIDUAL, stated because it is real: writes during that run
 * still resolve through the link. What is closed here is the PERMANENT capture — `~/.vibectx`
 * is not made a link — and deletion, which the D-46 root guard in cache-evict.ts refuses.
 */
describe("D-46: a symlinked legacy cache directory is refused, not renamed", () => {
  let target: string;
  let victim: string;
  beforeEach(() => {
    target = mkdtempSync(join(tmpdir(), "vibectx-victim-"));
    victim = join(target, "thesis.md");
    writeFileSync(victim, "# My thesis", "utf8");
  });
  afterEach(() => {
    rmSync(target, { recursive: true, force: true });
  });

  const legacyIsLinkTo = (dest: string) => symlinkSync(dest, legacy());

  it("never renames the link, so ~/.vibectx cannot become a link aimed at user files", () => {
    legacyIsLinkTo(target);
    const notes: string[] = [];
    const root = cacheRoot({ warn: (m) => notes.push(m) });

    expect(existsSync(current())).toBe(false); // nothing was created at the new path
    expect(lstatSync(legacy()).isSymbolicLink()).toBe(true); // the link is exactly where it was
    expect(realpathSync(legacy())).toBe(realpathSync(target));
    expect(existsSync(victim)).toBe(true);
    expect(root).toBe(legacy()); // degraded in place, as a failed rename does
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("symlink");
    expect(notes[0]).toContain(legacy());
  });

  it("says it once per process, however many times cacheRoot is called", () => {
    legacyIsLinkTo(target);
    const notes: string[] = [];
    const warn = (m: string) => notes.push(m);
    cacheRoot({ warn });
    cacheRoot({ warn });
    cacheRoot({ warn });
    expect(notes).toHaveLength(1);
  });

  it("refuses a legacy path that exists but is not a directory", () => {
    writeFileSync(legacy(), "not a cache", "utf8");
    const notes: string[] = [];
    cacheRoot({ warn: (m) => notes.push(m) });
    expect(existsSync(current())).toBe(false);
    expect(readFileSync(legacy(), "utf8")).toBe("not a cache");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("not a directory");
  });

  it("a real legacy directory still migrates — the guard costs the good case nothing", () => {
    const marker = seedLegacy();
    const notes: string[] = [];
    expect(cacheRoot({ warn: (m) => notes.push(m) })).toBe(current());
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(current(), "react", "doc.md"), "utf8")).toBe("# react");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("moved the cache directory");
  });
});

/**
 * PAR-652b (security-gate note, info) — rule 1 was silent about what it left behind.
 *
 * `~/.vibectx` existing wins outright, and rightly so: a user with both directories has
 * already moved on, and overwriting the newer cache with the older one is the worst outcome
 * available here. But an EMPTY `~/.vibectx` — created by a `mkdir`, a dotfile manager, a
 * half-finished earlier run — took the same path and said nothing, so a full legacy cache sat
 * there stranded while the tool re-downloaded every document the user already had.
 *
 * The fix is a note, not a move: rule 1 does not change, the user is simply told where the
 * old cache is and what to do with it.
 */
describe("an empty ~/.vibectx no longer strands a legacy cache silently", () => {
  it("names both directories, once, and moves nothing", () => {
    const marker = seedLegacy();
    mkdirSync(current(), { recursive: true }); // empty
    const notes: string[] = [];
    const warn = (m: string) => notes.push(m);

    expect(cacheRoot({ warn })).toBe(current());
    cacheRoot({ warn });
    cacheRoot({ warn });

    expect(existsSync(marker)).toBe(true); // the legacy cache is exactly where it was
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(legacy());
    expect(notes[0]).toContain(current());
  });

  it("says nothing when ~/.vibectx already holds a cache — that user has moved on", () => {
    seedLegacy();
    mkdirSync(current(), { recursive: true });
    writeFileSync(join(current(), "keep.md"), "new", "utf8");
    const notes: string[] = [];
    expect(cacheRoot({ warn: (m) => notes.push(m) })).toBe(current());
    expect(notes).toEqual([]);
  });

  it("says nothing when there is no legacy directory to strand", () => {
    mkdirSync(current(), { recursive: true });
    const notes: string[] = [];
    expect(cacheRoot({ warn: (m) => notes.push(m) })).toBe(current());
    expect(notes).toEqual([]);
  });

  it("says nothing when the legacy path is not a real directory", () => {
    mkdirSync(current(), { recursive: true });
    const elsewhere = mkdtempSync(join(tmpdir(), "vibectx-elsewhere-"));
    try {
      symlinkSync(elsewhere, legacy());
      const notes: string[] = [];
      expect(cacheRoot({ warn: (m) => notes.push(m) })).toBe(current());
      expect(notes).toEqual([]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
    expect(existsSync(elsewhere)).toBe(false);
  });
});

/**
 * Gate decision (Tom, PAR-805/PAR-859, 2026-09-18, amending D-84) — recorded verbatim in
 * `docs/decisions.md`: a pre-existing DEFAULT root (`~/.vibectx`, reached only when
 * `VIBECTX_CACHE_DIR` is unset) found looser than
 * `0700` is `chmod`'d to `0700` on the next call, with one stderr line saying what was done. An
 * env-CONFIGURED root keeps the original, warn-only behaviour unchanged — that case is already
 * covered by `test/cache-permissions.test.ts`'s "a pre-existing, looser-than-0700 cache root is
 * disclosed, never tightened or refused" describe block (which sets `VIBECTX_CACHE_DIR`), and
 * this file's own `beforeEach` deletes both env vars, so every test below is exercising the
 * DEFAULT-root branch specifically.
 */
describe("Gate decision (Tom, PAR-805/PAR-859, 2026-09-18) — the DEFAULT cache root is auto-tightened when found looser than 0700", () => {
  it("a retired DOCS_CACHE_DIR setting does not suppress default-root tightening", () => {
    process.env.DOCS_CACHE_DIR = join(home, "old");
    mkdirSync(current(), { recursive: true });
    chmodSync(current(), 0o755);
    const notes: string[] = [];
    const root = cacheRoot({ warn: (m) => notes.push(m) });
    expect(root).toBe(current());
    expect(ensureCacheRoot(root, (m) => notes.push(m))).toBe(true);
    expect(lstatSync(current()).mode & 0o777).toBe(0o700);
    expect(notes.some((note) => note.includes("tightened"))).toBe(true);
  });

  it("a pre-existing default root at 0755 is tightened to 0700 on the next call, with one stderr line naming the mode change", () => {
    mkdirSync(current(), { recursive: true });
    chmodSync(current(), 0o755);
    expect(lstatSync(current()).mode & 0o777).toBe(0o755);
    const root = cacheRoot({ warn: () => {} });
    const notes: string[] = [];

    expect(ensureCacheRoot(root, (m) => notes.push(m))).toBe(true);

    expect(lstatSync(current()).mode & 0o777).toBe(0o700);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(current());
    expect(notes[0]).toContain("0755");
    expect(notes[0]).toContain("tightened");
  });

  it("says it once per process, however many times ensureCacheRoot is called for the same root", () => {
    mkdirSync(current(), { recursive: true });
    chmodSync(current(), 0o755);
    const root = cacheRoot({ warn: () => {} });
    const notes: string[] = [];

    ensureCacheRoot(root, (m) => notes.push(m));
    ensureCacheRoot(root, (m) => notes.push(m));
    ensureCacheRoot(root, (m) => notes.push(m));

    expect(notes).toHaveLength(1);
  });

  it("does not touch a default root that is already 0700 — no warning, nothing to tighten", () => {
    mkdirSync(current(), { recursive: true, mode: 0o700 });
    const root = cacheRoot({ warn: () => {} });
    const notes: string[] = [];

    expect(ensureCacheRoot(root, (m) => notes.push(m))).toBe(true);

    expect(lstatSync(current()).mode & 0o777).toBe(0o700);
    expect(notes).toEqual([]);
  });

  /**
   * A hardening attempt must never be the reason an ordinary retrieval fails (this function's
   * own doc comment). `EPERM` here stands for the realistic case: a default root now owned by a
   * different user than the one running this process, or a read-only filesystem it sits on.
   */
  it("EPERM on chmod is warned about, never thrown — ensureCacheRoot still returns true and leaves the root exactly as it was", () => {
    mkdirSync(current(), { recursive: true });
    chmodSync(current(), 0o755);
    chmodImpl = () => {
      const e = new Error("EPERM: operation not permitted, chmod") as NodeJS.ErrnoException;
      e.code = "EPERM";
      throw e;
    };
    const root = cacheRoot({ warn: () => {} });
    const notes: string[] = [];

    let result: boolean | undefined;
    expect(() => {
      result = ensureCacheRoot(root, (m) => notes.push(m));
    }).not.toThrow();

    expect(result).toBe(true); // the directory is still usable — only the chmod attempt failed
    expect(lstatSync(current()).mode & 0o777).toBe(0o755); // left exactly as it was
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(current());
    expect(notes[0]).toContain("could not tighten");
    expect(notes[0]).toContain("EPERM");
  });

  /**
   * security-architect (Phase 1b review round, optional hardening) — the TOCTOU-narrowing
   * ownership guard: `chmodSync` is only attempted when the directory `ensureCacheRoot` just
   * `lstat`'d is owned by THIS process. `process.getuid` is mocked here, not `lstatSync` — the
   * real directory this test creates is genuinely owned by whatever user runs the suite, so
   * making `process.getuid()` report a DIFFERENT uid is what fakes the mismatch, without needing
   * a second filesystem identity this test cannot create.
   */
  it("a default root not owned by this process is left untouched, with a distinct message, not silently tightened (mutation target: the ownedByThisProcess/stat.uid guard)", () => {
    mkdirSync(current(), { recursive: true });
    chmodSync(current(), 0o755);
    const realUid = process.getuid!();
    const getuidSpy = vi.spyOn(process, "getuid").mockReturnValue(realUid + 1);
    try {
      const root = cacheRoot({ warn: () => {} });
      const notes: string[] = [];

      expect(ensureCacheRoot(root, (m) => notes.push(m))).toBe(true);

      expect(lstatSync(current()).mode & 0o777).toBe(0o755); // NOT tightened
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain(current());
      expect(notes[0]).toContain("not owned by this process");
      expect(notes[0]).not.toContain("tightened"); // distinct from the successful-tighten message
    } finally {
      getuidSpy.mockRestore();
    }
  });
});
