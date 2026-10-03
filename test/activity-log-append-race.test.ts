import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * PAR-1030 (final audit H-1) — the append branch must not follow a symlink that appears AFTER
 * `readActivityFile` saw a regular file. The planted-link case (link already present when the
 * read runs) is `activity-log.test.ts`; this file covers the gap between that read and the
 * append's own open, which only an `O_NOFOLLOW` open closes.
 *
 * The swap is made deterministic by hooking the one `openSync` call that asks for `O_APPEND` on
 * the log's path: the hook replaces the regular file with a link to a victim, then lets the real
 * open run. `swaps` proves the hook actually fired, so the test cannot pass by never reaching the
 * append open (an append done through some other call would leave `swaps` at 0 and fail).
 */
let armedPath: string | undefined;
let victimPath = "";
let swaps = 0;
let swapIn: "symlink" | "fifo" = "symlink";
/** Read side (PAR-1030 audit F-A1030-1): the next read-only open of this path finds a FIFO. A
 *  blocking open of a FIFO with no writer never returns, so the hook records that instead of
 *  hanging the run, and the test asserts it never happened. */
let readArmedPath: string | undefined;
let readWouldBlock = false;
let readSwaps = 0;
vi.mock("node:fs", async (importOriginal) => {
  const actual = { ...(await importOriginal<typeof import("node:fs")>()), execFileSync: (await import("node:child_process")).execFileSync };
  const openSync = ((path: unknown, flags: unknown, mode?: unknown) => {
    if (readArmedPath !== undefined && String(path) === readArmedPath) {
      const numeric = typeof flags === "number" ? flags : flags === "r" ? actual.constants.O_RDONLY : -1;
      if (numeric !== -1 && (numeric & actual.constants.O_APPEND) === 0 && (numeric & actual.constants.O_WRONLY) === 0) {
        readArmedPath = undefined;
        readSwaps += 1;
        actual.rmSync(String(path));
        actual.execFileSync("mkfifo", [String(path)]);
        if ((numeric & actual.constants.O_NONBLOCK) === 0) {
          readWouldBlock = true;
          throw new Error("open would block on a FIFO with no writer");
        }
      }
    }
    if (armedPath !== undefined && String(path) === armedPath && typeof flags === "number" && (flags & actual.constants.O_APPEND) !== 0) {
      armedPath = undefined;
      swaps += 1;
      actual.rmSync(String(path));
      if (swapIn === "fifo") {
        actual.execFileSync("mkfifo", [String(path)]);
        // A blocking write-only open of a FIFO with no reader never returns, which would hang the
        // whole test run. Report that as an error here, so dropping O_NONBLOCK fails a named test.
        if ((flags & actual.constants.O_NONBLOCK) === 0) throw new Error("open would block on a FIFO with no reader");
      } else {
        actual.symlinkSync(victimPath, String(path));
      }
    }
    return (actual.openSync as (...a: unknown[]) => number)(path, flags, mode);
  }) as typeof actual.openSync;
  return { ...actual, default: { ...actual, openSync }, openSync };
});

const { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, chmodSync, statSync, symlinkSync, lstatSync } = await import("node:fs");
const activityLogModule = await import("../src/activity-log.js");
const { recordActivity, activityLogPath } = activityLogModule;
const { appendRegularFileWith } = await import("../src/atomic-store.js");

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "vibectx-activity-race-")));
  process.env.VIBECTX_CACHE_DIR = dir;
  armedPath = undefined;
  swaps = 0;
  swapIn = "symlink";
  readArmedPath = undefined;
  readWouldBlock = false;
  readSwaps = 0;
});
afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("PAR-1030: append open refuses a symlink swapped in after the read", () => {
  it("PAR-1030: a symlink swapped in between the read and the append is not chmod'd or appended through", () => {
    const entry = { tool: "search", query: "hooks", outcome: "matched" } as const;
    recordActivity(entry, { now: () => new Date("2026-09-27T18:00:00.000Z") }); // a real, regular log exists
    victimPath = join(dir, "victim.txt");
    writeFileSync(victimPath, "SYNTH-MARKER-123 not a log\n", "utf8");
    chmodSync(victimPath, 0o644);
    const before = readFileSync(victimPath);
    const warnings: string[] = [];

    armedPath = activityLogPath();
    recordActivity(entry, { warn: (m) => void warnings.push(m), now: () => new Date("2026-09-27T18:00:01.000Z") });

    expect(swaps).toBe(1);
    expect(statSync(victimPath).mode & 0o777).toBe(0o644);
    expect(readFileSync(victimPath).equals(before)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^vibectx: activity not logged: ELOOP/);
    expect(lstatSync(activityLogPath()).isSymbolicLink()).toBe(true); // the swap really happened
  });

  it("PAR-1030: a FIFO swapped in between the read and the append is refused without hanging", () => {
    const entry = { tool: "search", query: "hooks", outcome: "matched" } as const;
    recordActivity(entry, { now: () => new Date("2026-09-27T18:00:00.000Z") }); // a real, regular log exists
    const warnings: string[] = [];

    swapIn = "fifo";
    armedPath = activityLogPath();
    recordActivity(entry, { warn: (m) => void warnings.push(m), now: () => new Date("2026-09-27T18:00:01.000Z") });

    expect(swaps).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^vibectx: activity not logged: ENXIO/);
    expect(lstatSync(activityLogPath()).isFIFO()).toBe(true); // the swap really happened
  });
});

/**
 * Windows has no `O_NOFOLLOW` (Node leaves `fs.constants.O_NOFOLLOW` undefined there), so
 * `appendRegularFile` falls back to an `lstat` before the open and a device/inode comparison
 * after it. These tests force that path on any platform by passing `noFollow: undefined`.
 * Skipped on Windows itself, where creating a symlink needs extra privileges; on POSIX they run
 * the fallback's exact code.
 */
describe.skipIf(process.platform === "win32")("PAR-1030: no-O_NOFOLLOW fallback (the Windows path, forced)", () => {
  function plantVictim(): Buffer {
    victimPath = join(dir, "victim.txt");
    writeFileSync(victimPath, "SYNTH-MARKER-123 not a log\n", "utf8");
    chmodSync(victimPath, 0o644);
    return readFileSync(victimPath);
  }

  it("PAR-1030 fallback: appends to a regular file and sets the owner-only mode on it", () => {
    const target = join(dir, "log.ndjson");
    writeFileSync(target, "one\n", "utf8");
    chmodSync(target, 0o644);
    appendRegularFileWith(target, "two\n", 0o600, undefined);
    expect(readFileSync(target, "utf8")).toBe("one\ntwo\n");
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it("PAR-1030 fallback: a symlink already at the path is refused before the open", () => {
    const before = plantVictim();
    const target = join(dir, "log.ndjson");
    symlinkSync(victimPath, target);
    expect(() => appendRegularFileWith(target, "x\n", 0o600, undefined)).toThrow(/not a regular file/);
    expect(statSync(victimPath).mode & 0o777).toBe(0o644);
    expect(readFileSync(victimPath).equals(before)).toBe(true);
  });

  it("PAR-1030 fallback: a symlink swapped in between the lstat and the open is refused before any chmod or write", () => {
    const before = plantVictim();
    const target = join(dir, "log.ndjson");
    writeFileSync(target, "one\n", "utf8");
    armedPath = target;
    expect(() => appendRegularFileWith(target, "x\n", 0o600, undefined)).toThrow(/changed while it was opened/);
    expect(swaps).toBe(1);
    expect(statSync(victimPath).mode & 0o777).toBe(0o644);
    expect(readFileSync(victimPath).equals(before)).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")("PAR-1030 audit (F-A1030-1, F-A1030-2): FIFOs on the read side and with a reader", () => {
  const entry = { tool: "search", query: "hooks", outcome: "matched" } as const;

  it("PAR-1030: a FIFO swapped in before the log is read is opened without blocking and refused", () => {
    recordActivity(entry, { now: () => new Date("2026-09-27T18:00:00.000Z") }); // a real, regular log
    readArmedPath = activityLogPath();
    const { readActivityLog } = activityLogModule;
    const report = readActivityLog();
    expect(readSwaps).toBe(1); // the swap really happened at the read open
    expect(readWouldBlock).toBe(false);
    expect(report.entries).toEqual([]);
  });

  it("PAR-1030: a FIFO swapped in before the oversized-file schema probe is opened without blocking", () => {
    writeFileSync(activityLogPath(), `${"x".repeat(8 * 1024 * 1024 + 10)}\n`, { mode: 0o600 });
    readArmedPath = activityLogPath();
    activityLogModule.readActivityLog();
    expect(readSwaps).toBe(1);
    expect(readWouldBlock).toBe(false);
  });

  it("PAR-1030: a FIFO that has a reader opens for append but is refused by the descriptor check; nothing is written", async () => {
    const { execFileSync } = await import("node:child_process");
    const { openSync, closeSync, readSync, constants } = await import("node:fs");
    const fifo = join(dir, "log.fifo");
    execFileSync("mkfifo", [fifo]);
    const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      expect(() => appendRegularFileWith(fifo, "x\n", 0o600, constants.O_NOFOLLOW)).toThrow(/not a regular file/);
      const buf = Buffer.alloc(16);
      let n = 0;
      try {
        n = readSync(reader, buf, 0, 16, null);
      } catch {
        n = 0; // EAGAIN: nothing was written
      }
      expect(n).toBe(0);
    } finally {
      closeSync(reader);
    }
  });

  it("PAR-1039: past the read window, an archive's link record is read without blocking on a swapped-in FIFO", () => {
    const at = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
    const rec = (i: number) => JSON.stringify({ schemaVersion: 2, tool: "search", query: `q${i}`, outcome: "matched", timestamp: at(i) });
    const link = (seq: number) => JSON.stringify({ schemaVersion: 2, type: "rotation", previous: `activity-${String(seq).padStart(6, "0")}.json`, previousSeq: seq, rotatedAt: at(9000) });
    const many = Array.from({ length: 2000 }, (_, i) => rec(i + 10)).join("\n");
    writeFileSync(join(dir, "activity-000001.json"), `${rec(1)}\n`, { mode: 0o600 });
    writeFileSync(join(dir, "activity-000002.json"), `${link(1)}\n${many}\n`, { mode: 0o600 });
    writeFileSync(activityLogPath(), `${link(2)}\n${rec(9999)}\n`, { mode: 0o600 });
    readArmedPath = join(dir, "activity-000001.json"); // reached only through its link record
    activityLogModule.readActivityLog();
    expect(readSwaps).toBe(1);
    expect(readWouldBlock).toBe(false);
  });
});
