import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { writeCache, readCache, touchCache, toCacheMeta, libDirName, urlSlug } from "../src/cache.js";
import { getDocsDetailed, getDocsToolText } from "../src/get-docs.js";
import { runSearch, formatSearchResults } from "../src/search.js";
import { runDoctor } from "../src/doctor.js";
import { buildBugPreview } from "../src/bug-report.js";
import { runBugReportCli } from "../src/cli.js";
import { buildServer } from "../src/server.js";
import { readActivityEntries } from "../src/activity-log.js";

let dir: string;
const entry = { name: "audit1032", urls: ["https://audit.example.test/llms.txt"] };
const registry = () => ({ entries: new Map([[entry.name, entry]]) });
const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
const path = (suffix: string) => join(dir, libDirName(entry.name), `${urlSlug(entry.urls[0])}.${suffix}`);
const seed = (content: string) => writeCache(entry.name, entry.urls[0], content);
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "par1042-"));
  vi.stubEnv("VIBECTX_CACHE_DIR", dir); vi.stubEnv("VIBECTX_NO_LOG", "1");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

it.each([undefined, "middleware"])("PAR-1042: budget clipping labels the cut within maxTokens (topic %s)", async (topic) => {
  seed("# Middleware\n\n" + "Middleware sentence explains request handling in detail. ".repeat(100));
  const out = await getDocsDetailed(entry, { offline: true, topic, maxTokens: 200 });
  expect(out.refused).not.toBe(true); expect(out.text).toContain("Middleware");
  expect(out.text.length).toBeLessThanOrEqual(800);
  expect(out.text).toMatch(/\[cut at maxTokens[^\]]*raise maxTokens\]/);
  expect(out.text).toMatch(/\n`{3,}\s*$/);
  const roomy = await getDocsDetailed(entry, { offline: true, topic, maxTokens: 4000 });
  expect(roomy.text).toContain("in detail."); expect(roomy.text).not.toContain("[cut at maxTokens");
});

it("PAR-1042: TOC ignores fenced headings and includes deep headings", async () => {
  seed("# Actual\n\n```md\n## CODE_ONLY_HEADING\n```\n\n#### DEEP_REAL_HEADING\n\nDeep real body.");
  const out = await getDocsDetailed(entry, { offline: true });
  const toc = out.text.split("Table of contents:\n")[1]?.split("\n\n---")[0];
  expect(toc).toBeDefined(); expect(toc).toContain("Actual");
  expect(toc).not.toContain("CODE_ONLY_HEADING"); expect(toc).toContain("DEEP_REAL_HEADING");
  expect(out.text).toContain("## CODE_ONLY_HEADING");
});

it("PAR-1042: followed pages do not create empty duplicate sections", async () => {
  seed("# Honesty\n- [Request](/Request.md)\n- [Reply](/Reply.md)");
  vi.stubGlobal("fetch", vi.fn(async () => new Response("# Request\n\nRequest body includes a usable answer.", { headers: { "content-type": "text/plain" } })));
  const out = await getDocsDetailed(entry, { topic: "request" }, undefined, undefined, undefined, lookup);
  expect(out.followed).toHaveLength(1); expect(out.text).toContain("usable answer");
  expect(out.matched).toBe(2); // one primary section and one substantive followed section
});

it("PAR-1042: a clipped followed heading is not counted as returned linked content", async () => {
  seed("# Audit\n- [Request](/Request.md)\n- [Reply](/Reply.md)");
  vi.stubGlobal("fetch", vi.fn(async () => new Response("## Request hostname details\n\nACTUALFOLLOWEDCONTENT request hostname comes from the Host header.", { headers: { "content-type": "text/plain" } })));
  const out = await getDocsDetailed(entry, { topic: "request hostname", maxTokens: 67 }, undefined, undefined, undefined, lookup);
  expect(out.followed.length).toBeGreaterThan(0);
  expect(out.text).not.toContain("ACTUALFOLLOWEDCONTENT"); expect(out.returnedFromFollowed).toBe(0);
  expect(out.thin || out.refused || out.indexMatchLooksLikeToc).toBe(true);
  const roomy = await getDocsDetailed(entry, { topic: "request hostname", maxTokens: 4000 }, undefined, undefined, undefined, lookup);
  expect(roomy.text).toContain("ACTUALFOLLOWEDCONTENT"); expect(roomy.returnedFromFollowed).toBeGreaterThan(0);
});

it("PAR-1042: every budget counts followed content only when its actual body prefix was emitted", async () => {
  seed("# Audit\n- [Request](/Request.md)\n- [Reply](/Reply.md)");
  writeCache(entry.name, "https://audit.example.test/Request.md", "## Request hostname details\n\nACTUALFOLLOWEDCONTENT request hostname comes from the Host header.");
  let bodySeen = 0, bodyAbsent = 0;
  for (let maxTokens = 60; maxTokens <= 150; maxTokens++) {
    const out = await getDocsDetailed(entry, { topic: "request hostname", maxTokens, offline: true });
    expect(out.followed).toHaveLength(1);
    if (out.returnedFromFollowed > 0) { expect(out.text).toContain("\n\nA"); bodySeen += 1; }
    else bodyAbsent += 1;
  }
  expect(bodySeen).toBeGreaterThan(0); expect(bodyAbsent).toBeGreaterThan(0);
});

it.each([79, 4000])("PAR-1042: clipped index-only content cannot make doctor healthy (budget %i)", async (maxTokens) => {
  const primary = maxTokens === 4000
    ? "# Request\n" + "- [Request](/Request.md)\n".repeat(800).slice(0, 15_670)
    : "# Request\n- [Request](/Request.md)\n- [Reply](/Reply.md)";
  seed(primary);
  writeCache(entry.name, "https://audit.example.test/Request.md", "## Overview\n\nrequest ACTUALFOLLOWEDANSWER.");
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const followedPrefix = "## Request > Overview\n\n";
  const ample = await getDocsDetailed(entry, { topic: "request", offline: true, maxTokens: 200_000 });
  expect(ample.text.split(followedPrefix)).toHaveLength(2); // real, unique body anchor
  expect(ample.text).toContain("request ACTUALFOLLOWEDANSWER.");
  const out = await getDocsDetailed(entry, { topic: "request", offline: true, ...(maxTokens === 4000 ? {} : { maxTokens }) });
  const emittedBody = (out.text.split(followedPrefix)[1] ?? "").split(/\n?\[cut at maxTokens/)[0].replace(/\n`+\s*$/, "").trim();
  expect(out.followed.length).toBeGreaterThan(0); expect(out.returnedFromFollowed).toBe(emittedBody ? 1 : 0);
  expect(out.text).not.toContain("ACTUALFOLLOWEDANSWER");
  if (!emittedBody) expect(out.thin || out.refused || out.indexMatchLooksLikeToc).toBe(true);
  if (out.indexMatchLooksLikeToc) expect(out.text).toContain("no linked-page content is included");
  const configured = { ...entry, probeQueries: ["request"] };
  const report = await runDoctor({ entries: new Map([[entry.name, configured]]) }, { offline: true, ...(maxTokens === 4000 ? {} : { maxTokens }) });
  expect(report.libraries).toHaveLength(1); expect(report.libraries[0].probes).toHaveLength(1);
  if (!emittedBody) {
    expect(report.libraries[0].healthy).toBe(false); expect(report.libraries[0].probes[0].status).not.toBe("answered");
  } else {
    expect(report.libraries[0].healthy).toBe(true); expect(report.libraries[0].probes[0].status).toBe("index-followed");
  }
  expect(fetch).not.toHaveBeenCalled();
});

it("PAR-1042: header refitting does not label a primary prose answer as index-only", async () => {
  seed("# Request request request\n\nrequest ACTUAL_PRIMARY_ANSWER.\n\n# Reference\n\n" + "- [Request](/Request.md)\n".repeat(3));
  writeCache(entry.name, "https://audit.example.test/Request.md", "## Unrelated\n\nOff-topic nonmatching prose.");
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const ample = await getDocsDetailed(entry, { topic: "request", offline: true, maxTokens: 200_000 });
  expect(ample.text).toContain("request ACTUAL_PRIMARY_ANSWER.");
  expect(ample.indexMatchLooksLikeToc).not.toBe(true);
  const out = await getDocsDetailed(entry, { topic: "request", offline: true, maxTokens: 111 });
  expect(out.text).toContain("request ACTUAL_PRIMARY_ANSWER.");
  expect(out.returnedFromFollowed).toBe(0); expect(out.thin).not.toBe(true);
  expect(out.indexMatchLooksLikeToc).not.toBe(true);
  expect(out.text).not.toContain("matched only index or link-title text");
  expect(out.text.length).toBeLessThanOrEqual(444); expect(fetch).not.toHaveBeenCalled();
});

it("PAR-1042: variable-width fence refitting keeps the linked-content disclosure truthful", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  let followedPositive = 0, indexPositive = 0;
  for (const width of [3, 30, 60, 100]) {
    seed("# Request\n- [Request](/Request.md)\n- [Reply](/Reply.md)");
    const fence = "`".repeat(width);
    writeCache(entry.name, "https://audit.example.test/Request.md", `## Overview\n\nrequest ACTUAL_FOLLOWED_BODY.\n\n${fence}\nrequest code\n${fence}`);
    for (let maxTokens = 80; maxTokens <= 200; maxTokens++) {
      const out = await getDocsDetailed(entry, { topic: "request", offline: true, maxTokens });
      expect(out.followed.length).toBeGreaterThan(0);
      expect(out.text.length).toBeLessThanOrEqual(maxTokens * 4);
      if (out.returnedFromFollowed > 0) {
        expect(out.text).toContain("## Request > Overview\n\nr");
        expect(out.indexMatchLooksLikeToc).not.toBe(true);
        expect(out.text).not.toContain("no linked-page content is included");
        followedPositive += 1;
      }
      if (out.indexMatchLooksLikeToc) {
        expect(out.returnedFromFollowed).toBe(0);
        expect(out.text).toContain("no linked-page content is included"); indexPositive += 1;
      }
    }
  }
  expect(followedPositive).toBeGreaterThan(0); expect(indexPositive).toBeGreaterThan(0);
  expect(fetch).not.toHaveBeenCalled();
});

it("PAR-1042: search footer agrees with groups left after budget clipping", () => {
  const entries = new Map();
  for (let i = 0; i < 11; i++) {
    const e = { name: `honesty-${i}`, urls: [`https://honesty-${i}.example.test/llms.txt`] };
    writeCache(e.name, e.urls[0], "# Middleware\n\nMiddleware handles request events."); entries.set(e.name, e);
  }
  const roomy = runSearch({ entries }, { query: "middleware", maxTokens: 4000 });
  expect(roomy.matchedLibraries).toBe(11); expect(roomy.groups.length).toBe(8);
  const text = formatSearchResults({ ...roomy, maxTokens: 200 });
  const shown = (text.match(/^# honesty-\d+/gm) ?? []).length;
  expect(shown).toBeGreaterThan(0); expect(shown).toBeLessThan(8);
  expect(text).toContain(`${shown} shown`);
  for (const note of text.matchAll(/the (\d+) best are shown/g)) expect(Number(note[1])).toBe(shown);
});

it.each([0, 168])("PAR-1042: future fetchedAt is stale even at ttlHours %i and doctor reports skew", async (ttlHours) => {
  seed("# Middleware\n\nMiddleware handles request events and returns a response.");
  const meta = JSON.parse(readFileSync(path("meta.json"), "utf8"));
  meta.fetchedAt = "2099-01-01T00:00:00.000Z"; writeFileSync(path("meta.json"), JSON.stringify(meta));
  const hit = readCache(entry.name, entry.urls[0], ttlHours);
  expect(hit?.content).toContain("returns a response"); expect(hit?.stale).toBe(true);
  const configured = { ...entry, ttlHours, probeQueries: ["middleware"] };
  const report = await runDoctor({ entries: new Map([[entry.name, configured]]) }, { offline: true });
  expect(report.libraries[0].healthy).toBe(false);
  expect(report.libraries[0].reasons.join(" ")).toMatch(/clock|future/i);
});

it("PAR-1042: truncated cached markdown fails integrity verification", () => {
  const content = "# Middleware\n\nCOMPLETE_CONTENT includes the final sentence."; seed(content);
  expect(readCache(entry.name, entry.urls[0], 168)?.content).toBe(content);
  writeFileSync(path("md"), content.slice(0, 12));
  expect(readCache(entry.name, entry.urls[0], 168)).toBeUndefined();
});
it("PAR-1042: written contentHash survives revalidation and rejects malformed integrity metadata", () => {
  const content = "# Honest complete cache content"; seed(content);
  const hash = createHash("sha256").update(content).digest("hex");
  expect(JSON.parse(readFileSync(path("meta.json"), "utf8")).contentHash).toBe(hash);
  expect(touchCache(entry.name, entry.urls[0])).toBeDefined();
  expect(JSON.parse(readFileSync(path("meta.json"), "utf8")).contentHash).toBe(hash);
  const meta = JSON.parse(readFileSync(path("meta.json"), "utf8")); meta.contentHash = "not-a-hash";
  writeFileSync(path("meta.json"), JSON.stringify(meta));
  expect(readCache(entry.name, entry.urls[0], 168)).toBeUndefined();
});

it("PAR-1042: integrity metadata refuses malformed hashes before consumers use it", () => {
  const meta = { url: entry.urls[0], fetchedAt: "2026-01-01T00:00:00.000Z" };
  const hash = createHash("sha256").update("real content").digest("hex");
  expect(toCacheMeta({ ...meta, contentHash: hash })?.contentHash).toBe(hash);
  expect(toCacheMeta(meta)?.url).toBe(meta.url);
  for (const contentHash of ["not-a-hash", hash.toUpperCase(), 42, null, [hash]]) {
    expect(toCacheMeta({ ...meta, contentHash })).toBeUndefined();
  }
});

it("PAR-1042: whitespace topic behaves as no topic", async () => {
  seed("# Middleware\n\nMiddleware handles requests.");
  const normal = await getDocsDetailed(entry, { offline: true });
  const whitespace = await getDocsDetailed(entry, { offline: true, topic: " \t\n " });
  expect(normal.text).toContain("Table of contents:"); expect(whitespace.text).toBe(normal.text);
});
it("PAR-1042: whitespace get_docs logs the same successful outcome as no topic", async () => {
  vi.stubEnv("VIBECTX_NO_LOG", "0");
  seed("# Middleware\n\nMiddleware handles requests.");
  const normal = await getDocsToolText(registry(), { library: entry.name, offline: true });
  const whitespace = await getDocsToolText(registry(), { library: entry.name, offline: true, topic: " \t\n " });
  expect(whitespace).toBe(normal); expect(whitespace).toContain("Table of contents:");
  const records = readActivityEntries(); expect(records).toHaveLength(2);
  expect(records.map((r) => r.outcome)).toEqual(["matched", "matched"]);
  expect(records[1].query).toBeUndefined();
});
it("PAR-1042: length errors identify UTF-16 units", async () => {
  const out = await getDocsDetailed(entry, { offline: true, topic: "😀".repeat(101) });
  expect(out.refused).toBe(true); expect(out.text).toContain("202 UTF-16 units");
});
it("PAR-1042: raw topic units are bounded before whitespace normalization", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  for (const topic of ["x".repeat(200) + " ", " ".repeat(201)]) {
    const out = await getDocsDetailed(entry, { topic, offline: true });
    expect(out.refused).toBe(true); expect(out.text).toContain("201 UTF-16 units");
  }
  expect(fetch).not.toHaveBeenCalled();
});
it.each(["detailed", "tool", "search"])("PAR-1042: direct %s calls enforce MAX_TOKENS_BUDGET before I/O", async (which) => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const call = () => which === "detailed" ? getDocsDetailed(entry, { maxTokens: 200_001 })
    : which === "tool" ? getDocsToolText({ entries: new Map() }, { library: "unknown", offline: true, maxTokens: 200_001 })
      : runSearch(registry(), { query: "middleware", maxTokens: 200_001 });
  await expect(Promise.resolve().then(call)).rejects.toThrow(/maxTokens.*200000/);
  expect(fetch).not.toHaveBeenCalled();
});

const bugArgs = ["--operation", "get_docs", "--where", "network", "--error-class", "NetworkError"];
it("PAR-1042: invalid CLI technology names identify the offending value", async () => {
  const errors: string[] = [];
  const code = await runBugReportCli([...bugArgs, "--tech", "language:hono"], { stdout: () => { throw new Error("unexpected stdout"); }, stderr: (v) => errors.push(v) });
  expect(code).toBe(2); expect(errors.join(" ")).toContain("language:hono");
});
it("PAR-1042: older cache entries remain readable without fabricating integrity evidence", () => {
  const content = "# Legacy\n\nPreviously written local documentation."; seed(content);
  const meta = JSON.parse(readFileSync(path("meta.json"), "utf8")); delete meta.contentHash;
  writeFileSync(path("meta.json"), JSON.stringify(meta));
  const hit = readCache(entry.name, entry.urls[0], 168);
  expect(hit?.content).toBe(content); expect(hit?.meta.contentHash).toBeUndefined();
});
it("PAR-1042: snippet clipping reserves a complete cut marker within maxTokens", async () => {
  seed("# Middleware\n\nMiddleware sample.\n```ts\n" + "middlewareHandleRequest();\n".repeat(100) + "```\n");
  const out = await getDocsDetailed(entry, { offline: true, topic: "middleware", mode: "snippets", maxTokens: 200 });
  expect(out.refused).not.toBe(true); expect(out.text).toContain("middlewareHandleRequest");
  expect(out.text.length).toBeLessThanOrEqual(800); expect(out.text).toContain("[cut at maxTokens");
  expect(out.text).toContain("raise maxTokens]"); expect(out.text).toMatch(/\n`{3,}\s*$/);
});
it("PAR-1042: oversized search query disclosure names UTF-16 units", () => {
  const out = runSearch(registry(), { query: "😀".repeat(501) });
  expect(out.query.length).toBeGreaterThan(0); expect(out.query.length).toBeLessThanOrEqual(200); expect(out.notes.join(" ")).toContain("1000 UTF-16 units");
});
it("PAR-1042: report_bug accepts case-insensitive known technology names and identifies invalid CLI values", async () => {
  const facts = { operation: "get_docs" as const, where: "network" as const, errorClass: "NetworkError" as const, version: "0.2.0", platform: "darwin", nodeVersion: "v22.0.0" };
  expect(buildBugPreview({ ...facts, techStack: [{ kind: "language", name: "tYpEsCrIpT" }] })).toContain("language: TypeScript");
  const stdout: string[] = [], stderr: string[] = [];
  const io = { stdout: (v: string) => stdout.push(v), stderr: (v: string) => stderr.push(v), confirm: async () => false };
  expect(await runBugReportCli([...bugArgs, "--tech", "language:typescript"], io)).toBe(0);
  expect(stderr.join(" ")).toContain("language: TypeScript");
  stderr.length = 0;
  expect(await runBugReportCli([...bugArgs, "--tech", "language:hono"], io)).toBe(2);
  expect(stderr.join(" ")).toContain("language:hono"); expect(stdout.join(" ")).not.toContain("issues/new?");
});
it("PAR-1042: report_bug tool advertises finite names and rejects unknown technology rather than dropping it", async () => {
  const server = buildServer({ entries: new Map() });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "honesty-test", version: "1.0.0" });
  await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    const schema = JSON.stringify(listed.tools.find(t => t.name === "report_bug")?.inputSchema);
    expect(schema).toContain("TypeScript");
    const invalid = await client.callTool({ name: "report_bug", arguments: { operation: "get_docs", where: "network", errorClass: "NetworkError", techStack: [{ kind: "language", name: "hono" }] } });
    expect(invalid.isError).toBe(true);
    const valid = await client.callTool({ name: "report_bug", arguments: { operation: "get_docs", where: "network", errorClass: "NetworkError", techStack: [{ kind: "language", name: "typescript" }] } });
    expect(valid.isError).not.toBe(true); expect(JSON.stringify(valid.content)).toContain("language: TypeScript");
  } finally { await client.close(); await server.close(); }
});


it("PAR-1042: structured search notes count the groups actually left by a tight budget", () => {
  const entries = new Map();
  for (let i = 0; i < 11; i++) {
    const e = { name: `structured-honesty-${i}`, urls: [`https://structured-${i}.example.test/llms.txt`] };
    writeCache(e.name, e.urls[0], "# Middleware\n\nMiddleware handles request events."); entries.set(e.name, e);
  }
  const roomy = runSearch({ entries }, { query: "middleware", maxTokens: 4000 });
  expect(roomy.groups).toHaveLength(8); expect(roomy.matchedLibraries).toBe(11);
  const tight = runSearch({ entries }, { query: "middleware", maxTokens: 200 });
  expect(tight.groups.length).toBeGreaterThan(0); expect(tight.groups.length).toBeLessThan(8);
  expect(tight.notes).toContain(`11 libraries matched; the ${tight.groups.length} best are shown`);
});

it("PAR-1042: report_bug rejects a known technology paired with the wrong kind", async () => {
  const server = buildServer({ entries: new Map() });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "technology-kind-test", version: "1.0.0" });
  await server.connect(serverTransport); await client.connect(clientTransport);
  const facts = { operation: "get_docs", where: "network", errorClass: "NetworkError" };
  try {
    const invalid = await client.callTool({ name: "report_bug", arguments: { ...facts, techStack: [{ kind: "language", name: "AWS" }] } });
    expect(invalid.isError).toBe(true);
    expect(JSON.stringify(invalid.content)).toContain("Technology name is not allowed for this kind");
    const valid = await client.callTool({ name: "report_bug", arguments: { ...facts, techStack: [{ kind: "hosting", name: "aWs" }] } });
    expect(valid.isError).not.toBe(true); expect(JSON.stringify(valid.content)).toContain("hosting: AWS");
  } finally { await client.close(); await server.close(); }
});

it("PAR-1042: README explains cache integrity, clock skew, and case-insensitive report names", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  expect(readme).toContain("64-character SHA-256 contentHash");
  expect(readme).toContain("Legacy entries without a content hash remain readable");
  expect(readme).toContain("Future fetchedAt timestamps are stale");
  expect(readme).toContain("clock skew");
  expect(readme).toContain("report_bug technology names are case-insensitive");
  expect(readme).toContain("must belong to the selected kind");
});


it("PAR-1042: snippet linked counts agree with code blocks that survived fitting", async () => {
  seed("# Request\n- [Request one](/One.md)\n- [Request two](/Two.md)");
  for (const [file, marker] of [["One", "A"], ["Two", "B"]]) {
    writeCache(entry.name, `https://audit.example.test/${file}.md`, [`## Request ${file}`, "", "Request example.", "", "```ts", `${marker}_REQUEST_CODE();`, "```"].join("\n"));
  }
  let single = 0, both = 0;
  for (let maxTokens = 80; maxTokens <= 700; maxTokens++) {
    const out = await getDocsDetailed(entry, { topic: "request", mode: "snippets", maxTokens, offline: true });
    expect(out.followed).toHaveLength(2);
    const actual = (out.text.match(/^```ts\n[AB]/gm) ?? []).length;
    expect(out.returnedFromFollowed).toBe(actual);
    if (actual === 1) single++; if (actual === 2) both++;
    expect(out.text.length).toBeLessThanOrEqual(maxTokens * 4);
  }
  expect(single).toBeGreaterThan(0); expect(both).toBeGreaterThan(0);
});

it("PAR-1042: a link-only visible prefix of a prose section is labelled index-only", async () => {
  const links = Array.from({ length: 6 }, (_, i) => `- [Request ${i}](/Unfollowed-${i}.md)`).join("\n") + "\n";
  seed("# Library\n" + "- [Other](/Other.md)\n".repeat(200) + `## Request\n${links}\n${"Request ACTUAL_PROSE_ANSWER explains handling.\n".repeat(30)}`);
  const ample = await getDocsDetailed(entry, { topic: "request", offline: true, maxTokens: 4000 });
  expect(ample.text).toContain("ACTUAL_PROSE_ANSWER"); expect(ample.indexMatchLooksLikeToc).not.toBe(true);
  let indexOnly = 0;
  for (let maxTokens = 100; maxTokens <= 300; maxTokens++) {
    const out = await getDocsDetailed(entry, { topic: "request", offline: true, maxTokens });
    expect(out.followed).toHaveLength(0);
    if (out.text.includes("- [Request 2](/Unfollowed-2.md)") && !out.text.includes("- [Request 5](/Unfollowed-5.md)")) {
      expect(out.indexMatchLooksLikeToc).toBe(true);
      expect(out.text).toContain("no linked page was followed"); indexOnly++;
    }
  }
  expect(indexOnly).toBeGreaterThan(0);
});
