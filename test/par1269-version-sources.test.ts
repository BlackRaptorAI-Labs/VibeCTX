import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDocsToolText } from "../src/get-docs.js";
import { resetResolutionWindow } from "../src/resolve.js";
import { writeCache } from "../src/cache.js";
import { DEFAULT_REGISTRY, type Registry } from "../src/registry.js";
import { readConfigFile } from "../src/config.js";
import { validateLibraryUrl } from "../src/link-policy.js";
import { stubPublicDns } from "./helpers/public-dns.js";

// PAR-1269 / D6 (decided 2026-10-05): a curated entry may list sources per major version
// (`versionUrls`). An explicit `version` whose major is listed is served from those sources and
// the reply says so; any other version keeps the D5 "Not version-matched" behaviour.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-par1269-d6-"));
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

const LATEST = "https://www.prisma.io/docs/llms-full.txt";
const V6 = "https://www.prisma.io/docs/llms/orm-v6.txt";
const V7 = "https://www.prisma.io/docs/llms/orm-v7.txt";

const prismaRegistry = (): Registry => ({
  entries: new Map([["prisma", { name: "prisma", urls: [LATEST], versionUrls: { "6": [V6], "7": [V7] } }]]),
});

function stubPages(pages: Record<string, string>) {
  const spy = vi.fn(async (url: unknown) => {
    const body = pages[String(url)];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

const fetched = (spy: ReturnType<typeof stubPages>) => spy.mock.calls.map((call) => String(call[0]));

const PAGES = {
  [LATEST]: "# Prisma 7\n\n## Null and undefined\n\nPrisma 7 behaviour.",
  [V6]: "# Prisma 6\n\n## Null and undefined\n\nPrisma 6 behaviour.",
  [V7]: "# Prisma 7 index\n\n## Null and undefined\n\nPrisma 7 index behaviour.",
};

function sourceLine(out: string): string {
  const line = out.split("\n").find((l) => l.startsWith("Source: "));
  expect(line, "the reply has a Source line").toBeDefined();
  return line!;
}

describe("PAR-1269 D6: a listed major is served from its own sources", () => {
  it("prisma + version 6.19.2: Source is orm-v6.txt and the reply names major 6", async () => {
    const spy = stubPages(PAGES);
    const out = await getDocsToolText(prismaRegistry(), { library: "prisma", topic: "null and undefined", version: "6.19.2" });
    expect(sourceLine(out)).toContain(`Source: ${V6}`);
    expect(out).toContain(`Version-matched: major 6 (from ${V6})`);
    expect(out).toContain("Prisma 6 behaviour.");
    expect(out).not.toContain("Prisma 7 behaviour.");
    expect(out).not.toContain("Not version-matched");
    expect(out).not.toContain("not version-matched");
    expect(fetched(spy)).not.toContain(LATEST);
  });

  it("the Source line does not claim the exact version, only the verdict names the major", async () => {
    stubPages(PAGES);
    const out = await getDocsToolText(prismaRegistry(), { library: "prisma", topic: "null and undefined", version: "6.19.2" });
    expect(sourceLine(out)).not.toContain("· version 6.19.2");
  });

  it("prisma + version 7.1.0: served from orm-v7.txt", async () => {
    stubPages(PAGES);
    const out = await getDocsToolText(prismaRegistry(), { library: "prisma", topic: "null and undefined", version: "7.1.0" });
    expect(sourceLine(out)).toContain(`Source: ${V7}`);
    expect(out).toContain(`Version-matched: major 7 (from ${V7})`);
  });

  it("a leading v is accepted: v6.0.0 is major 6", async () => {
    stubPages(PAGES);
    const out = await getDocsToolText(prismaRegistry(), { library: "prisma", topic: "null and undefined", version: "v6.0.0" });
    expect(sourceLine(out)).toContain(`Source: ${V6}`);
  });
});

describe("PAR-1269 D6: a listed major whose sources cannot be fetched (decided 2026-10-05)", () => {
  it("unreachable and nothing cached: says plainly that major 6's docs could not be fetched, and does not fall back to latest", async () => {
    const spy = stubPages({ [LATEST]: PAGES[LATEST]! });
    const out = await getDocsToolText(prismaRegistry(), { library: "prisma", topic: "null and undefined", version: "6.19.2" });
    expect(out).toContain("The version-specific docs for major 6 could not be fetched. They are not cached, and VibeCTX did not fall back to the latest docs.");
    expect(out).toContain("Source: none · nothing cached · curated");
    expect(out).toContain(V6);
    expect(out).not.toContain("Prisma 7 behaviour.");
    expect(fetched(spy)).not.toContain(LATEST);
  });

  it("offline and nothing cached: the same plain sentence, with the offline reason", async () => {
    const spy = stubPages({});
    const out = await getDocsToolText(prismaRegistry(), { library: "prisma", version: "6.19.2", offline: true });
    expect(out).toContain("The version-specific docs for major 6 could not be fetched. This call is offline and they are not cached.");
    expect(spy).not.toHaveBeenCalled();
  });

  it("no version and nothing cached: no major sentence", async () => {
    stubPages({});
    const out = await getDocsToolText(prismaRegistry(), { library: "prisma", offline: true });
    expect(out).not.toContain("version-specific docs");
  });
});

describe("PAR-1269 D6: an unlisted major keeps the D5 behaviour", () => {
  it("prisma + version 5.0.0: latest docs plus the D5 note", async () => {
    const spy = stubPages(PAGES);
    const out = await getDocsToolText(prismaRegistry(), { library: "prisma", topic: "null and undefined", version: "5.0.0" });
    expect(sourceLine(out)).toContain(`Source: ${LATEST}`);
    expect(sourceLine(out)).toMatch(/ · not version-matched$/);
    expect(out).toContain("Not version-matched: you asked for prisma 5.0.0, but VibeCTX has only the latest prisma docs for this library. Check APIs against 5.0.0.");
    expect(out).not.toContain("Version-matched: major");
    expect(fetched(spy)).not.toContain(V6);
  });

  it("an invalid version never selects a major", async () => {
    stubPages(PAGES);
    const out = await getDocsToolText(prismaRegistry(), { library: "prisma", topic: "null and undefined", version: "6\r\nX: y" });
    expect(sourceLine(out)).toContain(`Source: ${LATEST}`);
    expect(out).not.toContain("Version-matched: major");
  });

  it("a non-numeric major never selects a major", async () => {
    stubPages(PAGES);
    const out = await getDocsToolText(prismaRegistry(), { library: "prisma", topic: "null and undefined", version: "latest" });
    expect(sourceLine(out)).toContain(`Source: ${LATEST}`);
    expect(out).not.toContain("Version-matched: major");
  });

  it("no version: the per-major sources are ignored", async () => {
    const spy = stubPages(PAGES);
    const out = await getDocsToolText(prismaRegistry(), { library: "prisma", topic: "null and undefined" });
    expect(sourceLine(out)).toContain(`Source: ${LATEST}`);
    expect(out).not.toContain("Version-matched");
    expect(fetched(spy)).not.toContain(V6);
  });
});

describe("PAR-1269 D6: shipped per-major sources", () => {
  const entry = (name: string) => DEFAULT_REGISTRY.find((e) => e.name === name);

  it("prisma lists v6 and v7; ai-sdk lists v4", () => {
    expect(entry("prisma")?.versionUrls).toEqual({ "6": [V6], "7": [V7] });
    expect(entry("ai-sdk")?.versionUrls).toEqual({ "4": ["https://v4.ai-sdk.dev/llms.txt"] });
  });

  it("only those two built-ins carry per-major sources", () => {
    expect(DEFAULT_REGISTRY.filter((e) => e.versionUrls !== undefined).map((e) => e.name).sort()).toEqual(["ai-sdk", "prisma", "tanstack-query"]);
  });

  it("every shipped per-major URL passes the same URL policy as urls", () => {
    for (const e of DEFAULT_REGISTRY) {
      for (const [major, urls] of Object.entries(e.versionUrls ?? {})) {
        expect(major, `${e.name} key`).toMatch(/^\d+$/);
        expect(urls.length, `${e.name} major ${major}`).toBeGreaterThan(0);
        for (const url of urls) expect(() => validateLibraryUrl(url, {}), url).not.toThrow();
      }
    }
  });
});

describe("PAR-1269 D6: config validates versionUrls like urls", () => {
  const write = (libraries: unknown) => {
    const path = join(dir, "vibectx.config.json");
    writeFileSync(path, JSON.stringify({ libraries }));
    return path;
  };

  it("a valid https per-major list loads", () => {
    const path = write([{ name: "acme", urls: ["https://docs.acme.dev/llms.txt"], versionUrls: { "2": ["https://docs.acme.dev/v2/llms.txt"] } }]);
    expect(readConfigFile(path).libraries[0]?.versionUrls).toEqual({ "2": ["https://docs.acme.dev/v2/llms.txt"] });
  });

  it("an http URL is refused", () => {
    const path = write([{ name: "acme", urls: ["https://docs.acme.dev/llms.txt"], versionUrls: { "2": ["http://docs.acme.dev/v2/llms.txt"] } }]);
    expect(() => readConfigFile(path)).toThrow(/versionUrls/);
  });

  it("a key that is not a whole major number is refused", () => {
    const path = write([{ name: "acme", urls: ["https://docs.acme.dev/llms.txt"], versionUrls: { "2.x": ["https://docs.acme.dev/v2/llms.txt"] } }]);
    expect(() => readConfigFile(path)).toThrow(/versionUrls/);
  });

  it("an empty URL list is refused", () => {
    const path = write([{ name: "acme", urls: ["https://docs.acme.dev/llms.txt"], versionUrls: { "2": [] } }]);
    expect(() => readConfigFile(path)).toThrow(/versionUrls/);
  });

  it("a configured per-major source is served for its major", async () => {
    const path = write([{ name: "acme", urls: ["https://docs.acme.dev/llms.txt"], versionUrls: { "2": ["https://docs.acme.dev/v2/llms.txt"] } }]);
    const [acme] = readConfigFile(path).libraries;
    stubPages({ "https://docs.acme.dev/v2/llms.txt": "# Acme 2\n\n## Widgets\n\nVersion two widgets." });
    const reg: Registry = { entries: new Map([["acme", acme!]]) };
    const out = await getDocsToolText(reg, { library: "acme", topic: "widgets", version: "2.4.0" });
    expect(out).toContain("Version two widgets.");
    expect(out).toContain("Version-matched: major 2 (from https://docs.acme.dev/v2/llms.txt)");
  });
});

describe("PAR-1269 D6: offline", () => {
  it("serves a cached per-major document without the network", async () => {
    writeCache("prisma", V6, PAGES[V6]!);
    const spy = stubPages({});
    const out = await getDocsToolText(prismaRegistry(), { library: "prisma", topic: "null and undefined", version: "6.19.2", offline: true });
    expect(out).toContain("Prisma 6 behaviour.");
    expect(out).toContain(`Version-matched: major 6 (from ${V6})`);
    expect(spy).not.toHaveBeenCalled();
  });
});
