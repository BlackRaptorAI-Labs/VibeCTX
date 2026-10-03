import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { bugFailureOffer, buildBugPreview, issueLinkAfterConfirmation, type BugFacts } from "../src/bug-report.js";

const facts = {
  operation: "get_docs" as const,
  where: "network" as const,
  errorClass: "NetworkError" as const,
  version: "0.2.0",
  platform: "darwin",
  nodeVersion: "v22.12.0",
};

describe("PAR-1009: safe opt-in bug report", () => {
  it("offers help for an operational failure without a link or raw diagnostics", () => {
    const raw = new Error("SYNTHETIC_SECRET /Users/Private/name https://user:pass@example.test/path?token=QUERY");
    const offer = bugFailureOffer(facts, raw);
    expect(offer).toContain("get_docs failed in network");
    expect(offer).toContain("NetworkError");
    expect(offer).toContain("VibeCTX 0.2.0");
    expect(offer).toContain("report-bug");
    expect(offer).not.toMatch(/SYNTHETIC_SECRET|\/Users\/Private|user:pass|QUERY|github\.com\/BlackRaptorAI\/VibeCTX\/issues\/new/);
  });

  it("previews only allowlisted fields and permitted tech names", () => {
    const preview = buildBugPreview({
      ...facts,
      techStack: [
        { kind: "language" as const, name: "TypeScript" },
        { kind: "service" as const, name: "API_KEY=SYNTHETIC_SECRET" },
        { kind: "hosting" as const, name: "/Users/Private/name" },
        { kind: "app" as const, name: "https://user:pass@example.test/path?token=QUERY" },
        { kind: "service" as const, name: "sk_live_12345678901234567890" },
      ],
    });
    expect(preview).toContain("TypeScript");
    expect(preview).toContain("get_docs");
    expect(preview).not.toMatch(/SYNTHETIC_SECRET|\/Users\/Private|user:pass|QUERY|sk_live_12345678901234567890/);
    expect(preview).not.toContain("issues/new");
  });

  it("scrubs hostile VibeCTX and Node version strings before either reaches the report or link", () => {
    const hostile = {
      ...facts,
      version: "0.2.0/SYNTHETIC_SECRET /Users/Private/name",
      nodeVersion: "v22.12.0?token=SYNTHETIC_SECRET",
    };
    const preview = buildBugPreview(hostile);
    const link = issueLinkAfterConfirmation(hostile, true);
    expect(preview).toContain("VibeCTX version: unknown");
    expect(preview).toContain("Node version: unknown");
    expect(preview).not.toMatch(/SYNTHETIC_SECRET|\/Users\/Private|token=/);
    expect(link.kind).toBe("url");
    if (link.kind !== "url") throw new Error("expected URL");
    expect(decodeURIComponent(link.value)).not.toMatch(/SYNTHETIC_SECRET|\/Users\/Private|token=/);
  });

  it("rejects forged operation, component, error class, and platform values at the report boundary", () => {
    const forged = {
      ...facts,
      operation: "get_docs/SYNTHETIC_SECRET",
      where: "network/SYNTHETIC_SECRET",
      errorClass: "NetworkError/SYNTHETIC_SECRET",
      platform: "darwin/SYNTHETIC_SECRET",
    } as unknown as BugFacts;
    const preview = buildBugPreview(forged);
    expect(preview).toContain("Operation: startup");
    expect(preview).toContain("Where: startup");
    expect(preview).toContain("Error class: UnknownError");
    expect(preview).toContain("OS/platform: other");
    expect(preview).not.toContain("SYNTHETIC_SECRET");
    const link = issueLinkAfterConfirmation(forged, true);
    expect(link.kind).toBe("url");
    if (link.kind !== "url") throw new Error("expected URL");
    expect(decodeURIComponent(link.value)).not.toContain("SYNTHETIC_SECRET");
  });

  it("produces no link without confirmation, then a pre-filled fixed-host link containing the exact preview", () => {
    const preview = buildBugPreview(facts);
    expect(issueLinkAfterConfirmation(facts, false)).toEqual({ kind: "declined" });
    const result = issueLinkAfterConfirmation(facts, true);
    expect(result.kind).toBe("url");
    if (result.kind !== "url") throw new Error("expected URL");
    const url = new URL(result.value);
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/BlackRaptorAI-Labs/VibeCTX/issues/new");
    expect(url.searchParams.get("template")).toBe("bug_report.md");
    expect(url.searchParams.get("body")).toBe(preview);
  });

  it("falls back to copyable preview text when the encoded URL is too long, without submitting", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const names = Array.from({ length: 100 }, () => ({ kind: "language" as const, name: "TypeScript" }));
    const reportFacts = { ...facts, techStack: names };
    const preview = buildBugPreview(reportFacts);
    const result = issueLinkAfterConfirmation(reportFacts, true);
    expect(result).toEqual({ kind: "copy", value: preview });
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("has an issue template matching the approved report fields", () => {
    const template = readFileSync(new URL("../.github/ISSUE_TEMPLATE/bug_report.md", import.meta.url), "utf8");
    for (const field of ["VibeCTX version", "OS/platform", "Node version", "Operation", "Where", "Error class", "Tech stack"]) {
      expect(template).toContain(field);
    }
  });
});
