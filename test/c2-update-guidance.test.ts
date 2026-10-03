import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { libDirName, readCache, writeCache } from "../src/cache.js";
import { getDocs } from "../src/get-docs.js";
import { getLibraryDoc } from "../src/fetcher.js";
import { refreshToolText } from "../src/refresh.js";
import { resetResolutionWindow } from "../src/resolve.js";
import type { Registry } from "../src/registry.js";
import { formatSearchResults, runSearch } from "../src/search.js";
import { resetSearchIndexMemo } from "../src/search-index.js";
import { formatWarmTable, runWarm, warmExitCode } from "../src/warm.js";
import { stubPublicDns } from "./helpers/public-dns.js";

const URL = "https://docs.example.com/llms.txt";
const entry = { name: "example", urls: [URL], ttlHours: 0 };
const registry = (): Registry => ({ entries: new Map([[entry.name, entry]]) });
let cacheDir: string;
let projectDir: string;

beforeEach(() => {
  cacheDir = realpathSync(mkdtempSync(join(tmpdir(), "vibectx-c2-cache-")));
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "vibectx-c2-project-")));
  process.env.VIBECTX_CACHE_DIR = cacheDir;
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ dependencies: { example: "^1.0.0" } }), "utf8");
  resetSearchIndexMemo();
  resetResolutionWindow();
  stubPublicDns();
});

afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(cacheDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

describe("C2 update failure guidance", () => {
  it("README describes the supported stale-search update action as current behavior", () => {
    const readme = readFileSync(new globalThis.URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain("For a stale search result, call the MCP `refresh(library)` tool");
    expect(readme).not.toContain("stale search output currently suggests `vibectx refresh");
  });

  it("refresh: a network outage with a stale fallback reports failure, the retained copy, and a retry step", async () => {
    writeCache(entry.name, URL, "# Old example docs");
    const fetchSpy = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    vi.stubGlobal("fetch", fetchSpy);

    const text = await refreshToolText(registry(), entry.name);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(readCache(entry.name, URL, 0)?.content).toBe("# Old example docs");
    expect(text).toMatch(/example:.*(?:failed|could not refresh|not refreshed)/i);
    expect(text).toMatch(/stale|old|cached copy/i);
    expect(text).toMatch(/network|connect|offline/i);
    expect(text).toMatch(/retry|try again|check.*connection/i);
  });

  it("warm --force: network outage names connectivity and gives a retry step", async () => {
    const fetchSpy = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    vi.stubGlobal("fetch", fetchSpy);

    const report = await runWarm(registry(), { dir: projectDir, force: true });
    const text = formatWarmTable(report);
    const detail = report.dependencies[0].note ?? "";

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(warmExitCode(report)).toBe(1);
    expect(text).toMatch(/example.*unreachable/i);
    expect(detail).toMatch(/network|connect|offline/i);
    expect(detail).toMatch(/retry|try again|check.*connection/i);
    expect(formatWarmTable(report, { modelVisible: true })).toMatch(/network problem.*check your connection/i);
  });

  it("warm_project distinguishes a retained stale copy from a failed update with no copy", async () => {
    writeCache(entry.name, URL, "# Old example docs");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));

    const report = await runWarm(registry(), { dir: projectDir, force: true });
    const model = formatWarmTable(report, { modelVisible: true });

    expect(model).toMatch(/update failed.*stale cached copy retained/i);
    expect(model).toMatch(/network problem.*warm --force/i);
  });

  it("refresh: caller cancellation does not misdiagnose a connectivity outage", async () => {
    const aborted = new Error("This operation was aborted");
    aborted.name = "AbortError";
    vi.stubGlobal("fetch", vi.fn(async () => { throw aborted; }));

    const text = await refreshToolText(registry(), entry.name);

    expect(text).toMatch(/request was cancelled|operation was aborted/i);
    expect(text).toMatch(/retry|try again/i);
    expect(text).not.toMatch(/network connection failed/i);
  });

  it("PAR-1000: single-library refresh reports cache write guidance instead of throwing a local path", async () => {
    writeFileSync(join(cacheDir, libDirName(entry.name)), "blocks the library directory", "utf8");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("# Current example docs", { status: 200 })));

    const text = await refreshToolText(registry(), entry.name);

    expect(text).toContain("check the cache directory is writable and has free disk space");
    expect(text).not.toContain(cacheDir);
  });

  it("PAR-1000: warm --force retains stale content and names the network repair action", async () => {
    writeCache(entry.name, URL, "# Old example docs");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));

    const report = await runWarm(registry(), { dir: projectDir, force: true });
    const row = report.dependencies[0];

    expect(row.status).toBe("unreachable");
    expect(row.note).toMatch(/stale copy.*kept/);
    expect(row.note).toMatch(/network problem|check your connection/i);
    expect(row.note).toContain("vibectx warm --force again");
  });

  it("PAR-1000: mixed candidate failures are classified as mixed", async () => {
    const urls = [URL, "https://docs.example.com/alternate.txt"];
    const onFailure = vi.fn();
    const fetchSpy = vi.fn(async (input: unknown) => String(input) === URL
      ? new Response("not found", { status: 404 })
      : Promise.reject(new Error("ECONNREFUSED")));
    vi.stubGlobal("fetch", fetchSpy);

    const doc = await getLibraryDoc({ name: entry.name, urls }, { onFailure });

    expect(doc).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(onFailure).toHaveBeenCalledWith({ kind: "mixed", candidates: 2 });
  });

  it("PAR-1000: a throwing diagnostic callback cannot change a failed fetch result", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    const onFailure = vi.fn(() => { throw new Error("diagnostic callback sentinel"); });

    await expect(getLibraryDoc(entry, { onFailure })).resolves.toBeUndefined();

    expect(onFailure).toHaveBeenCalledWith({ kind: "not-found", candidates: 1 });
  });

  it("PAR-1000: unresolved package note offers a connectivity and source repair step", async () => {
    writeFileSync(join(projectDir, "package.json"), JSON.stringify({ dependencies: { "zz-docless": "1" } }), "utf8");
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => String(input) === "https://registry.npmjs.org/zz-docless/latest"
      ? new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
      : new Response("not found", { status: 404 })));

    const report = await runWarm({ entries: new Map() }, { dir: projectDir });
    const row = report.dependencies[0];

    expect(row.status).toBe("unresolved");
    expect(row.note).toContain("check connectivity and the package's published docs URL");
    expect(row.note).toContain("vibectx warm --force again");
  });

  it("warm --force: a 404 identifies a moved or stale docs URL and a repair step distinct from an outage", async () => {
    const fetchSpy = vi.fn(async () => new Response("not found", { status: 404 }));
    vi.stubGlobal("fetch", fetchSpy);

    const report = await runWarm(registry(), { dir: projectDir, force: true });
    const text = formatWarmTable(report);
    const detail = report.dependencies[0].note ?? "";

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(warmExitCode(report)).toBe(1);
    expect(text).toMatch(/example.*unreachable/i);
    expect(detail).toMatch(/404|not found/i);
    expect(detail).toMatch(/moved|stale.*url|source.*changed/i);
    expect(detail).toMatch(/config|registry|report.*bug|file.*bug/i);
    expect(formatWarmTable(report, { modelVisible: true })).toMatch(/docs URL returned 404.*registry entry/i);
  });

  it("warm: a document cache write failure names the local cache issue and a repair step", async () => {
    writeFileSync(join(cacheDir, libDirName(entry.name)), "blocks the library directory", "utf8");
    const fetchSpy = vi.fn(async () => new Response("# Current example docs", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const report = await runWarm(registry(), { dir: projectDir });
    const text = formatWarmTable(report);
    const detail = report.dependencies[0].note ?? "";

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(warmExitCode(report)).toBe(1);
    expect(text).toMatch(/example.*unreachable/i);
    expect(detail).toMatch(/cache|storage|disk/i);
    expect(detail).toContain("check the cache directory is writable and has free disk space");
    expect(formatWarmTable(report, { modelVisible: true })).toMatch(/cache write failed.*permissions.*free disk space/i);
  });

  it("warm_project model text keeps HTML-negotiation guidance without raw diagnostic notes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<!doctype html><html>login</html>", { status: 200 })));

    const report = await runWarm(registry(), { dir: projectDir, force: true });
    const model = formatWarmTable(report, { modelVisible: true });

    expect(model).toMatch(/docs endpoint returned HTML.*markdown URL.*warm --force/i);
    expect(model).not.toContain(cacheDir);
    expect(model).not.toContain(projectDir);
  });

  it("warm_project does not infer a docs 404 from a free-form local error or reveal its path", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const report = await runWarm(registry(), { dir: projectDir });
    const path = `${cacheDir}/private-file`;
    const poisoned = {
      ...report,
      dependencies: report.dependencies.map((row) => ({ ...row, note: `error: local cache parse failed at ${path}: docs URL returned 404 inside file` })),
    };

    const model = formatWarmTable(poisoned, { modelVisible: true });
    expect(model).not.toContain(path);
    expect(model).not.toContain("docs URL returned 404");
    expect(model).toMatch(/could not update.*check connectivity/i);
  });

  it("stale search output suggests a supported update action", () => {
    writeCache(entry.name, URL, "# Example\n\n## Streaming\n\nStream the response.");
    const text = formatSearchResults(runSearch(registry(), { query: "streaming" }));

    expect(text).toMatch(/> Stale:/);
    expect(text).toMatch(/refresh\(example\)|vibectx warm --force/i);
    expect(text).not.toMatch(/vibectx refresh\s+example/);
  });

  it("get_docs: failed Accept negotiation and markdown retry explain the missing linked content and next step", async () => {
    const link = "https://docs.example.com/guide";
    writeCache(entry.name, URL, `# Example\n\n- [Streaming guide](${link})`);
    const fetchSpy = vi.fn(async () => new Response("<!doctype html><html><body>rendered docs</body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    }));
    vi.stubGlobal("fetch", fetchSpy);

    const text = await getDocs({ name: entry.name, urls: entry.urls }, { topic: "streaming guide" });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(text).toMatch(/Could not fetch 1 index link/);
    expect(text).toMatch(/markdown|Accept|HTML|content format/i);
    expect(text).toMatch(/try|check|open|report/i);
  });

  it("get_docs: HTML original and 404 markdown retry still explain the format failure", async () => {
    const link = "https://docs.example.com/guide";
    writeCache(entry.name, URL, `# Example\n\n- [Streaming guide](${link})`);
    const fetchSpy = vi.fn(async (input: unknown) => String(input).endsWith(".md")
      ? new Response("not found", { status: 404 })
      : new Response("<!doctype html><html>rendered docs</html>", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const text = await getDocs({ name: entry.name, urls: entry.urls }, { topic: "streaming guide" });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(text).toMatch(/returned HTML despite a markdown Accept request and .md retry/i);
    expect(text).toMatch(/check the source's markdown URL/i);
  });

  it("get_docs: 404 original and HTML markdown retry still explain the format failure", async () => {
    const link = "https://docs.example.com/guide";
    writeCache(entry.name, URL, `# Example\n\n- [Streaming guide](${link})`);
    const fetchSpy = vi.fn(async (input: unknown) => String(input).endsWith(".md")
      ? new Response("<!doctype html><html>rendered docs</html>", { status: 200 })
      : new Response("not found", { status: 404 }));
    vi.stubGlobal("fetch", fetchSpy);

    const text = await getDocs({ name: entry.name, urls: entry.urls }, { topic: "streaming guide" });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(text).toMatch(/returned HTML despite a markdown Accept request and .md retry/i);
    expect(text).toMatch(/check the source's markdown URL/i);
  });
});
