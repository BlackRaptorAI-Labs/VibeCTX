import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDocsToolText } from "../src/get-docs.js";
import { resetResolutionWindow } from "../src/resolve.js";
import { writeCache } from "../src/cache.js";
import type { Registry } from "../src/registry.js";
import { stubPublicDns } from "./helpers/public-dns.js";

// PAR-1269 / D5 (decided 2026-10-05): a curated entry asked for a version it cannot match says the
// CONSEQUENCE first (these are the latest docs, check APIs against the version asked for). On every
// path where a version was requested and not matched, the Source line ends with
// "· not version-matched". The marker never contains "· version", which means a confirmed match.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-par1269-"));
  process.env.VIBECTX_CACHE_DIR = dir;
  resetResolutionWindow();
  stubPublicDns();
});
afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PRISMA_URL = "https://www.prisma.io/docs/llms-full.txt";
const registry = (): Registry => ({ entries: new Map([["prisma", { name: "prisma", urls: [PRISMA_URL] }]]) });

function seed() {
  writeCache("prisma", PRISMA_URL, "# Prisma\n\n## Null and undefined\n\nUndefined means do nothing.");
}

function stubPages(pages: Record<string, string>) {
  const spy = vi.fn(async (url: unknown) => {
    const body = pages[String(url)];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

function sourceLine(out: string): string {
  const line = out.split("\n").find((l) => l.startsWith("Source: "));
  expect(line, "the reply has a Source line").toBeDefined();
  return line!;
}

const ELYSIA_PAGES = {
  "https://registry.npmjs.org/elysia/latest": JSON.stringify({ homepage: "https://elysiajs.com", repository: "https://github.com/elysiajs/elysia" }),
  "https://elysiajs.com/llms-full.txt": "# Elysia (latest)\n\n## Middleware\n\nUse .onBeforeHandle().",
};

describe("PAR-1269 D5: consequence-first note for an unmatched version on a curated entry", () => {
  it("names the library and version, says the docs are the latest, and asks to check APIs against the requested version", async () => {
    seed();
    stubPages({});
    const out = await getDocsToolText(registry(), { library: "prisma", topic: "null and undefined", version: "6.19.2" });
    expect(out).toContain(
      "Not version-matched: you asked for prisma 6.19.2, but VibeCTX has only the latest prisma docs for this library. Check APIs against 6.19.2.",
    );
    expect(out).not.toContain("is a curated entry");
    expect(out).toContain("Undefined means do nothing.");
  });

  it("an over-long version is clipped in both places it appears, never echoed whole", async () => {
    seed();
    stubPages({});
    const longVersion = "9".repeat(250);
    const out = await getDocsToolText(registry(), { library: "prisma", topic: "null and undefined", version: longVersion });
    expect(out).not.toContain(longVersion);
    const clipped = `${longVersion.slice(0, 99)}…`;
    expect(out).toContain(`Not version-matched: you asked for prisma ${clipped}, but VibeCTX has only the latest prisma docs for this library. Check APIs against ${clipped}.`);
  });
});

describe("PAR-1269 D5: the Source line marks every unmatched version request", () => {
  it("curated entry", async () => {
    seed();
    stubPages({});
    const out = await getDocsToolText(registry(), { library: "prisma", topic: "null and undefined", version: "6.19.2" });
    const source = sourceLine(out);
    expect(source).toContain(`Source: ${PRISMA_URL}`);
    expect(source).toMatch(/ · curated · not version-matched$/);
    expect(source).not.toContain("· version");
  });

  it("curated entry with a quoted name: fenced name, consequence-first note, marked Source line", async () => {
    const name = 'configured" ``` forged';
    const url = "https://docs.example.com/llms.txt";
    writeCache(name, url, "# Configured\n\nVersion note content.");
    const reg: Registry = { entries: new Map([[name, { name, urls: [url] }]]) };
    const out = await getDocsToolText(reg, { library: name, version: "1.0.0", offline: true });
    expect(out).toContain("````\n" + name + "\n````");
    expect(out).toContain("Not version-matched: you asked for version 1.0.0 of this library:");
    expect(out).toContain("Check APIs against 1.0.0.");
    expect(sourceLine(out)).toMatch(/ · not version-matched$/);
  });

  it("resolved package that falls back to latest", async () => {
    stubPages(ELYSIA_PAGES);
    const reg: Registry = { entries: new Map() };
    const out = await getDocsToolText(reg, { library: "elysia", topic: "middleware", version: "9.9.9" });
    expect(out).toContain("No document found for version 9.9.9; showing the latest available instead.");
    const source = sourceLine(out);
    expect(source).toContain("Source: https://elysiajs.com/llms-full.txt");
    expect(source).toMatch(/ · resolved · not version-matched$/);
    expect(source).not.toContain("· version");
  });

  it("invalid version that was ignored", async () => {
    stubPages(ELYSIA_PAGES);
    const reg: Registry = { entries: new Map() };
    const out = await getDocsToolText(reg, { library: "elysia", topic: "middleware", version: "1.0.0\r\nX-Injected: true" });
    expect(out).toContain("is not a valid version and was ignored.");
    const source = sourceLine(out);
    expect(source).toMatch(/ · not version-matched$/);
    expect(source).not.toContain("· version");
  });

  it("nothing cached, offline: the Source: none line is marked too", async () => {
    const spy = stubPages({});
    const out = await getDocsToolText(registry(), { library: "prisma", version: "6.19.2", offline: true });
    expect(sourceLine(out)).toBe("Source: none · nothing cached · curated · not version-matched");
    expect(spy).not.toHaveBeenCalled();
  });

  it("nothing cached, every source unreachable: the Source: none line is marked too", async () => {
    stubPages({});
    const out = await getDocsToolText(registry(), { library: "prisma", topic: "null and undefined", version: "6.19.2" });
    expect(sourceLine(out)).toBe("Source: none · nothing cached · curated · not version-matched");
  });

  it("nothing cached, no version requested: the Source: none line is unmarked", async () => {
    stubPages({});
    const out = await getDocsToolText(registry(), { library: "prisma", offline: true });
    expect(sourceLine(out)).toBe("Source: none · nothing cached · curated");
  });

  it("no version requested: no note and no marker", async () => {
    seed();
    stubPages({});
    const out = await getDocsToolText(registry(), { library: "prisma", topic: "null and undefined" });
    expect(out).not.toContain("Not version-matched");
    expect(out).not.toContain("not version-matched");
  });

  it("a matched version keeps its own stamp and no marker", async () => {
    const versionUrl = "https://raw.githubusercontent.com/elysiajs/elysia/refs/tags/v1.2.3/README.md";
    stubPages({
      "https://registry.npmjs.org/elysia/latest": ELYSIA_PAGES["https://registry.npmjs.org/elysia/latest"],
      "https://registry.npmjs.org/elysia/1.2.3": ELYSIA_PAGES["https://registry.npmjs.org/elysia/latest"],
      [versionUrl]: "# Elysia v1.2.3\n\n## Middleware\n\nUse .onBeforeHandle().",
    });
    const reg: Registry = { entries: new Map() };
    const out = await getDocsToolText(reg, { library: "elysia", topic: "middleware", version: "1.2.3" });
    const source = sourceLine(out);
    expect(source).toContain("· version 1.2.3");
    expect(source).not.toContain("not version-matched");
  });

  it("at every budget, an accepted reply carries the marker; a budget that cannot hold it refuses (D8)", async () => {
    seed();
    stubPages({});
    let accepted = 0;
    let refused = 0;
    for (let maxTokens = 1; maxTokens <= 200; maxTokens += 1) {
      const out = await getDocsToolText(registry(), { library: "prisma", topic: "null and undefined", version: "6.19.2", maxTokens });
      const source = out.split("\n").find((l) => l.startsWith("Source: "));
      if (source === undefined) {
        expect(out, `maxTokens ${maxTokens}`).toContain("Raise maxTokens");
        refused += 1;
      } else {
        expect(source, `maxTokens ${maxTokens}`).toMatch(/ · not version-matched$/);
        expect(out, `maxTokens ${maxTokens}`).toContain("Not version-matched:");
        accepted += 1;
      }
    }
    expect(accepted).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  });

  it("the marked reply still fits maxTokens × 4", async () => {
    seed();
    stubPages({});
    for (const maxTokens of [60, 80, 120, 400]) {
      const out = await getDocsToolText(registry(), { library: "prisma", topic: "null and undefined", version: "6.19.2", maxTokens });
      expect(out.length, `maxTokens ${maxTokens}`).toBeLessThanOrEqual(maxTokens * 4);
    }
  });
});
