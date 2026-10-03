import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { recordActivity } from "../src/activity-log.js";
import { ensureCacheRoot, resetCacheRootState } from "../src/cache.js";

// PAR-1044 L-5: best-effort warnings on stderr show `[cache]` and `~`, not full local paths,
// and the same warning is written once per process. Decision 10 keeps the real path in the
// copy-paste `chmod 700` repair line only.
let dir: string;
let terminal: string[];
beforeEach(() => {
  // Not realpath'd on purpose: on macOS the temp folder sits under a symlinked /var, and the
  // cache root is pinned to its real spelling, so both spellings must be redacted.
  dir = fs.mkdtempSync(join(os.tmpdir(), "l5-PATHMARK-"));
  vi.stubEnv("HOME", join(dir, "home"));
  vi.stubEnv("VIBECTX_CACHE_DIR", join(dir, "cache"));
  vi.stubEnv("VIBECTX_NO_LOG", "");
  resetCacheRootState();
  terminal = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { terminal.push(String(chunk)); return true; });
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); resetCacheRootState();
  fs.rmSync(dir, { recursive: true, force: true });
});

it("PAR-1044 L-5: an activity-log write failure reaches stderr with the cache folder redacted, once per process", () => {
  if (process.platform === "win32" || process.getuid?.() === 0) return;
  const root = join(dir, "cache");
  fs.mkdirSync(root, { mode: 0o700 });
  fs.writeFileSync(join(root, "activity.json"), "", { mode: 0o400 });
  recordActivity({ tool: "search", query: "hooks", outcome: "matched" });
  recordActivity({ tool: "search", query: "hooks", outcome: "matched" });
  const text = terminal.join("");
  const failures = terminal.filter((s) => s.includes("activity not logged"));
  expect(failures).toHaveLength(1);
  expect(text).toContain("[cache]/activity.json");
  expect(text).not.toContain("PATHMARK");
});

it("PAR-1044 L-5: the loose cache-root warning redacts its prose and keeps the real path only in the chmod line (decision 10)", () => {
  if (process.platform === "win32" || process.getuid?.() === 0) return;
  const root = join(dir, "cache");
  fs.mkdirSync(root, { mode: 0o755 }); fs.chmodSync(root, 0o755);
  ensureCacheRoot(fs.realpathSync(root));
  const warnings = terminal.filter((s) => s.includes("already exists with mode"));
  expect(warnings).toHaveLength(1);
  const lines = warnings[0]!.split("\n").filter((line) => line.length > 0);
  const command = lines.filter((line) => line.startsWith("chmod 700 "));
  expect(command).toEqual([`chmod 700 '${fs.realpathSync(root)}'`]);
  const prose = lines.filter((line) => !line.startsWith("chmod 700 ")).join("\n");
  expect(prose).toContain("the cache root [cache] already exists");
  expect(prose).not.toContain("PATHMARK");
});

it("PAR-1044 L-5: the shared stderr writer shows the home folder as ~, keeps URLs and sibling names, and ends with one newline", async () => {
  const { writeStderrWarning, resetStderrWarnings } = await import("../src/redact-paths.js");
  resetStderrWarnings();
  const home = join(dir, "home");
  writeStderrWarning(`vibectx: project record not written: EACCES '${home}/work/app' (see https://example.com${home}/x; ${home}-other kept)\n\n`);
  expect(terminal).toEqual([`vibectx: project record not written: EACCES '~/work/app' (see https://example.com${home}/x; ${home}-other kept)\n`]);
});

it("PAR-1044 L-5/L-29: the README states stderr redaction, once-per-process warnings and the isError failure shape", () => {
  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  expect(readme).toContain("Other warnings on stderr show the cache folder as `[cache]` and your home folder as `~`");
  expect(readme).toContain("each distinct warning is printed once per process, up to the first 1,024 distinct warnings\n(past that, a repeated warning can print again); only that chmod line keeps the real path.");
  expect(readme).toContain("When a tool call fails, the reply is marked as an error (`isError`) with a fixed message");
});

it("PAR-1044 L-5: the writer remembers the first 1,024 distinct warnings, as the README states; past that a repeat can print again", async () => {
  const { writeStderrWarning, resetStderrWarnings } = await import("../src/redact-paths.js");
  resetStderrWarnings();
  writeStderrWarning("first witness"); writeStderrWarning("first witness");
  for (let i = 1; i < 1024; i++) writeStderrWarning(`distinct warning ${i}`);
  writeStderrWarning("first witness");
  writeStderrWarning("overflow witness"); writeStderrWarning("overflow witness");
  expect(terminal.filter((s) => s === "first witness\n")).toHaveLength(1);
  expect(terminal.filter((s) => s === "overflow witness\n")).toHaveLength(2);
  resetStderrWarnings();
});
