import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { writeCache } from "../src/cache.js";
import { saveConsent } from "../src/consent.js";
import type { Registry } from "../src/registry.js";
import { resetAutowarm, resetBackgroundResolutionWindow } from "../src/autowarm.js";
import { resetResolutionWindow, seedResolutionWindowForTest, MAX_RESOLUTIONS_PER_HOUR } from "../src/resolve.js";
import { MAX_BACKGROUND_RESOLUTIONS_PER_HOUR } from "../src/limits.js";
import { startServer } from "../src/server.js";
import { stubPublicDns } from "./helpers/public-dns.js";

/**
 * PAR-1048 (final audit L-20; Tom's F11, option a): by default the background autowarm warms only
 * the project's own dependencies that match a built-in or configured library, and makes no npm or
 * PyPI request. Unknown dependencies are resolved in the background only when consent is
 * `allowed`, with their own budget (F32). The project is the server's working directory when it
 * holds a supported manifest; the home folder and `/` never count (F12). The full curated warm
 * becomes opt-in (`VIBECTX_AUTOWARM=all`).
 *
 * Every test drives the real server: one `get_docs` for a cached library goes online (starting
 * the autowarm), and `fetch` is stubbed so registry requests are counted, never sent.
 */
const REACT_URL = "https://react.dev/llms-full.txt";
const HONO_URL = "https://hono.dev/llms.txt";
const CACHED_URL = "https://cached.example.com/llms.txt";
const FASTAPI_URL = "https://fastapi.tiangolo.com/llms.txt";
const KNOWN_URL = "https://zz-known.example.com/llms.txt";
const registry = (): Registry => ({
  entries: new Map([
    ["react", { name: "react", urls: [REACT_URL], aliases: ["react-dom"] }],
    ["hono", { name: "hono", urls: [HONO_URL] }],
    ["cachedlib", { name: "cachedlib", urls: [CACHED_URL] }],
    ["fastapi", { name: "fastapi", urls: [FASTAPI_URL], ecosystem: "pypi" }],
    ["zz-known", { name: "zz-known", urls: [KNOWN_URL], resolved: { source: "npm", resolvedAt: "2026-09-01T00:00:00.000Z", metadataUrl: "https://registry.npmjs.org/zz-known/latest" } }],
  ]),
});

let cache: string;
let project: string;
let fetched: string[];
/** Runs once, at the first npm/PyPI request: stages a consent change mid-run. */
let onRegistryRequest: (() => void) | undefined;
beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), "vibectx-autowarm-scope-cache-"));
  project = mkdtempSync(join(tmpdir(), "vibectx-autowarm-scope-proj-"));
  process.env.VIBECTX_CACHE_DIR = cache;
  resetAutowarm();
  resetResolutionWindow();
  resetBackgroundResolutionWindow();
  stubPublicDns();
  fetched = [];
  onRegistryRequest = undefined;
  writeCache("cachedlib", CACHED_URL, "# Cached");
  vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
    const u = String(url);
    fetched.push(u);
    if (onRegistryRequest !== undefined && (u.startsWith("https://registry.npmjs.org/") || u.startsWith("https://pypi.org/"))) {
      const hook = onRegistryRequest;
      onRegistryRequest = undefined;
      hook();
    }
    if (u === REACT_URL || u === HONO_URL || u === FASTAPI_URL) return new Response(`# ${u}`, { status: 200, headers: { "content-type": "text/plain" } });
    const npm = /^https:\/\/registry\.npmjs\.org\/(zz-[a-z0-9-]+)\/latest$/.exec(u);
    if (npm) return new Response(JSON.stringify({ homepage: `https://${npm[1]}.example.com` }), { status: 200, headers: { "content-type": "application/json" } });
    const docs = /^https:\/\/(zz-[a-z0-9-]+)\.example\.com\/llms\.txt$/.exec(u);
    if (docs) return new Response(`# ${docs[1]} docs`, { status: 200, headers: { "content-type": "text/plain" } });
    return new Response("not found", { status: 404 });
  }));
});
afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  rmSync(cache, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const registryRequests = () => fetched.filter((u) => u.startsWith("https://registry.npmjs.org/") || u.startsWith("https://pypi.org/"));
const docRequests = () => fetched.filter((u) => u === REACT_URL || u === HONO_URL);
const writeDeps = (deps: string[]) =>
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "app", dependencies: Object.fromEntries(deps.map((d) => [d, "1.0.0"])) }));

async function run(opts: { cwd: string; env?: NodeJS.ProcessEnv; reg?: Registry; afterOnline?: (call: (name: string, args: Record<string, unknown>) => Promise<string>) => Promise<void> }) {
  const notes: string[] = [];
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const started = await startServer(opts.reg ?? registry(), serverTransport, { env: opts.env ?? {}, warn: (m) => notes.push(m), cwd: opts.cwd });
  const client = new Client({ name: "autowarm-scope-probe", version: "0" });
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown>) =>
    ((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0].text;
  try {
    await call("get_docs", { library: "cachedlib" }); // goes online: starts the autowarm
    const summary = await started.autowarm;
    await opts.afterOnline?.(call);
    return { summary, notes };
  } finally {
    await client.close();
  }
}

describe("PAR-1048: autowarm warms the project's own matching dependencies by default", () => {
  it("PAR-1048 (F11): under disclosed, one built-in match and one unknown dependency: the match is warmed and 0 registry requests are made", async () => {
    saveConsent("disclosed", "fallback");
    writeDeps(["react", "zz-unknown"]);
    const { summary } = await run({ cwd: project });
    expect(docRequests()).toEqual([REACT_URL]); // hono is configured but not a dependency: not warmed
    expect(registryRequests()).toEqual([]);
    expect(summary?.attempted).toBe(1);
  });

  it("PAR-1048 (F11): under allowed, the unknown dependency is resolved in the background", async () => {
    saveConsent("allowed", "elicitation");
    writeDeps(["react", "zz-unknown"]);
    await run({ cwd: project });
    expect(docRequests()).toEqual([REACT_URL]);
    expect(registryRequests()).toContain("https://registry.npmjs.org/zz-unknown/latest");
    expect(fetched).toContain("https://zz-unknown.example.com/llms.txt");
  });

  it("PAR-1048 (F12): with the working directory at home or /, autowarm warms nothing, and get_docs still fetches on demand", async () => {
    saveConsent("allowed", "elicitation");
    for (const cwd of [homedir(), "/"]) {
      resetAutowarm();
      fetched.length = 0;
      rmSync(cache, { recursive: true, force: true }); // each case starts with hono uncached
      cache = mkdtempSync(join(tmpdir(), "vibectx-autowarm-scope-cache-"));
      process.env.VIBECTX_CACHE_DIR = cache;
      saveConsent("allowed", "elicitation");
      writeCache("cachedlib", CACHED_URL, "# Cached");
      await run({
        cwd,
        afterOnline: async (call) => {
          expect(docRequests(), cwd).toEqual([]); // nothing warmed in the background
          expect(await call("get_docs", { library: "hono" }), cwd).toContain(`# ${HONO_URL}`);
        },
      });
      expect(registryRequests(), cwd).toEqual([]);
      expect(docRequests(), cwd).toEqual([HONO_URL]); // only the on-demand fetch
    }
  });

  it("PAR-1048 (F12): a working directory with no supported manifest warms nothing", async () => {
    saveConsent("allowed", "elicitation");
    await run({ cwd: project }); // empty project directory
    expect(docRequests()).toEqual([]);
    expect(registryRequests()).toEqual([]);
  });

  it("PAR-1048: VIBECTX_AUTOWARM=all keeps the full configured warm, as an opt-in", async () => {
    saveConsent("disclosed", "fallback");
    writeDeps(["react"]);
    await run({ cwd: project, env: { VIBECTX_AUTOWARM: "all" } });
    expect(docRequests().sort()).toEqual([HONO_URL, REACT_URL]);
    expect(registryRequests()).toEqual([]);
  });

  it("PAR-1048: a bad VIBECTX_AUTOWARM value prints one stderr line and keeps the project default", async () => {
    saveConsent("disclosed", "fallback");
    writeDeps(["react"]);
    const { notes } = await run({ cwd: project, env: { VIBECTX_AUTOWARM: "everything" } });
    expect(docRequests()).toEqual([REACT_URL]);
    expect(notes.filter((n) => n.includes("VIBECTX_AUTOWARM"))).toHaveLength(1);
  });

  it("PAR-1048 (F32): background resolution has its own smaller budget, so a person's own resolve_library still works after it", async () => {
    saveConsent("allowed", "elicitation");
    const unknown = Array.from({ length: 30 }, (_, i) => `zz-dep${i}`);
    writeDeps(unknown);
    // Leave room for exactly 21 more resolutions in the shared per-process window.
    seedResolutionWindowForTest(MAX_RESOLUTIONS_PER_HOUR - 21, Date.now());
    await run({
      cwd: project,
      afterOnline: async (call) => {
        const text = await call("resolve_library", { name: "zz-mine" });
        expect(text).not.toMatch(/limit/i);
        expect(fetched).toContain("https://registry.npmjs.org/zz-mine/latest");
      },
    });
    // One resolution may make several registry requests; the budget counts resolutions.
    const resolvedNames = new Set(registryRequests().map((u) => /zz-dep\d+/.exec(u)?.[0]).filter((n): n is string => n !== undefined));
    expect(resolvedNames.size).toBeGreaterThan(0);
    expect(resolvedNames.size).toBeLessThanOrEqual(MAX_BACKGROUND_RESOLUTIONS_PER_HOUR);
  });

  it("PAR-1048: a user-config autowarm value wins over the variable, and a bad one keeps the project scope", async () => {
    const { autowarmScopeSetting } = await import("../src/autowarm.js");
    const warnings: string[] = [];
    const warn = (m: string) => void warnings.push(m);
    expect(autowarmScopeSetting({ VIBECTX_AUTOWARM: "all" }, "project", warn)).toBe("project");
    expect(autowarmScopeSetting({}, "all", warn)).toBe("all");
    expect(autowarmScopeSetting({ VIBECTX_AUTOWARM: "all" }, 7, warn)).toBe("project");
    expect(warnings).toHaveLength(1);
  });

  it("PAR-1048: README states the project scope, the allowed-only resolution, its budget, and the all opt-in", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const section = readme.match(/\*\*Background revalidation after consent\.\*\*[\s\S]*?(?=\n## )/)?.[0] ?? "";
    expect(section).toContain("the libraries *your\nproject depends on* are fetched in the background");
    expect(section).toContain("this makes no npm or PyPI request");
    expect(section).toContain("only after you **allow** network access");
    expect(section).toContain("at most 20 per hour per process");
    expect(section).toContain("the background can take at most 20 of the 100");
    expect(section).not.toContain("never uses up");
    expect(section).toContain("`VIBECTX_AUTOWARM=all`");
    expect(section).not.toContain("fetches the 30 defaults");
    expect(readme).not.toContain("background revalidation on startup");
  });

  it("PAR-1048 (F12): a home folder with a stray manifest is still not a project", async () => {
    const { autowarmProjectDir } = await import("../src/autowarm.js");
    writeDeps(["react"]);
    expect(autowarmProjectDir(project, "/elsewhere")).toBe(project); // a real project
    expect(autowarmProjectDir(project, project)).toBeUndefined(); // the same folder, as home
    expect(autowarmProjectDir("/", "/elsewhere")).toBeUndefined(); // a filesystem root
  });

  it("PAR-1048: a consent deny or reset during background lookups stops the next lookup", async () => {
    for (const change of ["deny", "reset"] as const) {
      saveConsent("allowed", "elicitation");
      resetAutowarm();
      resetBackgroundResolutionWindow();
      fetched.length = 0;
      writeDeps(["zz-a", "zz-b", "zz-c", "zz-d"]);
      onRegistryRequest = () => (change === "deny" ? saveConsent("declined", "cli") : rmSync(join(cache, "consent.json"), { force: true }));
      const { notes } = await run({ cwd: project });
      const names = new Set(registryRequests().map((u) => /zz-[a-d]/.exec(u)?.[0]));
      expect([...names], change).toEqual(["zz-a"]); // the one in flight may finish; no other starts
      expect(notes.join(""), change).toContain("lookups stopped: consent no longer allowed");
    }
  });

  it("PAR-1048: background lookups are reported on the summary line", async () => {
    saveConsent("allowed", "elicitation");
    writeDeps(["zz-unknown"]);
    const { notes } = await run({ cwd: project });
    expect(notes.join("")).toContain("looked up 1 unknown dependency (1 resolved)");
  });

  it("PAR-1048: a noise-list dependency is neither warmed nor looked up", async () => {
    saveConsent("allowed", "elicitation");
    writeDeps(["eslint", "eslint-config-next"]);
    await run({ cwd: project });
    expect(registryRequests()).toEqual([]);
  });

  it("PAR-1048: a dependency matching a library by alias warms that library", async () => {
    saveConsent("disclosed", "fallback");
    writeDeps(["react-dom"]);
    await run({ cwd: project });
    expect(docRequests()).toEqual([REACT_URL]);
  });

  it("PAR-1048: a PyPI manifest's matching dependency is warmed", async () => {
    saveConsent("disclosed", "fallback");
    writeFileSync(join(project, "requirements.txt"), "fastapi==0.110.0\n");
    await run({ cwd: project });
    expect(fetched).toContain(FASTAPI_URL);
    expect(registryRequests()).toEqual([]);
  });

  it("PAR-1048: a dependency matching an auto-resolved record is left alone: not warmed, not looked up", async () => {
    saveConsent("allowed", "elicitation");
    writeDeps(["zz-known"]);
    await run({ cwd: project });
    expect(fetched).not.toContain(KNOWN_URL);
    expect(registryRequests()).toEqual([]);
  });

  it("PAR-1048: a bad autowarm setting is reported once per process, from the variable or the user config", async () => {
    saveConsent("disclosed", "fallback");
    writeDeps(["react"]);
    const fromEnv = await run({ cwd: project, env: { VIBECTX_AUTOWARM: "everything" }, afterOnline: async (call) => void (await call("get_docs", { library: "cachedlib" })) });
    expect(fromEnv.notes.filter((n) => n.includes("VIBECTX_AUTOWARM"))).toHaveLength(1);
    resetAutowarm();
    const fromConfig = await run({ cwd: project, reg: { ...registry(), autowarm: 7 }, afterOnline: async (call) => void (await call("get_docs", { library: "cachedlib" })) });
    expect(fromConfig.notes.filter((n) => n.includes("autowarm in config"))).toHaveLength(1);
  });

  it("PAR-1048 (F12): home is compared by real path, so a symlink to it is still home", async () => {
    const { autowarmProjectDir } = await import("../src/autowarm.js");
    writeDeps(["react"]);
    const link = join(mkdtempSync(join(tmpdir(), "vibectx-autowarm-scope-link-")), "home-link");
    symlinkSync(project, link);
    expect(autowarmProjectDir(project, link)).toBeUndefined(); // home given as a symlink
    expect(autowarmProjectDir(link, realpathSync(project))).toBeUndefined(); // cwd given as a symlink to home
    rmSync(join(link, ".."), { recursive: true, force: true });
  });

  it("PAR-1048: a working directory that cannot be read is reported, not thrown", async () => {
    const { startAutowarm } = await import("../src/autowarm.js");
    const warnings: string[] = [];
    const summary = await startAutowarm(registry(), {
      warn: (m) => void warnings.push(m),
      scope: { kind: "project", cwd: () => { throw new Error("cwd is gone"); }, mayResolve: () => false },
    });
    expect(summary.attempted).toBe(0);
    expect(warnings.join("")).toContain("cwd is gone");
  });
});
