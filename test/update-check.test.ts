import { describe, expect, it, vi } from "vitest";
import { checkForUpdate } from "../src/update-check.js";
import { readFileSync } from "node:fs";

const reply = (tag_name: string, status = 200) =>
  new Response(JSON.stringify({ tag_name, html_url: "https://example.invalid/untrusted" }), { status });

describe("PAR-1008: opt-in update notice", () => {
  it("README states the manual source update and the opt-in request disclosure", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const updates = readme.match(/Update with `git pull && npm ci && npm run build`\.[\s\S]*?(?=\n> \*\*On pinning:)/)?.[0];
    expect(updates).toContain("VIBECTX_CHECK_UPDATES=1");
    expect(updates).toContain('"checkUpdates": true');
    expect(updates).toContain("GitHub Releases");
    expect(updates).toContain("off by default");
    expect(updates).toContain("vibectx --version");
  });
  it("does not contact GitHub when disabled by default", async () => {
    const request = vi.fn(async () => reply("v99.0.0"));
    const notes: string[] = [];
    await checkForUpdate({ enabled: false, currentVersion: "0.2.0", request, notify: (s) => notes.push(s) });
    expect(request).toHaveBeenCalledTimes(0);
    expect(notes).toEqual([]);
  });

  it("checks only the fixed public Releases endpoint and prints one safe newer-version notice", async () => {
    const request = vi.fn(async () => reply("v0.3.0"));
    const notes: string[] = [];
    await checkForUpdate({ enabled: true, currentVersion: "0.2.0", request, notify: (s) => notes.push(s) });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe("https://api.github.com/repos/BlackRaptorAI-Labs/VibeCTX/releases/latest");
    expect(request.mock.calls[0][1]).toMatchObject({ redirect: "error" });
    expect(notes).toEqual(["update available: v0.2.0 → v0.3.0 — https://github.com/BlackRaptorAI-Labs/VibeCTX/releases/tag/v0.3.0\n"]);
    expect(notes.join("")).not.toContain("example.invalid");
  });

  it("stays silent for same, older, malformed, HTTP failure, and thrown network errors", async () => {
    const notes: string[] = [];
    for (const response of [reply("v0.2.0"), reply("v0.1.9"), reply("99.0.0"), reply("v99.0.0\nLEAK"), reply("v9999999999999999.0.0"), reply("v99.0.0", 500)]) {
      await checkForUpdate({ enabled: true, currentVersion: "0.2.0", request: async () => response, notify: (s) => notes.push(s) });
    }
    await checkForUpdate({ enabled: true, currentVersion: "0.2.0", request: async () => { throw new Error("synthetic secret"); }, notify: (s) => notes.push(s) });
    expect(notes).toEqual([]);
  });

  it("refuses a release tag too large to be a one-line notice", async () => {
    const notes: string[] = [];
    await checkForUpdate({
      enabled: true, currentVersion: "0.2.0",
      request: async () => reply(`v${"9".repeat(100)}.0.0`),
      notify: (s) => notes.push(s),
    });
    expect(notes).toEqual([]);
  });

  it("does not parse or announce an oversized Releases response", async () => {
    const notes: string[] = [];
    await checkForUpdate({
      enabled: true, currentVersion: "0.2.0",
      request: async () => new Response(JSON.stringify({ tag_name: "v99.0.0", filler: "x".repeat(70_000) })),
      notify: (s) => notes.push(s),
    });
    expect(notes).toEqual([]);
  });
});
