import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDocsToolText, resetOverrideNotes } from "../src/get-docs.js";
import { resetResolutionWindow } from "../src/resolve.js";
import { writeCache } from "../src/cache.js";
import { DEFAULT_REGISTRY, loadDiscoveredRegistry, loadRegistry } from "../src/registry.js";
import { stubPublicDns } from "./helpers/public-dns.js";

// PAR-1272 item 3 (decided 2026-10-05): a config entry with a built-in's exact name replaces the
// whole built-in entry (unchanged). That replacement is now stated once on stderr at load and once
// in that library's get_docs reply.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-par1272-"));
  process.env.VIBECTX_CACHE_DIR = join(dir, "cache");
  resetResolutionWindow();
  resetOverrideNotes();
  stubPublicDns();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 404 })));
});
afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const STRIPE_OVERRIDE = "https://docs.stripe.example/llms.txt";

function writeConfig(libraries: unknown, folder = dir): string {
  const path = join(folder, "vibectx.config.json");
  writeFileSync(path, JSON.stringify({ libraries }));
  return path;
}

const replyNote = 'Note: "stripe" from vibectx.config.json replaces the built-in entry of the same name (its URLs and probes are not merged).';

describe("PAR-1272: a same-name config entry that replaces a built-in", () => {
  it("is recorded as a load note naming the library and the config file", () => {
    const path = writeConfig([{ name: "stripe", urls: [STRIPE_OVERRIDE] }]);
    const registry = loadRegistry(path, { includeResolved: false });
    const notes = registry.config?.notes ?? [];
    const mine = notes.filter((n) => n.includes("replaces the built-in entry of the same name"));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toContain('"stripe"');
    expect(mine[0]).toContain("vibectx.config.json");
    expect(mine[0]).toContain("(its URLs and probes are not merged)");
  });

  it("goes to stderr at load through the discovered-registry warn channel", () => {
    const project = join(dir, "project");
    mkdirSync(project);
    writeConfig([{ name: "stripe", urls: [STRIPE_OVERRIDE] }], project);
    const warn = vi.fn();
    loadDiscoveredRegistry({ cwd: project, env: {}, home: join(dir, "home"), warn, includeResolved: false });
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("replaces the built-in entry of the same name"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"stripe"');
  });

  it("appears in that library's first get_docs reply, then not again", async () => {
    const path = writeConfig([{ name: "stripe", urls: [STRIPE_OVERRIDE] }]);
    const registry = loadRegistry(path, { includeResolved: false });
    writeCache("stripe", STRIPE_OVERRIDE, "# Stripe\n\n## Checkout\n\nCreate a checkout session.");
    const first = await getDocsToolText(registry, { library: "stripe", topic: "checkout" });
    expect(first).toContain(replyNote);
    expect(first).toContain(`Source: ${STRIPE_OVERRIDE}`);
    const second = await getDocsToolText(registry, { library: "stripe", topic: "checkout" });
    expect(second).not.toContain("replaces the built-in entry");
  });

  it("get_docs lookups never print the note to stderr; it prints only at load", async () => {
    const path = writeConfig([{ name: "stripe", urls: [STRIPE_OVERRIDE] }]);
    const registry = loadRegistry(path, { includeResolved: false });
    writeCache("stripe", STRIPE_OVERRIDE, "# Stripe\n\n## Checkout\n\nCreate a checkout session.");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    for (let i = 0; i < 3; i += 1) await getDocsToolText(registry, { library: "stripe", topic: "checkout" });
    const written = stderr.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("replaces the built-in entry"));
    expect(written).toEqual([]);
  });

  it("the reply names only the config file's base name, never its folder", async () => {
    const path = writeConfig([{ name: "stripe", urls: [STRIPE_OVERRIDE] }]);
    const registry = loadRegistry(path, { includeResolved: false });
    writeCache("stripe", STRIPE_OVERRIDE, "# Stripe\n\n## Checkout\n\nCreate a checkout session.");
    const out = await getDocsToolText(registry, { library: "stripe", topic: "checkout" });
    expect(out).not.toContain(dir);
  });

  it("replacement semantics are unchanged: config URLs only, built-in aliases inherited", () => {
    const path = writeConfig([{ name: "stripe", urls: [STRIPE_OVERRIDE] }]);
    const entry = loadRegistry(path, { includeResolved: false }).entries.get("stripe");
    const builtin = DEFAULT_REGISTRY.find((e) => e.name === "stripe");
    expect(entry?.urls).toEqual([STRIPE_OVERRIDE]);
    expect(entry?.aliases).toEqual(builtin?.aliases);
    expect(entry?.probeQueries).toBeUndefined();
  });
});

describe("PAR-1272: configs that do not replace a built-in stay quiet", () => {
  it("an additive config with a new name: no note at load or in get_docs", async () => {
    const url = "https://docs.acme.example/llms.txt";
    const path = writeConfig([{ name: "acme", urls: [url] }]);
    const registry = loadRegistry(path, { includeResolved: false });
    expect((registry.config?.notes ?? []).some((n) => n.includes("replaces the built-in entry"))).toBe(false);
    writeCache("acme", url, "# Acme\n\n## Widgets\n\nWidgets.");
    const out = await getDocsToolText(registry, { library: "acme", topic: "widgets" });
    expect(out).not.toContain("replaces the built-in entry");
  });

  it("a project config replacing a user config's non-built-in entry is not called a built-in replacement", () => {
    const home = join(dir, "home");
    const userDir = join(home, ".config", "vibectx");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "config.json"), JSON.stringify({ libraries: [{ name: "acme", urls: ["https://docs.acme.example/llms.txt"] }] }));
    const project = join(dir, "project");
    mkdirSync(project);
    writeConfig([{ name: "acme", urls: ["https://docs.acme.example/v2/llms.txt"] }], project);
    const warn = vi.fn();
    const registry = loadDiscoveredRegistry({ cwd: project, env: {}, home, warn, includeResolved: false });
    expect(registry.entries.get("acme")?.urls).toEqual(["https://docs.acme.example/v2/llms.txt"]);
    expect(warn.mock.calls.map((c) => String(c[0])).some((l) => l.includes("replaces the built-in entry"))).toBe(false);
    expect(registry.entries.get("acme")?.replacedBuiltin).toBeUndefined();
  });

  it("an untouched built-in in the same registry gets no note", async () => {
    const path = writeConfig([{ name: "stripe", urls: [STRIPE_OVERRIDE] }]);
    const registry = loadRegistry(path, { includeResolved: false });
    const react = registry.entries.get("react")!;
    writeCache("react", react.urls[0]!, "# React\n\n## useEffect\n\nEffects.");
    const out = await getDocsToolText(registry, { library: "react", topic: "useEffect" });
    expect(out).not.toContain("replaces the built-in entry");
  });
});
