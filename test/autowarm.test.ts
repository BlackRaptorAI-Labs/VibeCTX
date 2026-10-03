import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readCache, writeCache, urlSlug, libDirName } from "../src/cache.js";
import { DEFAULT_REGISTRY, loadDiscoveredRegistry, type Registry } from "../src/registry.js";
import {
  AUTOWARM_CONCURRENCY,
  AUTOWARM_OPT_OUT_ENV,
  shouldAutowarm,
  configuredEntriesNeedingWarm,
  startAutowarm,
  autowarmStatus,
  resetAutowarm,
} from "../src/autowarm.js";
import { listLibrariesText } from "../src/list-libraries.js";
import { dispatchCli } from "../src/cli.js";
import { readIndex, resetSearchIndexMemo } from "../src/search-index.js";
import { runSearch } from "../src/search.js";
import { getLibraryDoc } from "../src/fetcher.js";
import { stubPublicDns } from "./helpers/public-dns.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-autowarm-"));
  process.env.VIBECTX_CACHE_DIR = dir;
  resetAutowarm();
  stubPublicDns();
});

afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const REACT_URL = "https://react.dev/llms-full.txt";
const HONO_URL = "https://hono.dev/llms.txt";
const ZOD_URL = "https://zod.dev/llms.txt";
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

function fetchDocWithLookup(entry: Parameters<typeof getLibraryDoc>[0]) {
  return getLibraryDoc(entry, { lookup: publicLookup });
}

function registry(): Registry {
  return {
    entries: new Map([
      ["react", { name: "react", urls: [REACT_URL] }],
      ["hono", { name: "hono", urls: [HONO_URL], ttlHours: 0 }],
      ["zod", { name: "zod", urls: [ZOD_URL] }],
      [
        "elysia",
        {
          name: "elysia",
          urls: ["https://elysiajs.com/llms.txt"],
          resolved: { source: "npm", resolvedAt: "2026-09-06T00:00:00.000Z", metadataUrl: "https://registry.npmjs.org/elysia/latest" },
        },
      ],
    ]),
  };
}

/** n configured entries, none cached. */
function manyEntries(n: number): Registry {
  const entries = new Map();
  for (let i = 0; i < n; i++) entries.set(`lib${i}`, { name: `lib${i}`, urls: [`https://lib${i}.example.com/llms.txt`] });
  return { entries };
}

/** A fetch stub that resolves after `ms`, tracking peak concurrency. */
function slowFetch(ms: number, body = "# doc") {
  const state = { inFlight: 0, peak: 0, urls: [] as string[] };
  const spy = vi.fn(async (url: unknown) => {
    state.inFlight += 1;
    state.peak = Math.max(state.peak, state.inFlight);
    state.urls.push(String(url));
    await new Promise((r) => setTimeout(r, ms));
    state.inFlight -= 1;
    return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
  });
  vi.stubGlobal("fetch", spy);
  return { spy, state };
}

describe("shouldAutowarm (R5: env only — the server has no --offline mode)", () => {
  it("is on by default for the long-lived server, off with VIBECTX_NO_AUTOWARM set to anything but '', '0', 'false'", () => {
    expect(AUTOWARM_OPT_OUT_ENV).toBe("VIBECTX_NO_AUTOWARM");
    expect(shouldAutowarm({})).toBe(true);
    expect(shouldAutowarm({ VIBECTX_NO_AUTOWARM: "1" })).toBe(false);
    expect(shouldAutowarm({ VIBECTX_NO_AUTOWARM: "true" })).toBe(false);
    expect(shouldAutowarm({ VIBECTX_NO_AUTOWARM: "yes" })).toBe(false);
    expect(shouldAutowarm({ VIBECTX_NO_AUTOWARM: "0" })).toBe(true);
    expect(shouldAutowarm({ VIBECTX_NO_AUTOWARM: "false" })).toBe(true);
    expect(shouldAutowarm({ VIBECTX_NO_AUTOWARM: "" })).toBe(true);
  });
});

describe("configuredEntriesNeedingWarm", () => {
  it("picks configured (non-resolved) entries that are uncached or past TTL; fresh ones and resolved ones are left alone", () => {
    writeCache("react", REACT_URL, "# React fresh");
    writeCache("hono", HONO_URL, "# Hono stale"); // ttlHours 0 → stale at once
    const names = configuredEntriesNeedingWarm(registry()).map((e) => e.name);
    expect(names).toEqual(["hono", "zod"]);
  });

  it("A4: a corrupt meta.json reads as uncached (never throws), so that entry needs warm like any other uncached one", () => {
    mkdirSync(join(dir, libDirName("react")), { recursive: true });
    const slug = urlSlug(REACT_URL);
    writeFileSync(join(dir, libDirName("react"), `${slug}.md`), "# React", "utf8");
    writeFileSync(join(dir, libDirName("react"), `${slug}.meta.json`), "{ corrupt", "utf8");
    let names: string[] = [];
    expect(() => {
      names = configuredEntriesNeedingWarm(registry()).map((e) => e.name);
    }).not.toThrow();
    expect(names).toContain("react");
  });
});

describe("startAutowarm", () => {
  it("revalidates stale entries etag-first and fetches uncached ones; list_libraries shows warming… while in flight", async () => {
    writeCache("react", REACT_URL, "# React fresh"); // fresh: left alone
    writeCache("hono", HONO_URL, "# Hono old", '"v1"'); // stale (ttl 0): revalidated
    const reg = registry(); // zod: uncached → fetched; elysia: resolved → left alone
    const seenDuring: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        seenDuring.push(listLibrariesText(reg));
        await new Promise((r) => setTimeout(r, 5));
        if (String(url) === HONO_URL) {
          expect((init?.headers as Record<string, string>)["if-none-match"]).toBe('"v1"');
          return new Response(null, { status: 304 });
        }
        return new Response("# Zod", { status: 200, headers: { "content-type": "text/plain" } });
      }),
    );
    const notes: string[] = [];
    expect(autowarmStatus().started).toBe(false);
    const summary = await startAutowarm(reg, { warn: (m) => notes.push(m), fetchDoc: fetchDocWithLookup });
    expect(summary).toEqual({ attempted: 2, cached: 2, failed: [], aborted: 0 });
    expect(autowarmStatus().started).toBe(true);
    expect(autowarmStatus().inFlight.size).toBe(0);
    expect(readCache("zod", ZOD_URL, 168)?.content).toBe("# Zod");
    expect(readCache("hono", HONO_URL, 168)?.content).toBe("# Hono old"); // 304: TTL touched, body untouched
    expect(seenDuring.some((t) => /\*\*hono\*\*.*warming…/.test(t) || /\*\*zod\*\*.*warming…/.test(t))).toBe(true);
    expect(listLibrariesText(reg)).not.toContain("warming…");
    expect(notes.join("")).toMatch(/^vibectx: autowarm cached 2\/2 configured libraries\n$/);
  });

  it("Q4: with six entries needing warm, peak concurrency is exactly AUTOWARM_CONCURRENCY", async () => {
    expect(AUTOWARM_CONCURRENCY).toBe(2);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const state = { inFlight: 0, peak: 0, calls: 0 };
    const pending = startAutowarm(manyEntries(6), {
      warn: () => {},
      fetchDoc: async (entry) => {
        state.calls += 1;
        state.inFlight += 1;
        state.peak = Math.max(state.peak, state.inFlight);
        await barrier;
        state.inFlight -= 1;
        return { content: "# doc", url: entry.urls[0], finalUrl: entry.urls[0], fetchedAt: "2026-09-23T00:00:00.000Z", stale: false };
      },
    });
    const initiallyInFlight = autowarmStatus().inFlight.size;
    release();
    const summary = await pending;
    expect(summary).toEqual({ attempted: 6, cached: 6, failed: [], aborted: 0 });
    expect(state.calls).toBe(6);
    expect(initiallyInFlight).toBe(AUTOWARM_CONCURRENCY);
    expect(state.peak).toBe(AUTOWARM_CONCURRENCY);
  });

  it("R4: once the signal aborts, no further entry is scheduled; the ones in flight finish; the summary says how many never started", async () => {
    const { spy, state } = slowFetch(20);
    const controller = new AbortController();
    const notes: string[] = [];
    const run = startAutowarm(manyEntries(8), { signal: controller.signal, warn: (m) => notes.push(m), fetchDoc: fetchDocWithLookup });
    await new Promise((r) => setTimeout(r, 5)); // the first two are in flight
    expect(autowarmStatus().inFlight.size).toBe(2);
    controller.abort();
    const summary = await run;
    expect(spy).toHaveBeenCalledTimes(2);
    // Both the per-call resolver and beforeEach public-DNS stub remove OS DNS latency;
    // this asserts WHICH TWO were fetched, not the order concurrent work settled.
    expect([...state.urls].sort()).toEqual(["https://lib0.example.com/llms.txt", "https://lib1.example.com/llms.txt"]);
    expect(summary).toEqual({ attempted: 8, cached: 2, failed: [], aborted: 6 });
    expect(autowarmStatus().inFlight.size).toBe(0);
    expect(notes.join("")).toBe("vibectx: autowarm cached 2/8 configured libraries; 6 not started (transport closed)\n");
  });

  it("R4: a signal already aborted before the run starts schedules nothing", async () => {
    const { spy } = slowFetch(1);
    const controller = new AbortController();
    controller.abort();
    const summary = await startAutowarm(manyEntries(3), { signal: controller.signal, warn: () => {} });
    expect(spy).not.toHaveBeenCalled();
    expect(summary).toEqual({ attempted: 3, cached: 0, failed: [], aborted: 3 });
  });

  it("Q5: a cache directory that cannot be written (a file where the library dir belongs) fails that entry only; the run completes and reports it", async () => {
    writeFileSync(join(dir, libDirName("zod")), "not a directory", "utf8"); // writeCache → mkdirSync throws ENOTDIR/EEXIST
    writeCache("react", REACT_URL, "# React fresh");
    const reg: Registry = { entries: new Map([...registry().entries].filter(([k]) => k !== "hono")) };
    vi.stubGlobal("fetch", vi.fn(async () => new Response("# Zod", { status: 200, headers: { "content-type": "text/plain" } })));
    const notes: string[] = [];
    const summary = await startAutowarm(reg, { warn: (m) => notes.push(m), fetchDoc: fetchDocWithLookup });
    expect(summary).toEqual({ attempted: 1, cached: 0, failed: ["zod"], aborted: 0 });
    expect(autowarmStatus().inFlight.size).toBe(0);
    expect(notes.join("")).toMatch(/^vibectx: autowarm cached 0\/1 configured libraries; not fetched: zod \(zod: E(NOTDIR|EXIST)/);
  });

  it("Q5, superseded by A4: one corrupt meta no longer aborts the whole warm batch", async () => {
    // Before A4: a corrupt meta.json made the pre-scan itself throw, aborting the WHOLE
    // batch — every other entry went silently unwarmed too, not just the corrupt one. After
    // A4: that one entry just reads as uncached, and the run completes normally for all of
    // them (react, hono and zod all attempted below; react because its meta reads as
    // uncached, not because anything threw).
    mkdirSync(join(dir, libDirName("react")), { recursive: true });
    const slug = urlSlug(REACT_URL);
    writeFileSync(join(dir, libDirName("react"), `${slug}.md`), "# React", "utf8");
    writeFileSync(join(dir, libDirName("react"), `${slug}.meta.json`), "{ corrupt", "utf8");
    const notes: string[] = [];
    const summary = await startAutowarm(registry(), {
      warn: (m) => notes.push(m),
      fetchDoc: async () => undefined, // network unavailable for every entry in this test
    });
    // react, hono and zod all needed warm (react because its meta reads as uncached, not
    // because it threw); elysia is resolved and stays excluded. All three were genuinely
    // attempted — this is the fix: one corrupt file no longer silently skips the batch.
    expect(summary).toEqual({ attempted: 3, cached: 0, failed: ["react", "hono", "zod"], aborted: 0 });
    expect(notes.join("")).toBe("vibectx: autowarm cached 0/3 configured libraries; not fetched: react, hono, zod\n");
  });

  it("swallows a throwing fetchDoc and a network failure alike: the promise resolves and the failures are reported once", async () => {
    const reg = registry();
    const notes: string[] = [];
    const summary = await startAutowarm(reg, {
      warn: (m) => notes.push(m),
      fetchDoc: async (entry) => {
        if (entry.name === "zod") throw new Error("boom");
        return undefined;
      },
    });
    expect(summary).toEqual({ attempted: 3, cached: 0, failed: ["react", "hono", "zod"], aborted: 0 });
    expect(notes.join("")).toBe("vibectx: autowarm cached 0/3 configured libraries; not fetched: react, hono, zod (zod: boom)\n");
  });

  it("a warn sink that throws (stderr closed) does not break the run", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("# doc", { status: 200, headers: { "content-type": "text/plain" } })));
    await expect(
      startAutowarm(manyEntries(1), {
        warn: () => {
          throw new Error("EPIPE");
        },
        fetchDoc: fetchDocWithLookup,
      }),
    ).resolves.toEqual({ attempted: 1, cached: 1, failed: [], aborted: 0 });
  });

  it("does nothing, and says nothing, when every configured entry is fresh", async () => {
    writeCache("react", REACT_URL, "# React");
    writeCache("zod", ZOD_URL, "# Zod");
    const reg: Registry = { entries: new Map([...registry().entries].filter(([k]) => k !== "hono")) };
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const notes: string[] = [];
    expect(await startAutowarm(reg, { warn: (m) => notes.push(m) })).toEqual({ attempted: 0, cached: 0, failed: [], aborted: 0 });
    expect(spy).not.toHaveBeenCalled();
    expect(notes).toEqual([]);
  });

  it("is never started by the doctor / resolve / warm subcommands", async () => {
    const spy = vi.fn(async () => new Response("not found", { status: 404 }));
    vi.stubGlobal("fetch", spy);
    const io = { stdout: () => {}, stderr: () => {} };
    await dispatchCli(["node", "dist/index.js", "doctor", "--offline"], io);
    await dispatchCli(["node", "dist/index.js", "resolve", "zz-nothing"], io);
    await dispatchCli(["node", "dist/index.js", "warm", dir, "--offline"], io);
    expect(autowarmStatus().started).toBe(false);
  });

  it("source tripwire: server.ts starts it only from the post-consent callback, guarded by shouldAutowarm, never awaited; index.ts closes the server when stdin ends", () => {
    const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    const connectAt = server.indexOf("await server.connect(transport)");
    const consentAt = server.indexOf("onOnline: (decision) => {");
    const startAt = server.indexOf("startAutowarm(registry");
    expect(connectAt).toBeGreaterThan(-1);
    expect(consentAt).toBeGreaterThan(-1);
    expect(server.slice(connectAt)).not.toContain("checkForUpdate("); // PAR-1040: never at connect
    expect(startAt).toBeGreaterThan(consentAt);
    expect(server.slice(consentAt, startAt)).toContain("shouldAutowarm(");
    expect(server.slice(connectAt)).not.toContain("startAutowarm(");
    const startLine = server.split("\n").find((l) => l.includes("startAutowarm(registry"))!;
    expect(startLine).not.toContain("await");
    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(index).toMatch(/process\.stdin\.once\("end", \(\) => void started\.server\.close\(\)\)/);
    expect(index).not.toContain("startAutowarm(");
  });
});

/**
 * PAR-659 · D-34 — the startup autowarm leaves a usable cross-library search index behind, so
 * the first `search` of a session is the fast path rather than a full re-tokenization.
 */
describe("autowarm leaves a usable search index behind (PAR-659, D-34)", () => {
  it("indexes each primary document it warmed", async () => {
    resetSearchIndexMemo();
    const reg: Registry = {
      entries: new Map([
        ["react", { name: "react", urls: [REACT_URL] }],
        ["hono", { name: "hono", urls: [HONO_URL] }],
      ]),
    };
    await startAutowarm(reg, {
      fetchDoc: async (entry) => ({
        content: `# ${entry.name}\n\n## Streaming\n\nserver-sent events`,
        url: entry.urls[0],
        finalUrl: entry.urls[0],
        fetchedAt: "2026-01-01T00:00:00.000Z",
        stale: false,
      }),
    });
    expect([...readIndex().libraries.keys()].sort()).toEqual(["hono", "react"]);
    expect(runSearch(reg, { query: "server-sent events" }).tokenized).toBe(0);
  });

  it("an index failure never fails the autowarm", async () => {
    resetSearchIndexMemo();
    const reg: Registry = { entries: new Map([["react", { name: "react", urls: [REACT_URL] }]]) };
    // A cache root whose parent is a FILE: mkdirSync throws ENOTDIR, so every index write fails.
    writeFileSync(join(dir, "blocked"), "not a directory", "utf8");
    process.env.VIBECTX_CACHE_DIR = join(dir, "blocked", "cache");
    const notes: string[] = [];
    const summary = await startAutowarm(reg, {
      warn: (m) => notes.push(m),
      fetchDoc: async (entry) => ({
        content: "# React",
        url: entry.urls[0],
        finalUrl: entry.urls[0],
        fetchedAt: "2026-01-01T00:00:00.000Z",
        stale: false,
      }),
    });
    expect(summary.cached).toBe(1);
    expect(summary.failed).toEqual([]);
    expect(notes.join("")).toMatch(/search index not written|ENOTDIR/);
  });
});

/**
 * A1 (PAR-714) enforcement liveness. VibeCTX-audit-2026-09-08.md §4.1: a `vibectx.config.json`
 * COMMITTED TO THE REPO and auto-discovered (no `--config` flag — exactly what `startAutowarm`
 * (server.ts:195) fetches at server startup with no user action) names an internal endpoint;
 * this proves the fix holds on THAT path, not only on a direct `readConfigFile` call.
 *
 * Follows the "prove absence of request" pattern at test/fetcher.test.ts:425-562, with one
 * correction a round of test-auditor review caught: the target here is `https://127.0.0.1`,
 * but this stand-in listener is a plain `node:http` server (no TLS) — a real `fetch` to it
 * sends a TLS ClientHello, which the server's HTTP parser cannot read as a request line, so
 * the CONNECTION is made but the REQUEST handler never fires. `listenerHits` (request-level)
 * would therefore stay `[]` whether or not the fix works — it is kept for diagnostic detail
 * only. `connections` (TCP-accept-level, scheme-agnostic) is the assertion that actually
 * proves absence, and a positive-control test below proves the instrument can fire at all.
 */
describe("enforcement liveness (A1, PAR-714): a committed config's forbidden urls entry never reaches startAutowarm's fetch", () => {
  let repo: string;
  let home: string;
  let server: Server;
  let listenerHits: string[];
  let connections: number;
  let port: number;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "vibectx-enforce-repo-"));
    home = mkdtempSync(join(tmpdir(), "vibectx-enforce-home-"));
    mkdirSync(join(repo, ".git")); // an ordinary clone — project-scope config discovery applies
    listenerHits = [];
    connections = 0;
    server = createServer((req, res) => {
      listenerHits.push(`${req.method} ${req.url}`);
      res.end("SECRET");
    });
    server.on("connection", () => {
      connections += 1;
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
    // Every DEFAULT_REGISTRY entry pre-warmed and fresh, so startAutowarm below has nothing
    // legitimate left to fetch either — this test is entirely about the config-contributed
    // entry, not the 30 real-network defaults (out of scope here; covered elsewhere).
    for (const e of DEFAULT_REGISTRY) writeCache(e.name, e.urls[0], "# cached");
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("the listener instrument is live: a direct plain-http request to it registers a connection and a hit", async () => {
    // Positive control (test/fetcher.test.ts:500-507's pattern): proves `connections` and
    // `listenerHits` actually increment on a real request, so their staying at zero in the
    // next tests is evidence of absence, not of a miswired counter. Talks plain http — this
    // is the harness proving itself, not the app under test.
    const res = await fetch(`http://127.0.0.1:${port}/probe`);
    await res.text();
    expect(connections).toBe(1);
    expect(listenerHits).toEqual(["GET /probe"]);

    // Also probes via the literal string `localhost`, on THIS environment's actual DNS/family
    // resolution (Node's autoSelectFamily default may prefer ::1 and fall back to 127.0.0.1,
    // or resolve 127.0.0.1 directly — either way, if it reaches this server at all, this proves
    // it) — so the localhost negative test below is proven live here, not assumed live.
    const res2 = await fetch(`http://localhost:${port}/probe2`);
    await res2.text();
    expect(connections).toBe(2);
    expect(listenerHits).toEqual(["GET /probe", "GET /probe2"]);
  });

  it("the entry is rejected at discovery (never enters the registry) and startAutowarm makes zero requests", async () => {
    const target = `https://127.0.0.1:${port}/latest/meta-data/iam/security-credentials/`;
    writeFileSync(join(repo, "vibectx.config.json"), JSON.stringify({ libraries: [{ name: "internal-docs", urls: [target] }] }), "utf8");

    // The exact call index.ts makes before starting the server (no --config flag: discovery
    // finds the committed project file on its own, as the exploit relies on).
    const registry = loadDiscoveredRegistry({ cwd: repo, env: {}, home, warn: () => {} });

    expect(registry.entries.has("internal-docs")).toBe(false);
    expect(registry.config?.files).toHaveLength(1);
    expect(registry.config?.files[0].error).toMatch(
      /^libraries\[0\]\.urls \("internal-docs"\): "https:\/\/127\.0\.0\.1:\d+\/latest\/meta-data\/iam\/security-credentials\/" is a private, loopback or non-routable host$/,
    );

    // The exact call server.ts:195 makes next, on this exact registry, with the REAL fetch
    // path (no fetchDoc stub) — if enforcement ever regressed to a config-load-only check that
    // some other path bypassed, this is where it would show up as a real request.
    const summary = await startAutowarm(registry, { warn: () => {} });

    expect(summary.attempted).toBe(0);
    // Scheme-agnostic proof: no TCP connection was ever opened to the listener, so the request
    // never left the process — not merely that its HTTP request line was never parsed.
    expect(connections).toBe(0);
    expect(listenerHits).toEqual([]);
  });

  it("also holds for `localhost:<port>` (proven live above against this exact address resolution)", async () => {
    // 169.254.169.254 (link-local) cannot be bound without assigning it to a real interface,
    // and a .local/.internal name or a single-label host does not resolve to any address this
    // process controls — a "real listener" proof for those three would need to fake OS-level
    // network or DNS infrastructure, not exercise more of this code. They're covered instead
    // by test/config.test.ts's D-22-grammar rejection assertions and test/link-policy.test.ts's
    // unit-level `validateLibraryUrl` coverage. `localhost` and the IPv6 loopback (below) ARE
    // real, controllable addresses, so they get the same live-listener treatment as 127.0.0.1 —
    // and the positive control above proved `localhost`'s address resolution reaches a server
    // bound identically (127.0.0.1) moments earlier in this same run.
    const target = `https://localhost:${port}/x`;
    writeFileSync(join(repo, "vibectx.config.json"), JSON.stringify({ libraries: [{ name: "internal-docs", urls: [target] }] }), "utf8");

    const registry = loadDiscoveredRegistry({ cwd: repo, env: {}, home, warn: () => {} });
    expect(registry.entries.has("internal-docs")).toBe(false);

    const summary = await startAutowarm(registry, { warn: () => {} });
    expect(summary.attempted).toBe(0);
    expect(connections).toBe(0);
    expect(listenerHits).toEqual([]);
  });

  it("also holds for an IPv6 loopback literal, `[::1]` — a second real, bindable listener", async () => {
    const v6Hits: string[] = [];
    let v6Connections = 0;
    const v6Server = createServer((req, res) => {
      v6Hits.push(`${req.method} ${req.url}`);
      res.end("SECRET");
    });
    v6Server.on("connection", () => {
      v6Connections += 1;
    });
    try {
      await new Promise<void>((resolve, reject) => {
        v6Server.once("error", reject);
        v6Server.listen(0, "::1", resolve);
      });
    } catch {
      return; // no IPv6 loopback on this machine/CI runner — nothing to test here
    }
    try {
      const v6Port = (v6Server.address() as AddressInfo).port;

      // Positive control on this server too — [::1]'s reachability isn't guaranteed on every
      // host the suite runs on, so prove it before trusting a zero count from it.
      const probe = await fetch(`http://[::1]:${v6Port}/probe`);
      await probe.text();
      expect(v6Connections).toBe(1);
      expect(v6Hits).toEqual(["GET /probe"]);

      const target = `https://[::1]:${v6Port}/latest/meta-data`;
      writeFileSync(join(repo, "vibectx.config.json"), JSON.stringify({ libraries: [{ name: "internal-docs", urls: [target] }] }), "utf8");

      const registry = loadDiscoveredRegistry({ cwd: repo, env: {}, home, warn: () => {} });
      expect(registry.entries.has("internal-docs")).toBe(false);

      const summary = await startAutowarm(registry, { warn: () => {} });
      expect(summary.attempted).toBe(0);
      expect(v6Connections).toBe(1); // unchanged since the positive-control probe above
      expect(v6Hits).toEqual(["GET /probe"]);
    } finally {
      await new Promise<void>((r) => v6Server.close(() => r()));
    }
  });

  it("D-47: the same entry with allowInternalHosts:true is admitted, and IS the one startAutowarm schedules for fetch", async () => {
    const target = `https://127.0.0.1:${port}/docs.txt`;
    writeFileSync(
      join(repo, "vibectx.config.json"),
      JSON.stringify({ libraries: [{ name: "internal-docs", urls: [target], allowInternalHosts: true }] }),
      "utf8",
    );

    const registry = loadDiscoveredRegistry({ cwd: repo, env: {}, home, warn: () => {} });
    expect(registry.entries.has("internal-docs")).toBe(true);
    expect(registry.config?.files[0].error).toBeUndefined();

    // fetchDoc stubbed here (not the real network): the real TLS handshake against a plain
    // http.Server is a separate concern from A1, which is about ADMISSION into the registry —
    // that admission is what this asserts, via the exact entry startAutowarm hands to fetchDoc.
    const fetchDoc = vi.fn(async (entry: { name: string; urls: string[] }) => ({
      content: "# docs",
      url: entry.urls[0],
      finalUrl: entry.urls[0],
      fetchedAt: "2026-01-01T00:00:00.000Z",
      stale: false,
    }));
    const summary = await startAutowarm(registry, { warn: () => {}, fetchDoc });

    expect(summary.attempted).toBe(1);
    expect(summary.cached).toBe(1);
    expect(fetchDoc).toHaveBeenCalledTimes(1);
    expect(fetchDoc.mock.calls[0][0]).toMatchObject({ name: "internal-docs", urls: [target] });
    // Deliberately no listenerHits/connections assertion here: fetchDoc is stubbed, so the
    // listener is untouched regardless of this test's outcome — asserting it would prove nothing.
  });
});
