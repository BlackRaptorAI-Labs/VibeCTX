import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { writeCache } from "../src/cache.js";
import { saveConsent } from "../src/consent.js";
import type { Registry } from "../src/registry.js";
import { startServer } from "../src/server.js";

/**
 * PAR-1008 opt-in update check, as amended by PAR-1040 (D-97 amendment, Tom 2026-09-24/26):
 * connecting makes no network request; the update check runs only when consent is `allowed`,
 * at the first tool call that goes online, never under `disclosed` or `declined`.
 *
 * Every tool call here is a `get_docs` for a cached library, so it passes the consent gate
 * (the "goes online" point) without any document fetch. `request` counts update checks only.
 */
const REACT_URL = "https://react.dev/llms-full.txt";
const registry = (checkUpdates: boolean): Registry => ({
  entries: new Map([["react", { name: "react", urls: [REACT_URL] }]]),
  checkUpdates,
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-update-startup-"));
  process.env.VIBECTX_CACHE_DIR = dir;
  writeCache("react", REACT_URL, "# React docs");
});
afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

async function connect(checkUpdates: boolean, elicitation?: "allow" | "decline") {
  const request = vi.fn(async () => new Response(JSON.stringify({ tag_name: "v99.0.0" })));
  const notes: string[] = [];
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const started = await startServer(registry(checkUpdates), serverTransport, {
    env: { VIBECTX_NO_AUTOWARM: "1" },
    warn: (s) => notes.push(s),
    updateRequest: request,
  });
  const client = new Client({ name: "update-probe", version: "0" }, elicitation ? { capabilities: { elicitation: {} } } : {});
  if (elicitation) {
    client.setRequestHandler(ElicitRequestSchema, async () =>
      elicitation === "allow" ? { action: "accept" as const, content: { allow: true } } : { action: "decline" as const });
  }
  await client.connect(clientTransport);
  const call = async () => {
    const res = (await client.callTool({ name: "get_docs", arguments: { library: "react" } })) as { content: { text: string }[] };
    return res.content[0].text;
  };
  /** Let any update check that was started finish before counting. */
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 0));
    await started.updateCheck;
  };
  const close = async () => {
    await client.close();
    await started.closed;
  };
  const listTools = () => client.listTools();
  return { request, notes, call, settle, close, listTools };
}

describe("PAR-1040: the update check runs only when consent is allowed, never at connect", () => {
  it("PAR-1040 (F10c): a stored allowed makes 0 update-check requests at connect and 1 after the first online tool call", async () => {
    saveConsent("allowed", "elicitation");
    const s = await connect(true);
    try {
      await s.settle();
      expect(s.request).toHaveBeenCalledTimes(0);
      const text = await s.call();
      await s.settle();
      expect(s.request).toHaveBeenCalledTimes(1);
      expect(s.notes.filter((n) => n.startsWith("update available"))).toHaveLength(1); // operator channel only
      expect(text).not.toContain("update available");
      // Operator channel only: never in the tool definitions either (PAR-1008; kept per audit F-A1040-1).
      expect(JSON.stringify(await s.listTools())).not.toContain("update available");
      await s.call();
      await s.settle();
      expect(s.request).toHaveBeenCalledTimes(1); // one check per process
    } finally {
      await s.close();
    }
  });

  it("PAR-1040: a first-run Allow answer starts the check at that same tool call", async () => {
    const s = await connect(true, "allow");
    try {
      await s.settle();
      expect(s.request).toHaveBeenCalledTimes(0);
      await s.call();
      await s.settle();
      expect(s.request).toHaveBeenCalledTimes(1);
    } finally {
      await s.close();
    }
  });

  it("PAR-1040 (F10b): no update-check request under disclosed, for both the fallback and cli kinds", async () => {
    for (const kind of ["fallback", "cli"] as const) {
      rmSync(join(dir, "consent.json"), { force: true });
      if (kind === "cli") saveConsent("disclosed", "cli"); // an online vibectx doctor/resolve/warm ran first
      const s = await connect(true); // no elicitation capability: a first run falls back to disclosed
      try {
        await s.call();
        await s.call();
        await s.settle();
        expect(s.request, kind).toHaveBeenCalledTimes(0);
        expect(s.notes.filter((n) => n.startsWith("update available")), kind).toEqual([]);
      } finally {
        await s.close();
      }
    }
  });

  it("PAR-1040: no update-check request under declined, stored or answered", async () => {
    for (const how of ["stored", "answered"] as const) {
      rmSync(join(dir, "consent.json"), { force: true });
      if (how === "stored") saveConsent("declined", "elicitation");
      const s = await connect(true, how === "answered" ? "decline" : undefined);
      try {
        await s.settle();
        await s.call();
        await s.settle();
        expect(s.request, how).toHaveBeenCalledTimes(0);
      } finally {
        await s.close();
      }
    }
  });

  it("PAR-1040: README states no request at connect, the allowed-only update check, and the cli consent skip", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const consent = readme.match(/^## Network access and consent\n[\s\S]*?(?=\n#{1,6} )/m)?.[0] ?? "";
    expect(consent).toContain("Connecting makes no network request.");
    expect(consent).toContain("When no answer is stored yet, it also records\nconsent as `cli`, so an MCP host");
    expect(consent).toContain("run `vibectx consent reset` to be asked again");
    expect(consent).toContain("The opt-in update\ncheck runs only when consent is allowed");
    const updates = readme.match(/Update with `git pull && npm ci && npm run build`\.[\s\S]*?(?=\n> \*\*On pinning:)/)?.[0] ?? "";
    expect(updates).toContain("(a project config cannot turn it on)");
    expect(updates).toContain("`--config` or `VIBECTX_CONFIG`");
  });

  it("PAR-1040: consent changed to declined, or reset, before the first tool call makes no update-check request", async () => {
    for (const change of ["declined", "reset"] as const) {
      saveConsent("allowed", "elicitation");
      const s = await connect(true); // no elicitation capability: a reset falls back to disclosed
      try {
        if (change === "declined") saveConsent("declined", "cli");
        else rmSync(join(dir, "consent.json"), { force: true });
        await s.call();
        await s.settle();
        expect(s.request, change).toHaveBeenCalledTimes(0);
      } finally {
        await s.close();
      }
    }
  });

  it("PAR-1008: the check stays opt-in; allowed with checkUpdates off makes no request", async () => {
    saveConsent("allowed", "elicitation");
    const s = await connect(false);
    try {
      await s.call();
      await s.settle();
      expect(s.request).toHaveBeenCalledTimes(0);
    } finally {
      await s.close();
    }
  });
});
