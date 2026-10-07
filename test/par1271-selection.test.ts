import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assemble, renderSection, selectSections, SECTION_ASSEMBLE_JOIN, type Section } from "../src/retrieval.js";
import { DEFAULT_REGISTRY } from "../src/registry.js";
import { writeCache, resetCacheRootState } from "../src/cache.js";
import { getDocsDetailed } from "../src/get-docs.js";

const section = (heading: string, body: string): Section => ({ heading, body, level: 2, path: [], score: 1 });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); resetCacheRootState(); });

it("PAR-1271: byte-identical bodies are selected once and the freed budget admits the next distinct body", () => {
  const first = section("React", "Snapshot the cache before changing it and restore the snapshot on error.");
  const duplicate = section("Solid", first.body);
  const next = section("Rollback", "Return the snapshot from onMutate to the onError callback.");
  const budget = Math.ceil((renderSection(first).length + SECTION_ASSEMBLE_JOIN.length + renderSection(next).length) / 4);
  const chosen = selectSections([first, duplicate, next], budget);
  expect(chosen).toEqual([first, next]);
  const rendered = assemble([first, duplicate, next], budget);
  expect(rendered.split(first.body)).toHaveLength(2);
  expect(rendered).toContain(next.body);
  expect(rendered.length).toBeLessThanOrEqual(budget * 4);
});

it("PAR-1271 D13: distinct heading-only sections retain their place and never deduplicate empty bodies", () => {
  const sections = [
    section("Installation", ""),
    section("Configuration", ""),
    section("Examples", ""),
    section("Rollback", "Restore the snapshot after an error."),
    section("Reference", ""),
  ];
  expect(selectSections(sections, 4000)).toEqual(sections);
  const rendered = assemble(sections, 4000);
  for (const entry of sections) expect(rendered).toContain(renderSection(entry));
});

it("PAR-1271: equality is byte-exact, independent of headings, without collapsing framework-specific or whitespace variants", () => {
  const bodies = ["useMutation({ onError: rollback })", "useMutation({ onError: rollback })\n", "useMutation({ onError: rollbackSolid })", "useMutation({ onError: Rollback })", "useMutation({ onError: rollback })"];
  const sections = bodies.map((body) => section("Same heading", body));
  expect(selectSections(sections, 4000)).toEqual(sections.slice(0, 4));
});

it("PAR-1271: deduplication retains the guaranteed first section even when the remaining budget is zero", () => {
  const first = section("Snapshot", "Preserve the snapshot.");
  expect(selectSections([first, section("Duplicate", first.body)], 1, 20)).toEqual([first]);
  expect(selectSections([], 1)).toEqual([]);
});

it("PAR-1271: get_docs renders identical followed-page bodies once and fills with distinct content", async () => {
  const root = mkdtempSync(join(tmpdir(), "par1271-"));
  vi.stubEnv("VIBECTX_CACHE_DIR", root); vi.stubEnv("VIBECTX_NO_LOG", "1"); resetCacheRootState();
  const entry = { name: "selection-fixture", urls: ["https://docs.example.test/llms.txt"] };
  const shared = "Cancel pending optimistic requests, snapshot the cache, then restore that snapshot on rollback.";
  const distinct = "An optimistic update invalidates the query after mutation settlement to refetch the server state.";
  writeCache(entry.name, entry.urls[0]!, "# Docs\n- [Optimistic React](/react.md)\n- [Optimistic Solid](/solid.md)\n- [Optimistic Settlement](/settle.md)");
  const fetch = vi.fn(async (url: string | URL | Request) => new Response(String(url).endsWith("settle.md") ? `## Optimistic settlement\n${distinct}` : `## Optimistic rollback\n${shared}`, { headers: { "content-type": "text/markdown" } }));
  vi.stubGlobal("fetch", fetch);
  try {
    const out = await getDocsDetailed(entry, { topic: "optimistic", maxTokens: 4000 }, undefined, undefined, undefined, async () => [{address:"93.184.216.34",family:4}]);
    expect(out.followed).toEqual(["https://docs.example.test/react.md", "https://docs.example.test/solid.md", "https://docs.example.test/settle.md"]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(out.text.split(shared)).toHaveLength(2);
    expect(out.text).toContain(distinct);
    expect(out.returnedFromFollowed).toBe(2);
    expect(out.text.length).toBeLessThanOrEqual(16000);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("PAR-1272: TanStack uses its Query index and probes optimistic updates, invalidation and mutations", () => {
  const entry = DEFAULT_REGISTRY.find((e) => e.name === "tanstack-query")!;
  expect(entry.urls).toEqual([
    "https://tanstack.com/query/latest/llms.txt",
    "https://tanstack.com/query/latest/docs/framework/react/guides/queries.md",
    "https://tanstack.com/llms.txt", "https://tanstack.com/query/llms-full.txt",
    "https://tanstack.com/query/llms.txt", "https://raw.githubusercontent.com/TanStack/query/main/README.md",
  ]);
  expect(entry.probeQueries).toEqual(["optimistic updates", "query invalidation mutations"]);
});
