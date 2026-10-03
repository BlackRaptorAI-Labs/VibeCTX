import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { join } from "node:path";
import * as atomic from "../src/atomic-store.js";
import { writeCache, readCache, libDirName, urlSlug } from "../src/cache.js";
import { enforceCacheSizeCap, resetCacheEvictionState } from "../src/cache-evict.js";
import { tokenize, RETRIEVAL_VERSION, MAX_TOKEN_CHARS } from "../src/tokenize.js";
import { runSearch } from "../src/search.js";
import { listLibrariesText } from "../src/list-libraries.js";
import { indexDocument, readIndex, writeIndex, openIndexSession, resetSearchIndexMemo, searchIndexPath, MAX_INDEX_FILE_BYTES } from "../src/search-index.js";

// Instrument real filesystem/clock/hash exports; each wrapper delegates until an
// individual warning test forces its upstream failure. Retrieval is never mocked.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, default: actual, lstatSync: vi.fn(actual.lstatSync), readSync: vi.fn(actual.readSync), readFileSync: vi.fn(actual.readFileSync) };
});
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: actual, homedir: vi.fn(actual.homedir) };
});
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, default: actual, createHash: vi.fn(actual.createHash) };
});

let dir: string;
const entry = { name: "unicodefixture", urls: ["https://unicode.example.test/llms.txt"] };
const registry = { entries: new Map([[entry.name, entry]]) };
const bodyPath = () => join(dir, libDirName(entry.name), `${urlSlug(entry.urls[0])}.md`);
const metaPath = () => join(dir, libDirName(entry.name), `${urlSlug(entry.urls[0])}.meta.json`);
const prose = (text: string) => `# Reference\n\n${(text + " explains the documented behavior. ").repeat(20)}`;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "par1043-")));
  vi.stubEnv("VIBECTX_CACHE_DIR", dir); vi.stubEnv("VIBECTX_CACHE_MAX_MB", "0"); vi.stubEnv("VIBECTX_NO_LOG", "1");
  resetSearchIndexMemo(); resetCacheEvictionState();
});
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); fs.rmSync(dir, { recursive: true, force: true }); });

it.each(["支付 创建", "نص عربي", "Привет мир", "café résumé"])("PAR-1043: Unicode query %s finds its actual cached document", (query) => {
  writeCache(entry.name, entry.urls[0], prose(query));
  const out = runSearch(registry, { query });
  expect(out.groups).toHaveLength(1); expect(out.groups[0].library).toBe(entry.name);
  expect(out.groups[0].sections.some((s) => s.body.includes(query))).toBe(true);
  expect(tokenize(query).length).toBeGreaterThan(0);
  const warm = runSearch(registry, { query }); expect(warm.fromIndex).toBe(1);
  expect(warm.groups[0].sections.some((section) => section.body.includes(query))).toBe(true);
});

it("PAR-1043: CJK bigrams match a query inside an unspaced document run", () => {
  writeCache(entry.name, entry.urls[0], prose("移动支付接口说明"));
  expect(tokenize("移动支付接口说明")).toContain("支付");
  const out = runSearch(registry, { query: "支付" });
  expect(out.groups).toHaveLength(1); expect(out.groups[0].sections[0].body).toContain("移动支付接口说明");
});

it("PAR-1043: Unicode normalization retains complete accented tokens and English controls", () => {
  expect(tokenize("café résumé")).toEqual(["café", "résumé"]);
  expect(tokenize("cafe\u0301 re\u0301sume\u0301")).toEqual(tokenize("café résumé"));
  expect(tokenize("useEffect policies HTTPServer")).toEqual(["use", "effect", "useeffect", "policy", "http", "server", "httpserver"]);
  expect(tokenize("x".repeat(65))).toEqual([]); expect(tokenize("я".repeat(65))).toEqual([]);
});

it("PAR-1043: Unicode retrieval invalidates the earlier tokenizer version", () => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(searchIndexPath(), JSON.stringify({ schemaVersion: 1, retrievalVersion: 1, libraries: {} }));
  expect(RETRIEVAL_VERSION).toBeGreaterThan(1);
  expect(readIndex().problem).toContain("retrieval version 1");
});

it("PAR-1043: unchanged searches reuse the parsed index and avoid rereading document bodies", () => {
  writeCache(entry.name, entry.urls[0], prose("request route"));
  const firstReads = vi.spyOn(fs, "readSync"); const indexReads = vi.spyOn(fs, "readFileSync");
  expect(runSearch(registry, { query: "request" }).groups).toHaveLength(1);
  expect(firstReads.mock.calls.length).toBeGreaterThan(0);
  expect(runSearch(registry, { query: "route" }).groups).toHaveLength(1);
  firstReads.mockClear(); indexReads.mockClear();
  const out = runSearch(registry, { query: "request" });
  expect(out.fromIndex).toBe(1); expect(out.groups[0].sections[0].body).toContain("request route");
  expect(firstReads.mock.calls).toHaveLength(0);
  expect(indexReads.mock.calls.filter(([path]) => String(path) === searchIndexPath())).toHaveLength(0);
});

it("PAR-1043: changed body metadata and stat invalidate memoized content", () => {
  writeCache(entry.name, entry.urls[0], prose("oldneedle"));
  expect(runSearch(registry, { query: "oldneedle" }).groups).toHaveLength(1);
  writeCache(entry.name, entry.urls[0], prose("newneedle"));
  const reads = vi.spyOn(fs, "readSync");
  const out = runSearch(registry, { query: "newneedle" });
  expect(out.groups).toHaveLength(1); expect(out.groups[0].sections[0].body).toContain("newneedle");
  expect(out.groups[0].sections[0].body).not.toContain("oldneedle"); expect(reads.mock.calls.length).toBeGreaterThan(0);
  const meta = JSON.parse(fs.readFileSync(metaPath(), "utf8")); meta.contentHash = "0".repeat(64); fs.writeFileSync(metaPath(), JSON.stringify(meta));
  expect(runSearch(registry, { query: "newneedle" }).uncached).toContain(entry.name);
});

it("PAR-1043: index stat changes invalidate the parsed memo without exposing its mutable maps", () => {
  const indexed = indexDocument(entry.urls[0], prose("request"), new Date().toISOString())!;
  expect(writeIndex(new Map([[entry.name, indexed]]))).toBe(true);
  expect(readIndex().libraries.has(entry.name)).toBe(true);
  const loaded = readIndex(); loaded.libraries.clear();
  expect(readIndex().libraries.has(entry.name)).toBe(true);
  const editable = readIndex().libraries.get(entry.name)!;
  editable.lengths[0] = 999_999; editable.postings.clear();
  expect(readIndex().libraries.get(entry.name)?.lengths).toEqual(indexed.lengths);
  expect(readIndex().libraries.get(entry.name)?.postings).toEqual(indexed.postings);
  fs.writeFileSync(searchIndexPath(), "{ malformed index");
  expect(readIndex().libraries.size).toBe(0); expect(readIndex().problem).toContain("unreadable");
});

it("PAR-1043: list_libraries reads metadata without reading bodies and keeps stored kind", () => {
  writeCache(entry.name, entry.urls[0], "# Reference\n- [Request](/Request.md)\n- [Reply](/Reply.md)");
  const reads = vi.spyOn(fs, "readSync");
  const text = listLibrariesText(registry);
  expect(text).toContain(`**${entry.name}**`); expect(text).toContain("[cached "); expect(text).toContain("[index-only]");
  expect(reads.mock.calls).toHaveLength(0);
  fs.rmSync(bodyPath()); expect(listLibrariesText(registry)).toContain("[not cached]");
});

it("PAR-1043: legacy metadata listings report unknown kind without reading bodies", () => {
  writeCache(entry.name, entry.urls[0], prose("request"));
  const meta = JSON.parse(fs.readFileSync(metaPath(), "utf8")); delete meta.sourceKind; delete meta.contentBytes; delete meta.contentHash;
  fs.writeFileSync(metaPath(), JSON.stringify(meta));
  const reads = vi.spyOn(fs, "readSync"); reads.mockClear();
  const text = listLibrariesText(registry); expect(text).toContain("[cached "); expect(text).toContain("[unknown]");
  expect(reads.mock.calls).toHaveLength(0);
});

it("PAR-1043: same-size legacy body edits invalidate reuse even with restored mtime", () => {
  writeCache(entry.name, entry.urls[0], prose("oldneedle"));
  const meta = JSON.parse(fs.readFileSync(metaPath(), "utf8")); delete meta.contentHash; fs.writeFileSync(metaPath(), JSON.stringify(meta));
  const fixed = new Date("2020-01-01T00:00:00Z"); fs.utimesSync(bodyPath(), fixed, fixed);
  expect(runSearch(registry, { query: "oldneedle" }).groups).toHaveLength(1);
  const before = fs.statSync(bodyPath()); fs.writeFileSync(bodyPath(), prose("newneedle")); fs.utimesSync(bodyPath(), fixed, fixed);
  expect(fs.statSync(bodyPath()).size).toBe(before.size); expect(fs.statSync(bodyPath()).mtimeMs).toBe(before.mtimeMs);
  const out = runSearch(registry, { query: "newneedle" });
  expect(out.groups).toHaveLength(1); expect(out.groups[0].sections[0].body).toContain("newneedle");
  expect(runSearch(registry, { query: "oldneedle" }).groups).toHaveLength(0);
});

it("PAR-1043: same-size index edits invalidate parsed reuse even with restored mtime", () => {
  const indexed = indexDocument(entry.urls[0], prose("request"), new Date().toISOString())!;
  expect(writeIndex(new Map([[entry.name, indexed]]))).toBe(true);
  const fixed = new Date("2020-01-01T00:00:00Z"); fs.utimesSync(searchIndexPath(), fixed, fixed);
  expect(readIndex().libraries.has(entry.name)).toBe(true);
  const text = fs.readFileSync(searchIndexPath(), "utf8"), changed = text.replace(entry.name, "changedfixture");
  expect(changed.length).toBe(text.length); expect(changed).not.toBe(text);
  fs.writeFileSync(searchIndexPath(), changed); fs.utimesSync(searchIndexPath(), fixed, fixed);
  expect(readIndex().libraries.has("changedfixture")).toBe(true); expect(readIndex().libraries.has(entry.name)).toBe(false);
});

it("PAR-1043: eviction removes empty document directories but preserves nonempty ones", () => {
  for (const name of ["emptyfixture", "retainedfixture"]) writeCache(name, entry.urls[0], "request ".repeat(1500));
  const empty = join(dir, libDirName("emptyfixture")), retained = join(dir, libDirName("retainedfixture"));
  const canary = join(retained, "keep.txt"); fs.writeFileSync(canary, "KEEP_CANARY"); resetCacheEvictionState();
  const result = enforceCacheSizeCap(dir, { env: { VIBECTX_CACHE_MAX_MB: "0.0001" }, warn: () => {} });
  expect(result?.evicted.map((e) => e.library).sort()).toEqual([libDirName("emptyfixture"), libDirName("retainedfixture")].sort());
  expect(fs.existsSync(empty)).toBe(false); expect(fs.readFileSync(canary, "utf8")).toBe("KEEP_CANARY");
  expect(fs.readdirSync(retained)).toEqual(["keep.txt"]);
});

it.each(["write", "add", "flush"])("PAR-1043: index warning %s redacts home and cache paths and preserves URLs", (route) => {
  writeCache(entry.name, entry.urls[0], prose("request"));
  const home = "/example/PATHMARK-owner"; vi.spyOn(os, "homedir").mockReturnValue(home);
  const url = `https://docs.example.test${home}/guide`;
  const error = new Error(`open ${dir}/index.json and ${home}/notes failed; source ${url}`);
  const messages: string[] = []; const warn = (m: string) => { messages.push(m); };
  if (route === "write") {
    const indexed = indexDocument(entry.urls[0], prose("request"), new Date().toISOString())!;
    vi.spyOn(atomic, "writeAtomic").mockImplementation(() => { throw error; });
    expect(writeIndex(new Map([[entry.name, indexed]]), warn)).toBe(false);
  } else if (route === "add") {
    const session = openIndexSession(warn);
    vi.spyOn(crypto, "createHash").mockImplementation(() => { throw error; });
    session.add(entry.name, entry.urls[0], prose("request"));
  } else {
    const session = openIndexSession((m) => { if (messages.length === 0) { messages.push(m); throw error; } warn(m); });
    session.add(entry.name, entry.urls[0], prose("request"));
    vi.spyOn(atomic, "writeAtomic").mockImplementation(() => { throw new Error("forced write failure"); });
    expect(session.flush()).toBe(false);
  }
  const final = messages.at(-1)!; expect(final).toContain("search index"); expect(final).toContain("[cache]/index.json");
  expect(final).toContain("~/notes"); expect(final).toContain(url);
  expect(final).not.toContain(dir); expect(final.replace(url, "URL")).not.toContain(home);
});

it("PAR-1043: oversized-index wording names the file without exposing its local path", () => {
  expect(writeIndex(new Map())).toBe(true);
  fs.truncateSync(searchIndexPath(), MAX_INDEX_FILE_BYTES + 1);
  const loaded = readIndex(); expect(loaded.libraries.size).toBe(0);
  expect(loaded.problem).toContain(`index.json is ${MAX_INDEX_FILE_BYTES + 1} bytes`);
  expect(loaded.problem).not.toContain(dir);
});


it("PAR-1043: stored byte counts reject changed metadata even with a matching body hash", () => {
  writeCache(entry.name, entry.urls[0], prose("request"));
  expect(runSearch(registry, { query: "request" }).groups).toHaveLength(1);
  const meta = JSON.parse(fs.readFileSync(metaPath(), "utf8")); meta.contentBytes += 1; fs.writeFileSync(metaPath(), JSON.stringify(meta));
  expect(listLibrariesText(registry)).toContain("[not cached]");
  expect(runSearch(registry, { query: "request" }).uncached).toContain(entry.name);
});

it("PAR-1043: metadata classification refuses invented values", () => {
  writeCache(entry.name, entry.urls[0], prose("request"));
  expect(listLibrariesText(registry)).toContain("[full-text]");
  const meta = JSON.parse(fs.readFileSync(metaPath(), "utf8")); meta.sourceKind = "invented-kind"; fs.writeFileSync(metaPath(), JSON.stringify(meta));
  expect(listLibrariesText(registry)).toContain("[not cached]");
  expect(readCache(entry.name, entry.urls[0], 168, { memoize: true })).toBeUndefined();
});

it("PAR-1043: bounded body reuse evicts the oldest entry after 128 documents", () => {
  for (let i = 0; i < 129; i++) {
    const name = `memofixture${i}`; writeCache(name, entry.urls[0], prose("request"));
    expect(readCache(name, entry.urls[0], 168, { memoize: true })?.content).toContain("request");
  }
  const reads = vi.spyOn(fs, "readSync"); reads.mockClear();
  expect(readCache("memofixture128", entry.urls[0], 168, { memoize: true })?.content).toContain("request");
  expect(reads.mock.calls).toHaveLength(0);
  expect(readCache("memofixture0", entry.urls[0], 168, { memoize: true })?.content).toContain("request");
  expect(reads.mock.calls.length).toBeGreaterThan(0);
});


it("PAR-1043: live tool description explains unknown kinds on legacy cached metadata", async () => {
  writeCache(entry.name, entry.urls[0], prose("request"));
  const meta = JSON.parse(fs.readFileSync(metaPath(), "utf8")); delete meta.sourceKind; fs.writeFileSync(metaPath(), JSON.stringify(meta));
  const server = buildServer(registry); const client = new Client({ name: "metadata-kind-probe", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const tools = await client.listTools(); const description = tools.tools.find((tool) => tool.name === "list_libraries")?.description;
    expect(description).toContain("unknown when uncached or when legacy metadata has no recorded kind");
    const result = await client.callTool({ name: "list_libraries", arguments: {} });
    expect(JSON.stringify(result)).toContain("[cached "); expect(JSON.stringify(result)).toContain("[unknown]");
  } finally { await client.close(); await server.close(); }
});


it("PAR-1043: Unicode folding bounds final tokens and keeps valid expanded words indexed", () => {
  const overlong = "İ".repeat(40), accepted = "İ".repeat(20);
  expect(tokenize(overlong).every((token) => token.length <= MAX_TOKEN_CHARS)).toBe(true);
  expect(tokenize(overlong)).toEqual([]); expect(tokenize(accepted)).toEqual(["i\u0307".repeat(20)]);
  writeCache(entry.name, entry.urls[0], prose(`${overlong} ${accepted}`));
  const first = runSearch(registry, { query: accepted }); expect(first.groups).toHaveLength(1);
  expect(first.groups[0].sections[0].body).toContain(accepted); resetSearchIndexMemo();
  expect(readIndex().libraries.has(entry.name)).toBe(true);
  const second = runSearch(registry, { query: accepted }); expect(second.fromIndex).toBe(1); expect(second.tokenized).toBe(0);
  expect(second.groups[0].sections[0].body).toContain(accepted);
  const ordinary = runSearch(registry, { query: "documented" }); expect(ordinary.groups).toHaveLength(1); expect(ordinary.fromIndex).toBe(1); expect(ordinary.tokenized).toBe(0);
});

it.each(["body", "metadata", "body-only"])("PAR-1043: scan-to-render %s refresh never mixes scored content and provenance", async (change) => {
  const originalBody = "# Reference\n\nneedle ORIGINAL_MATCHED_BODY.";
  writeCache(entry.name, entry.urls[0], originalBody);
  const meta = JSON.parse(fs.readFileSync(metaPath(), "utf8")); meta.fetchedAt = "2020-01-01T00:00:00.000Z"; fs.writeFileSync(metaPath(), JSON.stringify(meta));
  const real = await vi.importActual<typeof import("node:fs")>("node:fs"); let calls = 0, changed = false;
  vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
    if (String(args[0]) === metaPath() && ++calls === 2) {
      changed = true; writeCache(entry.name, entry.urls[0], change !== "metadata" ? "# Other\n\nUNRELATED_REPLACEMENT_BODY." : originalBody, undefined, "https://docs.example.test/new-document.md");
      if (change === "body-only") {
        const updated = JSON.parse(fs.readFileSync(metaPath(), "utf8")); updated.fetchedAt = meta.fetchedAt; delete updated.finalUrl;
        fs.writeFileSync(metaPath(), JSON.stringify(updated));
      }
    }
    return Reflect.apply(real.lstatSync, real, args);
  });
  const raced = runSearch(registry, { query: "needle" }); expect(changed).toBe(true);
  expect(raced.groups).toHaveLength(0); expect(raced.matchedLibraries).toBe(0);
  expect(raced.notes.join(" ")).toContain("changed during search");
  vi.restoreAllMocks();
  const next = runSearch(registry, { query: change !== "metadata" ? "unrelated" : "needle" });
  expect(next.groups).toHaveLength(1);
  const actualMeta = JSON.parse(fs.readFileSync(metaPath(), "utf8"));
  expect(next.groups[0].fetchedAt).toBe(actualMeta.fetchedAt); expect(next.groups[0].finalUrl).toBe(actualMeta.finalUrl);
  expect(next.groups[0].stale).toBe(change === "body-only");
  expect(next.groups[0].sections[0].body).toContain(change !== "metadata" ? "UNRELATED_REPLACEMENT_BODY" : "ORIGINAL_MATCHED_BODY");
});


it("PAR-1043: actual index warning preserves mixed-case HTTPS URLs", () => {
  const url = `hTtPs://docs.example.test${dir}/guide`;
  vi.spyOn(atomic, "writeAtomic").mockImplementation(() => { throw new Error(`open ${dir}/index.json failed; source ${url}`); });
  const messages: string[] = []; expect(writeIndex(new Map(), (message) => messages.push(message))).toBe(false);
  expect(messages).toHaveLength(1); expect(messages[0]).toContain("[cache]/index.json");
  expect(messages[0]).toContain(url); expect(messages[0].replace(url, "URL")).not.toContain(dir);
});

it("PAR-1043: a memoized read refuses a body changed after its bytes were read", async () => {
  const original = prose("AUDIT_POST_READ_OLD");
  writeCache(entry.name, entry.urls[0], original);
  const body = bodyPath();
  const { readSync, writeFileSync } = await vi.importActual<typeof import("node:fs")>("node:fs");
  let replaced = false;
  vi.mocked(fs.readSync).mockImplementation((...args: Parameters<typeof fs.readSync>) => {
    const n = Reflect.apply(readSync, undefined, args);
    if (!replaced && n > 0 && Buffer.isBuffer(args[1]) && args[1].toString("utf8").includes("AUDIT_POST_READ_OLD")) {
      replaced = true;
      writeFileSync(body, prose("AUDIT_POST_READ_NEW"));
    }
    return n;
  });
  expect(readCache(entry.name, entry.urls[0], 168, { memoize: true })).toBeUndefined();
  expect(replaced).toBe(true);
  expect(fs.readFileSync(body, "utf8")).toContain("AUDIT_POST_READ_NEW");
});

it("PAR-1043: English suffix stemming leaves non-ASCII words unchanged", async () => {
  const { stem } = await import("../src/tokenize.js");
  expect(stem("réquests")).toBe("réquests");
  expect(stem("русскиеs")).toBe("русскиеs");
  expect(stem("requests")).toBe("request");
});
