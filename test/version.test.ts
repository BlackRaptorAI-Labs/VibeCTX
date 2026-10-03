import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { VERSION, USER_AGENT, UNKNOWN_VERSION, versionFrom } from "../src/version.js";
import { buildServer } from "../src/server.js";
import type { Registry } from "../src/registry.js";

/**
 * PAR-652 item 6: the version was hard-coded in two places (`src/server.ts` and the
 * user-agent in `src/fetcher.ts`) and had already drifted once. There is one source of
 * truth — the package manifest — and this file pins every consumer to it by reading the
 * manifest independently rather than by comparing two constants to each other.
 */

const MANIFEST = fileURLToPath(new URL("../package.json", import.meta.url));
const manifestVersion = (JSON.parse(readFileSync(MANIFEST, "utf8")) as { version: string }).version;

const emptyRegistry = (): Registry => ({ entries: new Map() });

describe("the version is read from package.json, never written twice", () => {
  it("VERSION equals the manifest's version", () => {
    expect(manifestVersion).toMatch(/^\d+\.\d+\.\d+/); // the manifest itself is sane
    expect(VERSION).toBe(manifestVersion);
  });

  it("the advertised MCP server version equals package.json's version", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildServer(emptyRegistry());
    await server.connect(serverTransport);
    const client = new Client({ name: "probe", version: "0" });
    await client.connect(clientTransport);
    expect(client.getServerVersion()).toEqual({ name: "vibectx", version: manifestVersion });
    await client.close();
  });

  it("the user-agent carries that same version", () => {
    expect(USER_AGENT).toContain(`vibectx/${manifestVersion}`);
    expect(USER_AGENT).toBe(`vibectx/${manifestVersion} (+https://github.com/BlackRaptorAI-Labs/VibeCTX)`);
  });

  it("no source file hard-codes a version string of its own", async () => {
    // The defect this closes: `src/server.ts` said 0.1.3 while the manifest could move.
    const { readdirSync } = await import("node:fs");
    const srcDir = fileURLToPath(new URL("../src", import.meta.url));
    const offenders: string[] = [];
    for (const name of readdirSync(srcDir)) {
      if (!name.endsWith(".ts") || name === "version.ts") continue;
      const text = readFileSync(`${srcDir}/${name}`, "utf8");
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) continue; // prose may cite an old release
        if (/\bversion\s*:\s*["'`]\d+\.\d+\.\d+/.test(line) || /vibectx\/\d+\.\d+\.\d+/.test(line)) {
          offenders.push(`${name}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * PAR-652c schema K4 — a deprecation that names a removal version needs a mechanism, not a
 * promise. Before 0.3.0, `src/cache.ts` and README promised to stop reading `DOCS_CACHE_DIR`
 * after 0.2.x; the same schedule applied to the legacy config filename and command alias.
 *
 * This is that mechanism, and it is deliberately strict in BOTH directions: past the removal
 * version the marker must be gone, and before it the marker must still be there. Rows remain
 * as regression guards after removal, so a later edit cannot quietly restore an old path.
 */
describe("every 0.2.x deprecation is removed the moment the version passes it", () => {
  const root = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));

  /** Is `version` at or past `removeAt`? Major.minor only; a prerelease suffix is ignored. */
  function atOrPast(version: string, removeAt: string): boolean {
    const [major, minor] = version.split(".").map((part) => Number.parseInt(part, 10));
    const [removeMajor, removeMinor] = removeAt.split(".").map((part) => Number.parseInt(part, 10));
    return major > removeMajor || (major === removeMajor && minor >= removeMinor);
  }

  /** file → the exact text whose presence means the deprecated path is still shipped. */
  const promises = [
    {
      what: "the DOCS_CACHE_DIR fallback",
      marker: "DOCS_CACHE_DIR",
      file: "src/cache.ts",
      removeAt: "0.3.0",
      promisedAt: "src/cache.ts (cacheRoot docstring + the deprecation note) and README, 'Upgrading from ~/.docs-cache-mcp'",
    },
    {
      what: "the legacy config filename",
      marker: "docs-cache.config.json",
      file: "src/config.ts",
      removeAt: "0.3.0",
      promisedAt: "src/config.ts LEGACY_CONFIG_FILENAME (D-16) and README, 'Team config, no flags'",
    },
    {
      what: "the docs-cache-mcp bin alias",
      marker: '"docs-cache-mcp"',
      file: "package.json",
      removeAt: "0.3.0",
      promisedAt: "README, 'Upgrading from ~/.docs-cache-mcp'",
    },
  ] as const;

  it("the gate flips at the removal version — the cases below are not vacuous", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/); // the comparison has something to compare
    expect(atOrPast("0.1.3", "0.3.0")).toBe(false);
    expect(atOrPast("0.2.9", "0.3.0")).toBe(false);
    expect(atOrPast("0.3.0", "0.3.0")).toBe(true);
    expect(atOrPast("0.3.0-rc.1", "0.3.0")).toBe(true);
    expect(atOrPast("1.0.0", "0.3.0")).toBe(true);
  });

  for (const p of promises) {
    it(`${p.what} is gone at ${p.removeAt}, and present until then (${p.file})`, () => {
      const past = atOrPast(VERSION, p.removeAt);
      const present = readFileSync(root(p.file), "utf8").includes(p.marker);
      if (past) {
        expect(
          present,
          `VERSION is ${VERSION}, at or past ${p.removeAt}: remove ${p.what} from ${p.file} (promised at ${p.promisedAt}) and delete this row.`,
        ).toBe(false);
      } else {
        expect(
          present,
          `${p.what} is documented as supported until ${p.removeAt} (${p.promisedAt}) but is not in ${p.file}: retire the promise, or this row.`,
        ).toBe(true);
      }
    });
  }
});

/**
 * PAR-652c review R2. The docstring promised a `0.0.0-unknown` fallback "so a manifest that
 * somehow cannot be read degrades … rather than throwing at import time and taking the server
 * down with it" — and the `require` was unguarded, so it did exactly the thing the comment
 * denied. These cases use a REAL `createRequire` rooted in a directory with no manifest above
 * it, so the guard is proven against a real `MODULE_NOT_FOUND` rather than a stubbed thrower.
 */
describe("an unreadable manifest degrades the version — it never kills the process", () => {
  /** A directory whose parent holds no package.json, plus one whose parent holds a bad one. */
  function rootedAt(parentManifest?: string): { load: (s: string) => unknown; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), "vibectx-manifest-"));
    const pkgDir = join(dir, "pkg");
    mkdirSync(pkgDir, { recursive: true });
    if (parentManifest !== undefined) writeFileSync(join(dir, "package.json"), parentManifest, "utf8");
    return { load: createRequire(pathToFileURL(join(pkgDir, "version.js"))), dir };
  }

  it("the unguarded require really does throw — this is the failure being guarded", () => {
    const { load, dir } = rootedAt();
    try {
      expect(() => load("../package.json")).toThrowError(/Cannot find module/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a missing manifest yields 0.0.0-unknown instead of throwing at import", () => {
    const { load, dir } = rootedAt();
    try {
      expect(versionFrom(load)).toBe(UNKNOWN_VERSION);
      expect(UNKNOWN_VERSION).toBe("0.0.0-unknown");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an unparsable manifest yields 0.0.0-unknown", () => {
    const { load, dir } = rootedAt("{not json");
    try {
      expect(versionFrom(load)).toBe(UNKNOWN_VERSION);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a manifest with no version, an empty one, or a non-string one falls back too", () => {
    for (const body of ['{"name":"x"}', '{"version":""}', '{"version":3}', '{"version":null}']) {
      const { load, dir } = rootedAt(body);
      try {
        expect(versionFrom(load)).toBe(UNKNOWN_VERSION);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("a readable manifest still wins — the guard costs the good case nothing", () => {
    const { load, dir } = rootedAt('{"version":"9.9.9-test"}');
    try {
      expect(versionFrom(load)).toBe("9.9.9-test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
