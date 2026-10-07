import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function repoFile(name: string): string {
  return readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
}

describe("PAR-1015: 0.3.0 source-release preparation", () => {
  it("pins the assumed release version in the manifest and lockfile root", () => {
    const pkg = JSON.parse(repoFile("package.json")) as { version: string; bin: Record<string, string> };
    const lock = JSON.parse(repoFile("package-lock.json")) as {
      version: string;
      packages: { "": { version: string; bin: Record<string, string> } };
    };
    expect(pkg.version).toBe("0.3.1");
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[""].version).toBe(pkg.version);
    expect(pkg.bin).toEqual({ vibectx: "dist/index.js" });
    expect(lock.packages[""].bin).toEqual(pkg.bin);
  });

  it("CI fetches full Git history so the README tag check runs", () => {
    const workflow = repoFile(".github/workflows/ci.yml");
    const checkoutSteps = workflow.match(/^      - uses: actions\/checkout@[^\n]+\n(?: {8,}[^\n]*\n)*/gm);
    expect(checkoutSteps).toHaveLength(1);
    expect(checkoutSteps![0]).toMatch(/^        with:\n          fetch-depth: 0$/m);
    expect(workflow).toContain("npm test -- test/readme-release-consistency.test.ts --reporter=verbose");
    const tagTest = repoFile("test/readme-release-consistency.test.ts");
    expect(tagTest).toMatch(/if \(process\.env\.CI\)\s*\{\s*throw new Error\("CI checkout has no reachable tag/);
  });

  it("README tells 0.3.0 users how to preserve a custom legacy cache", () => {
    const upgrade = repoFile("README.md").split("**Upgrading from `~/.docs-cache-mcp`.**")[1]?.split("\n## ")[0];
    expect(upgrade).toBeDefined();
    expect(upgrade).toContain("`DOCS_CACHE_DIR` no longer selects the cache directory");
    expect(upgrade).toContain("read only for path redaction");
    expect(upgrade).toContain("`VIBECTX_CACHE_DIR`");
    expect(upgrade).toContain("to that same directory **before** upgrading");
    expect(upgrade).not.toContain("Both still work");
    expect(upgrade).not.toContain("is still read through");
    expect(upgrade).not.toContain("The `docs-cache-mcp` command still works");
  });

  it("README 0.1.x upgrade guidance names the retired discovered config filename", () => {
    const upgrade = repoFile("README.md").split("### Upgrading from 0.1.x")[1]?.split("\n## ")[0];
    expect(upgrade).toBeDefined();
    expect(upgrade).toContain("docs-cache.config.json");
    expect(upgrade).toContain("rename");
    expect(upgrade).toContain("--config");
    expect(upgrade).not.toContain("Configs written for 0.1.3 keep working, with one exception");
  });

  it("README does not call failed preliminary DNS resolution safe from rebinding", () => {
    const dns = repoFile("README.md").split("**Resolved-address check.**")[1]?.split("\n**Honest limit.**")[0];
    expect(dns).toBeDefined();
    expect(dns).not.toMatch(/a name with no answer is\s+not a rebinding risk/);
    expect(dns).toContain("hostname that fails this preliminary lookup is not refused by default");
    expect(dns).toContain("runtime's separate");
    expect(dns).toContain("separate resolution");
  });

  it("records D-98 as Tom's trusted-launching-client decision, not an assumed transport control", () => {
    const decisions = repoFile("docs/decisions.md");
    const d98 = decisions.split("## D-98 —")[1];
    expect(d98).toBeDefined();
    expect(d98).toContain("decided 2026-09-24 by Tom");
    expect(d98).toContain("PAR-1016");
    expect(d98).toContain("launching host");
    expect(d98).toContain("not size-capped");
    expect(d98).toContain("VibeCTX 0.2.1");
    expect(d98).not.toContain("ASSUMED");
  });

  it("README keeps the trusted-client inbound-size disclosure accepted in D-98", () => {
    const readme = repoFile("README.md");
    const transportLimit = readme.split("Every MCP string argument is bounded")[1]?.split("\n## Command line")[0];
    expect(transportLimit).toBeDefined();
    expect(transportLimit).toContain("before Zod validates a tool");
    expect(transportLimit).toContain("capped at 10 MiB by default");
    expect(transportLimit).toContain("MCP client you");
    expect(transportLimit).toContain("trust to bound requests");
  });
});
