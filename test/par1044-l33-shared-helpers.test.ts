import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

// L-33 (I-29 integration pass): one copy of each shared validator and bound, so raising a
// bound or fixing a validator is one edit, and no store silently disagrees with another.
const srcDir = new URL("../src/", import.meta.url);
const sources = readdirSync(srcDir).filter((name) => name.endsWith(".ts"))
  .map((name) => ({ name, text: readFileSync(new URL(name, srcDir), "utf8") }));
const definers = (pattern: RegExp) => sources.filter(({ text }) => pattern.test(text)).map(({ name }) => name).sort();

it("L-33: validIsoInstant is defined once, in cache-meta.ts, and every persisted-store reader imports it", () => {
  expect(definers(/function\s+validIsoInstant\b|const\s+validIsoInstant\s*=/)).toEqual(["cache-meta.ts"]);
  for (const name of ["activity-log.ts", "project-store.ts", "search-index.ts", "doctor-store.ts"]) {
    const text = sources.find((s) => s.name === name)!.text;
    expect(text, name).toMatch(/import\s*\{[^}]*\bvalidIsoInstant\b[^}]*\}\s*from\s*["']\.\/cache-meta\.js["']/);
  }
});

it("L-33: stripBom is defined once, in text.ts", () => {
  expect(definers(/function\s+stripBom\b|const\s+stripBom\s*=/)).toEqual(["text.ts"]);
});

it("L-33: the 214-character name bound is written once, as MAX_NAME_LENGTH in package-names.ts", () => {
  expect(definers(/=\s*214\b/)).toEqual(["package-names.ts"]);
});

it("L-33: MAX_QUERY_CHARS has one meaning (search's 1000); the activity log's 200 has its own name", () => {
  expect(definers(/(?:const|let|var)\s+MAX_QUERY_CHARS\s*=/)).toEqual(["search.ts"]);
});
