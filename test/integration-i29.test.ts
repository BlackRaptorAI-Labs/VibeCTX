import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { writeCache, resetCacheRootState } from "../src/cache.js";
import { readConsent } from "../src/consent.js";
import { activityLogPath, readActivityTrail, ACTIVITY_LOG_SCHEMA_VERSION } from "../src/activity-log.js";
import { ACTIVITY_LOG_ROTATE_ENTRIES } from "../src/limits.js";
import { resetAutowarm, resetBackgroundResolutionWindow } from "../src/autowarm.js";
import { resetResolutionWindow } from "../src/resolve.js";
import type { Registry } from "../src/registry.js";
import { startServer } from "../src/server.js";
import { stubPublicDns } from "./helpers/public-dns.js";

/**
 * I-29 integration pass (plan §8): one real server process, end to end, across the three
 * Track A areas that meet at the first online tool call.
 * - Consent (D-103): a client that cannot prompt gets the one-time disclosure, recorded as
 *   `disclosed`; nothing goes online at connect.
 * - Autowarm (D-105): that first online call starts the background warm of the project's own
 *   matching dependencies; an unknown dependency is not resolved under `disclosed`.
 * - Log rotation (D-104): the same call's activity entry rotates a full live log into a linked,
 *   hash-checked archive, and the trail reads back through both files.
 */
const REACT_URL = "https://react.dev/llms-full.txt";
const CACHED_URL = "https://cached.example.com/llms.txt";
const registry = (): Registry => ({
  entries: new Map([
    ["react", { name: "react", urls: [REACT_URL] }],
    ["cachedlib", { name: "cachedlib", urls: [CACHED_URL] }],
  ]),
});

let root: string;
let fetched: string[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vibectx-i29-"));
  vi.stubEnv("VIBECTX_CACHE_DIR", join(root, "cache"));
  vi.stubEnv("VIBECTX_NO_LOG", "");
  vi.stubEnv("VIBECTX_NO_AUTOWARM", "");
  resetCacheRootState();
  resetAutowarm();
  resetResolutionWindow();
  resetBackgroundResolutionWindow();
  stubPublicDns();
  fetched = [];
  vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
    const u = String(url);
    fetched.push(u);
    if (u === REACT_URL) return new Response("# React\n\n## Hooks\n\nuseState", { status: 200, headers: { "content-type": "text/plain" } });
    return new Response("not found", { status: 404 });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); resetCacheRootState();
  rmSync(root, { recursive: true, force: true });
});

it("I-29: the first online call discloses consent, warms only the project's matching dependency, and rotates a full activity log into a linked trail", async () => {
  const project = join(root, "project");
  writeCache("cachedlib", CACHED_URL, "# Cached\n\n## Start\n\nhello");
  mkdirSync(project);
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "app", dependencies: { react: "1.0.0", "zz-unknown": "1.0.0" } }));
  const seeded: string[] = [];
  for (let i = 0; i < ACTIVITY_LOG_ROTATE_ENTRIES; i++) {
    seeded.push(JSON.stringify({ schemaVersion: ACTIVITY_LOG_SCHEMA_VERSION, tool: "search", query: `q${i}`, outcome: "matched", timestamp: new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString() }));
  }
  writeFileSync(activityLogPath(), `${seeded.join("\n")}\n`, { mode: 0o600 });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const started = await startServer(registry(), serverTransport, { env: {}, warn: () => {}, cwd: project });
  const client = new Client({ name: "i29-integration", version: "0" }); // no elicitation capability
  await client.connect(clientTransport);
  try {
    expect(fetched).toEqual([]); // connecting makes no request
    expect(readConsent()).toBeUndefined();
    const reply = (await client.callTool({ name: "get_docs", arguments: { library: "cachedlib", topic: "start" } })) as { content: { text: string }[] };
    const summary = await started.autowarm;

    // Consent: disclosed once, recorded.
    expect(reply.content[0]!.text).toContain("Network access disclosure");
    expect(readConsent()?.network).toBe("disclosed");

    // Autowarm: the matching dependency only; no npm/PyPI lookup for the unknown one.
    expect(fetched.filter((u) => u === REACT_URL)).toEqual([REACT_URL]);
    expect(fetched.filter((u) => u.startsWith("https://registry.npmjs.org/") || u.startsWith("https://pypi.org/"))).toEqual([]);
    expect(summary?.attempted).toBe(1);

    // Rotation: the full live log became a linked archive; the new live file holds this call.
    const trail = readActivityTrail();
    expect(trail.files.map((f) => f.name)).toEqual(["activity.json", "activity-000001.json"]);
    expect(trail.files[0]!.entries).toBeGreaterThanOrEqual(1);
    expect(trail.files[1]).toMatchObject({ entries: ACTIVITY_LOG_ROTATE_ENTRIES, hash: "ok" });
    expect(trail.end).toEqual({ kind: "start" });
  } finally {
    await client.close();
  }
});
