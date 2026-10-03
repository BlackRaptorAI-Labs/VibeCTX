import { describe, it, expect } from "vitest";
import { shouldLog } from "../src/activity-log.js";
import { shouldAutowarm } from "../src/autowarm.js";
import { debugEnabled } from "../src/debug.js";
import { loadDiscoveredRegistry } from "../src/registry.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * PAR-1044 (final audit I-3) — every on/off environment variable reads its value one way:
 * 1/true/yes/on are on, ""/0/false/no/off are off (any case, trimmed). An unrecognized value
 * leaves an opt-in (STRICT_DNS, CHECK_UPDATES, DEBUG) off and an opt-out (NO_LOG, NO_AUTOWARM)
 * in force, so a typo never turns logging or the background warm back on.
 */
const registryFlags = (env: NodeJS.ProcessEnv) => {
  const dir = mkdtempSync(join(tmpdir(), "vibectx-env-flags-"));
  try {
    const r = loadDiscoveredRegistry({ cwd: dir, env, home: dir, includeResolved: false });
    return { strictDns: r.strictDns === true, checkUpdates: r.checkUpdates === true };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("PAR-1044 (I-3): one reading of on/off environment variables", () => {
  it("PAR-1044 (I-3): opt-ins accept 1/true/yes/on in any case", () => {
    for (const v of ["1", "true", "YES", " on "]) {
      expect(registryFlags({ VIBECTX_STRICT_DNS: v }).strictDns, v).toBe(true);
      expect(registryFlags({ VIBECTX_CHECK_UPDATES: v }).checkUpdates, v).toBe(true);
      expect(debugEnabled({ VIBECTX_DEBUG: v }), v).toBe(true);
    }
  });

  it("PAR-1044 (I-3): opt-ins stay off for off-words and for anything unrecognized", () => {
    for (const v of ["", "0", "false", "no", "OFF", "maybe"]) {
      expect(registryFlags({ VIBECTX_STRICT_DNS: v }).strictDns, v).toBe(false);
      expect(registryFlags({ VIBECTX_CHECK_UPDATES: v }).checkUpdates, v).toBe(false);
      expect(debugEnabled({ VIBECTX_DEBUG: v }), v).toBe(false);
    }
  });

  it("PAR-1044 (I-3): opt-outs read no/off as 'not opted out', like 0/false", () => {
    for (const v of ["", "0", "false", "no", "Off"]) {
      expect(shouldLog({ VIBECTX_NO_LOG: v }), v).toBe(true);
      expect(shouldAutowarm({ VIBECTX_NO_AUTOWARM: v }), v).toBe(true);
    }
  });

  it("PAR-1044 (I-3): opt-outs take effect for on-words (any case, trimmed) and for anything unrecognized", () => {
    expect(shouldLog({}), "unset").toBe(true);
    expect(shouldAutowarm({}), "unset").toBe(true);
    for (const v of ["1", "true", "yes", "on", " 1 ", "TRUE", "maybe"]) {
      expect(shouldLog({ VIBECTX_NO_LOG: v }), v).toBe(false);
      expect(shouldAutowarm({ VIBECTX_NO_AUTOWARM: v }), v).toBe(false);
    }
  });

  it("PAR-1044 (I-3): README states the shared reading", async () => {
    const { readFileSync } = await import("node:fs");
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain("reads `1`, `true`, `yes` or `on` as on and an empty\nvalue, `0`, `false`, `no` or `off` as off, in any case.");
  });

  it("PAR-1044: README states the new refused ranges, the docs.<apex> rule and the fake-IP symptom", async () => {
    const { readFileSync } = await import("node:fs");
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain("benchmarking (`198.18.0.0/15`), multicast (`224.0.0.0/4`, `ff00::/8`)");
    expect(readme).toContain("IPv6 site-local (`fec0::/10`)");
    expect(readme).toContain('"fake-IP" mode');
    expect(readme).toContain("when the homepage is that registrable domain itself or its\n`www.`");
    expect(readme).toContain("`VIBECTX_NO_LOG=off` means \"not off\"");
    expect(readme).toContain("**Resolving an\nunknown package** (npm/PyPI metadata, then its candidate documents) has its own 60-second ceiling");
  });
});
