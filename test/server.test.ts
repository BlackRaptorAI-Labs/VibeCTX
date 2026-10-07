import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { writeCache, libDirName } from "../src/cache.js";
import type { Registry } from "../src/registry.js";
import { autowarmStatus, resetAutowarm } from "../src/autowarm.js";
import { buildServer, MAX_PROJECT_DIR_CHARS, startServer, startServerWithReport } from "../src/server.js";
import { loadDiscoveredRegistry } from "../src/registry.js";
import { MAX_TOKENS_BUDGET } from "../src/search.js";
import { MAX_NAME_LENGTH } from "../src/package-names.js";
import { writeProjectRecord } from "../src/project-store.js";
import { saveConsent } from "../src/consent.js";
import { dispatchCli } from "../src/cli.js";
import { stubPublicDns } from "./helpers/public-dns.js";

/**
 * Q2 (PAR-656): the real McpServer over an in-memory transport — the tool list, a tool
 * call answered while the autowarm holds a fetch open, the `warming…` marker, and the
 * autowarm's start / opt-out / abort-on-close, all without a process or stdio.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-PATHMARK-server-"));
  process.env.VIBECTX_CACHE_DIR = dir;
  resetAutowarm();
  stubPublicDns();
});
afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  // Q2 (PAR-657): the done-when case spies process.cwd(); restoring it here means a failure
  // inside that test cannot leave every later file running against a temp directory.
  vi.restoreAllMocks();
});

const REACT_URL = "https://react.dev/llms-full.txt";
const ZOD_URL = "https://zod.dev/llms.txt";
const registry = (): Registry => ({
  entries: new Map([
    ["react", { name: "react", urls: [REACT_URL], description: "React" }],
    ["zod", { name: "zod", urls: [ZOD_URL], description: "Zod" }],
  ]),
});

describe("PAR-1009: human-reviewed MCP bug report", () => {
  const args = { operation: "get_docs", where: "network", errorClass: "NetworkError", techStack: [{ kind: "language", name: "TypeScript" }] };

  it("turns an unexpected transport startup failure into a path-free report offer", async () => {
    const transport = { start: async () => { throw new Error("SYNTHETIC_SECRET /Users/Private/name"); } } as unknown as Parameters<typeof startServer>[1];
    const result = await startServerWithReport(registry(), transport, { env: { VIBECTX_NO_AUTOWARM: "1" } });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("startup should fail");
    expect(result.text).toContain("startup failed in startup (UnknownError");
    expect(result.text).toContain("vibectx report-bug");
    expect(result.text).not.toMatch(/SYNTHETIC_SECRET|\/Users\/Private|issues\/new\?/);
  });

  it("offers after a full-refresh cache exception without disclosing its path", async () => {
    writeFileSync(join(dir, libDirName("react")), "not a directory");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("# React", { status: 200, headers: { "content-type": "text/plain" } })));
    const { client, started, call } = await connect(registry(), { VIBECTX_NO_AUTOWARM: "1" });
    try {
      const response = await call("refresh");
      expect(response).toContain("refresh failed in cache (CacheError");
      expect(response).toContain("vibectx report-bug");
      expect(response).not.toContain(dir);
      expect(response).not.toContain("issues/new?");
    } finally { await client.close(); await started.closed; }
  });

  it("offers a bug report for a failed refresh but not a link before human review", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream unavailable", { status: 503 })));
    const { client, started, call } = await connect(registry(), { VIBECTX_NO_AUTOWARM: "1" });
    try {
      const response = await call("refresh", { library: "react" });
      expect(response).toContain("FAILED");
      expect(response).toContain("report-bug");
      expect(response).toContain("refresh failed in network");
      expect(response).not.toContain("issues/new?");
    } finally {
      await client.close();
      await started.closed;
    }
  });

  it("offers for a resolver outage, not for a confirmed unknown package", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream unavailable", { status: 503 })));
    const { client, started, call } = await connect(registry(), { VIBECTX_NO_AUTOWARM: "1" });
    try {
      const response = await call("resolve_library", { name: "synthetic-package" });
      expect(response).toContain("report-bug");
      expect(response).toContain("resolve_library failed in network");
      expect(response).not.toContain("issues/new?");
      vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
      const absent = await call("resolve_library", { name: "synthetic-missing-package" });
      expect(absent).not.toContain("report-bug");
    } finally {
      await client.close();
      await started.closed;
    }
  });

  it("offers when get_docs implicit package resolution fails during a registry outage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream unavailable", { status: 503 })));
    const { client, started, call } = await connect(registry(), { VIBECTX_NO_AUTOWARM: "1" });
    try {
      const response = await call("get_docs", { library: "synthetic-package" });
      expect(response).toContain("Could not resolve");
      expect(response).toContain("get_docs failed in network (NetworkError");
      expect(response).toContain("vibectx report-bug");
      expect(response).not.toContain("issues/new?");
    } finally { await client.close(); await started.closed; }
  });

  it("offers when get_docs cannot fetch any configured source", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream unavailable", { status: 503 })));
    const { client, started, call } = await connect(registry(), { VIBECTX_NO_AUTOWARM: "1" });
    try {
      const response = await call("get_docs", { library: "react" });
      expect(response).toContain("All candidate URLs unreachable");
      expect(response).toContain("report-bug");
      expect(response).not.toContain("issues/new?");
    } finally {
      await client.close();
      await started.closed;
    }
  });

  it("offers after a get_docs cache-write failure without revealing its path", async () => {
    writeFileSync(join(dir, libDirName("react")), "not a directory");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("# React", { status: 200, headers: { "content-type": "text/plain" } })));
    const { client, started, call } = await connect(registry(), { VIBECTX_NO_AUTOWARM: "1" });
    try {
      const response = await call("get_docs", { library: "react" });
      expect(response).toContain("get_docs failed in cache (CacheError");
      expect(response).toContain("vibectx report-bug");
      expect(response).not.toContain(dir);
      expect(response).not.toContain("issues/new?");
    } finally { await client.close(); await started.closed; }
  });

  it("shows the exact preview in elicitation, and only a human yes produces a link", async () => {
    for (const confirm of [false, true]) {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const started = await startServer(registry(), serverTransport, { env: { VIBECTX_NO_AUTOWARM: "1" } });
      const client = new Client({ name: "bug-probe", version: "0" }, { capabilities: { elicitation: {} } });
      const shown: string[] = [];
      client.setRequestHandler(ElicitRequestSchema, async (request) => {
        shown.push(request.params.message);
        return { action: "accept" as const, content: { confirm } };
      });
      await client.connect(clientTransport);
      try {
        const result = await client.callTool({ name: "report_bug", arguments: args });
        const body = JSON.stringify(result);
        expect(shown[0]).toContain("VibeCTX bug report");
        expect(shown[0]).toContain("TypeScript");
        expect(shown[0]).not.toContain("issues/new?");
        expect(body.includes("issues/new?")).toBe(confirm);
        if (confirm) expect(decodeURIComponent(body)).toContain("VibeCTX version:");
      } finally {
        await client.close();
        await started.closed;
      }
    }
  });

  it("never generates a link when the MCP client cannot elicit human confirmation", async () => {
    const { client, started, call } = await connect(registry(), { VIBECTX_NO_AUTOWARM: "1" });
    try {
      const body = await call("report_bug", args);
      expect(body).toContain("VibeCTX bug report");
      expect(body).toContain("vibectx report-bug");
      expect(body).not.toContain("issues/new?");
    } finally {
      await client.close();
      await started.closed;
    }
  });
});

/** A fetch stub whose responses are released by the test. */
function heldFetch() {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const spy = vi.fn(async () => {
    await gate;
    return new Response("# doc", { status: 200, headers: { "content-type": "text/plain" } });
  });
  vi.stubGlobal("fetch", spy);
  return { spy, release };
}

async function connect(reg: Registry, env: NodeJS.ProcessEnv = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const notes: string[] = [];
  const started = await startServer(reg, serverTransport, { env, warn: (m) => notes.push(m) });
  const client = new Client({ name: "probe", version: "0" });
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[] };
    return res.content[0].text;
  };
  return { client, started, notes, call };
}

async function connectWithElicitation(reg: Registry, allow: boolean | "decline" | "cancel" | "hang" | "malformed", consentTimeoutMs?: number, env: NodeJS.ProcessEnv = { VIBECTX_NO_AUTOWARM: "1" }) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const started = await startServer(reg, serverTransport, { env, consentTimeoutMs });
  const client = new Client({ name: "consent-probe", version: "0" }, { capabilities: { elicitation: {} } });
  const elicitation = vi.fn(async (_request: { params: { message: string } }) => {
    if (allow === "hang") return new Promise<{ action: "cancel" }>(() => {});
    if (allow === "cancel") return { action: "cancel" as const };
    if (allow === "decline") return { action: "decline" as const };
    if (allow === "malformed") return { action: "accept" as const, content: { allow: "yes" as unknown as boolean } };
    return { action: "accept" as const, content: { allow } };
  });
  client.setRequestHandler(ElicitRequestSchema, elicitation);
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[] };
    return result.content[0].text;
  };
  return { client, started, call, elicitation };
}

describe("PAR-1002: first network access consent", () => {
  it("consent read checks regular-file type before the bounded read", () => {
    const source = readFileSync(new URL("../src/consent.ts", import.meta.url), "utf8");
    const regularAt = source.indexOf("if (!isRegularFile(path)) return undefined;");
    const boundedAt = source.indexOf("const raw = readBoundedRegularFile(path, MAX_CONSENT_BYTES);");
    expect(regularAt).toBeGreaterThan(-1);
    expect(boundedAt).toBeGreaterThan(regularAt);
  });

  it("README discloses the first-call wait and consent reset", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const consent = readme.match(/^## Network access and consent\n[\s\S]*?(?=\n#{1,6} )/m)?.[0];
    expect(consent).toContain("vibectx consent reset");
    expect(consent).toContain("dependency names and pinned versions");
    expect(consent).toContain("package-provided documentation sites");
    expect(consent).toContain("search");
    expect(consent).toContain("list_libraries");
    const revalidation = readme.match(/\*\*Background revalidation after consent\.\*\*[\s\S]*?(?=\n## )/)?.[0];
    expect(revalidation).toContain("the first network tool waits for consent");
    expect(revalidation).not.toContain("It never delays the handshake or a tool call");
  });

  it("accept stores allowed and asks only once", async () => {
    writeCache("react", REACT_URL, "# React docs");
    const { client, call, elicitation } = await connectWithElicitation(registry(), true);
    try {
      expect(await call("get_docs", { library: "react" })).toContain("# React docs");
      expect(await call("get_docs", { library: "react" })).toContain("# React docs");
      expect(elicitation).toHaveBeenCalledTimes(1);
      expect(elicitation.mock.calls[0][0].params.message).toContain("dependency names and pinned versions");
      expect(elicitation.mock.calls[0][0].params.message).toContain("package-provided documentation sites");
      expect(JSON.parse(readFileSync(join(dir, "consent.json"), "utf8"))).toMatchObject({
        schemaVersion: 1, network: "allowed", via: "elicitation",
      });
    } finally {
      await client.close();
    }
  });

  it("decline stores cache-only mode and fetches zero times", async () => {
    const fetchSpy = vi.fn(async () => new Response("# forbidden network doc", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const { client, call, elicitation } = await connectWithElicitation(registry(), false);
    try {
      const first = await call("get_docs", { library: "react" });
      const second = await call("get_docs", { library: "react" });
      expect(first).toContain("Offline mode, network not attempted");
      expect(second).toContain("Offline mode, network not attempted");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(elicitation).toHaveBeenCalledTimes(1);
      expect(JSON.parse(readFileSync(join(dir, "consent.json"), "utf8"))).toMatchObject({
        schemaVersion: 1, network: "declined", via: "elicitation",
      });
    } finally {
      await client.close();
    }
    const restarted = await connectWithElicitation(registry(), true);
    try {
      expect(await restarted.call("get_docs", { library: "react" })).toContain("Offline mode, network not attempted");
      expect(restarted.elicitation).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await restarted.client.close();
    }
  });

  it("a declined action keeps every network tool offline and prevents autowarm", async () => {
    const fetchSpy = vi.fn(async () => new Response("# forbidden network doc", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { react: "19" } }), "utf8");
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    const { client, call } = await connectWithElicitation(registry(), "decline", undefined, {});
    try {
      expect(await call("refresh", { library: "react" })).toContain("Network access was declined");
      expect(await call("resolve_library", { name: "unlisted" })).toContain("Network access was declined");
      expect(await call("get_docs", { library: "react" })).toContain("Offline mode, network not attempted");
      expect(await call("doctor", { library: "react" })).toContain("cache-only");
      expect(await call("warm_project")).toContain("cache-only");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(autowarmStatus().started).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("connect and cache-only tools do not start autowarm or fetch", async () => {
    const fetchSpy = vi.fn(async () => new Response("# doc", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const { client, started, call } = await connect(registry());
    try {
      expect(autowarmStatus().started).toBe(false);
      expect(started.autowarm).toBeUndefined();
      await call("list_libraries");
      await call("search", { query: "react" });
      expect(autowarmStatus().started).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(existsSync(join(dir, "consent.json"))).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("a client without elicitation sees a one-time fallback disclosure", async () => {
    writeCache("react", REACT_URL, "# React docs");
    const { client, call } = await connect(registry(), { VIBECTX_NO_AUTOWARM: "1" });
    try {
      const first = await call("get_docs", { library: "react" });
      const second = await call("get_docs", { library: "react" });
      expect(first).toContain("Network access disclosure:");
      expect(first).toContain("dependency names and pinned versions");
      expect(first).toContain("package-provided documentation sites");
      expect(first).toContain("vibectx consent reset");
      expect(second).not.toContain("Network access disclosure:");
    } finally {
      await client.close();
    }
    const restarted = await connect(registry(), { VIBECTX_NO_AUTOWARM: "1" });
    try {
      expect(await restarted.call("get_docs", { library: "react" })).not.toContain("Network access disclosure:");
    } finally {
      await restarted.client.close();
    }
  });

  it("cancel is remembered as disclosed and does not prompt again", async () => {
    writeCache("react", REACT_URL, "# React docs");
    const { client, call, elicitation } = await connectWithElicitation(registry(), "cancel");
    try {
      expect(await call("get_docs", { library: "react" })).toContain("Network access disclosure:");
      expect(await call("get_docs", { library: "react" })).not.toContain("Network access disclosure:");
      expect(elicitation).toHaveBeenCalledTimes(1);
      expect(JSON.parse(readFileSync(join(dir, "consent.json"), "utf8"))).toMatchObject({ network: "disclosed", via: "fallback" });
    } finally {
      await client.close();
    }
  });

  it("malformed accept content falls back to a remembered disclosure", async () => {
    writeCache("react", REACT_URL, "# React docs");
    const { client, call, elicitation } = await connectWithElicitation(registry(), "malformed");
    try {
      expect(await call("get_docs", { library: "react" })).toContain("Network access disclosure:");
      expect(elicitation).toHaveBeenCalledTimes(1);
      expect(JSON.parse(readFileSync(join(dir, "consent.json"), "utf8"))).toMatchObject({ network: "disclosed", via: "fallback" });
    } finally {
      await client.close();
    }
  });

  it("a never-answering client falls back after the injected request timeout", async () => {
    writeCache("react", REACT_URL, "# React docs");
    const { client, call, elicitation } = await connectWithElicitation(registry(), "hang", 20);
    try {
      expect(await call("get_docs", { library: "react" })).toContain("Network access disclosure:");
      expect(elicitation).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
    }
  });

  it("the elicitation request receives the injected timeout option", async () => {
    writeCache("react", REACT_URL, "# React docs");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const timed = await startServer(registry(), serverTransport, { env: { VIBECTX_NO_AUTOWARM: "1" }, consentTimeoutMs: 37 });
    const caller = new Client({ name: "timeout-option-probe", version: "0" });
    let observedTimeout: number | undefined;
    const optionSpy = vi.spyOn(timed.server.server, "elicitInput").mockImplementation(async (_params, options) => {
      observedTimeout = options?.timeout;
      throw new Error("synthetic timeout");
    });
    try {
      await caller.connect(clientTransport);
      const result = await caller.callTool({ name: "get_docs", arguments: { library: "react" } });
      expect(JSON.stringify(result)).toContain("Network access disclosure:");
      expect(optionSpy).toHaveBeenCalledTimes(1);
      expect(observedTimeout).toBe(37);
    } finally {
      await caller.close();
    }
  });

  it("CLI reset makes the next network call ask again", async () => {
    writeCache("react", REACT_URL, "# React docs");
    const first = await connectWithElicitation(registry(), true);
    await first.call("get_docs", { library: "react" });
    expect(first.elicitation).toHaveBeenCalledTimes(1);
    await first.client.close();
    const output: string[] = [];
    expect(await dispatchCli(["node", "dist/index.js", "consent", "reset"], {
      stdout: (s) => output.push(s), stderr: (s) => output.push(s),
    })).toBe(0);
    expect(output).toEqual(["none\n"]);
    const second = await connectWithElicitation(registry(), false);
    try {
      await second.call("get_docs", { library: "react" });
      expect(second.elicitation).toHaveBeenCalledTimes(1);
    } finally {
      await second.client.close();
    }
  });

  it("a running server observes CLI deny and reset before its next network call", async () => {
    writeCache("react", REACT_URL, "# React docs");
    const fetchSpy = vi.fn(async () => new Response("# online doc", { status: 200, headers: { "content-type": "text/plain" } }));
    vi.stubGlobal("fetch", fetchSpy);
    const { client, call, elicitation } = await connectWithElicitation(registry(), true);
    const cli = { stdout: (_s: string) => {}, stderr: (_s: string) => {} };
    try {
      await call("get_docs", { library: "react" });
      expect(elicitation).toHaveBeenCalledTimes(1);
      expect(await dispatchCli(["node", "dist/index.js", "consent", "deny"], cli)).toBe(0);
      expect(await call("refresh", { library: "react" })).toContain("Network access was declined");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await dispatchCli(["node", "dist/index.js", "consent", "allow"], cli)).toBe(0);
      expect(await call("refresh", { library: "react" })).toContain("refreshed from");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(await dispatchCli(["node", "dist/index.js", "consent", "reset"], cli)).toBe(0);
      await call("get_docs", { library: "react" });
      expect(elicitation).toHaveBeenCalledTimes(2);
    } finally {
      await client.close();
    }
  });

  it("a CLI deny during a pending elicitation wins over its later accept", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const fetchSpy = vi.fn(async () => new Response("# forbidden network doc", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const started = await startServer(registry(), serverTransport, { env: { VIBECTX_NO_AUTOWARM: "1" } });
    const client = new Client({ name: "race-probe", version: "0" }, { capabilities: { elicitation: {} } });
    const elicitation = vi.fn(async () => {
      await barrier;
      return { action: "accept" as const, content: { allow: true } };
    });
    client.setRequestHandler(ElicitRequestSchema, elicitation);
    await client.connect(clientTransport);
    try {
      const first = client.callTool({ name: "get_docs", arguments: { library: "react" } });
      await vi.waitFor(() => expect(elicitation).toHaveBeenCalledTimes(1));
      const cli = { stdout: (_s: string) => {}, stderr: (_s: string) => {} };
      expect(await dispatchCli(["node", "dist/index.js", "consent", "deny"], cli)).toBe(0);
      release();
      expect(JSON.stringify(await first)).toContain("Network access was declined");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(join(dir, "consent.json"), "utf8"))).toMatchObject({ network: "declined", via: "cli" });
      const next = await client.callTool({ name: "refresh", arguments: { library: "react" } });
      expect(JSON.stringify(next)).toContain("Network access was declined");
    } finally {
      release();
      await client.close();
      await started.closed;
    }
  });

  it("a CLI deny stops autowarm before it schedules more outbound fetches", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    const notes: string[] = [];
    const many: Registry = { entries: new Map() };
    for (let i = 0; i < 6; i++) many.entries.set(`lib${i}`, { name: `lib${i}`, urls: [`https://lib${i}.example.com/llms.txt`] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const started = await startServer(many, serverTransport, {
      env: { VIBECTX_AUTOWARM: "all" }, // PAR-1048: the six libraries are not project dependencies
      warn: (message) => notes.push(message),
      autowarmFetchDoc: async (entry) => {
        calls.push(entry.name);
        await barrier;
        return { content: "# doc", url: entry.urls[0], finalUrl: entry.urls[0], fetchedAt: "2026-09-23T00:00:00.000Z", stale: false };
      },
    });
    const client = new Client({ name: "autowarm-consent-probe", version: "0" });
    await client.connect(clientTransport);
    try {
      await client.callTool({ name: "doctor", arguments: { library: "unknown" } });
      expect(calls).toEqual(["lib0", "lib1"]);
      const cli = { stdout: (_s: string) => {}, stderr: (_s: string) => {} };
      expect(await dispatchCli(["node", "dist/index.js", "consent", "deny"], cli)).toBe(0);
      release();
      await started.autowarm;
      expect(calls).toEqual(["lib0", "lib1"]);
      expect(notes.join("")).toContain("not started (consent revoked)");
    } finally {
      release();
      await client.close();
    }
  });

  it("two concurrent first network calls share one elicitation", async () => {
    writeCache("react", REACT_URL, "# React docs");
    const { client, call, elicitation } = await connectWithElicitation(registry(), true);
    try {
      const results = await Promise.all([
        call("get_docs", { library: "react" }),
        call("get_docs", { library: "react" }),
      ]);
      expect(results).toHaveLength(2);
      expect(results.every((result) => result.includes("# React docs"))).toBe(true);
      expect(elicitation).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
    }
  });

  it("concurrent no-capability calls put the disclosure on exactly one response", async () => {
    writeCache("react", REACT_URL, "# React docs");
    const { client, call } = await connect(registry(), { VIBECTX_NO_AUTOWARM: "1" });
    try {
      const responses = await Promise.all([
        call("get_docs", { library: "react" }),
        call("get_docs", { library: "react" }),
      ]);
      expect(responses.filter((result) => result.startsWith("Network access disclosure:"))).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it("autowarm starts only once even if two server instances share this process", async () => {
    writeCache("react", REACT_URL, "# React docs");
    writeCache("zod", ZOD_URL, "# Zod docs");
    const first = await connect(registry());
    try {
      expect(first.started.autowarm).toBeUndefined();
      await first.call("get_docs", { library: "react" });
      expect(first.started.autowarm).toBeDefined();
      await first.started.autowarm;
    } finally {
      await first.client.close();
    }
    const second = await connect(registry());
    try {
      await second.call("get_docs", { library: "react" });
      expect(second.started.autowarm).toBeUndefined();
    } finally {
      await second.client.close();
    }
  });

  it("a symlinked consent store is ignored and never replaced", async () => {
    const target = join(dir, "target.json");
    writeFileSync(target, "synthetic sentinel", "utf8");
    symlinkSync(target, join(dir, "consent.json"));
    writeCache("react", REACT_URL, "# React docs");
    const { client, call, elicitation } = await connectWithElicitation(registry(), true);
    try {
      expect(await call("get_docs", { library: "react" })).toContain("# React docs");
      expect(elicitation).toHaveBeenCalledTimes(1);
      expect(readFileSync(target, "utf8")).toBe("synthetic sentinel");
      expect(readFileSync(join(dir, "consent.json"), "utf8")).toBe("synthetic sentinel");
    } finally {
      await client.close();
    }
  });

  it("a newer-schema consent store is not overwritten", async () => {
    const path = join(dir, "consent.json");
    const newer = JSON.stringify({ schemaVersion: 99, network: "declined", decidedAt: "future", via: "cli" });
    writeFileSync(path, newer, "utf8");
    writeCache("react", REACT_URL, "# React docs");
    const { client, call, elicitation } = await connectWithElicitation(registry(), true);
    try {
      expect(await call("get_docs", { library: "react" })).toContain("# React docs");
      expect(elicitation).toHaveBeenCalledTimes(1);
      expect(readFileSync(path, "utf8")).toBe(newer);
    } finally {
      await client.close();
    }
  });

  it("an oversized consent store is not read or replaced", async () => {
    const path = join(dir, "consent.json");
    const oversized = JSON.stringify({ schemaVersion: 1, network: "allowed", via: "cli", decidedAt: "2026-09-23T00:00:00.000Z", padding: "x".repeat(5000) });
    writeFileSync(path, oversized, "utf8");
    writeCache("react", REACT_URL, "# React docs");
    const { client, call, elicitation } = await connectWithElicitation(registry(), true);
    try {
      expect(await call("get_docs", { library: "react" })).toContain("# React docs");
      expect(elicitation).toHaveBeenCalledTimes(1);
      expect(readFileSync(path, "utf8")).toBe(oversized);
    } finally {
      await client.close();
    }
  });
});

describe("buildServer", () => {
  it("registers the eight tools", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildServer(registry());
    await server.connect(serverTransport);
    const client = new Client({ name: "probe", version: "0" });
    await client.connect(clientTransport);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["doctor", "get_docs", "list_libraries", "refresh", "report_bug", "resolve_library", "search", "warm_project"]);
    expect(autowarmStatus().started).toBe(false); // buildServer alone never warms
    await client.close();
  });

  it("S-B / D-12: warm_project's input schema is `dir` only — `force` is a CLI flag, not a model-callable one", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildServer(registry());
    await server.connect(serverTransport);
    const client = new Client({ name: "probe", version: "0" });
    await client.connect(clientTransport);
    const warm = (await client.listTools()).tools.find((t) => t.name === "warm_project")!;
    expect(Object.keys(warm.inputSchema.properties ?? {})).toEqual(["dir"]);
    expect(JSON.stringify(warm)).not.toContain("force");
    await client.close();
  });
});

describe("PAR-989: MCP responses do not disclose personal filesystem paths", () => {
  const stubHonoFetch = () => vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
    if (String(url) === "https://registry.npmjs.org/hono/latest") return new Response(JSON.stringify({ homepage: "https://hono.dev" }), { status: 200, headers: { "content-type": "application/json" } });
    if (String(url) === "https://hono.dev/llms-full.txt") return new Response("# Hono\n\nPublic docs.", { status: 200, headers: { "content-type": "text/plain" } });
    return new Response("not found", { status: 404 });
  }));

  it("PAR-1003: doctor hides the activity-log path after a get_docs call", async () => {
    const url = "https://hono.dev/llms-full.txt";
    writeCache("hono", url, "# Hono\n\nPublic docs.");
    const reg: Registry = { entries: new Map([["hono", { name: "hono", urls: [url] }]]) };
    const { client, call } = await connect(reg, { VIBECTX_NO_AUTOWARM: "1" });
    try {
      await call("get_docs", { library: "hono" });
      const out = await call("doctor", { offline: true });
      expect(out).toContain("activity log:");
      expect(out).not.toContain("PATHMARK");
    } finally {
      await client.close();
    }
  });

  it("PAR-1003: get_docs hides a newer-schema resolved store path", async () => {
    writeFileSync(join(dir, "resolved.json"), JSON.stringify({ schemaVersion: 99, entries: [] }), "utf8");
    stubHonoFetch();
    const { client, call } = await connect({ entries: new Map() }, { VIBECTX_NO_AUTOWARM: "1" });
    try {
      const out = await call("get_docs", { library: "hono" });
      expect(out).toContain("resolution not saved");
      expect(out).toContain("newer schemaVersion");
      expect(out).not.toContain("PATHMARK");
    } finally {
      await client.close();
    }
  });

  it("PAR-1003: get_docs hides a symlinked configured cache-root path", async () => {
    const real = join(dir, "real");
    const link = join(dir, "PATHMARK-link");
    mkdirSync(real);
    symlinkSync(real, link);
    process.env.VIBECTX_CACHE_DIR = link;
    stubHonoFetch();
    const { client, call } = await connect({ entries: new Map() }, { VIBECTX_NO_AUTOWARM: "1" });
    try {
      const out = await call("get_docs", { library: "hono" });
      expect(out).toContain("resolution not saved");
      expect(out).not.toContain("PATHMARK");
    } finally {
      await client.close();
    }
  });

  it("PAR-1003: failed implicit get_docs and resolve_library hide a cache-write blocker path", async () => {
    writeFileSync(join(dir, libDirName("hono")), "blocking file", "utf8");
    stubHonoFetch();
    const { client, call } = await connect({ entries: new Map() }, { VIBECTX_NO_AUTOWARM: "1" });
    try {
      for (const [tool, args] of [["get_docs", { library: "hono" }], ["resolve_library", { name: "hono", ecosystem: "npm" }]] as const) {
        const out = await call(tool, args);
        expect(out, tool).toContain("cache write failed");
        expect(out, tool).not.toContain("PATHMARK");
      }
    } finally {
      await client.close();
    }
  });

  it("PAR-1003: refresh hides a resolved entry's cache-write blocker path", async () => {
    writeFileSync(join(dir, libDirName("hono")), "blocking file", "utf8");
    stubHonoFetch();
    const reg: Registry = { entries: new Map([["hono", {
      name: "hono", urls: ["https://hono.dev/llms-full.txt"],
      resolved: { source: "npm", resolvedAt: "2026-09-06T00:00:00.000Z", metadataUrl: "https://registry.npmjs.org/hono/latest" },
    }]]) };
    const { client, call } = await connect(reg, { VIBECTX_NO_AUTOWARM: "1" });
    try {
      const out = await call("refresh", { library: "hono" });
      expect(out).toContain("FAILED");
      expect(out).not.toContain("PATHMARK");
    } finally {
      await client.close();
    }
  });

  it("resolve_library keeps the saved-record status but not the cache root", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
      if (String(url) === "https://registry.npmjs.org/hono/latest") {
        return new Response(JSON.stringify({ homepage: "https://hono.dev" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (String(url) === "https://hono.dev/llms-full.txt") return new Response("# Hono\n\nDocs.", { status: 200, headers: { "content-type": "text/plain" } });
      return new Response("not found", { status: 404 });
    }));
    const { client, call } = await connect({ entries: new Map() }, { VIBECTX_NO_AUTOWARM: "1" });
    const out = await call("resolve_library", { name: "hono", ecosystem: "npm" });
    expect(out).toContain("saved to");
    expect(out).not.toContain(dir);
    await client.close();
  });

  it("resolve_library hides the store path when a newer schema refuses the save", async () => {
    writeFileSync(join(dir, "resolved.json"), JSON.stringify({ schemaVersion: 99, entries: [] }), "utf8");
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
      if (String(url) === "https://registry.npmjs.org/hono/latest") return new Response(JSON.stringify({ homepage: "https://hono.dev" }), { status: 200, headers: { "content-type": "application/json" } });
      if (String(url) === "https://hono.dev/llms-full.txt") return new Response("# Hono\n\nDocs.", { status: 200, headers: { "content-type": "text/plain" } });
      return new Response("not found", { status: 404 });
    }));
    const { client, call } = await connect({ entries: new Map() }, { VIBECTX_NO_AUTOWARM: "1" });
    const out = await call("resolve_library", { name: "hono", ecosystem: "npm" });
    expect(out).toContain("NOT saved");
    expect(out).toContain("newer schemaVersion");
    expect(out).not.toContain(dir);
    await client.close();
  });

  it("warm_project reports success and failures without project or cache paths", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {} }), "utf8");
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(dir);
    const { client, call } = await connect({ entries: new Map() }, { VIBECTX_NO_AUTOWARM: "1" });
    try {
      const success = await call("warm_project");
      expect(success).toContain("0/0 dependencies cached");
      expect(success).not.toContain(dir);
      const missing = await call("warm_project", { dir: join(dir, "missing") });
      expect(missing).not.toContain(dir);
      const empty = join(dir, "empty");
      mkdirSync(empty);
      const noManifest = await call("warm_project", { dir: empty });
      expect(noManifest).toContain("no dependency manifest");
      expect(noManifest).not.toContain(dir);
      const outside = await call("warm_project", { dir: join(dir, "..", "outside") });
      expect(outside).toContain("outside the project directory");
      expect(outside).not.toContain(dir);
    } finally {
      await client.close();
      cwd.mockRestore();
    }
  });

  it("PAR-989: warm_project generic failures do not return path-bearing error details", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {} }), "utf8");
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(dir);
    const { client, call } = await connect({ entries: new Map() }, { VIBECTX_NO_AUTOWARM: "1" });
    const clock = vi.spyOn(Date.prototype, "getTime").mockImplementationOnce(() => {
      throw new Error(`diagnostic referenced ${join(dir, "private-note")}`);
    });
    try {
      const out = await call("warm_project");
      expect(out).toContain("warm_project failed");
      expect(out).not.toContain(dir);
      expect(out).not.toContain("private-note");
    } finally {
      clock.mockRestore();
      await client.close();
      cwd.mockRestore();
    }
  });

  it("list_libraries keeps project counts without the recorded absolute directory", async () => {
    writeProjectRecord({ schemaVersion: 1, dir, manifests: ["package.json"], dependencies: [], warmedAt: "2026-09-23T00:00:00.000Z" });
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(dir);
    const { client, call } = await connect({ entries: new Map() }, { VIBECTX_NO_AUTOWARM: "1" });
    try {
      const out = await call("list_libraries");
      expect(out).toContain("Project deps");
      expect(out).toContain("0 cached, 0 unresolved, 0 denied");
      expect(out).not.toContain(dir);
    } finally {
      await client.close();
      cwd.mockRestore();
    }
  });
});

describe('get_docs mode over the transport (D-26)', () => {
  const STRIPE_URL = "https://docs.stripe.com/llms-full.txt";
  const STRIPE_DOC = [
    "# Stripe",
    "## Checkout",
    "### Create a Checkout Session",
    "Create the session server-side, then redirect:",
    "```js",
    "const session = await stripe.checkout.sessions.create({",
    "  mode: 'payment',",
    "});",
    "```",
  ].join("\n");
  const stripeRegistry = (): Registry => ({
    entries: new Map([["stripe", { name: "stripe", urls: [STRIPE_URL], description: "Stripe" }]]),
  });

  it('mode "snippets" returns fenced code with its heading path and context line', async () => {
    writeCache("stripe", STRIPE_URL, STRIPE_DOC);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    const { client, call } = await connect(stripeRegistry(), { VIBECTX_NO_AUTOWARM: "1" });
    const out = await call("get_docs", { library: "stripe", topic: "checkout session create", mode: "snippets" });
    expect(out).toContain("### Stripe > Checkout > Create a Checkout Session");
    expect(out).toContain("Create the session server-side, then redirect:");
    expect(out).toContain("```js\nconst session = await stripe.checkout.sessions.create({");
    await client.close();
  });

  it("the default is sections mode, byte for byte", async () => {
    writeCache("stripe", STRIPE_URL, STRIPE_DOC);
    saveConsent("allowed", "cli"); // This test compares modes, not first-call disclosure.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    const { client, call } = await connect(stripeRegistry(), { VIBECTX_NO_AUTOWARM: "1" });
    const args = { library: "stripe", topic: "checkout session create" };
    expect(await call("get_docs", args)).toBe(await call("get_docs", { ...args, mode: "sections" }));
    expect(await call("get_docs", args)).toContain("## Stripe > Checkout > Create a Checkout Session");
    await client.close();
  });

  it("an unknown mode is rejected by the schema, not silently treated as sections", async () => {
    writeCache("stripe", STRIPE_URL, STRIPE_DOC);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    const { client, call } = await connect(stripeRegistry(), { VIBECTX_NO_AUTOWARM: "1" });
    // The SDK reports a schema violation as an error result, not a thrown transport error.
    const out = await call("get_docs", { library: "stripe", topic: "checkout", mode: "code" });
    expect(out).toContain("Input validation error");
    expect(out).toContain("mode");
    expect(out).not.toContain("Source:");
    await client.close();
  });

  it("A2 (PAR-715): the maxTokens matrix — Infinity, over-budget, negative, zero and fractional are schema errors; the default and the ceiling are accepted", async () => {
    // Pinned against a literal, not only against itself — see the identical note in cli.test.ts.
    expect(MAX_TOKENS_BUDGET).toBe(200_000);
    writeCache("stripe", STRIPE_URL, STRIPE_DOC);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    const { client, call } = await connect(stripeRegistry(), { VIBECTX_NO_AUTOWARM: "1" });
    for (const maxTokens of [Infinity, 1_000_000_000, -5, 0, 3.7, MAX_TOKENS_BUDGET + 1]) {
      const out = await call("get_docs", { library: "stripe", topic: "checkout session create", maxTokens });
      expect(out, `maxTokens: ${maxTokens}`).toContain("Input validation error");
    }
    for (const maxTokens of [4000, MAX_TOKENS_BUDGET]) {
      const out = await call("get_docs", { library: "stripe", topic: "checkout session create", maxTokens });
      expect(out, `maxTokens: ${maxTokens}`).toContain("Source:");
      expect(out, `maxTokens: ${maxTokens}`).not.toContain("Input validation error");
    }
    await client.close();
  });

  it("A11/PAR-724: the version param reaches getDocsToolText over the transport (a curated entry's explicit skip note is the observable proof)", async () => {
    writeCache("stripe", STRIPE_URL, STRIPE_DOC);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    const { client, call } = await connect(stripeRegistry(), { VIBECTX_NO_AUTOWARM: "1" });
    const out = await call("get_docs", { library: "stripe", topic: "checkout session create", version: "9.9.9" });
    expect(out).toContain("Not version-matched: you asked for stripe 9.9.9");
    await client.close();
  });

  it("get_docs advertises mode as an enum of exactly sections and snippets, and maxTokens as a bounded integer", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildServer(stripeRegistry());
    await server.connect(serverTransport);
    const client = new Client({ name: "probe", version: "0" });
    await client.connect(clientTransport);
    const getDocs = (await client.listTools()).tools.find((t) => t.name === "get_docs")!;
    const props = getDocs.inputSchema.properties as Record<string, { enum?: string[]; type?: string; exclusiveMinimum?: number; maximum?: number }>;
    // A11/PAR-724: "version" added for version-matched documentation.
    expect(Object.keys(props).sort()).toEqual(["library", "maxTokens", "mode", "topic", "version"]);
    expect(props.mode.enum).toEqual(["sections", "snippets"]);
    // A2 (PAR-715): this is what a conforming client actually reads — if the cap ever moved
    // out of the schema (into a `.refine()` or a handler-side clamp), this is the assertion
    // that would catch it; the rejection tests above would not, since both still reject.
    expect(props.maxTokens).toMatchObject({ type: "integer", exclusiveMinimum: 0, maximum: MAX_TOKENS_BUDGET });
    await client.close();
  });
});

// PAR-822 (security-audit #1-ranked finding) — Layer 1 of the two-layer fix: `get_docs.library`
// and `resolve_library.name` are bounded at the Zod parse boundary itself, the same way
// `get_docs.version` already is (A11/PAR-724) and `search.query` already is (D-41). This is a
// DIFFERENT assertion than the render-path clipping proven elsewhere (resolve.test.ts,
// registry.test.ts, get-docs.test.ts, doctor.test.ts, refresh.test.ts): it is "the call is
// refused outright before any handler code runs", not "the rendered text is bounded". This
// schema layer only bounds LENGTH — a hostile payload well under MAX_NAME_LENGTH sails through
// unchanged, so the render-path `clipText` is what actually strips control/bidi characters,
// for every caller including this one. The render-path clip is ALSO the only protection for
// the two CLI paths that bypass this schema entirely (`vibectx resolve <name>`, `vibectx doctor
// --library <x>`) — NOT `warm.ts`, whose dependency names are already validated by
// `project-deps.ts`'s own `npmNameError`/`pypiNameError` before ever reaching `resolvePackage`.
describe("get_docs.library / resolve_library.name — bounded at the schema boundary (PAR-822)", () => {
  function stub404() {
    const spy = vi.fn(async () => new Response("nope", { status: 404 }));
    vi.stubGlobal("fetch", spy);
    return spy;
  }

  it("get_docs: a library over MAX_NAME_LENGTH is an Input validation error, refused before any fetch", async () => {
    const spy = stub404();
    const { client, call } = await connect(registry(), { VIBECTX_NO_AUTOWARM: "1" });
    const out = await call("get_docs", { library: "a".repeat(MAX_NAME_LENGTH + 1) });
    expect(out).toContain("Input validation error");
    expect(spy).not.toHaveBeenCalled();
    await client.close();
  });

  it("get_docs: a library at exactly MAX_NAME_LENGTH is accepted by the schema (it may still fail to resolve, but not as a schema error)", async () => {
    stub404();
    const { client, call } = await connect(registry(), { VIBECTX_NO_AUTOWARM: "1" });
    const out = await call("get_docs", { library: "a".repeat(MAX_NAME_LENGTH) });
    expect(out).not.toContain("Input validation error");
    await client.close();
  });

  it("resolve_library: a name over MAX_NAME_LENGTH is an Input validation error, refused before any fetch", async () => {
    const spy = stub404();
    const { client, call } = await connect(registry(), { VIBECTX_NO_AUTOWARM: "1" });
    const out = await call("resolve_library", { name: "a".repeat(MAX_NAME_LENGTH + 1) });
    expect(out).toContain("Input validation error");
    expect(spy).not.toHaveBeenCalled();
    await client.close();
  });

  it("resolve_library: a name at exactly MAX_NAME_LENGTH is accepted by the schema (it may still fail to resolve, but not as a schema error)", async () => {
    stub404();
    const { client, call } = await connect(registry(), { VIBECTX_NO_AUTOWARM: "1" });
    const out = await call("resolve_library", { name: "a".repeat(MAX_NAME_LENGTH) });
    expect(out).not.toContain("Input validation error");
    await client.close();
  });
});

/** AUDIT-20260920-02 — every string supplied through MCP is bounded at the transport schema
 * before a handler can echo it, resolve it, or use it as a filesystem path. This is
 * application-level defense in depth: JSON-RPC has already received the message before Zod
 * evaluates it, so it is not a substitute for a transport-level inbound-message limit. */
describe("all remaining MCP string arguments — bounded at the schema boundary (AUDIT-20260920-02)", () => {
  it("rejects an over-limit library or directory field before the corresponding handler runs", async () => {
    const spy = vi.fn(async () => new Response("nope", { status: 404 }));
    vi.stubGlobal("fetch", spy);
    const { client, call } = await connect(registry(), { VIBECTX_NO_AUTOWARM: "1" });
    const oversizedName = "x".repeat(MAX_NAME_LENGTH + 1);
    const oversizedDir = "x".repeat(MAX_PROJECT_DIR_CHARS + 1);

    for (const [tool, args] of [
      ["refresh", { library: oversizedName }],
      ["doctor", { library: oversizedName }],
      ["search", { query: "anything", libraries: [oversizedName] }],
      ["warm_project", { dir: oversizedDir }],
    ] as const) {
      const out = await call(tool, args);
      expect(out, tool).toContain("Input validation error");
    }
    expect(spy).not.toHaveBeenCalled();
    await client.close();
  });

  it("accepts each newly bounded field at its exact schema limit", async () => {
    const { client, call } = await connect(registry(), { VIBECTX_NO_AUTOWARM: "1" });
    const exactName = "a".repeat(MAX_NAME_LENGTH);
    const exactDir = "a".repeat(MAX_PROJECT_DIR_CHARS);

    for (const [tool, args] of [
      ["refresh", { library: exactName }],
      ["doctor", { library: exactName }],
      ["search", { query: "anything", libraries: [exactName] }],
      ["warm_project", { dir: exactDir }],
    ] as const) {
      const out = await call(tool, args);
      expect(out, tool).not.toContain("Input validation error");
    }
    await client.close();
  });
});

/** PAR-852 — `get_docs.topic` gets the SAME schema-boundary treatment `library`/`name` got at
 *  PAR-822: bounded here (schema, defense-in-depth #1) AND again at the function boundary
 *  (`getDocsDetailed`, `test/get-docs.test.ts`'s own PAR-852 describe block — defense-in-depth
 *  #2, since this schema is reachable from the MCP transport only, not from the CLI or a direct
 *  unit test). `search.query`'s `MAX_QUERY_CHARS` already had this; `topic` did not. */
describe("get_docs.topic — bounded at the schema boundary (PAR-852)", () => {
  it("a topic over MAX_TOPIC_CHARS is an Input validation error, refused before any fetch", async () => {
    const spy = vi.fn(async () => new Response("nope", { status: 404 }));
    vi.stubGlobal("fetch", spy);
    const { client, call } = await connect(registry(), { VIBECTX_NO_AUTOWARM: "1" });
    const out = await call("get_docs", { library: "react", topic: "x".repeat(201) });
    expect(out).toContain("Input validation error");
    expect(spy).not.toHaveBeenCalled();
    await client.close();
  });

  it("a topic at exactly MAX_TOPIC_CHARS is accepted by the schema (not a schema error)", async () => {
    const spy = vi.fn(async () => new Response("not found", { status: 404 }));
    vi.stubGlobal("fetch", spy);
    const { client, call } = await connect(registry(), { VIBECTX_NO_AUTOWARM: "1" });
    const out = await call("get_docs", { library: "react", topic: "x".repeat(200) });
    expect(out).not.toContain("Input validation error");
    expect(spy).toHaveBeenCalled();
    await client.close();
  });
});

describe("startServer + autowarm over an in-memory transport", () => {
  it(
    "autowarm starts after the first network tool; a cache-only call answers while its fetch is held open and shows warming…",
    async () => {
      writeCache("react", REACT_URL, "# React fresh");
      const { spy, release } = heldFetch();
      expect(autowarmStatus().started).toBe(false);
      const { client, started, notes, call } = await connect(registry());
      expect(autowarmStatus().started).toBe(false);
      await call("get_docs", { library: "react" }); // first network tool, cached document
      expect(autowarmStatus().started).toBe(true);
      expect(started.autowarm).toBeDefined();
      // The autowarm is holding zod's fetch; list_libraries must still answer, and mark it.
      //
      // F-2 / PAR-733: this is a LIVENESS check, not a performance bound — the property is
      // "does not block behind autowarm's held fetch" (i.e. does not hang), and 1000 ms is a
      // stand-in for "forever", not a budget being measured against. It was previously an
      // unmeasured Promise.race with no [MEASURED] print and no per-test timeout of its own,
      // so under load it could die inside vitest's implicit 5000 ms default with a generic
      // "Test timed out" message rather than this test's own, more informative one — unmeasured
      // risk, never exercised under load before this item (not a confirmed flake, unlike
      // Target 1). Fixed by:
      // (a) an explicit per-test timeout below, well over vitest's 5000 ms default, so the test
      //     fails at ITS OWN boundary with ITS OWN message instead of vitest's generic one;
      // (b) a [MEASURED] print of the real elapsed time on every run, pass or fail;
      // (c) a failure message that says plainly this is a liveness timeout, not a proof the call
      //     would never have completed — it only proves it did not complete within the budget.
      //
      // MEASURED margin, this item, against the retained 1000 ms bound: 1.3-2.9 ms over 5 runs
      // isolated to this one file under ~6-process CPU oversubscription (~345x-770x margin),
      // 0.5-1.0 ms over 3 runs of the FULL 40-file suite (its own genuine parallelism, no extra
      // load) — faster under full-suite contention than isolated, because list_libraries does
      // no I/O and no tokenization (unlike Target 1's warm search): its cost is one JS
      // event-loop tick, not CPU-bound work that scales with core contention. ~1000x margin is
      // the honest figure at both load levels measured; kept as a 1000 ms stand-in for
      // "forever" rather than tightened, because tightening a liveness boundary that already has
      // three orders of magnitude of margin buys nothing and only risks the exact anti-pattern
      // this item exists to stop repeating.
      const listStart = performance.now();
      const LIST_LIBRARIES_LIVENESS_MS = 1000;
      let list: string;
      try {
        list = await Promise.race([
          call("list_libraries"),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `list_libraries did not answer within ${LIST_LIBRARIES_LIVENESS_MS} ms while autowarm's fetch was held open ` +
                      `(liveness timeout: it may still be running, not proven hung forever)`,
                  ),
                ),
              LIST_LIBRARIES_LIVENESS_MS,
            ),
          ),
        ]);
      } finally {
        console.log(`[F-2 MEASURED] list_libraries while a fetch is held open: ${(performance.now() - listStart).toFixed(1)} ms`);
      }
      expect(list).toMatch(/\*\*zod\*\* — Zod \[not cached, warming…\]/);
      expect(list).toMatch(/\*\*react\*\* — React \[cached [^\]]*\] \[full-text\]/);
      // PAR-851 — `fetchUrl` now does a real (if normally sub-10ms) `dns.lookup` before it calls
      // `fetch`, so "the held fetch has been dispatched" is no longer guaranteed to be true in
      // the SAME tick as `list_libraries`' own answer (which does no I/O of its own and was
      // already measured above at well under 1 ms — see the F-2 MEASURED print). `vi.waitFor`
      // polls rather than assuming same-tick delivery; it is not a race being papered over: the
      // property under test ("the fetch IS in flight, and is what is holding this open") is
      // unchanged, only WHEN it becomes observable moved by a few milliseconds. Getting this
      // wrong left a genuinely dangling, still-pending `fetchUrl` call behind on a failed
      // assertion (this test used to throw HERE, before `release()`, below) — leaking into and
      // spuriously incrementing a LATER test's own unrelated fetch spy once the delayed DNS
      // lookup finally resolved. `release()` runs only once this actually resolves, so this
      // could not itself get the same leak-on-failure wrong.
      await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
      release();
      expect(await started.autowarm).toEqual({ attempted: 1, cached: 1, failed: [], aborted: 0 });
      expect(await call("list_libraries")).not.toContain("warming…");
      expect(notes.join("")).toBe("vibectx: autowarm cached 1/1 configured libraries\n");
      await client.close();
    },
    30_000,
  );

  it("S-C: startServer sweeps orphan temp files out of the cache directories before anything else writes", async () => {
    writeCache("react", REACT_URL, "# React fresh");
    mkdirSync(join(dir, "projects"), { recursive: true });
    const orphans = [join(dir, "resolved.json.4242.1757000000000.tmp"), join(dir, "projects", "abc.json.4242.1757000000000.tmp"), join(dir, libDirName("react"), "page.md.4242.1757000000000.tmp")];
    for (const o of orphans) writeFileSync(o, "half a file", "utf8");
    writeFileSync(join(dir, "keep.tmp"), "not ours", "utf8");
    heldFetch();
    const { client } = await connect(registry(), { VIBECTX_NO_AUTOWARM: "1" });
    for (const o of orphans) expect(existsSync(o), o).toBe(false);
    expect(existsSync(join(dir, "keep.tmp"))).toBe(true);
    await client.close();
  });

  it("VIBECTX_NO_AUTOWARM=1: connected, tools work, autowarm never starts, nothing fetched", async () => {
    const { spy } = heldFetch();
    const { client, started, call } = await connect(registry(), { VIBECTX_NO_AUTOWARM: "1" });
    expect(autowarmStatus().started).toBe(false);
    expect(started.autowarm).toBeUndefined();
    expect(await call("list_libraries")).toMatch(/\*\*zod\*\* — Zod \[not cached\]/);
    expect(spy).not.toHaveBeenCalled();
    await client.close();
  });

  it("R4: closing the transport aborts the autowarm — entries not yet started are never fetched", async () => {
    const reg: Registry = { entries: new Map() };
    for (let i = 0; i < 6; i++) reg.entries.set(`lib${i}`, { name: `lib${i}`, urls: [`https://lib${i}.example.com/llms.txt`] });
    const { spy, release } = heldFetch();
    const { client, started, call } = await connect(reg, { VIBECTX_AUTOWARM: "all" }); // PAR-1048: warm all six
    expect(autowarmStatus().started).toBe(false);
    await call("doctor", { library: "unknown" }); // starts autowarm without another fetch
    await new Promise((r) => setTimeout(r, 5));
    expect(autowarmStatus().inFlight.size).toBe(2);
    await client.close(); // the linked pair closes the server side too
    await started.closed;
    release();
    const summary = await started.autowarm!;
    expect(summary).toEqual({ attempted: 6, cached: 2, failed: [], aborted: 4 });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  /** PAR-853 — cancellation reaches the actual fetch. Before this item, `get_docs`'s tool
   *  callback ignored the MCP SDK's own `RequestHandlerExtra.signal` entirely: a client that
   *  cancelled a call left the underlying fetch running to completion, unobserved. The stub
   *  fetch here only ever settles by REJECTING when ITS OWN `init.signal` aborts — exactly
   *  real `fetch()`'s contract against a genuinely hung server — so this proves the SDK's
   *  cancellation actually reaches that signal, not merely that the client-side promise
   *  resolves for some other reason (e.g. a transport-level timeout). */
  it("PAR-853: cancelling a get_docs call (client-side AbortSignal) aborts the underlying fetch", async () => {
    let capturedSignal: AbortSignal | undefined;
    const spy = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          capturedSignal = init?.signal ?? undefined;
          init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }),
    );
    vi.stubGlobal("fetch", spy);
    const { client } = await connect(registry(), { VIBECTX_NO_AUTOWARM: "1" });
    const controller = new AbortController();
    const call = client.callTool({ name: "get_docs", arguments: { library: "react" } }, undefined, { signal: controller.signal });
    // Give the tool call time to reach the held fetch before cancelling it.
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(capturedSignal?.aborted).toBe(false);
    controller.abort();
    await expect(call).rejects.toThrow();
    expect(capturedSignal?.aborted).toBe(true); // the underlying fetch's OWN signal observed the cancellation
    await client.close();
  });
});

describe("done-when (PAR-657): a committed vibectx.config.json reaches a flagless server start", () => {
  const ACME_URL = "https://docs.acme-internal.example.com/llms-full.txt";

  it("list_libraries shows the extra library with the (project) header, and the autowarm fetches it", async () => {
    const repo = join(dir, "repo");
    const home = join(dir, "home");
    mkdirSync(join(repo, ".git"), { recursive: true }); // a real repo, not a bare directory
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(repo, "vibectx.config.json"),
      JSON.stringify({ libraries: [{ name: "acme-internal", urls: [ACME_URL], description: "Acme internal platform" }] }),
      "utf8",
    );
    // PAR-1048: the autowarm covers the project's dependencies that match a configured library,
    // so the project depends on the committed one.
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "app", dependencies: { "acme-internal": "1.0.0" } }), "utf8");
    const spy = vi.fn(async () => new Response("# Acme\n\nInternal platform docs.", { status: 200, headers: { "content-type": "text/plain" } }));
    vi.stubGlobal("fetch", spy);
    vi.spyOn(process, "cwd").mockReturnValue(repo);

    // Exactly what index.ts does on the server path: no --config, no VIBECTX_CONFIG.
    const registry = loadDiscoveredRegistry({ cwd: process.cwd(), env: {}, home });
    expect(registry.entries.size).toBe(31); // the shipped 30 + the committed one
    const { client, started, call } = await connect(registry);

    const text = await call("list_libraries");
    expect(text.split("\n")[0]).toBe("config: [redacted] (project)");
    expect(text).toMatch(/- \*\*acme-internal\*\* — Acme internal platform/);

    await call("doctor", { library: "unknown" }); // first network tool starts configured autowarm
    await started.autowarm; // the autowarm's "configured libraries" include the discovered entry
    expect(spy.mock.calls.map((c) => String(c[0]))).toContain(ACME_URL);
    await client.close();
  });
});

/**
 * PAR-659 · D-35 — the `search` tool over the real transport. What matters over MCP and
 * nowhere else: the input schema is what a model sees, so an empty query and an over-long
 * library list must be SCHEMA errors the client is told about, not silently-wide searches.
 */
describe("search over the transport (PAR-659)", () => {
  const HONO_URL = "https://hono.dev/llms.txt";
  const AI_URL = "https://ai-sdk.dev/llms.txt";
  const searchRegistry = (): Registry => ({
    entries: new Map([
      ["hono", { name: "hono", urls: [HONO_URL], description: "Hono" }],
      ["ai-sdk", { name: "ai-sdk", aliases: ["ai"], urls: [AI_URL], description: "AI SDK" }],
    ]),
  });

  function seed(): void {
    writeCache("hono", HONO_URL, "# Hono\n\n## Streaming responses\n\nUse streamSSE to send server-sent events to the client.");
    writeCache("ai-sdk", AI_URL, "# AI SDK\n\n## streamText\n\nstreamText pipes a model response into a server-sent events stream.");
  }

  it("returns sections grouped by library, with Source lines and the searched/configured count", async () => {
    seed();
    const { call, client } = await connect(searchRegistry(), { VIBECTX_NO_AUTOWARM: "1" });
    const out = await call("search", { query: "server-sent events streaming" });
    expect(out).toContain("# hono");
    expect(out).toContain(`Source: ${HONO_URL}`);
    expect(out).toContain("# ai-sdk");
    expect(out).toContain("Searched 2 of 2 configured libraries");
    await client.close();
  });

  it("honours the libraries filter and maxTokens", async () => {
    seed();
    const { call, client } = await connect(searchRegistry(), { VIBECTX_NO_AUTOWARM: "1" });
    const out = await call("search", { query: "streaming", libraries: ["ai"], maxTokens: 500 });
    expect(out).toContain("# ai-sdk");
    expect(out).not.toContain("# hono");
    // N1: the count is reported against the registry too, so a filter cannot make the cache
    // look emptier than it is.
    expect(out).toContain("Searched 1 of 1 requested library (2 configured)");
    await client.close();
  });

  it("D-41: an empty query, an OVER-LONG query, a non-integer maxTokens and an over-long libraries list are schema errors", async () => {
    seed();
    const { client, call } = await connect(searchRegistry(), { VIBECTX_NO_AUTOWARM: "1" });
    // The SDK reports a schema violation as an error result, not a thrown transport error.
    for (const args of [
      { query: "" },
      // D-41: a 200,000-term query exhausted a 2 GB heap and took the whole server with it.
      // Over MCP that is a schema error the client is told about, never work this process does.
      { query: "streaming ".repeat(20_000) },
      { query: "x".repeat(1001) },
      { query: "streaming", maxTokens: 1.5 },
      { query: "streaming", maxTokens: 0 },
      { query: "streaming", maxTokens: -100 },
      { query: "streaming", libraries: Array.from({ length: 31 }, (_, i) => `l${i}`) },
    ]) {
      const out = await call("search", args);
      expect(out).toContain("Input validation error");
      expect(out).not.toContain("Source:");
    }
    await client.close();
  });

  it("A2 (PAR-715): the maxTokens matrix — Infinity, over-budget, negative, zero and fractional are schema errors; the default and the ceiling are accepted", async () => {
    expect(MAX_TOKENS_BUDGET).toBe(200_000);
    seed();
    const { client, call } = await connect(searchRegistry(), { VIBECTX_NO_AUTOWARM: "1" });
    for (const maxTokens of [Infinity, 1_000_000_000, -5, 0, 3.7, MAX_TOKENS_BUDGET + 1]) {
      const out = await call("search", { query: "streaming", maxTokens });
      expect(out, `maxTokens: ${maxTokens}`).toContain("Input validation error");
    }
    for (const maxTokens of [4000, MAX_TOKENS_BUDGET]) {
      const out = await call("search", { query: "streaming", maxTokens });
      expect(out, `maxTokens: ${maxTokens}`).toContain("Source:");
      expect(out, `maxTokens: ${maxTokens}`).not.toContain("Input validation error");
    }
    await client.close();
  });

  it("its description tells an agent when to reach for it instead of get_docs", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildServer(searchRegistry());
    await server.connect(serverTransport);
    const client = new Client({ name: "probe", version: "0" });
    await client.connect(clientTransport);
    const tool = (await client.listTools()).tools.find((t) => t.name === "search")!;
    const props = tool.inputSchema.properties as Record<string, { type?: string; exclusiveMinimum?: number; maximum?: number }>;
    expect(Object.keys(props).sort()).toEqual(["libraries", "maxTokens", "query"]);
    expect(tool.description).toContain("get_docs");
    expect(tool.description).toMatch(/cache-only|offline/i);
    // A2 (PAR-715): same reasoning as the matching get_docs assertion above — the advertised
    // shape is what a conforming client reads, and nothing else in this file pins it.
    expect(props.maxTokens).toMatchObject({ type: "integer", exclusiveMinimum: 0, maximum: MAX_TOKENS_BUDGET });
    await client.close();
  });
});
