import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const register = (): string =>
  readFileSync(new URL("../docs/known-limitations.md", import.meta.url), "utf8");
const row = (id: string): string =>
  register().split("\n").find((line) => line.startsWith(`| ${id} |`)) ?? "";
const cells = (id: string): string[] => row(id).split("|").slice(1, -1).map((cell) => cell.trim());
const gate = (): string => register().split("## Compatibility choices")[1] ?? "";

describe("PAR-982 residual register reconciliation", () => {
  it("records the six pre-decided residuals without asking the gate again", () => {
    for (const id of ["B-15", "B-16", "B-17", "B-19", "B-20", "B-27"]) {
      expect(row(id), `${id} remains classified in the register`).not.toBe("");
      expect(gate(), `${id} is not an open gate row`).not.toContain(`| ${id} |`);
    }
  });

  it("classifies B-06 and B-08 by the recorded fix and decision", () => {
    expect(row("B-06")).toContain("9fc62f6");
    expect(row("B-06")).toContain("D-95");
    expect(row("B-08")).toContain("Accepted behavior");
    expect(row("B-08")).toContain("PAR-926");
  });

  it("PAR-981/982: B-06 owns only the configured-root residual; source references name functions", () => {
    expect(row("B-03")).toContain("ensureCacheRoot");
    expect(row("B-09")).toContain("touchCache");
    expect(row("B-09")).not.toMatch(/src\/cache\.ts:\d+/);
    expect(row("B-06")).toContain("configured-root");
    expect(row("B-06")).toContain("migration and followed-page cleanup are covered separately by B-04/B-25");
    expect(row("B-04")).toContain("migration and followed-page cleanup");
    expect(row("B-04")).toContain("| D-83/D-85; `src/cache.ts`");
    expect(row("B-04")).toContain("D-95 separately covers the configured-root race");
    expect(row("B-04")).toContain("Tom accepted the remaining migration/cleanup boundary");
    expect(row("B-25")).toContain("D-83/D-85");
    expect(row("B-25")).toContain("synchronous check-then-act windows");
    expect(row("B-25")).toContain("Tom accepted the remaining migration/cleanup boundary");
    expect(row("B-25")).toContain("D-95 separately covers the configured-root race");
    expect(row("B-25")).toContain("not broad cache-root exposure");
    expect(gate()).toContain("migration/cleanup boundary separately from D-95's configured-root race");
    expect(cells("B-03")[2]).toBe("D-84; `ensureCacheRoot` in `src/cache.ts`; README cache section");
    expect(cells("B-04")[2]).toBe("D-83/D-85; `src/cache.ts`");
    expect(cells("B-04")[3]).toBe("Descriptor-pinned reads and canonical-root checks close broader escapes; Tom accepted the remaining migration/cleanup boundary. D-95 separately covers the configured-root race.");
    expect(cells("B-06")[3]).toBe("Configured-root ancestor swaps are refused after canonical-root pinning. D-95 retains a configured-root check-then-use race; migration and followed-page cleanup are covered separately by B-04/B-25.");
    expect(cells("B-09")[3]).toBe("`touchCache` calls `metaMatchesLibrary` and leaves a mismatched record unchanged.");
    expect(cells("B-25").slice(1, 6)).toEqual([
      "Cache migration and followed-page cleanup retain synchronous check-then-act windows.",
      "D-83/D-85; `src/cache.ts`",
      "Tom accepted the remaining migration/cleanup boundary; D-95 separately covers the configured-root race.",
      "Accepted behavior",
      "Restrict parent-directory writes: this is the migration/cleanup boundary, not broad cache-root exposure.",
    ]);
    expect(gate()).toContain("| B-04/B-25 | Retain the migration/cleanup boundary separately from D-95's configured-root race. | Restrict cache-ancestor writes. |");
  });

  it("accounts for every B-31 through B-38 sweep finding", () => {
    for (let number = 31; number <= 38; number++) {
      expect(row(`B-${number}`), `B-${number} is classified`).not.toBe("");
    }
  });

  it("records all eight answered gate choices", () => {
    const answered = gate();
    expect(answered).toContain("decided by Tom");
    for (const id of ["B-02", "B-04/B-25", "B-13", "B-14", "B-23", "B-24", "B-36", "B-37"]) {
      expect(answered, `${id} has an answer`).toContain(`| ${id} |`);
    }
  });

  it("qualifies pre-8898a76 full-suite evidence as macOS-only", () => {
    expect(register()).toMatch(/macOS-only until `8898a76`/);
  });

  it("records the live D-90j Linear routing without calling either an open release gate", () => {
    expect(row("B-16")).toContain("VibeCTX 2.0");
    expect(row("B-16")).toContain("deferred-by-decision");
    expect(row("B-17")).toContain("VibeCTX 0.2.1");
    expect(row("B-17")).toContain("deferred-by-decision");
    expect(register()).toContain("## Supported scope");
  });
});
