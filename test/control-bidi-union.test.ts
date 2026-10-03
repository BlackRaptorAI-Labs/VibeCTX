import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCache } from "../src/cache.js";
import { debugField } from "../src/debug.js";
import { listLibrariesText } from "../src/list-libraries.js";
import { formatWarmTable, WARM_SCHEMA_VERSION, type WarmReport } from "../src/warm.js";
import { runDoctor, formatDoctorTable, deriveProbeQuery } from "../src/doctor.js";
import { getDocsToolText } from "../src/get-docs.js";
import { resolveToolText, resetResolutionWindow } from "../src/resolve.js";
import type { LibraryEntry, Registry } from "../src/registry.js";
import { stubPublicDns } from "./helpers/public-dns.js";

/**
 * A7 / PAR-720, Done when: "A fixture string containing one character from every class in the
 * union survives no path to any rendered output. One test, parameterised over every render
 * site: get_docs provenance line, resolve CLI output, list_libraries, warm table, doctor,
 * debug fields." One shared fixture, one shared assertion, run against all six sites.
 *
 * The union (D-48, src/text.ts): C0 control, DEL, C1 control (U+009B -- the control sequence
 * introducer this issue was opened over), zero-width space, line/paragraph separator, bidi
 * override, bidi isolate, BOM. Each entry is checked for individually -- not reconstructed as
 * a second copy of the regex here, which is exactly the mistake D-48 exists to prevent.
 */
const UNION_CHARS: readonly [string, number][] = [
  ["C0 control (NUL)", 0x00],
  ["DEL", 0x7f],
  ["C1 control -- CSI, U+009B", 0x9b],
  ["zero-width space", 0x200b],
  ["line separator", 0x2028],
  ["paragraph separator", 0x2029],
  ["bidi override (RLO)", 0x202e],
  ["bidi isolate", 0x2066],
  ["BOM / zero-width no-break space", 0xfeff],
];

const FIXTURE = "left" + UNION_CHARS.map(([, code]) => String.fromCharCode(code)).join("") + "right";

function assertUnionStripped(site: string, text: string): void {
  for (const [name, code] of UNION_CHARS) {
    expect(text.includes(String.fromCharCode(code)), `${site}: ${name} (U+${code.toString(16).padStart(4, "0")}) survived`).toBe(false);
  }
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-control-bidi-union-"));
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

/** JSON body for a metadata URL, plain text for a document URL; 404 for anything else. */
function stubFetch(routes: Record<string, unknown>) {
  const spy = vi.fn(async (url: unknown) => {
    const body = routes[String(url)];
    if (body === undefined) return new Response("not found", { status: 404 });
    if (typeof body === "string") return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("A7 / PAR-720: the union class survives no render site", () => {
  it("debug fields (debugField)", () => {
    assertUnionStripped("debugField", debugField(FIXTURE));
  });

  it("list_libraries (name, aliases, description)", () => {
    const registry: Registry = {
      entries: new Map([
        ["fixture-lib", { name: "fixture-lib", urls: ["https://example.com/llms.txt"], description: FIXTURE, aliases: [FIXTURE] } as LibraryEntry],
      ]),
    };
    assertUnionStripped("list_libraries", listLibrariesText(registry));
  });

  it("warm table (dependency name, note, and report notes)", () => {
    const report: WarmReport = {
      schemaVersion: WARM_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      dir: "/fixture-project",
      offline: false,
      manifests: ["package.json"],
      notes: [FIXTURE],
      dependencies: [{ name: FIXTURE, ecosystem: "npm", source: "package.json", status: "unresolved", note: FIXTURE }],
      cached: 0,
      attempted: 1,
      denied: 0,
      total: 1,
    };
    assertUnionStripped("warm table", formatWarmTable(report));
  });

  it("doctor (derived probe query and the formatted table) -- passes regardless of this fix: deriveProbeQuery's words() filter already drops every non-alphanumeric character, this fix or not; kept as a regression guard on that filter, not a demonstration of the fix", async () => {
    const url = "https://example.com/llms-full.txt";
    writeCache("fixture-doctor", url, "# fixture\n\nprose");
    stubFetch({});
    const entry: LibraryEntry = { name: "fixture-doctor", urls: [url], description: FIXTURE };
    assertUnionStripped("deriveProbeQuery", deriveProbeQuery(entry));
    const report = await runDoctor({ entries: new Map([["fixture-doctor", entry]]) }, { offline: true });
    assertUnionStripped("formatDoctorTable", formatDoctorTable(report));
  });

  it("get_docs provenance line (package-supplied description, implicit resolution)", async () => {
    stubFetch({
      "https://registry.npmjs.org/vibectx-fixture-pkg/latest": { description: FIXTURE, homepage: "https://github.com/acme/vibectx-fixture-pkg" },
      "https://raw.githubusercontent.com/acme/vibectx-fixture-pkg/HEAD/README.md": "# fixture\n\nprose",
    });
    const registry: Registry = { entries: new Map() };
    const out = await getDocsToolText(registry, { library: "vibectx-fixture-pkg", topic: "fixture" });
    assertUnionStripped("get_docs provenance line", out.split("\n")[0]);
  });

  it("resolve CLI output (package-supplied description, resolve_library)", async () => {
    stubFetch({
      "https://registry.npmjs.org/vibectx-fixture-pkg/latest": { description: FIXTURE, homepage: "https://github.com/acme/vibectx-fixture-pkg" },
      "https://raw.githubusercontent.com/acme/vibectx-fixture-pkg/HEAD/README.md": "# fixture\n\nprose",
    });
    const registry: Registry = { entries: new Map() };
    const text = await resolveToolText(registry, "vibectx-fixture-pkg");
    assertUnionStripped("resolve CLI output", text);
  });
});
