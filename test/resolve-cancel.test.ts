import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePackage, resetResolutionWindow } from "../src/resolve.js";
import { getDocsToolText } from "../src/get-docs.js";
import type { Registry } from "../src/registry.js";
import { stubPublicDns } from "./helpers/public-dns.js";

/**
 * PAR-1044 (final audit L-2) — the resolution phase honoured neither MCP cancellation nor the
 * caller's signal: with the signal already aborted, the audit saw 2 fetches made anyway, and one
 * unknown name could keep requests going for minutes. The signal now reaches every metadata and
 * candidate fetch, so a cancelled call starts none.
 */
let dir: string;
let spy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-resolve-cancel-"));
  process.env.VIBECTX_CACHE_DIR = dir;
  resetResolutionWindow();
  stubPublicDns();
  spy = vi.fn(async () => new Response(JSON.stringify({ homepage: "https://zz-pkg.example.com" }), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", spy);
});
afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PAR-1044 (L-2): cancellation reaches package resolution", () => {
  it("PAR-1044 (L-2): resolvePackage with an aborted signal makes no request", async () => {
    const out = await resolvePackage("zz-pkg", { signal: AbortSignal.abort() });
    expect(spy).not.toHaveBeenCalled();
    expect(out.ok).toBe(false);
  });

  it("PAR-1044 (L-2): get_docs for an unknown library, cancelled, makes no registry request", async () => {
    const registry: Registry = { entries: new Map() };
    await getDocsToolText(registry, { library: "zz-pkg" }, AbortSignal.abort());
    expect(spy).not.toHaveBeenCalled();
  });

  it("PAR-1044 (L-2) guard: without a signal, resolution still makes its requests", async () => {
    await resolvePackage("zz-pkg", {});
    expect(spy).toHaveBeenCalled();
  });

  it("PAR-1044 (L-2): the resolve_library tool text, cancelled, makes no request", async () => {
    const { resolveToolText } = await import("../src/resolve.js");
    await resolveToolText({ entries: new Map() }, "zz-pkg", undefined, true, AbortSignal.abort());
    expect(spy).not.toHaveBeenCalled();
  });

  it("PAR-1044 (L-2): one deadline spans the whole resolution: no fetch starts after it passes", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 40)); // each request outlives the deadline below
      return new Response(JSON.stringify({ homepage: "https://zz-pkg.example.com" }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    await resolvePackage("zz-pkg", { deadlineMs: 10 });
    expect(calls).toBe(1); // the first request was already in flight; nothing after the deadline
  });

  it("PAR-1044 (L-2): a cancelled resolution does not spend one of the hourly resolutions", async () => {
    const { seedResolutionWindowForTest, MAX_RESOLUTIONS_PER_HOUR } = await import("../src/resolve.js");
    seedResolutionWindowForTest(MAX_RESOLUTIONS_PER_HOUR - 1, Date.now());
    await resolvePackage("zz-pkg", { signal: AbortSignal.abort() });
    await resolvePackage("zz-pkg", {}); // the last slot is still free
    expect(spy).toHaveBeenCalled();
  });

  it("PAR-1044 (L-2): refresh of a resolved library, cancelled, makes no request", async () => {
    const { refreshToolText } = await import("../src/refresh.js");
    const registry: Registry = { entries: new Map([["zz-pkg", { name: "zz-pkg", urls: ["https://zz-pkg.example.com/llms.txt"], resolved: { source: "npm", resolvedAt: "2026-09-01T00:00:00.000Z", metadataUrl: "https://registry.npmjs.org/zz-pkg/latest" } }]]) };
    await refreshToolText(registry, "zz-pkg", { signal: AbortSignal.abort() });
    expect(spy).not.toHaveBeenCalled();
  });
});
