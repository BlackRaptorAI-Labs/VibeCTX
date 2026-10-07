import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDocsToolText, resetRetiredBuiltinNotes } from "../src/get-docs.js";
import { resetResolutionWindow } from "../src/resolve.js";
import { writeCache } from "../src/cache.js";
import { DEFAULT_REGISTRY, RETIRED_BUILTINS, loadRegistry, type LibraryEntry, type Registry } from "../src/registry.js";
import { saveResolvedEntry } from "../src/resolved-store.js";
import { REPO_URL } from "../src/repository.js";
import { stubPublicDns } from "./helpers/public-dns.js";

// PAR-1268 / D4 (decided 2026-10-05): five names were built in through 0.1.2 and are not in the
// 0.3.x registry. In get_docs' unknown-name path only: each gets a one-time note with the config
// fix; fastify and fastify-type-provider-zod still resolve as before; timescaledb, pgvector and
// aws-cdk are not looked up at all (a lookup finds a different package), so the reply is the fix.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-par1268-"));
  process.env.VIBECTX_CACHE_DIR = dir;
  resetResolutionWindow();
  resetRetiredBuiltinNotes();
  stubPublicDns();
});
afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const EXAMPLE_CONFIG_LINK = `${REPO_URL}/blob/main/docs/examples/node-api-stack.vibectx.config.json`;
const NO_LOOKUP = "VibeCTX does not look this name up on npm or PyPI, because that finds a different package.";
const laterRemedy = (name: string) => `To use ${name}, add it to your config from ${EXAMPLE_CONFIG_LINK}.`;
const note = (name: string) =>
  `${name} was built into VibeCTX through 0.1.2. To keep its curated sources, add it from ${EXAMPLE_CONFIG_LINK}.`;

function stubPages(pages: Record<string, string>) {
  const spy = vi.fn(async (url: unknown) => {
    const body = pages[String(url)];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

const empty = (): Registry => ({ entries: new Map() });

describe("PAR-1268 D4: the retired-name table", () => {
  it("names exactly the five former built-ins, and which of them still resolve", () => {
    expect(RETIRED_BUILTINS).toEqual({
      fastify: { resolves: true },
      "fastify-type-provider-zod": { resolves: true },
      timescaledb: { resolves: false },
      pgvector: { resolves: false },
      "aws-cdk": { resolves: false },
    });
  });

  it("none of them is back in the 30-entry default registry", () => {
    expect(DEFAULT_REGISTRY).toHaveLength(30);
    for (const name of Object.keys(RETIRED_BUILTINS)) expect(DEFAULT_REGISTRY.some((e) => e.name === name)).toBe(false);
  });
});

describe("PAR-1268 D4: timescaledb, pgvector and aws-cdk are not looked up", () => {
  for (const name of ["timescaledb", "pgvector", "aws-cdk"]) {
    it(`unconfigured ${name}: zero registry requests and the config fix`, async () => {
      const spy = stubPages({});
      const out = await getDocsToolText(empty(), { library: name, topic: "install" });
      expect(spy).not.toHaveBeenCalled();
      expect(out).toContain(note(name));
      expect(out).not.toContain("Source:");
    });
  }

  it("the historical notice appears once per process; later calls keep the config link and the no-lookup reason", async () => {
    const spy = stubPages({});
    const first = await getDocsToolText(empty(), { library: "pgvector" });
    expect(first).toContain(note("pgvector"));
    expect(first).toContain(NO_LOOKUP);
    for (let i = 0; i < 2; i += 1) {
      const later = await getDocsToolText(empty(), { library: "pgvector" });
      expect(later).not.toContain("was built into VibeCTX");
      expect(later).toContain(laterRemedy("pgvector"));
      expect(later).toContain(NO_LOOKUP);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("the name is matched the way registry names are (case and surrounding spaces)", async () => {
    const spy = stubPages({});
    const out = await getDocsToolText(empty(), { library: "  TimescaleDB " });
    expect(out).toContain(note("timescaledb"));
    expect(spy).not.toHaveBeenCalled();
  });

  it("offline gives the same fix", async () => {
    const spy = stubPages({});
    const out = await getDocsToolText(empty(), { library: "aws-cdk", offline: true });
    expect(out).toContain(note("aws-cdk"));
    expect(spy).not.toHaveBeenCalled();
  });

  it("configured timescaledb: a normal answer, no note", async () => {
    const url = "https://docs.timescale.com/llms.txt";
    writeCache("timescaledb", url, "# TimescaleDB\n\n## Hypertables\n\nCreate a hypertable with create_hypertable.");
    const spy = stubPages({});
    const reg: Registry = { entries: new Map([["timescaledb", { name: "timescaledb", urls: [url] }]]) };
    const out = await getDocsToolText(reg, { library: "timescaledb", topic: "hypertables" });
    expect(out).toContain(`Source: ${url}`);
    expect(out).toContain("create_hypertable");
    expect(out).not.toContain("was built into VibeCTX");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("PAR-1268 D4: fastify and fastify-type-provider-zod still resolve, with a one-time note", () => {
  const FASTIFY_PAGES = {
    "https://registry.npmjs.org/fastify/latest": JSON.stringify({ homepage: "https://fastify.dev", repository: "https://github.com/fastify/fastify" }),
    "https://fastify.dev/llms-full.txt": "# Fastify\n\n## Routes\n\nDeclare a route with fastify.get().",
  };

  it("unconfigured fastify: the note, then the resolved answer", async () => {
    const spy = stubPages(FASTIFY_PAGES);
    const out = await getDocsToolText(empty(), { library: "fastify", topic: "routes" });
    expect(out).toContain(note("fastify"));
    expect(out).toContain("Declare a route with fastify.get().");
    expect(spy.mock.calls.map((c) => String(c[0]))).toContain("https://registry.npmjs.org/fastify/latest");
  });

  it("the note is shown once per process", async () => {
    stubPages(FASTIFY_PAGES);
    const reg = empty();
    await getDocsToolText(reg, { library: "fastify", topic: "routes" });
    const second = await getDocsToolText(empty(), { library: "fastify", topic: "routes" });
    expect(second).not.toContain("was built into VibeCTX");
  });

  it("unconfigured fastify-type-provider-zod: the note, and a lookup", async () => {
    const spy = stubPages({
      "https://registry.npmjs.org/fastify-type-provider-zod/latest": JSON.stringify({ repository: "https://github.com/turkerdev/fastify-type-provider-zod" }),
      "https://raw.githubusercontent.com/turkerdev/fastify-type-provider-zod/HEAD/README.md": "# fastify-type-provider-zod\n\n## Setup\n\nRegister the type provider.",
    });
    const out = await getDocsToolText(empty(), { library: "fastify-type-provider-zod", topic: "setup" });
    expect(out).toContain(note("fastify-type-provider-zod"));
    expect(spy.mock.calls.map((c) => String(c[0]))).toContain("https://registry.npmjs.org/fastify-type-provider-zod/latest");
  });

  it("offline unconfigured fastify: the note with the unknown-library text, no network", async () => {
    const spy = stubPages({});
    const out = await getDocsToolText(empty(), { library: "fastify", offline: true });
    expect(out).toContain(note("fastify"));
    expect(out).toContain('Unknown library "fastify"');
    expect(spy).not.toHaveBeenCalled();
  });

  it("with a very long package description, the note and provenance stay within the 500-char note cap and the description stays fenced", async () => {
    stubPages({
      "https://registry.npmjs.org/fastify/latest": JSON.stringify({ description: "d".repeat(2000), homepage: "https://fastify.dev", repository: "https://github.com/fastify/fastify" }),
      "https://fastify.dev/llms-full.txt": "# Fastify\n\n## Routes\n\nDeclare a route with fastify.get().",
    });
    const out = await getDocsToolText(empty(), { library: "fastify", topic: "routes" });
    const head = out.slice(0, out.indexOf("\nSource: "));
    expect(head.startsWith(note("fastify"))).toBe(true);
    expect(head.length).toBeLessThanOrEqual(500);
    expect(head).toContain("(package-supplied) description: ");
    const fences = head.match(/`{3,}/g) ?? [];
    expect(fences.length % 2, "the description fence opens and closes").toBe(0);
    expect(fences.length).toBeGreaterThan(0);
  });

  it("configured fastify: no note", async () => {
    const url = "https://fastify.dev/llms.txt";
    writeCache("fastify", url, "# Fastify\n\n## Routes\n\nDeclare a route with fastify.get().");
    stubPages({});
    const reg: Registry = { entries: new Map([["fastify", { name: "fastify", urls: [url] }]]) };
    const out = await getDocsToolText(reg, { library: "fastify", topic: "routes" });
    expect(out).not.toContain("was built into VibeCTX");
  });
});

describe("PAR-1268 D4 / plan D11(b): the note links the example config on GitHub", () => {
  it("the link is built from the repository-address constant", () => {
    expect(EXAMPLE_CONFIG_LINK).toBe("https://github.com/BlackRaptorAI-Labs/VibeCTX/blob/main/docs/examples/node-api-stack.vibectx.config.json");
  });

  it("the reply carries the link, not a bare repository path", async () => {
    stubPages({});
    const out = await getDocsToolText(empty(), { library: "pgvector" });
    expect(out).toContain(EXAMPLE_CONFIG_LINK);
    expect(out).not.toContain("add it from docs/examples/");
  });
});

describe("PAR-1268 D4 / plan D11(c): a record saved by 0.3.0 for a blocked name is ignored", () => {
  const savedRecord = (name: string, url: string): LibraryEntry => ({
    name,
    urls: [url],
    resolved: { source: "pypi", resolvedAt: "2026-09-30T00:00:00.000Z", metadataUrl: `https://pypi.org/pypi/${name}/json` },
  });

  for (const name of ["timescaledb", "pgvector", "aws-cdk"]) {
    it(`saved ${name} record: no answer from it, the config fix instead, no network`, async () => {
      const url = `https://raw.githubusercontent.com/someone/${name}-wrapper/HEAD/README.md`;
      saveResolvedEntry(savedRecord(name, url), () => {});
      writeCache(name, url, `# ${name} wrapper\n\n## Install\n\nWRAPPER CONTENT for ${name}.`);
      const registry = loadRegistry(undefined, { includeResolved: true });
      expect(registry.entries.get(name)?.resolved, "the saved record really loaded").toBeDefined();
      const spy = stubPages({});
      const out = await getDocsToolText(registry, { library: name, topic: "install" });
      expect(out).toContain(note(name));
      expect(out).not.toContain("WRAPPER CONTENT");
      expect(out).not.toContain("Source:");
      expect(spy).not.toHaveBeenCalled();
      const later = await getDocsToolText(registry, { library: name, topic: "install" });
      expect(later, "the historical notice is shown once per process").not.toContain("was built into VibeCTX");
      expect(later).toContain(laterRemedy(name));
      expect(later).not.toContain("WRAPPER CONTENT");
      expect(spy).not.toHaveBeenCalled();
    });
  }

  it("a saved fastify record is still served (only the three blocked names are ignored)", async () => {
    const url = "https://fastify.dev/llms.txt";
    saveResolvedEntry({ ...savedRecord("fastify", url), resolved: { source: "npm", resolvedAt: "2026-09-30T00:00:00.000Z", metadataUrl: "https://registry.npmjs.org/fastify/latest" } }, () => {});
    writeCache("fastify", url, "# Fastify\n\n## Routes\n\nSAVED FASTIFY CONTENT.");
    stubPages({});
    const registry = loadRegistry(undefined, { includeResolved: true });
    const out = await getDocsToolText(registry, { library: "fastify", topic: "routes" });
    expect(out).toContain("SAVED FASTIFY CONTENT.");
    expect(out).not.toContain("was built into VibeCTX");
  });

  it("a config entry still works when a saved record for the same name exists", async () => {
    const wrapperUrl = "https://raw.githubusercontent.com/someone/timescaledb-wrapper/HEAD/README.md";
    saveResolvedEntry(savedRecord("timescaledb", wrapperUrl), () => {});
    const configUrl = "https://docs.timescale.com/llms.txt";
    writeCache("timescaledb", configUrl, "# TimescaleDB\n\n## Hypertables\n\nCONFIGURED TIMESCALE CONTENT.");
    const path = join(dir, "vibectx.config.json");
    writeFileSync(path, JSON.stringify({ libraries: [{ name: "timescaledb", urls: [configUrl] }] }));
    stubPages({});
    const registry = loadRegistry(path, { includeResolved: true });
    const out = await getDocsToolText(registry, { library: "timescaledb", topic: "hypertables" });
    expect(out).toContain("CONFIGURED TIMESCALE CONTENT.");
    expect(out).not.toContain("was built into VibeCTX");
  });
});
