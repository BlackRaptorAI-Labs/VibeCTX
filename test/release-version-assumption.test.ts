import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("PAR-985 release version assumption", () => {
  it("keeps the carried renderSection caller warning", () => {
    const source = readFileSync(new URL("../src/retrieval.ts", import.meta.url), "utf8");
    expect(source).toContain("Future callers must pass retrieved body text through fitRetrievedText before model-visible output.");
  });
});
