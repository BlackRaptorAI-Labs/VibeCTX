import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// PAR-1044 I-29: an index into an array or record may be undefined, and the type checker says so.
it("I-29: tsconfig keeps strict mode and noUncheckedIndexedAccess on", () => {
  const options = JSON.parse(readFileSync(new URL("../tsconfig.json", import.meta.url), "utf8")).compilerOptions;
  expect(options.strict).toBe(true);
  expect(options.noUncheckedIndexedAccess).toBe(true);
});
