import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheRoot, ensureCacheRoot, resetCacheRootState, writeCache } from "../src/cache.js";
import { activityLogPath, recordActivity } from "../src/activity-log.js";
import { dispatchCli, type CliIo } from "../src/cli.js";
import { resetStderrWarnings, writeStderrWarning } from "../src/redact-paths.js";
import { restoreTerminals, stubTerminal } from "./helpers/terminal.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "terminal-path-private-"));
  vi.stubEnv("HOME", join(dir, "home"));
  vi.stubEnv("XDG_CONFIG_HOME", join(dir, "xdg"));
  vi.stubEnv("VIBECTX_CONFIG", "");
  vi.stubEnv("VIBECTX_CACHE_DIR", join(dir, "cache"));
  vi.stubEnv("VIBECTX_NO_LOG", "1");
  resetCacheRootState(); resetStderrWarnings();
});
afterEach(() => {
  restoreTerminals(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  resetCacheRootState(); resetStderrWarnings();
  rmSync(dir, { recursive: true, force: true });
});

it.each([true, false, undefined])("doctor human output follows stdout's real terminal state (%s)", async (isTTY) => {
  stubTerminal(process.stdout, isTTY);
  vi.stubEnv("VIBECTX_NO_LOG", "");
  recordActivity({ tool: "search", query: "fixture", outcome: "matched" });
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ libraries: [{ name: "fixture", urls: ["https://example.com/llms.txt"] }] }));
  const out: string[] = [];
  const io: CliIo = { stdout: (s) => out.push(s), stderr: () => {} };
  expect(await dispatchCli(["node", "index.js", "doctor", "--offline", "--config", config], io)).toBe(1);
  if (isTTY === true) {
    expect(out.join("")).toContain(cacheRoot());
    expect(out.join("")).toContain(activityLogPath());
  } else {
    expect(out.join("")).not.toMatch(/(?:^|[\s'"(])(?:\/\S|[A-Za-z]:[\\/])/u);
    expect(out.join("")).not.toContain(dir);
    expect(out.join("")).not.toContain(activityLogPath());
    expect(out.join("")).toContain("cache [redacted]");
    expect(out.join("")).toContain("activity log: present");
  }
});

it.each([true, false])("doctor discovered-config diagnostics follow injected stdout terminal state (%s)", async (isTTY) => {
  mkdirSync(join(dir, ".git"));
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  writeCache("react", "https://react.dev/llms-full.txt", "# React\n\n## useEffect cleanup\n\nReturn a cleanup function.");
  writeFileSync(join(dir, "vibectx.config.json"), JSON.stringify({ libraries: [{ name: "a", urls: [] }] }));
  const out: string[] = [];
  const io: CliIo = { stdout: (s) => out.push(s), stderr: () => {}, stdoutIsTTY: isTTY };
  expect(await dispatchCli(["node", "index.js", "doctor", "--offline", "--library", "react"], io)).toBe(1);
  if (isTTY) expect(out.join("")).toContain('config ./vibectx.config.json (project): libraries[0].urls ("a")');
  else {
    expect(out.join("")).toContain("config [redacted] (project): local config error;");
    expect(out.join("")).not.toContain(dir);
    expect(out.join("")).not.toContain("./vibectx.config.json");
  }
});

it("doctor terminal detection can be injected independently of stdout", async () => {
  stubTerminal(process.stdout, true);
  const out: string[] = [];
  const io: CliIo = { stdout: (s) => out.push(s), stderr: () => {}, stdoutIsTTY: false };
  await dispatchCli(["node", "index.js", "doctor", "--offline"], io);
  expect(out.join("")).not.toContain(dir);
  expect(out.join("")).toContain("cache [redacted]");
});

it("the warning sink's injected non-terminal state removes a legacy verbatim repair path", () => {
  stubTerminal(process.stderr, true);
  const out: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((s) => { out.push(String(s)); return true; });
  mkdirSync(cacheRoot(), { recursive: true, mode: 0o700 });
  writeStderrWarning(`the cache root ${cacheRoot()}\nchmod 700 '${cacheRoot()}'`, process.env, false);
  expect(out.join("")).not.toMatch(/(?:\/|[A-Za-z]:[\\/])/u);
  expect(out.join("")).toContain('chmod 700 "$VIBECTX_CACHE_DIR"');
  expect(out.join("")).toContain("shown above as [cache]");
});

it("cache permission repair detection can be injected before a custom warning sink", () => {
  if (process.platform === "win32") return;
  stubTerminal(process.stderr, true);
  const root = cacheRoot(); mkdirSync(root, { mode: 0o755 });
  const out: string[] = [];
  ensureCacheRoot(root, (s) => out.push(s), false);
  expect(out.join("")).not.toContain(`chmod 700 '${root}'`);
  expect(out.join("")).toContain('chmod 700 "$VIBECTX_CACHE_DIR"');
});
