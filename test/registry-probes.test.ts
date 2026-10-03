import { expect, it } from "vitest";
import { DEFAULT_REGISTRY } from "../src/registry.js";

// Decision 20: doctor proves retrieval per library with that library's own probe queries. A
// built-in library with no probe would fall back to a derived query nobody chose.
it("decision 20: every built-in library has at least one non-empty doctor probe", () => {
  const missing = DEFAULT_REGISTRY
    .filter((entry) => !(entry.probeQueries ?? []).some((query) => query.trim().length > 0))
    .map((entry) => entry.name);
  expect(DEFAULT_REGISTRY.length).toBeGreaterThanOrEqual(30);
  expect(missing).toEqual([]);
});

it("decision 22: four libraries start from a working docs source and keep their earlier candidates as fallbacks", () => {
  const urls = (name: string) => DEFAULT_REGISTRY.find((entry) => entry.name === name)?.urls ?? [];
  const expected: Record<string, { first: string; kept: string }> = {
    tailwindcss: { first: "https://raw.githubusercontent.com/tailwindlabs/tailwindcss.com/main/src/docs/responsive-design.mdx", kept: "https://raw.githubusercontent.com/tailwindlabs/tailwindcss/refs/heads/main/README.md" },
    "tanstack-query": { first: "https://tanstack.com/query/latest/docs/framework/react/guides/queries.md", kept: "https://tanstack.com/llms.txt" },
    firebase: { first: "https://firebase.google.com/docs/llms.txt", kept: "https://raw.githubusercontent.com/firebase/firebase-js-sdk/refs/heads/main/README.md" },
    supabase: { first: "https://supabase.com/llms-full.txt", kept: "https://supabase.com/llms.txt" },
  };
  for (const [name, { first, kept }] of Object.entries(expected)) {
    expect(urls(name)[0], name).toBe(first);
    expect(urls(name), name).toContain(kept);
  }
});
