import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const decisions = () => readFileSync(new URL("../docs/decisions.md", import.meta.url), "utf8");
const readme = () => readFileSync(new URL("../README.md", import.meta.url), "utf8");

describe("C1 PAR-990 owner decision", () => {
  it("records Tom's path-preserving privacy scope, not an ASSUMED decision", () => {
    const record = decisions();
    expect(record).toContain("D-96 — decided 2026-09-23 by Tom, PAR-990 / C1");
    expect(record).toContain("userinfo, query, or fragment");
    expect(record).toContain("Path-borne tokens are out of scope for 0.2.1");
    expect(record).toContain("B-23 / D-90j");
    expect(record).not.toContain("D-96 — ASSUMED");
  });

  it("warns README readers that URL paths are identity, not a safe token carrier", () => {
    expect(readme()).toContain("URL paths are preserved as document identity; do not use VibeCTX with URLs carrying access tokens in the path.");
  });

  it("does not promise an unsupported CLI refresh command as a stale-page repair", () => {
    const gap = readme().split("**KNOWN GAP (0.2.1), disclosed:**")[1]?.split("\n\n")[0];
    expect(gap).not.toContain("`vibectx refresh <library>`");
    expect(gap).toContain("A 304 does not invalidate the old followed-page cache");
  });

  it("qualifies the MCP refresh tool table with its 304 followed-page exception", () => {
    const tableRow = readme().split("\n").find((line) => line.startsWith("| `refresh(library?)` |"));
    expect(tableRow).toContain("A changed (200) refresh drops");
    expect(tableRow).toContain("A 304 revalidation keeps them");
  });

  it("discloses that the CLI lacks refresh while giving supported stale-search actions", () => {
    expect(readme()).toContain("For a stale search result, call the MCP `refresh(library)` tool");
    expect(readme()).toContain("The CLI has no\n`refresh` subcommand (PAR-998)");
    expect(readme()).not.toContain("stale search output currently suggests `vibectx refresh");
  });
});
