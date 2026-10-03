import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, appendFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTIVITY_LOG_SCHEMA_VERSION,
  activityLogPath,
  configureActivityLog,
  readActivityLog,
  readActivityTrail,
  recordActivity,
} from "../src/activity-log.js";
import { ACTIVITY_LOG_MAX_ENTRIES, ACTIVITY_LOG_ROTATE_ENTRIES, DEFAULT_ACTIVITY_LOG_ARCHIVES } from "../src/limits.js";
import { dispatchCli, runLogCli } from "../src/cli.js";

/**
 * PAR-1039 (final audit M-5, L-19; amends B-24) — the live `activity.json` rotates at
 * ACTIVITY_LOG_ROTATE_ENTRIES into a sequence-named archive, and each new file's first line is a
 * link record to the archive it replaced, so the files form a trail back to the oldest kept.
 * Tests seed the live file directly with NDJSON records (the format `recordActivity` appends), so
 * the 4,000-entry threshold is reached without 4,000 logged calls.
 */
let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "vibectx-rotation-")));
  process.env.VIBECTX_CACHE_DIR = dir;
  configureActivityLog({});
});
afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  configureActivityLog({});
  rmSync(dir, { recursive: true, force: true });
});

const at = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
const record = (i: number) => JSON.stringify({ schemaVersion: ACTIVITY_LOG_SCHEMA_VERSION, tool: "search", query: `q${i}`, outcome: "matched", timestamp: at(i) });
/** NDJSON for entries [from, to). */
const lines = (from: number, to: number) => {
  const out: string[] = [];
  for (let i = from; i < to; i++) out.push(record(i));
  return `${out.join("\n")}\n`;
};
const seedLive = (from: number, to: number) => writeFileSync(activityLogPath(), lines(from, to), { mode: 0o600 });
const archives = () => readdirSync(dir).filter((n) => /^activity-\d{6,}\.json$/.test(n)).sort();
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const firstLine = (path: string) => JSON.parse(readFileSync(path, "utf8").split("\n")[0]) as Record<string, unknown>;

function log(i: number, opts: { env?: NodeJS.ProcessEnv; warn?: (m: string) => void } = {}) {
  recordActivity({ tool: "search", query: `q${i}`, outcome: "matched" }, { env: opts.env ?? {}, warn: opts.warn ?? (() => {}), now: () => new Date(at(i)) });
}

/** A real process that stays running until the test kills it, for markers that must name a live
 *  holder on every platform (a made-up ID may or may not be in use, depending on the machine). */
async function liveHolder() {
  const { spawn } = await import("node:child_process");
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
}

/** Rotate `n` times: each round fills the live file to the threshold, then logs one entry. */
function rotateTimes(n: number, opts: { env?: NodeJS.ProcessEnv; warn?: (m: string) => void } = {}) {
  let next = 0;
  for (let r = 0; r < n; r++) {
    const live = activityLogPath();
    const missing = ACTIVITY_LOG_ROTATE_ENTRIES - (existsSync(live) ? readFileSync(live, "utf8").split("\n").filter((l) => l.trim() !== "" && !l.includes('"type":"rotation"')).length : 0);
    if (missing > 0) appendFileSync(live, lines(next, next + missing), { mode: 0o600 });
    next += missing;
    log(next++, opts);
  }
  return next;
}

describe("PAR-1039: rotation with a linked trail", () => {
  it("constants match Tom's decision: rotate at 4,000 entries, keep 5 archives, show 2,000", () => {
    expect(ACTIVITY_LOG_ROTATE_ENTRIES).toBe(4000);
    expect(DEFAULT_ACTIVITY_LOG_ARCHIVES).toBe(5);
    expect(ACTIVITY_LOG_MAX_ENTRIES).toBe(2000);
  });

  it("PAR-1039: the next entry after 4,000 rotates the live log to activity-000001.json, with one stderr line", () => {
    seedLive(0, 4000);
    const before = readFileSync(activityLogPath());
    const warnings: string[] = [];
    log(4000, { warn: (m) => warnings.push(m) });
    expect(archives()).toEqual(["activity-000001.json"]);
    expect(readFileSync(join(dir, "activity-000001.json")).equals(before)).toBe(true); // moved intact
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^vibectx: activity log rotated: 4000 entries moved to activity-000001\.json/);
    const live = readFileSync(activityLogPath(), "utf8").trim().split("\n");
    expect(live).toHaveLength(2); // link record + the new entry
    expect(JSON.parse(live[1])).toMatchObject({ query: "q4000", timestamp: at(4000) });
    expect(statSync(activityLogPath()).mode & 0o777).toBe(0o600);
  });

  it("PAR-1039: below 4,000 entries nothing rotates", () => {
    seedLive(0, 3999);
    log(3999);
    expect(archives()).toEqual([]);
    expect(readActivityLog().problem).toBeUndefined();
  });

  it("PAR-1039: the new file's first line is a link record naming the archive, its count, first and last timestamps, SHA-256 and rotatedAt", () => {
    seedLive(0, 4000);
    log(4000);
    const archive = join(dir, "activity-000001.json");
    expect(firstLine(activityLogPath())).toEqual({
      schemaVersion: ACTIVITY_LOG_SCHEMA_VERSION,
      type: "rotation",
      previous: "activity-000001.json",
      previousSeq: 1,
      previousEntries: 4000,
      previousFirstAt: at(0),
      previousLastAt: at(3999),
      previousSha256: sha256(archive),
      previousBytes: statSync(archive).size,
      rotatedAt: at(4000),
    });
  });

  it("PAR-1039: each rotation links to the one before it, so the files form a chain", () => {
    rotateTimes(3);
    expect(archives()).toEqual(["activity-000001.json", "activity-000002.json", "activity-000003.json"]);
    expect(firstLine(activityLogPath())).toMatchObject({ type: "rotation", previous: "activity-000003.json", previousSeq: 3 });
    expect(firstLine(join(dir, "activity-000003.json"))).toMatchObject({ type: "rotation", previous: "activity-000002.json", previousSeq: 2 });
    expect(firstLine(join(dir, "activity-000002.json"))).toMatchObject({ type: "rotation", previous: "activity-000001.json", previousSeq: 1 });
    expect(firstLine(join(dir, "activity-000001.json")).type).toBeUndefined(); // the first-ever file has no link
  });

  it("PAR-1039: vibectx log follows the chain for the newest 2,000 entries across the live file and archives", () => {
    seedLive(0, 4000);
    log(4000);
    for (let i = 4001; i < 4010; i++) log(i);
    expect(archives()).toEqual(["activity-000001.json"]); // the entries really span two files
    expect(readFileSync(activityLogPath(), "utf8").trim().split("\n")).toHaveLength(11); // link + 10
    const report = readActivityLog();
    expect(report.entries).toHaveLength(ACTIVITY_LOG_MAX_ENTRIES);
    expect(report.entries[0].timestamp).toBe(at(2010)); // 1,990 from the archive's end…
    expect(report.entries[report.entries.length - 1].timestamp).toBe(at(4009)); // …then the 10 live ones
    expect(report.problem).toBeUndefined(); // the link record is not an invalid entry
  });

  it("PAR-1039: a retention drop is reported as 'older history removed: <archive>'", () => {
    rotateTimes(6);
    expect(archives()).toEqual(["activity-000002.json", "activity-000003.json", "activity-000004.json", "activity-000005.json", "activity-000006.json"]);
    // Walk the whole trail: the oldest kept archive still names the removed one.
    const trail = readActivityTrail();
    expect(trail.end).toEqual({ kind: "removed", name: "activity-000001.json" });
    const report = readActivityLog();
    expect(report.problem).toContain("older history removed: activity-000001.json");
  });

  it("PAR-1039: the rotation that drops an archive names it on its one stderr line", () => {
    rotateTimes(5);
    const warnings: string[] = [];
    rotateTimes(1, { warn: (m) => warnings.push(m) });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/moved to activity-000006\.json; older history removed: activity-000001\.json$/);
  });

  it("PAR-1039: a planted-symlink archive in the chain is refused, not followed", () => {
    rotateTimes(2);
    const outside = join(mkdtempSync(join(tmpdir(), "vibectx-rotation-outside-")), "foreign.json");
    writeFileSync(outside, lines(9000, 9005));
    const archive = join(dir, "activity-000002.json");
    rmSync(archive);
    symlinkSync(outside, archive);
    const report = readActivityLog();
    expect(report.entries.some((e) => e.query === "q9000")).toBe(false);
    expect(report.problem).toContain("activity log archive refused: activity-000002.json is not a regular file");
    expect(readActivityTrail().end).toEqual({ kind: "refused", name: "activity-000002.json" });
    rmSync(join(outside, ".."), { recursive: true, force: true });
  });

  it("PAR-1039: a symlink planted at the next archive name is never written through", () => {
    seedLive(0, 4000);
    const outside = join(mkdtempSync(join(tmpdir(), "vibectx-rotation-outside-")), "victim.txt");
    writeFileSync(outside, "precious\n");
    symlinkSync(outside, join(dir, "activity-000001.json"));
    log(4000);
    expect(readFileSync(outside, "utf8")).toBe("precious\n");
    expect(lstatSync(join(dir, "activity-000001.json")).isSymbolicLink()).toBe(true);
    rmSync(join(outside, ".."), { recursive: true, force: true });
  });

  it("PAR-1039: retention follows this trail only; a planted archive name with a large number steers no deletion", () => {
    rotateTimes(2);
    writeFileSync(join(dir, "activity-999999.json"), "planted\n", { mode: 0o600 });
    writeFileSync(join(dir, `activity-${"9".repeat(22)}.json`), "planted\n", { mode: 0o600 }); // not a safe integer
    rotateTimes(1);
    expect(archives()).toContain("activity-000001.json"); // real archives kept: 3 of the default 5
    expect(archives()).toContain("activity-000002.json");
    expect(archives()).toContain("activity-999999.json"); // never removed: not on this trail
    expect(readFileSync(join(dir, "activity-999999.json"), "utf8")).toBe("planted\n");
    // The unsafe 22-digit name is ignored for numbering: the next archive follows 999999, and its
    // link record is valid, so the trail still reaches the start of history.
    expect(archives()).toContain("activity-1000000.json");
    expect(firstLine(activityLogPath())).toMatchObject({ type: "rotation", previous: "activity-1000000.json", previousSeq: 1000000 });
    expect(readActivityTrail().end).toEqual({ kind: "start" });
  });

  it("PAR-1039 audit (F-A1039-1): while another process holds the rotation claim, the entry is appended and nothing rotates", async () => {
    seedLive(0, 4000);
    const st = statSync(activityLogPath());
    const claim = join(dir, `activity.json.rotating-${st.dev}-${st.ino}`);
    const holder = await liveHolder(); // a real, running process: the marker is genuinely held
    writeFileSync(claim, `${holder.pid}\n`, { mode: 0o600 });
    try {
      log(4000);
    } finally {
      holder.kill("SIGKILL");
    }
    expect(archives()).toEqual([]);
    expect(readFileSync(activityLogPath(), "utf8")).toContain('"query":"q4000"');
    expect(existsSync(claim)).toBe(true); // someone else's claim is left alone
  });

  it("PAR-1039 audit (F-A1039-1): a claim older than the stale age is taken over even if its process ID is in use, and removed after rotating", async () => {
    seedLive(0, 4000);
    const st = statSync(activityLogPath());
    const claim = join(dir, `activity.json.rotating-${st.dev}-${st.ino}`);
    const holder = await liveHolder(); // a running process (e.g. a reused ID): only the age rule can clear it
    writeFileSync(claim, `${holder.pid}\n`, { mode: 0o600 });
    const old = new Date(Date.now() - 120_000);
    utimesSync(claim, old, old);
    try {
      log(4000);
    } finally {
      holder.kill("SIGKILL");
    }
    expect(archives()).toEqual(["activity-000001.json"]);
    expect(existsSync(claim)).toBe(false);
  });

  it("PAR-1039 (marker recovery): a marker left by a crashed holder whose process is gone is cleared at once, and rotation resumes", async () => {
    const { spawnSync } = await import("node:child_process");
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid; // a process that has exited
    seedLive(0, 4000);
    const st = statSync(activityLogPath());
    const claim = join(dir, `activity.json.rotating-${st.dev}-${st.ino}`);
    writeFileSync(claim, `${dead}\n`, { mode: 0o600 }); // fresh: the age rule alone would still wait
    log(4000);
    expect(archives()).toEqual(["activity-000001.json"]);
    expect(existsSync(claim)).toBe(false);
  });

  it("PAR-1039 (marker): a link planted at the marker path is never followed or written through, and rotation proceeds", () => {
    seedLive(0, 4000);
    const st = statSync(activityLogPath());
    const claim = join(dir, `activity.json.rotating-${st.dev}-${st.ino}`);
    const outside = join(mkdtempSync(join(tmpdir(), "vibectx-rotation-marker-")), "victim.txt");
    writeFileSync(outside, "precious\n");
    symlinkSync(outside, claim);
    log(4000);
    expect(readFileSync(outside, "utf8")).toBe("precious\n"); // not written through
    expect(archives()).toEqual(["activity-000001.json"]); // rotation was not blocked by the planted link
    expect(existsSync(claim)).toBe(false);
    expect(lstatSync(outside).isFile()).toBe(true);
    rmSync(join(outside, ".."), { recursive: true, force: true });
  });

  it("PAR-1039 audit pass 2 (F-A1039-2): at the archive-number ceiling, rotation is skipped with one line and the trail stays readable", () => {
    rotateTimes(1);
    writeFileSync(join(dir, "activity-999999999999.json"), "planted at the ceiling\n", { mode: 0o600 });
    const warnings: string[] = [];
    rotateTimes(2, { warn: (m) => warnings.push(m) });
    expect(archives()).not.toContain("activity-1000000000000.json");
    expect(readFileSync(activityLogPath(), "utf8")).not.toContain('"previousSeq":1000000000000');
    expect(readActivityTrail().files.map((f) => f.name)).toContain("activity-000001.json"); // still reachable
    expect(warnings.filter((w) => w.includes("archive numbering"))).toHaveLength(1);
  });

  it("PAR-1039 audit (F-A1039-2): a planted archive name at the top of the safe-integer range does not break numbering", () => {
    rotateTimes(1);
    writeFileSync(join(dir, "activity-9007199254740991.json"), "planted\n", { mode: 0o600 });
    rotateTimes(1);
    expect(firstLine(activityLogPath())).toMatchObject({ type: "rotation", previous: "activity-000002.json", previousSeq: 2 });
    const trail = readActivityTrail();
    expect(trail.end).toEqual({ kind: "start" });
    expect(trail.files.map((f) => f.name)).toEqual(["activity.json", "activity-000002.json", "activity-000001.json"]);
    expect(readActivityLog().problem).toBeUndefined();
  });

  it("PAR-1039: an archive that cannot be read as a log ends the trail, and says so", () => {
    rotateTimes(2);
    writeFileSync(join(dir, "activity-000002.json"), "{ not a log", { mode: 0o600 });
    expect(readActivityLog().problem).toContain("archive activity-000002.json cannot be read as a log; older history cannot be followed past it");
    expect(readActivityTrail().end).toEqual({ kind: "unreadable", name: "activity-000002.json" });
  });

  it("PAR-1039: past the 2,000-entry window an unreadable archive still ends the trail with its reason", () => {
    rotateTimes(2); // archive 2 alone fills the window, so archive 1 is reached by its link only
    writeFileSync(join(dir, "activity-000001.json"), "{ not a log", { mode: 0o600 });
    const report = readActivityLog();
    expect(report.entries).toHaveLength(2000);
    expect(report.problem).toContain("archive activity-000001.json cannot be read as a log");
  });

  it("PAR-1039: --trail does not follow a symlinked cache root", () => {
    rotateTimes(1);
    const linkedRoot = join(mkdtempSync(join(tmpdir(), "vibectx-rotation-root-")), "root");
    symlinkSync(dir, linkedRoot);
    process.env.VIBECTX_CACHE_DIR = linkedRoot;
    expect(readActivityTrail().files).toEqual([]);
    process.env.VIBECTX_CACHE_DIR = dir;
    rmSync(join(linkedRoot, ".."), { recursive: true, force: true });
  });

  it("PAR-1039: a link record cannot point outside the cache; the archive name comes from its sequence number only", () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "vibectx-rotation-outside-"));
    writeFileSync(join(outsideDir, "activity-000001.json"), lines(9000, 9005));
    const hostile = { schemaVersion: ACTIVITY_LOG_SCHEMA_VERSION, type: "rotation", previous: `../${outsideDir.split("/").pop()}/activity-000001.json`, previousSeq: 7, previousEntries: 5, rotatedAt: at(1) };
    writeFileSync(activityLogPath(), `${JSON.stringify(hostile)}\n${lines(0, 3)}`);
    const report = readActivityLog();
    expect(report.entries.map((e) => e.query)).toEqual(["q0", "q1", "q2"]);
    expect(report.problem).toContain("older history removed: activity-000007.json");
    rmSync(outsideDir, { recursive: true, force: true });
  });
});

describe("PAR-1039: archive retention setting", () => {
  it("PAR-1039: by default 5 archives are kept", () => {
    rotateTimes(7);
    expect(archives()).toHaveLength(5);
    expect(archives()[0]).toBe("activity-000003.json");
  });

  it("PAR-1039: VIBECTX_LOG_ARCHIVES=0 keeps no archives, and the trail still names what was removed", () => {
    const env = { VIBECTX_LOG_ARCHIVES: "0" };
    rotateTimes(2, { env });
    expect(archives()).toEqual([]);
    expect(readActivityLog().problem).toContain("older history removed: activity-000002.json");
  });

  it("PAR-1039: VIBECTX_LOG_ARCHIVES=2 keeps 2", () => {
    rotateTimes(4, { env: { VIBECTX_LOG_ARCHIVES: "2" } });
    expect(archives()).toEqual(["activity-000003.json", "activity-000004.json"]);
  });

  it("PAR-1039: a bad VIBECTX_LOG_ARCHIVES value prints one stderr line and keeps 5", () => {
    for (const bad of ["-1", "abc", "2.5"]) {
      rmSync(dir, { recursive: true, force: true });
      dir = realpathSync(mkdtempSync(join(tmpdir(), "vibectx-rotation-")));
      process.env.VIBECTX_CACHE_DIR = dir;
      configureActivityLog({});
      const warnings: string[] = [];
      rotateTimes(7, { env: { VIBECTX_LOG_ARCHIVES: bad }, warn: (m) => warnings.push(m) });
      expect(archives(), bad).toHaveLength(5);
      const bad_lines = warnings.filter((w) => w.includes("VIBECTX_LOG_ARCHIVES"));
      expect(bad_lines, bad).toHaveLength(1);
      expect(bad_lines[0], bad).toMatch(/must be a whole number 0 or more; keeping 5/);
    }
  });

  it("PAR-1039: a logArchives value in a config file reaches a real rotation through the CLI's startup", async () => {
    const config = join(dir, "chosen-config.json");
    writeFileSync(config, JSON.stringify({ libraries: [], logArchives: 1 }));
    configureActivityLog({});
    rotateTimes(3); // three archives under the default count
    // Top the live file (link record + 1 entry) up to the threshold, keeping its link record.
    appendFileSync(activityLogPath(), lines(20000, 20000 + ACTIVITY_LOG_ROTATE_ENTRIES - 1));
    const io = { stdout: () => {}, stderr: () => {} };
    const saved = process.env.VIBECTX_CONFIG;
    process.env.VIBECTX_CONFIG = config;
    try {
      // An empty cache finds nothing (exit 1) but still logs the call: the 4,000th-plus entry.
      expect([0, 1]).toContain(await dispatchCli(["node", "dist/index.js", "search", "anything"], io));
    } finally {
      if (saved === undefined) delete process.env.VIBECTX_CONFIG;
      else process.env.VIBECTX_CONFIG = saved;
    }
    expect(archives()).toEqual(["activity-000004.json"]);
  });

  it("PAR-1039: the user-config key logArchives sets the number", () => {
    configureActivityLog({ logArchives: 1 });
    rotateTimes(3);
    expect(archives()).toEqual(["activity-000003.json"]);
  });

  it("PAR-1039: a bad logArchives config value prints one stderr line and keeps 5", () => {
    const warnings: string[] = [];
    configureActivityLog({ logArchives: "lots", warn: (m) => warnings.push(m) });
    rotateTimes(6, { warn: (m) => warnings.push(m) });
    expect(archives()).toHaveLength(5);
    expect(warnings.filter((w) => w.includes("logArchives"))).toHaveLength(1);
  });
});

describe("PAR-1039 (F14): rotation keeps history instead of erasing it", () => {
  it("PAR-1039 (F14.1): a corrupt live file is rotated to an archive, not erased", () => {
    writeFileSync(activityLogPath(), "{ this is not json", { mode: 0o600 });
    const warnings: string[] = [];
    log(1, { warn: (m) => warnings.push(m) });
    expect(warnings).toEqual(["vibectx: activity log rotated: a log that is not valid activity records moved to activity-000001.json"]);
    expect(archives()).toEqual(["activity-000001.json"]);
    expect(readFileSync(join(dir, "activity-000001.json"), "utf8")).toBe("{ this is not json");
    expect(firstLine(activityLogPath())).toMatchObject({ type: "rotation", previous: "activity-000001.json" });
  });

  it("PAR-1039 (F14.1): an oversized live file is rotated to an archive, not erased", () => {
    const big = `${record(0)}\n${"x".repeat(8 * 1024 * 1024 + 10)}\n`;
    writeFileSync(activityLogPath(), big, { mode: 0o600 });
    const warnings: string[] = [];
    log(1, { warn: (m) => warnings.push(m) });
    expect(warnings).toEqual(["vibectx: activity log rotated: a log too large to read moved to activity-000001.json"]);
    expect(archives()).toEqual(["activity-000001.json"]);
    expect(statSync(join(dir, "activity-000001.json")).size).toBe(Buffer.byteLength(big));
    const link = firstLine(activityLogPath());
    expect(link).toMatchObject({ type: "rotation", previous: "activity-000001.json", previousBytes: Buffer.byteLength(big) });
    expect(link.previousSha256).toBeUndefined(); // too large to hash within the read limit; stated, not invented
  });
});

describe("PAR-1039: vibectx log --trail", () => {
  it("PAR-1039: --trail lists each file with its counts, dates and a matching hash", () => {
    rotateTimes(2);
    const trail = readActivityTrail();
    expect(trail.files.map((f) => f.name)).toEqual(["activity.json", "activity-000002.json", "activity-000001.json"]);
    expect(trail.files[1]).toMatchObject({ entries: 4000, hash: "ok" });
    expect(trail.files[2]).toMatchObject({ entries: 4000, firstAt: at(0), lastAt: at(3999), hash: "ok" });
    expect(trail.end).toEqual({ kind: "start" });
  });

  it("PAR-1039: an append that landed after rotation is reported as entries added after rotation, not tampering", () => {
    rotateTimes(1);
    appendFileSync(join(dir, "activity-000001.json"), lines(5000, 5002));
    expect(readActivityTrail().files[1].hash).toBe("entries added after rotation (2 lines)");
  });

  it("PAR-1039: an archive changed in place is reported as a hash mismatch", () => {
    rotateTimes(1);
    const archive = join(dir, "activity-000001.json");
    writeFileSync(archive, readFileSync(archive, "utf8").replace('"q7"', '"qX"'));
    expect(readActivityTrail().files[1].hash).toBe("changed since rotation (hash mismatch)");
  });

  it("PAR-1039: README states rotation, retention, the trail and its limits, and no longer says the log is capped", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const section = readme.match(/^## Activity log: `vibectx log`\n[\s\S]*?(?=\n## )/m)?.[0] ?? "";
    expect(section).toContain("When `activity.json` holds 4,000 entries");
    expect(section).toContain("`activity-000001.json`");
    expect(section).toContain("The newest 5 archives are kept by default");
    expect(section).toContain("`VIBECTX_LOG_ARCHIVES`");
    expect(section).toContain('`"logArchives"` in your user');
    expect(section).toContain("older history removed: activity-000001.json");
    expect(section).toContain("vibectx log --trail");
    expect(section).toContain("entries added after rotation");
    expect(section).toContain("it cannot prove tampering or its absence");
    expect(section).toContain("which takes precedence over the variable");
    expect(section).toContain("Rotation\nitself is single-holder");
    expect(section).toContain("A corrupt or oversized `activity.json` is not erased");
    expect(readme).not.toContain("capped at 2,000 entries");
  });

  it("PAR-1039: vibectx log --trail prints the table; --trail --json prints the trail", async () => {
    rotateTimes(1);
    const out: string[] = [];
    const io = { stdout: (s: string) => void out.push(s), stderr: (s: string) => void out.push(s) };
    expect(await runLogCli(["--trail"], io)).toBe(0);
    expect(out.join("")).toMatch(/activity-000001\.json\s+4000\s+.*ok/);
    expect(out.join("")).toContain("start of history");
    out.length = 0;
    expect(await runLogCli(["--trail", "--json"], io)).toBe(0);
    const json = JSON.parse(out.join("")) as { schemaVersion: number; files: Record<string, unknown>[]; end: unknown };
    expect(json.schemaVersion).toBe(1);
    expect(json.end).toEqual({ kind: "start" });
    expect(json.files).toHaveLength(2);
    expect(json.files[0]).toMatchObject({ name: "activity.json", entries: 1, hash: "live" });
    expect(json.files[1]).toEqual({ name: "activity-000001.json", entries: 4000, firstAt: at(0), lastAt: at(3999), hash: "ok" });
  });
});
