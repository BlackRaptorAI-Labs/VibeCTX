import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDocs, getDocsToolText } from "../src/get-docs.js";
import { readFileSync } from "node:fs";

/**
 * PAR-858 (Group B) — the `get_docs` MCP response contract, documented in one place (README's
 * "get_docs" section) and pinned here so code and docs cannot drift apart silently, the same
 * lesson PAR-856's own README-consistency test applies to a different claim.
 *
 * D-87 (PAR-848/849) settled this as "make the claim true": every response that reaches a real
 * document opens with a genuine `Source: <url> …` stamp (`sourceStampLine`/`fitStampLine`,
 * `retrieval.ts`), and — PAR-849's specific resolution — a response with NO document to point
 * at still gets a Source-SHAPED line (`Source: none · nothing cached · …`) rather than omitting
 * the stamp. Exactly four response "grammars" exist, distinguished by what the text OPENS WITH
 * — a client (or a person) can tell them apart from the first line alone, without parsing the
 * rest of the body:
 *
 *   1. Unknown library    — opens with `Unknown library "` (registry.ts's `unknownLibraryMessage`)
 *   2. Budget refusal      — opens with `maxTokens is too small to state ` (get-docs.ts's
 *                            `budgetRefusalText`) — deliberately NEVER a `Source:` line: naming
 *                            no document is the point (README's own "get_docs" section).
 *   3. No document at all  — opens with `Source: none · nothing cached · ` (curated|resolved) —
 *                            PAR-849's Source-SHAPED line for the no-document case.
 *   4. A document was read — opens with `Source: ` followed by a real URL, whether the topic
 *                            matched (content follows) or not (`noMatchNote` follows on the next
 *                            line) — the same opening either way, since D-87 the URL is reached.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-response-grammars-"));
  process.env.VIBECTX_CACHE_DIR = dir;
});
afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe("get_docs response contract: four grammars, each with a documented opening marker (D-87)", () => {
  it("1. unknown library — opens with `Unknown library \"`", async () => {
    const registry = { entries: new Map([["react", { name: "react", urls: ["https://react.dev/llms.txt"] }]]) };
    // `--offline` is the path that reaches `unknownLibraryMessage` directly; the online path
    // instead attempts `resolvePackage` first (a distinct grammar of its own, not this one).
    const out = await getDocsToolText(registry, { library: "totally-not-a-real-package", topic: "x", offline: true });
    expect(out.startsWith('Unknown library "')).toBe(true);
  });

  it("2. budget refusal — opens with `maxTokens is too small to state `, never a Source: line", async () => {
    // A very long URL forces even `Source: <url>` alone past a maxTokens: 1 budget.
    const entry = { name: "x", urls: [`https://example.com/${"a".repeat(400)}/llms.txt`] };
    const { writeCache } = await import("../src/cache.js");
    writeCache(entry.name, entry.urls[0], "# X\n\n## topic\n\nprose.");
    const out = await getDocs(entry, { topic: "topic", maxTokens: 1 });
    expect(out.startsWith("maxTokens is too small to state ")).toBe(true);
    expect(out.startsWith("Source:")).toBe(false);
  });

  it("3. no document at all — opens with `Source: none · nothing cached · `", async () => {
    const entry = { name: "ghost", urls: ["https://ghost.example.com/llms.txt"] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );
    const out = await getDocs(entry, { topic: "anything", offline: true });
    expect(out.startsWith("Source: none · nothing cached · ")).toBe(true);
  });

  it("4. a document was read — opens with `Source: ` followed by a real URL (matched case)", async () => {
    const entry = { name: "fastify", urls: ["https://fastify.dev/llms.txt"] };
    const { writeCache } = await import("../src/cache.js");
    writeCache(entry.name, entry.urls[0], "# Fastify\n\n## querystring parsing\n\nFastify parses query strings.");
    const out = await getDocs(entry, { topic: "querystring parsing" });
    expect(out.startsWith("Source: https://fastify.dev/llms.txt")).toBe(true);
  });

  it("4. a document was read — opens with `Source: ` followed by a real URL (no-match case)", async () => {
    const entry = { name: "fastify", urls: ["https://fastify.dev/llms.txt"] };
    const { writeCache } = await import("../src/cache.js");
    writeCache(entry.name, entry.urls[0], "# Fastify\n\n## querystring parsing\n\nFastify parses query strings.");
    const out = await getDocs(entry, { topic: "zzz-unmatched-topic" });
    expect(out.startsWith("Source: https://fastify.dev/llms.txt")).toBe(true);
    expect(out).toContain('No sections in fastify docs match "zzz-unmatched-topic"');
  });

  it("README consolidates all four opening markers in one place (D-87) — fails if the doc and the code drift apart", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const section = readme.match(/\*\*Response grammars, in one place \(D-87[\s\S]*?(?=\n\n\*\*|\n## )/);
    expect(section, "README must have a 'Response grammars, in one place (D-87 …)' section").not.toBeNull();
    for (const marker of ['Unknown library "', "maxTokens is too small to state ", "Source: none · nothing cached · ", "Source: <url>"]) {
      expect(section![0], `the consolidated section must document the "${marker}" opening marker`).toContain(marker);
    }
  });
});
