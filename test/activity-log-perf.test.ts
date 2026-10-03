import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * PAR-795 — two claims about `recordActivity`'s read-modify-write cost, both MEASURED here
 * rather than asserted, following `cache-evict-perf.test.ts`'s (call-counting) and
 * `search-perf.test.ts`'s (wall-clock, printed not bounded — D-37) precedent:
 *
 *   1. One call to `recordActivity` reads `activity.json` from disk exactly ONCE, not twice.
 *      Before this item, `newerSchemaVersion`'s own read (`atomic-store.ts`) and
 *      `readActivityEntries`'s read were two separate `readFileSync` + `JSON.parse` passes over
 *      the identical file, on every ordinary retrieval — this pins the fix by counting reads,
 *      the same "count operations, don't time them" approach `cache-evict-perf.test.ts` uses,
 *      so this cannot go flaky on a loaded machine.
 *   2. The wall-clock cost of a read-modify-write against a file already at
 *      `ACTIVITY_LOG_MAX_ENTRIES` is MEASURED and printed (not bounded — D-37/F-2's own
 *      flakiness lesson applies here too), replacing the old activity-log.ts top-comment's bare,
 *      uncited "~9.6 ms" figure with a number this test file actually produces.
 */
let activityReadCalls = 0;
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    readSync: ((fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null) => {
      activityReadCalls += 1;
      return actual.readSync(fd, buffer, offset, length, position);
    }) as typeof actual.readSync,
    readFileSync: (path: unknown, ...rest: unknown[]) => {
      return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
    },
  };
});

const { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } = await import("node:fs");
const { recordActivity, activityLogPath, ACTIVITY_LOG_SCHEMA_VERSION } = await import("../src/activity-log.js");
const { ACTIVITY_LOG_MAX_ENTRIES } = await import("../src/limits.js");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-activity-perf-"));
  process.env.VIBECTX_CACHE_DIR = dir;
  activityReadCalls = 0;
});
afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const base = { tool: "get_docs" as const, library: "react", outcome: "matched" as const };

describe("recordActivity reads activity.json exactly once per call (PAR-795)", () => {
  it("a single call against an already-populated file issues exactly one descriptor read", () => {
    recordActivity(base); // creates the file — first call, nothing to read yet
    expect(activityReadCalls).toBe(0); // no file existed before this call

    activityReadCalls = 0;
    recordActivity(base); // second call — the file now exists and must be read exactly once
    expect(activityReadCalls).toBe(1);
  });

  it("MEASURED: read-modify-write cost against a file already at ACTIVITY_LOG_MAX_ENTRIES", () => {
    // Seed the log to its cap directly (writeFileSync, not ACTIVITY_LOG_MAX_ENTRIES sequential
    // recordActivity calls — that would cost O(n^2) work just to set up the fixture, the same
    // "prove the property, don't pay for it twice" reasoning cache-evict-perf.test.ts's own
    // seedDocs already applies) with the worst-case-length entry shape, matching the top
    // comment's own "worst-case length" framing.
    mkdirSync(dir, { recursive: true });
    const worstCaseEntry = {
      tool: "get_docs",
      library: "x".repeat(214),
      query: "q".repeat(200),
      url: `https://example.com/${"a".repeat(250)}`,
      contentHash: "0123456789abcdef",
      version: "v".repeat(100),
      fresh: true,
      outcome: "matched",
      timestamp: "2026-01-01T00:00:00.000Z",
    };
    const seeded = {
      schemaVersion: ACTIVITY_LOG_SCHEMA_VERSION,
      entries: Array.from({ length: ACTIVITY_LOG_MAX_ENTRIES }, () => worstCaseEntry),
    };
    writeFileSync(activityLogPath(), JSON.stringify(seeded, null, 2), { mode: 0o600 });
    expect(readActivityEntryCount()).toBe(ACTIVITY_LOG_MAX_ENTRIES);

    const start = performance.now();
    recordActivity(base);
    const elapsed = performance.now() - start;

    console.log(
      `[PAR-795 MEASURED] recordActivity read-modify-write at ${ACTIVITY_LOG_MAX_ENTRIES} entries: ${elapsed.toFixed(2)} ms`,
    );
    // Not asserted as a bound (D-37/F-2: a wall-clock ceiling here would be exactly the flake
    // this project has already been burned by once) — the print above is the record.
    expect(Number.isFinite(elapsed)).toBe(true);
  });
});

function readActivityEntryCount(): number {
  const raw = JSON.parse(readFileSync(activityLogPath(), "utf8")) as { entries: unknown[] };
  return raw.entries.length;
}
