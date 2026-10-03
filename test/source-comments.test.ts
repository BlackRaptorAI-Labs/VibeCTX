import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function precedingDoc(file: string, symbol: string): string {
  const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
  const declaration = source.indexOf(symbol);
  expect(declaration, `${file}: ${symbol} must exist`).toBeGreaterThan(0);
  const start = source.lastIndexOf("/**", declaration);
  expect(start, `${file}: ${symbol} must have a doc comment`).toBeGreaterThanOrEqual(0);
  return source.slice(start, declaration);
}

describe("AUDIT-20260921-02 source comments", () => {
  it("activity-log jsonProblem describes the anchored regex now in use", () => {
    const doc = precedingDoc("activity-log.ts", "function jsonProblem(");
    expect(doc).toContain("anchored regex");
    expect(doc).not.toContain("not fixed here");
  });

  it("search-index jsonProblem describes its anchored regex, not a hand scan", () => {
    const doc = precedingDoc("search-index.ts", "function jsonProblem(");
    expect(doc).toContain("anchored regex");
    expect(doc).not.toContain("Scanned by hand");
  });

  it("PAR-981: JSON parse comments do not cite closed PAR-929 or equate different parsers", () => {
    const activity = precedingDoc("activity-log.ts", "function jsonProblem(");
    const search = precedingDoc("search-index.ts", "function jsonProblem(");
    expect(activity).not.toContain("PAR-929");
    expect(search).not.toContain("PAR-929");
    expect(search).not.toContain("Mirrors `jsonErrorMessage` in config.ts");
    expect(activity).toContain("terminal V8-shaped");
    expect(activity).toContain("pathological edge case is not excluded by this regex");
    expect(search).toContain("terminal V8-shaped");
    expect(search).toContain("uses an unanchored position");
    expect(search).toContain("converts the position to a line and column");
  });

  it("unknownLibraryMessage distinguishes the caller bound from Known-list length", () => {
    const doc = precedingDoc("registry.ts", "export function unknownLibraryMessage(");
    expect(doc).toContain("Known: list");
    expect(doc).not.toContain("grow this response without limit");
  });
});
