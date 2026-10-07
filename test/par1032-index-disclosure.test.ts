import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_REGISTRY } from "../src/registry.js";
import { getDocsDetailed } from "../src/get-docs.js";
import { writeCache } from "../src/cache.js";
import { runDoctor, formatDoctorTable } from "../src/doctor.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "par1032-")); vi.stubEnv("VIBECTX_CACHE_DIR", dir); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
const entry = { name: "fastify", urls: ["https://fastify.dev/llms.txt"] };
const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
const noFollowNote = "matched the index page's own text; no linked page was followed";
const noContentNote = "matched only index or link-title text; no linked-page content is included";
function seed(content: string) { writeCache(entry.name, entry.urls[0], content); }
function pages(content?: string) {
  const fetch = vi.fn(async () => new Response(content ?? "not found", { status: content ? 200 : 404, headers: { "content-type": "text/plain" } }));
  vi.stubGlobal("fetch", fetch); return fetch;
}

it("PAR-1032: next.js prefers the documentation full-text endpoint", () => {
  expect(DEFAULT_REGISTRY.find((e) => e.name === "next.js")?.urls).toEqual([
    "https://nextjs.org/docs/llms-full.txt", "https://nextjs.org/docs/llms.txt",
    "https://raw.githubusercontent.com/vercel/next.js/canary/packages/next/README.md",
  ]);
});

it.each([["react", "https://react.dev/llms.txt"], ["supabase", "https://supabase.com/llms-full.txt"], ["tailwindcss", "https://raw.githubusercontent.com/tailwindlabs/tailwindcss.com/main/src/docs/responsive-design.mdx"], ["shadcn", "https://ui.shadcn.com/llms.txt"], ["stripe", "https://docs.stripe.com/llms.txt"], ["ai-sdk", "https://ai-sdk.dev/llms.txt"], ["firebase", "https://firebase.google.com/docs/llms.txt"], ["playwright", "https://raw.githubusercontent.com/microsoft/playwright/refs/heads/main/README.md"], ["react-router", "https://raw.githubusercontent.com/remix-run/react-router/refs/heads/main/docs/start/framework/routing.md"], ["astro", "https://raw.githubusercontent.com/withastro/docs/refs/heads/main/src/content/docs/en/basics/astro-components.mdx"], ["tanstack-query", "https://tanstack.com/query/latest/llms.txt"], ["motion", "https://motion.dev/llms.txt"]] as const)("PAR-1032: %s starts with its live checked candidate", (name, url) => {
  expect(DEFAULT_REGISTRY.find((e) => e.name === name)?.urls[0]).toBe(url);
});

it("PAR-1032: get_docs identifies an index-only match without claiming linked content", async () => {
  seed("# Fastify\n- [Request docs](https://other.example.test/request)\n- [Reply docs](https://other.example.test/reply)");
  const fetch = pages();
  const out = await getDocsDetailed(entry, { topic: "request" }, undefined, undefined, undefined, lookup);
  expect(out.indexMatchLooksLikeToc).toBe(true); expect(out.followed).toEqual([]);
  expect(out.returnedFromFollowed).toBe(0); expect(fetch).not.toHaveBeenCalled();
  expect(out.text).toContain(noFollowNote);
});
it("PAR-1032: a failed linked fetch still discloses that only index text matched", async () => {
  seed("# Fastify\n- [Request](/docs/Request.md)\n- [Reply](/docs/Reply.md)");
  const fetch = pages();
  const out = await getDocsDetailed(entry, { topic: "request" }, undefined, undefined, undefined, lookup);
  expect(fetch).toHaveBeenCalled(); expect(out.followed).toEqual([]);
  expect(out.indexMatchLooksLikeToc).toBe(true); expect(out.text).toContain(noFollowNote);
});
it("PAR-1032: a hollow followed title does not claim no page was followed", async () => {
  seed("# Fastify\n- [Request](/docs/Request.md)\n- [Reply](/docs/Reply.md)");
  pages("# Unrelated\n\nNothing about the topic here.");
  const out = await getDocsDetailed(entry, { topic: "request" }, undefined, undefined, undefined, lookup);
  expect(out.followed).toEqual(["https://fastify.dev/docs/Request.md"]);
  expect(out.returnedFromFollowed).toBe(0); expect(out.indexMatchLooksLikeToc).toBe(true);
  expect(out.text).toContain(noContentNote); expect(out.text).not.toContain(noFollowNote);
});
it("PAR-1032: substantive followed content has no index-only disclosure", async () => {
  seed("# Fastify\n- [Request](/docs/Request.md)\n- [Reply](/docs/Reply.md)");
  pages("## Request details\n\nThe request hostname is read from the Host header and used by the request handler.");
  const out = await getDocsDetailed(entry, { topic: "request hostname" }, undefined, undefined, undefined, lookup);
  expect(out.returnedFromFollowed).toBeGreaterThan(0); expect(out.indexMatchLooksLikeToc).toBeUndefined();
  expect(out.text).toContain("Host header"); expect(out.text).not.toContain(noFollowNote); expect(out.text).not.toContain(noContentNote);
});
it("PAR-1032: substantive primary content under an index-shaped prefix has no disclosure", async () => {
  const links = Array.from({ length: 250 }, (_, i) => `- [Sponsor ${i}](https://sponsor-${i}.example.test)`);
  seed(["# Fastify", "## Sponsors", ...links, "## Middleware", "Middleware runs before the request handler and wraps the handler."].join("\n"));
  pages(); const out = await getDocsDetailed(entry, { topic: "middleware" }, undefined, undefined, undefined, lookup);
  expect(out.isIndex).toBe(true); expect(out.indexMatchLooksLikeToc).toBeUndefined();
  expect(out.text).toContain("wraps the handler"); expect(out.text).not.toContain(noFollowNote); expect(out.text).not.toContain(noContentNote);
});
it.each([120, 160, 250, 500])("PAR-1032: index-only disclosure fits its %i token budget as a complete note", async (maxTokens) => {
  seed("# Fastify\n- [Request docs](https://other.example.test/request)\n- [Reply docs](https://other.example.test/reply)");
  pages(); const out = await getDocsDetailed(entry, { topic: "request", maxTokens }, undefined, undefined, undefined, lookup);
  expect(out.indexMatchLooksLikeToc).toBe(true); expect(out.text).toContain(noFollowNote);
  expect(out.text.length).toBeLessThanOrEqual(maxTokens * 4); expect(out.text).toContain("Request");
  expect(out.text).toMatch(/\n```\s*$/);
});

it("PAR-1032: snippets render the existing index-only signal within the budget", async () => {
  const links = Array.from({ length: 12 }, (_, i) => `- [Request ${i}](https://other.example.test/request-${i})`);
  seed(["# Fastify", "## Request", ...links, "```ts", "request()", "```"].join("\n"));
  pages(); const out = await getDocsDetailed(entry, { topic: "request", mode: "snippets", maxTokens: 250 }, undefined, undefined, undefined, lookup);
  expect(out.indexMatchLooksLikeToc).toBe(true); expect(out.followed).toEqual([]);
  expect(out.text).toContain(noFollowNote); expect(out.text).toContain("request()");
  expect(out.text.length).toBeLessThanOrEqual(1000);
});
it("PAR-1032: no-topic and no-match paths do not invent an index-only match", async () => {
  seed("# Fastify\n- [Request](https://other.example.test/request)\n- [Reply](https://other.example.test/reply)"); pages();
  for (const topic of [undefined, "zzznomatchsentinel"]) {
    const out = await getDocsDetailed(entry, { topic }, undefined, undefined, undefined, lookup);
    expect(out.indexMatchLooksLikeToc).toBeUndefined(); expect(out.text).not.toContain(noFollowNote);
    expect(out.text).not.toContain(noContentNote);
  }
});

it.each([["react", "https://react.dev/llms-full.txt"], ["supabase", "https://supabase.com/docs/llms-full.txt"], ["tailwindcss", "https://tailwindcss.com/llms-full.txt"], ["shadcn", "https://ui.shadcn.com/llms-full.txt"], ["stripe", "https://docs.stripe.com/llms-full.txt"], ["ai-sdk", "https://ai-sdk.dev/docs/llms-full.txt"], ["firebase", "https://firebase.google.com/llms-full.txt"], ["playwright", "https://playwright.dev/llms-full.txt"], ["react-router", "https://reactrouter.com/llms-full.txt"], ["astro", "https://docs.astro.build/llms-full.txt"], ["tanstack-query", "https://tanstack.com/query/llms-full.txt"], ["motion", "https://motion.dev/llms-full.txt"]] as const)("PAR-1032: %s keeps its prior cached candidate reachable offline", async (name, priorUrl) => {
  const configured = DEFAULT_REGISTRY.find((e) => e.name === name)!;
  writeCache(name, priorUrl, "# Legacy fixture\n\nLegacy cached content remains reachable after the registry candidate order changes.");
  const fetch = pages();
  const out = await getDocsDetailed(configured, { topic: "legacy cached content", offline: true }, undefined, undefined, undefined, lookup);
  expect(out.text).toContain("Legacy cached content remains reachable");
  expect(out.matched).toBeGreaterThan(0); expect(fetch).not.toHaveBeenCalled();
});

it("PAR-1032: doctor distinguishes a hollow followed page from no page followed", async () => {
  seed("# Fastify\n- [Request](/docs/Request.md)\n- [Reply](/docs/Reply.md)");
  writeCache(entry.name, "https://fastify.dev/docs/Request.md", "# Unrelated\n\nNothing about the topic here.");
  const fetch = pages();
  const configured = { ...entry, probeQueries: ["request"] };
  const report = await runDoctor({ entries: new Map([[entry.name, configured]]) }, { offline: true });
  const library = report.libraries[0];
  expect(library.probes[0].status).toBe("index-only-match"); expect(library.probes[0].followed).toBe(1);
  expect(library.healthy).toBe(false); expect(fetch).not.toHaveBeenCalled();
  expect(library.reasons.join(" ")).toContain('index-only match, no linked content returned: "request"');
  const rendered = formatDoctorTable(report);
  expect(rendered).toContain("Linked pages were followed"); expect(rendered).not.toContain("no link followed");
  expect(rendered).not.toContain("no linked page actually followed");
});

it.each([160, 250, 500, 1000, 2000])("PAR-1032: a full 400-link index keeps its disclosure and closing data fence at %i tokens", async (maxTokens) => {
  const links = Array.from({ length: 400 }, (_, i) => `- [Request handling ${i}](https://other.example.test/request-${i})`);
  seed(["# Fastify", "## Request", ...links].join("\n"));
  const fetch = pages();
  const out = await getDocsDetailed(entry, { topic: "request", mode: "sections", maxTokens }, undefined, undefined, undefined, lookup);
  expect(out.matched).toBeGreaterThan(0);
  expect(out.indexMatchLooksLikeToc).toBe(true);
  expect(out.text).toContain(noFollowNote);
  expect(out.text).toContain("Request handling");
  expect(out.text.length).toBeLessThanOrEqual(maxTokens * 4);
  expect(out.text).toMatch(/\n```\s*$/);
  expect(fetch).not.toHaveBeenCalled();
});

it("PAR-1032: README describes the actual index-only note, doctor reason, and current React source", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  expect(readme).toContain(noFollowNote);
  expect(readme).toContain("index-only match, no linked content returned");
  expect(readme).toContain("Source: https://react.dev/llms.txt");
  expect(readme).not.toContain("Source: https://react.dev/llms-full.txt");
});


function oversizedIndexSnippet(): string {
  const links = Array.from({ length: 400 }, (_, i) => `- [Request handling ${i}](https://other.example.test/request-${i})`);
  const code = ["request('RESERVE_START');", ...Array.from({ length: 1200 }, (_, i) => `request('payload-${i}');`), "request('RESERVE_END');"];
  return ["# Fastify", "## Request", ...links, "```ts", ...code, "```"].join("\n");
}

it.each([
  [250, "PAR-1032: notice reservation keeps an oversized index snippet's closing fence"],
  [4000, "PAR-1032: full-budget snippets mode retains the complete index notice and closed code fence"],
] as const)("%s tokens: %s", async (maxTokens) => {
  const content = oversizedIndexSnippet();
  expect(content.length).toBeGreaterThan(maxTokens * 4);
  seed(content);
  const fetch = pages();
  const out = await getDocsDetailed(entry, { topic: "request", mode: "snippets", maxTokens }, undefined, undefined, undefined, lookup);
  expect(out.isIndex).toBe(true);
  expect(out.indexMatchLooksLikeToc).toBe(true);
  expect(out.matched).toBe(1);
  expect(out.followed).toEqual([]);
  expect(out.returnedFromFollowed).toBe(0);
  expect(out.text).toContain(`Note: ${noFollowNote}.`);
  expect(out.text).toContain("```ts\nrequest('RESERVE_START');");
  expect(out.text).not.toContain("RESERVE_END");
  expect(out.text.length).toBe(maxTokens * 4);
  // This final code fence is the structural boundary, not a substring earlier in context.
  expect(out.text).toMatch(/\n```$/);
  expect(fetch).not.toHaveBeenCalled();
});
