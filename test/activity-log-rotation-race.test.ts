import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * PAR-1039 (F14.2) — two processes rotating at once must never overwrite an archive. The race is
 * made deterministic by hiding one archive from the directory listing this process numbers its
 * own archive from, exactly as if another process created it between that listing and the
 * rename. The rename must then fail rather than replace the other process's archive, and the
 * entry being logged must still be kept.
 */
let hideFromListing: string | undefined;
let hidden = 0;
/** When set, the first unlink of this path is followed at once by another "process" creating
 *  it with one record — the window between moving the old live file and creating the new one. */
let recreateAfterUnlink: { path: string; content: string } | undefined;
let recreated = 0;
/** When set, unlinking this path fails as if another process had already removed it. */
let failUnlinkOf: string | undefined;
/** When set, runs once just before the first unlink of this path: another process's complete
 *  logging call, interleaved inside this process's rotation (audit F-A1039-1). */
let beforeUnlinkOf: { path: string; run: () => void } | undefined;
let interleaved = 0;
/** When set, runs once just before the first rename of this path: another process replacing a
 *  stale marker with its own fresh one inside this process's stale-marker handoff. */
let beforeRenameOf: { path: string; run: () => void } | undefined;
/** Staged just before the hard link, the way another process's own rotation would do it: the
 *  read file is first given that process's archive name (so it stays alive and its inode is not
 *  reused — on Linux a freed inode number is reused at once, which a plain delete would fake),
 *  then "vanish" removes the live name, "swap" also starts a new live file; "nolinks" throws as a
 *  file system without hard links does. */
let beforeLink: "vanish" | "swap" | "nolinks" | undefined;
let staged = 0;
let swapContent = "";
const OTHER_ARCHIVE = "activity-000077.json";
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readdirSync = ((path: unknown, opts?: unknown) => {
    const names = (actual.readdirSync as (...a: unknown[]) => string[])(path, opts);
    if (hideFromListing === undefined || !names.includes(hideFromListing)) return names;
    hidden += 1;
    return names.filter((n) => n !== hideFromListing);
  }) as typeof actual.readdirSync;
  const unlinkSync = ((path: unknown) => {
    if (beforeUnlinkOf !== undefined && String(path) === beforeUnlinkOf.path) {
      const { run } = beforeUnlinkOf;
      beforeUnlinkOf = undefined;
      interleaved += 1;
      run();
    }
    if (failUnlinkOf !== undefined && String(path) === failUnlinkOf) {
      failUnlinkOf = undefined;
      staged += 1;
      throw Object.assign(new Error("ENOENT: no such file or directory, unlink"), { code: "ENOENT" });
    }
    (actual.unlinkSync as (p: unknown) => void)(path);
    if (recreateAfterUnlink !== undefined && String(path) === recreateAfterUnlink.path) {
      actual.writeFileSync(recreateAfterUnlink.path, recreateAfterUnlink.content, { mode: 0o600 });
      recreateAfterUnlink = undefined;
      recreated += 1;
    }
  }) as typeof actual.unlinkSync;
  const linkSync = ((existing: unknown, newPath: unknown) => {
    const stage = beforeLink;
    if (stage !== undefined) {
      beforeLink = undefined;
      staged += 1;
      if (stage === "nolinks") throw Object.assign(new Error("EPERM: operation not permitted, link"), { code: "EPERM" });
      actual.linkSync(String(existing), join(String(existing), "..", OTHER_ARCHIVE));
      actual.rmSync(String(existing));
      if (stage === "swap") actual.writeFileSync(String(existing), `${swapContent}\n`, { mode: 0o600 });
    }
    return (actual.linkSync as (a: unknown, b: unknown) => void)(existing, newPath);
  }) as typeof actual.linkSync;
  const renameSync = ((from: unknown, to: unknown) => {
    if (beforeRenameOf !== undefined && String(from) === beforeRenameOf.path) {
      const { run } = beforeRenameOf;
      beforeRenameOf = undefined;
      interleaved += 1;
      run();
    }
    return (actual.renameSync as (a: unknown, b: unknown) => void)(from, to);
  }) as typeof actual.renameSync;
  return { ...actual, default: { ...actual, readdirSync, unlinkSync, linkSync, renameSync }, readdirSync, unlinkSync, linkSync, renameSync };
});

const { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } = await import("node:fs");
const { ACTIVITY_LOG_SCHEMA_VERSION, activityLogPath, configureActivityLog, readActivityLog, recordActivity } = await import("../src/activity-log.js");

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "vibectx-rotation-race-")));
  process.env.VIBECTX_CACHE_DIR = dir;
  configureActivityLog({});
  hideFromListing = undefined;
  hidden = 0;
  recreateAfterUnlink = undefined;
  recreated = 0;
  beforeLink = undefined;
  staged = 0;
  failUnlinkOf = undefined;
  beforeUnlinkOf = undefined;
  beforeRenameOf = undefined;
  interleaved = 0;
});

function seed4000() {
  const seeded: string[] = [];
  for (let i = 0; i < 4000; i++) seeded.push(JSON.stringify({ schemaVersion: ACTIVITY_LOG_SCHEMA_VERSION, tool: "search", query: `q${i}`, outcome: "matched", timestamp: at(i) }));
  writeFileSync(activityLogPath(), `${seeded.join("\n")}\n`, { mode: 0o600 });
}
const logOne = (query: string, warn: (m: string) => void = () => {}) =>
  recordActivity({ tool: "search", query, outcome: "matched" }, { env: {}, warn, now: () => new Date(at(5000)) });
afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const at = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();

describe("PAR-1039 (F14.2): concurrent rotation", () => {
  it("PAR-1039 (F14.2): a rotation that finds its archive name already taken does not overwrite it, and the entry is kept", () => {
    const seeded: string[] = [];
    for (let i = 0; i < 4000; i++) seeded.push(JSON.stringify({ schemaVersion: ACTIVITY_LOG_SCHEMA_VERSION, tool: "search", query: `q${i}`, outcome: "matched", timestamp: at(i) }));
    writeFileSync(activityLogPath(), `${seeded.join("\n")}\n`, { mode: 0o600 });
    const theirs = join(dir, "activity-000001.json");
    writeFileSync(theirs, "another process's archive\n", { mode: 0o600 });
    hideFromListing = "activity-000001.json";

    recordActivity({ tool: "search", query: "q4000", outcome: "matched" }, { env: {}, warn: () => {}, now: () => new Date(at(4000)) });

    expect(hidden).toBeGreaterThan(0); // the race was really staged
    expect(readFileSync(theirs, "utf8")).toBe("another process's archive\n");
    hideFromListing = undefined;
    expect(readActivityLog().entries.some((e) => e.query === "q4000")).toBe(true);
  });

  it("PAR-1039: a record another process writes between the move and the new file is kept, and the link record still lands", () => {
    const seeded: string[] = [];
    for (let i = 0; i < 4000; i++) seeded.push(JSON.stringify({ schemaVersion: ACTIVITY_LOG_SCHEMA_VERSION, tool: "search", query: `q${i}`, outcome: "matched", timestamp: at(i) }));
    writeFileSync(activityLogPath(), `${seeded.join("\n")}\n`, { mode: 0o600 });
    const theirs = JSON.stringify({ schemaVersion: ACTIVITY_LOG_SCHEMA_VERSION, tool: "search", query: "theirs", outcome: "matched", timestamp: at(4000) });
    recreateAfterUnlink = { path: activityLogPath(), content: `${theirs}\n` };

    recordActivity({ tool: "search", query: "ours", outcome: "matched" }, { env: {}, warn: () => {}, now: () => new Date(at(4001)) });

    expect(recreated).toBe(1); // the race was really staged
    const live = readFileSync(activityLogPath(), "utf8");
    expect(live.startsWith(`${theirs}\n`)).toBe(true); // their record was not replaced
    expect(live).toContain('"type":"rotation"');
    const queries = readActivityLog().entries.map((e) => e.query);
    expect(queries.slice(-2)).toEqual(["theirs", "ours"]);
    expect(queries).toContain("q3999"); // the archive is still reached through the late link record
  });

  it("PAR-1039: a live file that vanished just before archiving (another process moved it) keeps the entry", () => {
    seed4000();
    beforeLink = "vanish";
    const warnings: string[] = [];
    logOne("ours", (m) => warnings.push(m));
    expect(staged).toBe(1);
    expect(warnings).toEqual([]);
    expect(readdirSync(dir).filter((n) => n.startsWith("activity-"))).toEqual([OTHER_ARCHIVE]);
    expect(readActivityLog().entries.map((e) => e.query)).toEqual(["ours"]);
  });

  it("PAR-1039: a live file replaced after it was read is not archived; the entry joins the new file", () => {
    seed4000();
    swapContent = JSON.stringify({ schemaVersion: ACTIVITY_LOG_SCHEMA_VERSION, tool: "search", query: "theirs", outcome: "matched", timestamp: at(4999) });
    beforeLink = "swap";
    logOne("ours");
    expect(staged).toBe(1);
    // Only the other process's archive remains: the name this process made for the file was removed.
    expect(readdirSync(dir).filter((n) => n.startsWith("activity-"))).toEqual([OTHER_ARCHIVE]);
    expect(readActivityLog().entries.map((e) => e.query)).toEqual(["theirs", "ours"]);
  });

  it("PAR-1039: on a file system without hard links, rotation falls back to a checked rename", () => {
    seed4000();
    beforeLink = "nolinks";
    const warnings: string[] = [];
    logOne("ours", (m) => warnings.push(m));
    expect(staged).toBe(1);
    expect(readdirSync(dir).filter((n) => n.startsWith("activity-"))).toEqual(["activity-000001.json"]);
    expect(readFileSync(join(dir, "activity-000001.json"), "utf8").split("\n").filter(Boolean)).toHaveLength(4000);
    expect(warnings).toEqual(["vibectx: activity log rotated: 4000 entries moved to activity-000001.json"]);
  });

  it("PAR-1039: the no-hard-link fallback never renames onto an archive another process already made", () => {
    seed4000();
    const theirs = join(dir, "activity-000001.json");
    writeFileSync(theirs, "another process's archive\n", { mode: 0o600 });
    hideFromListing = "activity-000001.json";
    beforeLink = "nolinks";
    logOne("ours");
    expect(staged).toBe(1);
    expect(hidden).toBeGreaterThan(0);
    expect(readFileSync(theirs, "utf8")).toBe("another process's archive\n");
    hideFromListing = undefined;
    expect(readActivityLog().entries.some((e) => e.query === "ours")).toBe(true);
  });

  it("PAR-1039: when the old name cannot be removed after archiving, no second archive name is left behind", () => {
    seed4000();
    failUnlinkOf = activityLogPath();
    logOne("ours");
    expect(staged).toBe(1);
    expect(readdirSync(dir).filter((n) => n.startsWith("activity-"))).toEqual([]);
    const entries = readActivityLog().entries;
    expect(entries[entries.length - 1].query).toBe("ours");
  });

  it("PAR-1039 audit (F-A1039-1): a second process rotating the same file mid-rotation does not lose its entry", () => {
    seed4000();
    // Process B's whole logging call runs after process A has archived the full file but before
    // A removes the live name: B also sees the same full file and would rotate it too.
    beforeUnlinkOf = { path: activityLogPath(), run: () => logOne("peer") };
    logOne("ours");
    expect(interleaved).toBe(1); // the interleaving was really staged
    const queries = readActivityLog().entries.map((e) => e.query);
    expect(queries).toContain("peer");
    expect(queries).toContain("ours");
  });

  it("PAR-1039 audit pass 2: a stale marker replaced by another process's fresh one mid-handoff is not taken; that holder keeps it", async () => {
    const { statSync, utimesSync, existsSync } = await import("node:fs");
    seed4000();
    const st = statSync(activityLogPath());
    const claim = join(dir, `activity.json.rotating-${st.dev}-${st.ino}`);
    writeFileSync(claim, "1\n", { mode: 0o600 }); // stale by age
    const old = new Date(Date.now() - 120_000);
    utimesSync(claim, old, old);
    // Between this process judging the marker stale and moving it aside, another process clears
    // it and takes its own fresh claim (naming this process, so it is "held" by a live process).
    // Rewritten in place, so the fresh marker keeps the stale one's inode number: exactly what
    // Linux inode reuse produces when the stale file is deleted and a new one created.
    beforeRenameOf = { path: claim, run: () => writeFileSync(claim, `${process.pid}\n`, { mode: 0o600 }) };
    logOne("ours");
    expect(interleaved).toBe(1); // the handoff race was really staged
    expect(readdirSync(dir).filter((n) => /^activity-\d+\.json$/.test(n))).toEqual([]); // no second rotation
    expect(existsSync(claim)).toBe(true); // the other holder's fresh marker is back in place
    expect(readFileSync(claim, "utf8")).toBe(`${process.pid}\n`);
    expect(readActivityLog().entries.some((e) => e.query === "ours")).toBe(true); // our entry kept
  });
});
