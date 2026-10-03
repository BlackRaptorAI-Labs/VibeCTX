import { afterEach, expect, it, vi } from "vitest";
import * as crypto from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, createHash: vi.fn(actual.createHash) };
});
let owned: string | undefined;
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); if (owned) rmSync(owned, { recursive: true, force: true }); owned = undefined; });

it("PAR-1043: repeated exact cache keys reuse their digests while every body is still read and verified", async () => {
  vi.resetModules();
  const cache = await import("../src/cache.js");
  const meta = await import("../src/cache-meta.js");
  owned = mkdtempSync(join(tmpdir(), "key-reuse-"));
  vi.stubEnv("VIBECTX_CACHE_DIR", owned); vi.stubEnv("VIBECTX_CACHE_MAX_MB", "0");
  const url = "https://docs.example.test/reference?edition=one";
  cache.writeCache("keyfixture", url, "unchanged real document");
  const path = join(owned, meta.libDirName("keyfixture"), `${meta.urlSlug(url)}.md`);
  vi.mocked(crypto.createHash).mockClear();
  for (let n = 0; n < 100; n++) expect(cache.readCache("keyfixture", url, 168)?.content).toBe("unchanged real document");
  // Body integrity is rehashed on all 100 actual reads; immutable key digests are reusable.
  expect(vi.mocked(crypto.createHash).mock.calls).toHaveLength(100);
  writeFileSync(path, "unchanged real document".replace("unchanged", "different"));
  expect(cache.readCache("keyfixture", url, 168)).toBeUndefined();
  const original = JSON.parse(readFileSync(path.replace(/\.md$/, ".meta.json"), "utf8"));
  writeFileSync(path, "unchanged real document");
  writeFileSync(path.replace(/\.md$/, ".meta.json"), JSON.stringify({ ...original, urlHash: meta.urlHashFor(url + "-other") }));
  expect(cache.readCache("keyfixture", url, 168)).toBeUndefined();
});

it("PAR-1043: reused key digests retain native full-strength raw-input identity and filename suffixes", async () => {
  vi.resetModules();
  const meta = await import("../src/cache-meta.js");
  const native = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  for (const input of ["https://docs.example.test/a?token=first", "https://docs.example.test/a?token=second", "https://docs.example.test/a#one", "https://docs.example.test/a#two", "dotted.name", "dotted-name", "支付-دليل"]) {
    const hash = native.createHash("sha256").update(input, "utf8").digest("hex");
    for (let repeat = 0; repeat < 3; repeat++) {
      expect(meta.urlHashFor(input)).toBe(hash);
      expect(meta.urlHashFor(input)).toHaveLength(64);
      expect(meta.urlSlug(input)).toMatch(new RegExp(`_${hash.slice(0, 12)}$`));
      expect(meta.libDirName(input)).toMatch(new RegExp(`_${hash.slice(0, 12)}$`));
    }
  }
});

it("PAR-1043: immutable key reuse is bounded and never retains an oversized input", async () => {
  vi.resetModules();
  const meta = await import("../src/cache-meta.js");
  const { MAX_REMOTE_URL_LENGTH } = await import("../src/link-policy.js");
  const inputs = Array.from({ length: 129 }, (_, n) => `https://docs.example.test/bound-${n}`);
  for (const input of inputs) meta.urlHashFor(input);
  vi.mocked(crypto.createHash).mockClear();
  meta.urlHashFor(inputs[128]);
  expect(vi.mocked(crypto.createHash).mock.calls).toHaveLength(0);
  meta.urlHashFor(inputs[0]);
  expect(vi.mocked(crypto.createHash).mock.calls).toHaveLength(1);
  const large = "x".repeat(MAX_REMOTE_URL_LENGTH + 1);
  meta.urlHashFor(large); meta.urlHashFor(large);
  expect(vi.mocked(crypto.createHash).mock.calls).toHaveLength(3);
});
