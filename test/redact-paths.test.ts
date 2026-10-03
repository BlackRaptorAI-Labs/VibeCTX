import { describe, expect, it } from "vitest";
import { redactPathsForWarning } from "../src/redact-paths.js";

describe("redactPathsForWarning", () => {
  it("replaces cache paths before home paths in warning text without changing URLs", () => {
    const home = "/example/PATHMARK-owner";
    const cache = "/example/PATHMARK-owner/.vibectx";
    const url = `https://docs.example.test${cache}/guide`;
    const text = `open '${cache}/index.json' failed; also tried ${home}/private/config.json; source ${url}`;

    expect(redactPathsForWarning(text, cache, home)).toBe(`open '[cache]/index.json' failed; also tried ~/private/config.json; source ${url}`);
  });
  it("preserves uppercase and mixed-case HTTP schemes while redacting nearby local paths", () => {
    const home = "/example/PATHMARK-owner", cache = `${home}/.vibectx`;
    for (const scheme of ["HTTPS", "hTtPs", "HTTP", "hTtP"]) {
      const url = `${scheme}://docs.example.test${cache}/guide`;
      expect(redactPathsForWarning(`open ${cache}/index.json failed; source ${url}`, cache, home)).toBe(`open [cache]/index.json failed; source ${url}`);
    }
  });
});

it("PAR-1043: warning redaction matches complete home and cache path components", () => {
  const home = "/example/PATHMARK-home";
  const cache = `${home}/.vibectx`;
  expect(redactPathsForWarning(`failed: ${home}-sibling/notes.txt`, cache, home)).toBe(`failed: ${home}-sibling/notes.txt`);
  expect(redactPathsForWarning(`failed: '${cache}-sibling/x' and '${cache}/x' and '${home}/x'`, cache, home)).toBe("failed: '~/.vibectx-sibling/x' and '[cache]/x' and '~/x'");
  expect(redactPathsForWarning(`prefix/example/PATHMARK-home/x`, cache, home)).toBe("prefix/example/PATHMARK-home/x");
  expect(redactPathsForWarning(`https://example.test/a,${home}/x`, cache, home)).toBe(`https://example.test/a,${home}/x`);
});
