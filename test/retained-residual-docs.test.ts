import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("PAR-984 retained residual documentation", () => {
  it("explains why symlinked project config remains accepted", () => {
    expect(source("README.md")).toContain("linked monorepos and dotfile setups");
    expect(source("src/config.ts")).toContain("B-02 retained decision");
  });

  it("narrows accepted cache races to migration and followed-page cleanup", () => {
    expect(source("README.md")).toContain("migration and followed-page cleanup remain");
    expect(source("README.md")).toContain("[Compatibility choices](docs/known-limitations.md#compatibility-choices)");
    expect(source("src/cache.ts")).toContain("B-04/B-25 retained decision");
  });

  it("explains the accepted full-refresh duration", () => {
    expect(source("README.md")).toContain("B-14 retained decision");
    expect(source("src/refresh.ts")).toContain("B-14 retained decision");
    expect(source("src/refresh.ts")).not.toContain("DISCLOSED, DEFERRED GAP");
  });

  it("states the public-documentation-only product scope", () => {
    expect(source("README.md")).toContain("Public documentation only in this release");
    expect(source("src/retrieval.ts")).toContain("B-23 retained decision");
    expect(source("README.md")).not.toContain("remains an open question, deliberately not decided here");
  });
});
