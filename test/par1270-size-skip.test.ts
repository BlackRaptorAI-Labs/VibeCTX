import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDocsToolText } from "../src/get-docs.js";
import { getLibraryDoc, PRIMARY_DOC_MAX_BYTES } from "../src/fetcher.js";
import { formatDoctorTable, runDoctor } from "../src/doctor.js";
import { writeCache } from "../src/cache.js";
import { type LibraryEntry, type Registry } from "../src/registry.js";
import { stubPublicDns } from "./helpers/public-dns.js";

const FULL = "https://docs.example.com/llms-full.txt";
const FALLBACK = "https://docs.example.com/llms.txt";
const BODY = "# Documentation\n\n## Query invalidation\n\ninvalidateQueries marks matching queries stale.\n\n## Mutations\n\nuseMutation changes server state.";
const note = (urls = FULL, served = FALLBACK) => `Skipped ${urls}: larger than the 25 MiB limit; serving ${served} instead.`;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-par1270-"));
  process.env.VIBECTX_CACHE_DIR = dir;
  stubPublicDns();
});
afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const entry = (urls = [FULL, FALLBACK]): LibraryEntry => ({ name: "size-example", urls, probeQueries: ["query invalidation", "mutations"] });
const registry = (e = entry()): Registry => ({ entries: new Map([[e.name, e]]) });

function oversizedStream(cancel: () => void): Response {
  const chunk = new Uint8Array(1024 * 1024).fill(120);
  let sent = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= PRIMARY_DOC_MAX_BYTES + 4 * chunk.length) controller.close();
      else { sent += chunk.length; controller.enqueue(chunk); }
    },
    cancel,
  }), { headers: { "content-type": "text/plain" } });
}

function stubCandidates(urls = [FULL, FALLBACK], declared = false) {
  const cancel = vi.fn();
  const fetchSpy = vi.fn(async (url: unknown) => String(url) === urls.at(-1)
    ? new Response(BODY, { headers: { "content-type": "text/plain" } })
    : declared
      ? new Response("not read", { headers: { "content-length": String(PRIMARY_DOC_MAX_BYTES + 1) } })
      : oversizedStream(cancel));
  vi.stubGlobal("fetch", fetchSpy);
  return { cancel, fetchSpy };
}

describe("PAR-1270 B2: primary candidate size-skip disclosure", () => {
  it("a primary stream passes the cap, fallback succeeds: get_docs names the skip exactly once", async () => {
    const { cancel, fetchSpy } = stubCandidates();
    const out = await getDocsToolText(registry(), { library: "size-example", topic: "query invalidation" });
    expect(PRIMARY_DOC_MAX_BYTES).toBe(25 * 1024 * 1024);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toEqual([FULL, FALLBACK]);
    expect(out.split(note())).toHaveLength(2);
    expect(out).toContain(`Source: ${FALLBACK}`);
    expect(out).toContain("invalidateQueries marks matching queries stale.");
  });

  it("doctor retains the same fact across cached later probes, without making an answered library unhealthy", async () => {
    const { cancel, fetchSpy } = stubCandidates();
    const report = await runDoctor(registry());
    const table = formatDoctorTable(report, { redactCachePath: true });
    expect(table.split(note())).toHaveLength(2);
    expect(JSON.stringify(report)).toContain(note());
    expect(report.libraries[0]?.healthy).toBe(true);
    expect(report.libraries[0]?.probes).toHaveLength(2);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toEqual([FULL, FALLBACK]);
  });

  it("a declared content length over the same cap also produces the skip note", async () => {
    stubCandidates([FULL, FALLBACK], true);
    const out = await getDocsToolText(registry(), { library: "size-example" });
    expect(out).toContain(note());
  });

  it("a normal HTTP miss is not called a size skip", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => String(url) === FULL
      ? new Response("missing", { status: 404 }) : new Response(BODY)));
    const out = await getDocsToolText(registry(), { library: "size-example", topic: "mutations" });
    expect(out).toContain(`Source: ${FALLBACK}`);
    expect(out).not.toContain("Skipped ");
  });

  it("a fresh cached fallback is served without inventing a skip on this call", async () => {
    writeCache("size-example", FALLBACK, BODY);
    const fetchSpy = vi.fn(async () => { throw new Error("unexpected network"); });
    vi.stubGlobal("fetch", fetchSpy);
    const out = await getDocsToolText(registry(), { library: "size-example", topic: "mutations", offline: true });
    expect(out).toContain(`Source: ${FALLBACK}`);
    expect(out).not.toContain("Skipped ");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("several oversized candidates appear together in one note", async () => {
    const second = "https://docs.example.com/second-full.txt";
    stubCandidates([FULL, second, FALLBACK], true);
    const out = await getDocsToolText(registry(entry([FULL, second, FALLBACK])), { library: "size-example", topic: "mutations" });
    expect(out).toContain(note(`${FULL}, ${second}`));
    expect(out.match(/Skipped /g)).toHaveLength(1);
  });

  it("skip and served URLs redact query credentials in get_docs and doctor", async () => {
    const full = `${FULL}?token=SKIP_SECRET`;
    const fallback = `${FALLBACK}?key=SERVED_SECRET`;
    stubCandidates([full, fallback], true);
    const out = await getDocsToolText(registry(entry([full, fallback])), { library: "size-example", topic: "mutations" });
    expect(out).toContain("Skipped ");
    expect(out).not.toContain("SKIP_SECRET");
    expect(out).not.toContain("SERVED_SECRET");
    rmSync(dir, { recursive: true, force: true });
    const report = await runDoctor(registry(entry([full, fallback])));
    const shown = `${JSON.stringify(report)}\n${formatDoctorTable(report, { redactCachePath: true })}`;
    expect(shown).toContain("Skipped ");
    expect(shown).not.toContain("SKIP_SECRET");
    expect(shown).not.toContain("SERVED_SECRET");
  });

  it("a skip note fits alongside the existing unmatched-version note and within the requested budget", async () => {
    stubCandidates([FULL, FALLBACK], true);
    const out = await getDocsToolText(registry(), { library: "size-example", topic: "mutations", version: "1.0.0", maxTokens: 300 });
    expect(out).toContain(note());
    expect(out).toContain("Check APIs against 1.0.0.");
    expect(out.length).toBeLessThanOrEqual(300 * 4);
  });

  it("a 304 after an oversized candidate retains the skip fact", async () => {
    writeCache("size-example", FALLBACK, BODY, '"etag"');
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => String(url) === FULL
      ? new Response("not read", { headers: { "content-length": String(PRIMARY_DOC_MAX_BYTES + 1) } })
      : new Response(null, { status: 304 })));
    const doc = await getLibraryDoc(entry(), { forceRefresh: true });
    expect(doc).toMatchObject({ url: FALLBACK, notModified: true, skippedTooLarge: [FULL] });
  });

  it("a stale cached copy remains usable after its download is rejected for size", async () => {
    writeCache("size-example", FULL, BODY);
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => String(url) === FULL
      ? new Response("not read", { headers: { "content-length": String(PRIMARY_DOC_MAX_BYTES + 1) } })
      : new Response("missing", { status: 404 })));
    const out = await getDocsToolText(registry({ ...entry(), ttlHours: 0 }), { library: "size-example", topic: "mutations" });
    expect(out).toContain(note(FULL, `${FULL} from cache`));
    expect(out).toContain("useMutation changes server state.");
    expect(out).toContain("STALE:");
  });
});

describe("PAR-1270 B2 review: bounded size notices", () => {
  it.each([60, 80, 100, 120, 150, 200, 1000])("two long skipped URLs stay within %i tokens and do not prevent a fitting answer", async (maxTokens) => {
    const urls = [0, 1].map((n) => `https://docs.example.com/${"p".repeat(170)}/${n}/llms-full.txt`);
    stubCandidates([...urls, FALLBACK], true);
    const out = await getDocsToolText(registry(entry([...urls, FALLBACK])), { library: "size-example", topic: "mutations", maxTokens });
    expect(out.length).toBeLessThanOrEqual(maxTokens * 4);
    if (maxTokens >= 100) {
      expect(out).not.toContain("maxTokens is too small");
      expect(out).toContain("useMutation");
      expect(out).toContain("Skipped ");
      expect(out).toContain("25 MiB");
    }
  });

  it.each([60, 100, 150, 200, 1000])("49 skipped URLs stay within %i tokens and do not prevent a fitting answer", async (maxTokens) => {
    const urls = Array.from({ length: 49 }, (_, n) => `https://docs.example.com/${"p".repeat(170)}/${n}/llms-full.txt`);
    stubCandidates([...urls, FALLBACK], true);
    const out = await getDocsToolText(registry(entry([...urls, FALLBACK])), { library: "size-example", topic: "mutations", maxTokens });
    expect(out.length).toBeLessThanOrEqual(maxTokens * 4);
    if (maxTokens >= 100) {
      expect(out).not.toContain("maxTokens is too small");
      expect(out).toContain("useMutation");
      expect(out).toContain("Skipped ");
      expect(out).toContain("25 MiB");
    }
  });

  it("doctor bounds the notice while retaining the first skipped source and the remaining count", async () => {
    const urls = Array.from({ length: 49 }, (_, n) => `https://docs.example.com/${"p".repeat(170)}/${n}/llms-full.txt`);
    stubCandidates([...urls, FALLBACK], true);
    const report = await runDoctor(registry(entry([...urls, FALLBACK])));
    const notes = report.libraries[0]?.sizeSkipNotes;
    expect(notes).toHaveLength(1);
    expect(notes![0]!.length).toBeLessThanOrEqual(500);
    expect(notes![0]).toContain(urls[0]);
    expect(notes![0]).toContain("48 more");
    expect(notes![0]).toContain(FALLBACK);
    expect(report.libraries[0]?.healthy).toBe(true);
  });

  it("a reachable oversized source served from its older cache is not described as unreachable", async () => {
    writeCache("size-example", FULL, BODY);
    stubCandidates([FULL, FALLBACK], true);
    // This entry has only the oversized source; the stub's fallback is not a candidate.
    const out = await getDocsToolText(registry({ ...entry([FULL]), ttlHours: 0 }), { library: "size-example", topic: "mutations" });
    expect(out).toContain(note(FULL, `${FULL} from cache`));
    expect(out).toContain("STALE: served from cache fetched");
    expect(out).toContain("oversized documents were refused");
    expect(out).not.toContain("URLs unreachable");
    expect(out).toContain("useMutation");
  });
});
