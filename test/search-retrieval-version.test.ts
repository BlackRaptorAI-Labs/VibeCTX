import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCache } from "../src/cache.js";
import type { Registry } from "../src/registry.js";

/**
 * PAR-659 · D-38 — THE INDEX IS KEYED TO THE CODE THAT BUILT IT.
 *
 * The search index carries a content hash per document, and that hash is what makes a stale or
 * planted entry harmless. It is also exactly why a change to the RETRIEVAL CODE slips past it:
 * the bytes are unchanged, so the hash matches, while the postings on disk are filed under
 * terms today's tokenizer no longer produces. The result is not a wrong answer, which someone
 * would notice — it is an EMPTY one.
 *
 * MEASURED by the PAR-659 schema gate: deleting the stemmer's `ies→y` rule made a surviving
 * index return zero groups where a freshly built index returns the right section.
 *
 * This file runs that experiment. `../src/tokenize.js` is replaced by a COPY OF THE MODULE
 * whose stemmer maps `policies` the way a build without the `ies→y` rule would (to `polici`
 * rather than `policy`) — everything else identical — and, in the second case, whose
 * `RETRIEVAL_VERSION` is bumped, which is precisely what the comment at that site instructs a
 * developer to do. Both halves are asserted:
 *
 *   - WITHOUT the bump, the surviving index is used and the search returns nothing. That is the
 *     failure D-38 exists to prevent, and it is proved here rather than described.
 *   - WITH the bump, `readIndex` refuses the file, the document is re-tokenized on the spot,
 *     and the right section comes back.
 */

const mutant = vi.hoisted(() => ({ bump: false }));

const CACHE_URL = "https://acme-cache.example.com/llms.txt";
const DOC = [
  "# Acme Cache",
  "",
  "## Retention policies",
  "",
  "A retention policy decides how long an entry is kept before it is evicted.",
  "",
  "## Connection pooling",
  "",
  "Pool connections so a burst of requests does not open a socket each.",
].join("\n");

const registry = (): Registry => ({ entries: new Map([["acme-cache", { name: "acme-cache", urls: [CACHE_URL] }]]) });

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-retrieval-version-"));
  process.env.VIBECTX_CACHE_DIR = dir;
  mutant.bump = false;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
  vi.doUnmock("../src/tokenize.js");
  vi.resetModules();
});

/**
 * Load `search` against a copy of `src/tokenize.ts` with one stemmer rule changed. Mocking the
 * LEAF module is what makes this faithful: `retrieval.ts` and `search-index.ts` both import
 * their tokenizer from here, so the whole retrieval path moves together, exactly as it would
 * if the rule were edited in place.
 */
async function loadMutantSearch(): Promise<typeof import("../src/search.js")> {
  vi.resetModules();
  vi.doMock("../src/tokenize.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/tokenize.js")>();
    return {
      ...actual,
      // The one rule difference: without `ies→y`, `policies` stems to `polici`, not `policy`.
      // Documents and queries both go through this, so it is a consistent tokenizer — just not
      // the one that wrote the index file already on disk.
      tokenize: (text: string) => actual.tokenize(text).map((t) => (t === "policy" ? "polici" : t)),
      // …and the constant the comment at that site tells you to bump when you make it.
      RETRIEVAL_VERSION: actual.RETRIEVAL_VERSION + (mutant.bump ? 1 : 0),
    };
  });
  return import("../src/search.js");
}

describe("D-38 · an index built by different retrieval code is rebuilt, never used (PAR-659)", () => {
  it("without the version bump the stale index is used and the answer is silently EMPTY — the failure D-38 prevents", async () => {
    const { runSearch } = await import("../src/search.js");
    const { resetSearchIndexMemo } = await import("../src/search-index.js");
    resetSearchIndexMemo();
    writeCache("acme-cache", CACHE_URL, DOC);

    // Built by THIS build's tokenizer: the document is filed under `policy`.
    const built = runSearch(registry(), { query: "policies" });
    expect(built.tokenized).toBe(1);
    expect(built.groups[0].sections[0].heading).toBe("Retention policies");

    // Now the tokenizer changes and nobody bumps the version. The hash still matches — the
    // DOCUMENT did not change — so the postings are used, and they answer a question that is
    // no longer being asked.
    mutant.bump = false;
    const stale = await loadMutantSearch();
    const out = stale.runSearch(registry(), { query: "policies" });
    expect(out.fromIndex).toBe(1);
    expect(out.tokenized).toBe(0);
    expect(out.groups).toEqual([]);
  });

  it("with the version bumped the file is refused whole, the document re-tokenized, and the right section comes back", async () => {
    const { runSearch } = await import("../src/search.js");
    const { resetSearchIndexMemo } = await import("../src/search-index.js");
    resetSearchIndexMemo();
    writeCache("acme-cache", CACHE_URL, DOC);
    runSearch(registry(), { query: "policies" }); // the index this build wrote

    mutant.bump = true;
    const bumped = await loadMutantSearch();
    const { resetSearchIndexMemo: resetAgain } = await import("../src/search-index.js");
    resetAgain();
    const out = bumped.runSearch(registry(), { query: "policies" });

    expect(out.fromIndex).toBe(0); // the whole file was refused …
    expect(out.tokenized).toBe(1); // … and the document tokenized on the spot
    expect(out.notes.join(" ")).toMatch(/retrieval version/);
    expect(out.groups[0].sections[0].heading).toBe("Retention policies");
    expect(out.groups[0].sections[0].body).toContain("retention policy decides");
  });
});
