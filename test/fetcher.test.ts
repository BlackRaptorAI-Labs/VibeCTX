import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isAllowedLink,
  getLibraryDoc,
  fetchLinkedPage,
  fetchUrl,
  LINKED_PAGE_MAX_BYTES,
  PRIMARY_DOC_MAX_BYTES,
  MAX_REDIRECT_HOPS,
  FETCH_CONCURRENCY_LIMIT,
} from "../src/fetcher.js";
import { writeCache, readCache } from "../src/cache.js";
import { loadDiscoveredRegistry } from "../src/registry.js";
import { stubPublicDns } from "./helpers/public-dns.js";
import { MAX_REMOTE_URL_LENGTH } from "../src/link-policy.js";

/** A Response whose `url` reports where a redirect chain ended (real fetch sets this; stubs don't). */
function responseAt(finalUrl: string, body: string | null, init: ResponseInit = {}): Response {
  const res = new Response(body, {
    status: 200,
    headers: { "content-type": "text/plain" },
    ...init,
  });
  Object.defineProperty(res, "url", { value: finalUrl });
  return res;
}

/** A Response streamed in fixed-size chunks with no content-length header. */
function streamedResponse(totalBytes: number, chunkBytes = 64 * 1024): Response {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const n = Math.min(chunkBytes, totalBytes - sent);
      controller.enqueue(new Uint8Array(n).fill(0x61)); // 'a'
      sent += n;
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/plain" } });
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "docs-cache-fetch-"));
  process.env.VIBECTX_CACHE_DIR = dir;
  stubPublicDns();
});

afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isAllowedLink (SSRF guard)", () => {
  const source = "https://docs.example.com/llms.txt";

  it("allows same-origin https links", () => {
    expect(isAllowedLink("https://docs.example.com/guide.md", source)).toBe(true);
  });

  it("rejects http links even on the same host", () => {
    expect(isAllowedLink("http://docs.example.com/guide.md", source)).toBe(false);
  });

  it("rejects cross-origin links", () => {
    expect(isAllowedLink("https://evil.example.net/guide.md", source)).toBe(false);
    expect(isAllowedLink("https://169.254.169.254/latest/meta-data", source)).toBe(false);
    expect(isAllowedLink("https://localhost:8080/admin", source)).toBe(false);
  });

  it("rejects unparseable urls", () => {
    expect(isAllowedLink("not a url", source)).toBe(false);
  });

  it("rejects non-http(s) schemes: file:, javascript:, data:", () => {
    for (const link of ["file:///etc/passwd", "javascript:alert(1)", "data:text/plain,x"]) {
      expect(isAllowedLink(link, source), link).toBe(false);
      expect(isAllowedLink(link, source, { allowedHosts: ["*.example.com"] }), link).toBe(false);
    }
  });

  it("rejects userinfo, IPv6 literals and single-label hosts even when passed as the source (PAR-655 additions)", () => {
    expect(isAllowedLink("https://u:p@docs.example.com/x", source)).toBe(false);
    expect(isAllowedLink("https://[::1]/x", source)).toBe(false);
    expect(isAllowedLink("https://[::1]/x", "https://[::1]/llms.txt")).toBe(false);
    expect(isAllowedLink("https://intranet/x", "https://intranet/llms.txt")).toBe(false);
  });
});

describe("fetchLinkedPage origin enforcement", () => {
  it("refuses to fetch a cross-origin link without touching the network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await fetchLinkedPage("lib", "https://attacker.example.net/x.md", "https://docs.example.com/llms.txt");
    expect(result).toEqual({ status: "refused" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses file:, javascript: and data: links without touching the network, policy or not", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const source = "https://docs.example.com/llms.txt";
    for (const link of ["file:///etc/passwd", "javascript:alert(1)", "data:text/plain,x"]) {
      expect(await fetchLinkedPage("lib", link, source), link).toEqual({ status: "refused" });
      expect(await fetchLinkedPage("lib", link, source, 168, false, { allowedHosts: ["*.example.com"] }), link).toEqual({ status: "refused" });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("fetchLinkedPage redirect enforcement (SSRF guard, post-redirect)", () => {
  const source = "https://docs.example.com/llms.txt";
  const link = "https://docs.example.com/guide.md";

  it("refuses a same-origin link whose redirect chain ends cross-origin, without caching the body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responseAt("http://169.254.169.254/latest/meta-data", "SECRET")),
    );
    const result = await fetchLinkedPage("lib", link, source);
    expect(result.status).toBe("refused");
    expect(readCache("lib", link, 999)).toBeUndefined();
  });

  it("refuses a redirect that downgrades to http on the same host", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => responseAt("http://docs.example.com/guide.md", "body")));
    const result = await fetchLinkedPage("lib", link, source);
    expect(result.status).toBe("refused");
    expect(readCache("lib", link, 999)).toBeUndefined();
  });

  it("serves a same-origin redirect to a different path normally", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responseAt("https://docs.example.com/v2/guide.md", "# Moved guide")),
    );
    const result = await fetchLinkedPage("lib", link, source);
    expect(result).toMatchObject({ status: "ok", page: { content: "# Moved guide", url: link } });
    expect(readCache("lib", link, 999)?.content).toBe("# Moved guide");
  });

  it("reports a network failure as unavailable, not refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    const result = await fetchLinkedPage("lib", link, source);
    expect(result.status).toBe("unavailable");
  });

  it("getLibraryDoc still serves a primary URL that redirects across hosts (regression guard)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responseAt("https://platform.claude.com/llms.txt", "# Claude docs")),
    );
    const doc = await getLibraryDoc({ name: "anthropic", urls: ["https://docs.anthropic.com/llms.txt"] });
    expect(doc?.content).toBe("# Claude docs");
  });

  describe("resolved entries: primary URLs are content-derived, so their final URL must be https on a public host (PAR-655)", () => {
    const resolved = {
      name: "evil-pkg",
      urls: ["https://evil-pkg.example.com/llms.txt"],
      resolved: { source: "npm" as const, resolvedAt: "2026-09-06T00:00:00.000Z", metadataUrl: "https://registry.npmjs.org/evil-pkg/latest" },
    };

    it.each([
      "http://169.254.169.254/latest/meta-data",
      "https://169.254.169.254/latest/meta-data",
      "https://localhost/admin",
      "https://[::1]/x",
      "https://intranet/x",
      "http://evil-pkg.example.com/llms.txt",
    ])("refuses a primary whose redirect chain ends at %s and caches nothing", async (final) => {
      vi.stubGlobal("fetch", vi.fn(async () => responseAt(final, "SECRET")));
      expect(await getLibraryDoc(resolved)).toBeUndefined();
      expect(readCache(resolved.name, resolved.urls[0], 999)).toBeUndefined();
    });

    it("still allows a cross-host https redirect to a public host (D-04 preserved)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => responseAt("https://docs.evil-pkg.example.org/llms.txt", "# Docs")));
      expect((await getLibraryDoc(resolved))?.content).toBe("# Docs");
    });

    it("a curated (non-resolved) entry keeps the 0.1.3 behaviour on a cross-host redirect", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => responseAt("https://mirror.example.org/llms.txt", "# Mirror")));
      expect((await getLibraryDoc({ name: "curated", urls: ["https://docs.example.com/llms.txt"] }))?.content).toBe("# Mirror");
    });
  });
});

describe("fetchLinkedPage with an allowed-host policy (PAR-655)", () => {
  const source = "https://docs.example.com/llms.txt";
  const policy = { allowedHosts: ["api.example.com", "*.example.org"] };

  it("fetches a link on an allowed host that the same-origin rule would have refused", async () => {
    const link = "https://api.example.com/v1.md";
    const spy = vi.fn(async () => responseAt(link, "# API v1"));
    vi.stubGlobal("fetch", spy);
    expect(await fetchLinkedPage("lib", link, source)).toEqual({ status: "refused" }); // no policy → 0.1.3 behaviour
    expect(spy).not.toHaveBeenCalled();
    const result = await fetchLinkedPage("lib", link, source, 168, false, policy);
    expect(result).toMatchObject({ status: "ok", page: { content: "# API v1", url: link } });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("still refuses hosts outside the policy, IP literals and http, without fetching", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    for (const bad of [
      "https://evil.example.net/x.md",
      "https://example.org/x.md", // apex is not covered by *.example.org
      "https://169.254.169.254/latest/meta-data",
      "http://api.example.com/v1.md",
      "https://api.example.com:8443/v1.md",
    ]) {
      expect(await fetchLinkedPage("lib", bad, source, 168, false, policy), bad).toEqual({ status: "refused" });
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("post-redirect: a followed link that 302s to an allowed host passes and is cached under the link URL", async () => {
    const link = "https://docs.example.com/guide.md";
    vi.stubGlobal("fetch", vi.fn(async () => responseAt("https://sub.example.org/guide.md", "# Moved to sub")));
    const result = await fetchLinkedPage("lib", link, source, 168, false, policy);
    expect(result).toMatchObject({ status: "ok", page: { content: "# Moved to sub", url: link } });
    expect(readCache("lib", link, 999)?.content).toBe("# Moved to sub");
  });

  it("post-redirect: a followed link that 302s to a host outside the policy is refused and never cached", async () => {
    const link = "https://docs.example.com/guide.md";
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    const escapedTargets = [
      "https://evil.example.net/guide.md",
      "https://example.org/guide.md",
      "https://169.254.169.254/latest/meta-data",
      "https://localhost/admin",
      "http://api.example.com/guide.md",
      "https://api.example.com:8443/guide.md",
      "https://u:p@api.example.com/guide.md",
    ];
    for (const escaped of escapedTargets) {
      vi.stubGlobal("fetch", vi.fn(async () => responseAt(escaped, "SECRET")));
      expect(await fetchLinkedPage("lib", link, source, 168, false, policy, { lookup }), escaped).toEqual({ status: "refused" });
      expect(readCache("lib", link, 999), escaped).toBeUndefined();
    }
    expect(lookup).toHaveBeenCalledTimes(escapedTargets.length);
    expect(lookup.mock.calls.every(([host]) => host === "docs.example.com")).toBe(true);
  });

  it("post-redirect check uses the allowed-host policy, not origin equality: same policy passes an allowed host and refuses a malformed entry both before and after the redirect", async () => {
    const link = "https://docs.example.com/guide.md";
    // Pass case: the redirect lands on a host the policy allows (origin equality would refuse this).
    vi.stubGlobal("fetch", vi.fn(async () => responseAt("https://api.example.com/guide.md", "# On api")));
    expect(await fetchLinkedPage("lib", link, source, 168, false, policy)).toMatchObject({
      status: "ok",
      page: { content: "# On api", url: link },
    });
    // A malformed policy entry never matches, before or after the redirect.
    const broken = { allowedHosts: ["https://api.example.com"] };
    vi.stubGlobal("fetch", vi.fn(async () => responseAt("https://api.example.com/other.md", "SECRET")));
    expect(await fetchLinkedPage("lib", "https://api.example.com/other.md", source, 168, false, broken)).toEqual({ status: "refused" });
    expect(await fetchLinkedPage("lib", "https://docs.example.com/other.md", source, 168, false, broken)).toEqual({ status: "refused" });
    expect(readCache("lib", "https://docs.example.com/other.md", 999)).toBeUndefined();
  });
});

describe("response byte caps", () => {
  const source = "https://docs.example.com/llms.txt";
  const link = "https://docs.example.com/big.md";

  it("rejects a followed page early when Content-Length exceeds the linked-page cap", async () => {
    const spy = vi.fn(async () =>
      responseAt(link, "small body", {
        headers: { "content-type": "text/plain", "content-length": String(LINKED_PAGE_MAX_BYTES + 1) },
      }),
    );
    vi.stubGlobal("fetch", spy);
    const result = await fetchLinkedPage("lib", link, source);
    expect(result.status).toBe("too-large");
    expect(readCache("lib", link, 999)).toBeUndefined();
  });

  it("stops reading a streamed followed page once the linked-page cap is exceeded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamedResponse(LINKED_PAGE_MAX_BYTES + 64 * 1024)));
    const result = await fetchLinkedPage("lib", link, source);
    expect(result.status).toBe("too-large");
    expect(readCache("lib", link, 999)).toBeUndefined();
  });

  it("serves a streamed followed page that is exactly at the cap", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamedResponse(LINKED_PAGE_MAX_BYTES)));
    const result = await fetchLinkedPage("lib", link, source);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.page.content.length).toBe(LINKED_PAGE_MAX_BYTES);
  });

  it("primary documents use the larger cap: a body above the linked cap is still served", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamedResponse(LINKED_PAGE_MAX_BYTES + 64 * 1024)));
    const doc = await getLibraryDoc({ name: "big-lib", urls: ["https://docs.example.com/llms-full.txt"] });
    expect(doc?.content.length).toBe(LINKED_PAGE_MAX_BYTES + 64 * 1024);
  });

  it("primary documents are rejected above their own cap via Content-Length", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        responseAt("https://docs.example.com/llms-full.txt", "small", {
          headers: { "content-type": "text/plain", "content-length": String(PRIMARY_DOC_MAX_BYTES + 1) },
        }),
      ),
    );
    const doc = await getLibraryDoc({ name: "huge-lib", urls: ["https://docs.example.com/llms-full.txt"] });
    expect(doc).toBeUndefined();
  });

  it("primary documents are rejected above their own cap when streamed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamedResponse(PRIMARY_DOC_MAX_BYTES + 64 * 1024, 1024 * 1024)));
    const doc = await getLibraryDoc({ name: "huge-lib", urls: ["https://docs.example.com/llms-full.txt"] });
    expect(doc).toBeUndefined();
  });
});

describe("offline option (cache-only; PAR-707 doctor --offline)", () => {
  const source = "https://docs.example.com/llms.txt";
  const link = "https://docs.example.com/guide.md";

  it("getLibraryDoc serves a fresh cache hit and never calls fetch", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    writeCache("off-lib", source, "# Cached");
    const doc = await getLibraryDoc({ name: "off-lib", urls: [source] }, { offline: true });
    expect(doc).toMatchObject({ content: "# Cached", url: source, stale: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it("getLibraryDoc serves a stale cache hit flagged as offline, without calling fetch", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    writeCache("off-lib", source, "# Old");
    const doc = await getLibraryDoc({ name: "off-lib", urls: [source], ttlHours: 0 }, { offline: true });
    expect(doc?.content).toBe("# Old");
    expect(doc?.staleNote).toMatch(/^STALE: .*offline/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("getLibraryDoc returns undefined when nothing is cached, without calling fetch", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const doc = await getLibraryDoc({ name: "off-lib", urls: [source, link] }, { offline: true });
    expect(doc).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it("fetchLinkedPage serves cached pages (fresh or stale) and reports the rest unavailable, never fetching", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    writeCache("off-lib", link, "# Guide");
    expect(await fetchLinkedPage("off-lib", link, source, 168, true)).toMatchObject({
      status: "ok",
      page: { content: "# Guide", url: link, stale: false },
    });
    const stale = await fetchLinkedPage("off-lib", link, source, 0, true);
    expect(stale.status).toBe("ok");
    if (stale.status === "ok") expect(stale.page.staleNote).toMatch(/^STALE:/);
    expect(await fetchLinkedPage("off-lib", "https://docs.example.com/other.md", source, 168, true)).toEqual({
      status: "unavailable",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("fetchLinkedPage still refuses cross-origin links offline (guard runs before the cache)", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const result = await fetchLinkedPage("off-lib", "https://evil.example.net/x.md", source, 168, true);
    expect(result).toEqual({ status: "refused" });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("DocResult.fetchedAt / .stale (A17/PAR-726): every return path states when the document was fetched and whether it is past TTL, not just the staleNote prose", () => {
  const source = "https://docs.example.com/llms.txt";
  const link = "https://docs.example.com/guide.md";

  it("getLibraryDoc, fresh cache hit: fetchedAt is the cache meta's own value, stale is false", async () => {
    writeCache("fresh-lib", source, "# Fresh");
    const before = readCache("fresh-lib", source, 999)!.meta.fetchedAt;
    const doc = await getLibraryDoc({ name: "fresh-lib", urls: [source] });
    expect(doc).toMatchObject({ fetchedAt: before, stale: false });
    expect(doc?.staleNote).toBeUndefined();
  });

  it("getLibraryDoc, fresh network fetch: fetchedAt is exactly what writeCache persisted, not a second, separately-taken timestamp", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => responseAt(source, "# New")));
    const doc = await getLibraryDoc({ name: "new-lib", urls: [source] });
    const persisted = readCache("new-lib", source, 999)!.meta.fetchedAt;
    expect(doc).toMatchObject({ fetchedAt: persisted, stale: false });
  });

  it("getLibraryDoc, 304 revalidation: fetchedAt is the touched (refreshed) value, not the pre-revalidation one", async () => {
    writeCache("touch-lib", source, "# Cached", '"etag1"');
    const before = readCache("touch-lib", source, 999)!.meta.fetchedAt;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 304 })));
    await new Promise((r) => setTimeout(r, 5));
    const doc = await getLibraryDoc({ name: "touch-lib", urls: [source], ttlHours: 0 });
    expect(doc?.stale).toBe(false);
    expect(doc?.fetchedAt).not.toBe(before);
    expect(doc?.fetchedAt).toBe(readCache("touch-lib", source, 999)!.meta.fetchedAt);
  });

  it("getLibraryDoc, stale fallback (network down): fetchedAt is the stale cache's own meta value, stale is true", async () => {
    writeCache("stale-lib", source, "# Old");
    const before = readCache("stale-lib", source, 999)!.meta.fetchedAt;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    const doc = await getLibraryDoc({ name: "stale-lib", urls: [source], ttlHours: 0 });
    expect(doc).toMatchObject({ fetchedAt: before, stale: true });
    expect(doc?.staleNote).toMatch(/^STALE:/);
  });

  it("fetchLinkedPage: the same four cases carry the same fetchedAt/stale contract as getLibraryDoc", async () => {
    writeCache("page-lib", link, "# Guide");
    const before = readCache("page-lib", link, 999)!.meta.fetchedAt;
    const fresh = await fetchLinkedPage("page-lib", link, source, 999);
    if (fresh.status === "ok") expect(fresh.page).toMatchObject({ fetchedAt: before, stale: false });
    else expect.unreachable();

    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    const stale = await fetchLinkedPage("page-lib", link, source, 0);
    if (stale.status === "ok") expect(stale.page).toMatchObject({ fetchedAt: before, stale: true });
    else expect.unreachable();
  });
});

describe("PAR-776 (D-74) — DocResult.finalUrl", () => {
  const source = "https://docs.example.com/llms.txt";
  const link = "https://docs.example.com/guide.md";

  it("getLibraryDoc, fresh network fetch with no redirect: finalUrl equals the candidate url", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => responseAt(source, "# Doc")));
    const doc = await getLibraryDoc({ name: "no-redirect-lib", urls: [source] });
    expect(doc).toMatchObject({ url: source, finalUrl: source });
  });

  it("getLibraryDoc, fresh network fetch that redirects: finalUrl is the redirect target, url stays the candidate", async () => {
    const final = "https://final.example.com/llms.txt";
    vi.stubGlobal("fetch", vi.fn(async () => responseAt(final, "# Doc")));
    const doc = await getLibraryDoc({ name: "redirect-lib", urls: [source] });
    expect(doc).toMatchObject({ url: source, finalUrl: final });
    // Persisted, not just returned live — the whole point is a later cache-hit still knows it.
    expect(readCache("redirect-lib", source, 999)?.meta.finalUrl).toBe(final);
  });

  it("getLibraryDoc, fresh cache hit (no network call at all): finalUrl comes from the persisted meta, not just the candidate url", async () => {
    const final = "https://final.example.com/llms.txt";
    writeCache("cached-redirect-lib", source, "# Doc", undefined, final);
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const doc = await getLibraryDoc({ name: "cached-redirect-lib", urls: [source] });
    expect(spy).not.toHaveBeenCalled();
    expect(doc).toMatchObject({ url: source, finalUrl: final });
  });

  it("getLibraryDoc, 304 revalidation that still redirects: finalUrl is (re)computed from the redirect actually followed, not left stale", async () => {
    // A real revalidation re-requests the CANDIDATE url every time, so a site that keeps
    // redirecting keeps redirecting on revalidation too — the hop loop lands on `final`
    // before the 304 is ever seen, exactly as it did on the original fetch.
    const final = "https://final.example.com/llms.txt";
    writeCache("touch-redirect-lib", source, "# Doc", '"etag1"', final);
    const fetchSpy = vi.fn(async (input: unknown) => {
      if (String(input) === source) return new Response(null, { status: 301, headers: { location: final } });
      return new Response(null, { status: 304 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const doc = await getLibraryDoc({ name: "touch-redirect-lib", urls: [source], ttlHours: 0 });
    expect(doc).toMatchObject({ finalUrl: final });
    expect(readCache("touch-redirect-lib", source, 999)?.meta.finalUrl).toBe(final);
  });

  it("getLibraryDoc, stale fallback (network down): finalUrl comes from the stale cache's own meta", async () => {
    const final = "https://final.example.com/llms.txt";
    writeCache("stale-redirect-lib", source, "# Doc", undefined, final);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    const doc = await getLibraryDoc({ name: "stale-redirect-lib", urls: [source], ttlHours: 0 });
    expect(doc).toMatchObject({ stale: true, finalUrl: final });
  });

  it("fetchLinkedPage: a redirecting followed link reports its own finalUrl the same way", async () => {
    // Same-origin as `source` (the same-origin rule always allows it) — a cross-host redirect
    // additionally needing an allowed-host policy match is covered in the host-policy suite.
    const final = "https://docs.example.com/redirected-guide.md";
    vi.stubGlobal("fetch", vi.fn(async () => responseAt(final, "# Guide")));
    const result = await fetchLinkedPage("page-redirect-lib", link, source, 999);
    expect(result).toMatchObject({ status: "ok", page: { url: link, finalUrl: final } });
  });

  it("fetchLinkedPage: no redirect — finalUrl equals the link url", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => responseAt(link, "# Guide")));
    const result = await fetchLinkedPage("page-no-redirect-lib", link, source, 999);
    expect(result).toMatchObject({ status: "ok", page: { url: link, finalUrl: link } });
  });
});

describe("etag revalidation", () => {
  const entry = {
    name: "revalidate-lib",
    urls: ["https://docs.example.com/llms-full.txt"],
    ttlHours: 0, // instantly stale → every read revalidates
  };

  it("sends If-None-Match and serves cache on 304 without re-downloading", async () => {
    writeCache(entry.name, entry.urls[0], "# Cached content", '"abc123"');
    const fetchSpy = vi.fn(async (_url: unknown, init: any) => {
      expect(init.headers["if-none-match"]).toBe('"abc123"');
      return new Response(null, { status: 304 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const before = readCache(entry.name, entry.urls[0], 999)!.meta.fetchedAt;
    await new Promise((r) => setTimeout(r, 5));
    const doc = await getLibraryDoc(entry);

    expect(doc?.content).toBe("# Cached content");
    expect(doc?.staleNote).toBeUndefined();
    // PAR-744 — the field `refresh.ts` now uses to distinguish a 304 (nothing to drop) from a
    // genuine fresh fetch: a byte-identical revalidation must say so, not look like a change.
    expect(doc?.notModified).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // 304 must refresh the TTL clock (touchCache)
    const after = readCache(entry.name, entry.urls[0], 999)!.meta.fetchedAt;
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  it("stores the new etag on a 200 refresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("# Fresh content", {
          status: 200,
          headers: { etag: '"v2"', "content-type": "text/plain" },
        }),
      ),
    );
    const doc = await getLibraryDoc(entry);
    expect(doc?.content).toBe("# Fresh content");
    // PAR-744 — a genuine fresh fetch (a real 200, not a revalidation) must NOT be mistaken
    // for a 304: the field is absent, not false, matching every other optional DocResult flag.
    expect(doc?.notModified).toBeUndefined();
    expect(readCache(entry.name, entry.urls[0], 999)?.meta.etag).toBe('"v2"');
  });

  /** PAR-744 — `fetchLinkedPage` gets the same `notModified` flag `getLibraryDoc` does, for
   *  the same reason: a followed page revalidated via 304 is not a page that changed. */
  it("fetchLinkedPage: a 304 revalidation sets notModified on the returned page, a fresh 200 does not", async () => {
    const source = "https://docs.example.com/llms.txt";
    const link = "https://docs.example.com/guide.md";
    writeCache("linked-lib", link, "# Cached guide", '"etag-1"');
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 304 })));
    const revalidated = await fetchLinkedPage("linked-lib", link, source, 0);
    expect(revalidated).toMatchObject({ status: "ok", page: { content: "# Cached guide", url: link, stale: false, notModified: true } });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("# New guide", { status: 200, headers: { "content-type": "text/plain" } })),
    );
    const fresh = await fetchLinkedPage("linked-lib", link, source, 0);
    expect(fresh).toMatchObject({ status: "ok", page: { content: "# New guide", url: link, stale: false } });
    if (fresh.status === "ok") expect(fresh.page.notModified).toBeUndefined(); // absent, not false
  });
});

describe("hop-by-hop redirects (S1): every Location is checked BEFORE it is requested", () => {
  const source = "https://docs.example.com/llms.txt";
  const link = "https://docs.example.com/guide.md";
  const policy = { allowedHosts: ["*.example.org"] };
  const resolvedMeta = { source: "npm" as const, resolvedAt: "2026-09-06T00:00:00.000Z", metadataUrl: "https://registry.npmjs.org/evil/latest" };
  let server: Server;
  let listenerHits: string[];
  let port: number;
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    listenerHits = [];
    server = createServer((req, res) => {
      listenerHits.push(`${req.method} ${req.url}`);
      if (req.url === "/start") {
        res.writeHead(302, { location: "/admin/reboot?x=1" });
        res.end();
        return;
      }
      res.end("SECRET");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

  /** Stub: the https origin answers from `routes` (a string is a 200 body, a Response is returned as is);
   *  anything else goes to the REAL fetch — so a followed hop to the listener is observable. */
  function stubOrigin(routes: Record<string, string | Response | (() => Response)>) {
    const spy = vi.fn(async (url: unknown, init?: RequestInit) => {
      const r = routes[String(url)];
      if (r === undefined) return realFetch(url as string, init);
      if (typeof r === "string") return new Response(r, { status: 200, headers: { "content-type": "text/plain" } });
      return typeof r === "function" ? r() : r;
    });
    vi.stubGlobal("fetch", spy);
    return spy;
  }

  it("linkGuard path: a 302 to http://127.0.0.1:<port> produces ZERO requests at the listener and is refused", async () => {
    const spy = stubOrigin({ [link]: () => redirect(`http://127.0.0.1:${port}/admin/reboot?x=1`) });
    expect(await fetchLinkedPage("lib", link, source, 168, false, policy)).toEqual({ status: "refused" });
    expect(listenerHits).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(readCache("lib", link, 999)).toBeUndefined();
  });

  it("publicFinalUrl path (resolved primary): a 302 to the listener produces ZERO requests and nothing is served or cached", async () => {
    const primary = "https://evil-pkg.example.com/llms.txt";
    for (const target of [`http://127.0.0.1:${port}/admin/reboot?x=1`, `https://127.0.0.1:${port}/x`, `https://localhost:${port}/x`]) {
      const spy = stubOrigin({ [primary]: () => redirect(target) });
      expect(await getLibraryDoc({ name: "evil", urls: [primary], resolved: resolvedMeta }), target).toBeUndefined();
      expect(listenerHits, target).toEqual([]);
      expect(spy, target).toHaveBeenCalledTimes(1);
    }
    expect(readCache("evil", primary, 999)).toBeUndefined();
  });

  it("curated primary (no guard, D-04): cross-host https redirects are followed, but never to http / an IP / localhost", async () => {
    stubOrigin({
      "https://docs.example.com/llms.txt": () => redirect("https://platform.example.org/llms.txt"),
      "https://platform.example.org/llms.txt": "# Moved docs",
    });
    expect((await getLibraryDoc({ name: "curated", urls: ["https://docs.example.com/llms.txt"] }))?.content).toBe("# Moved docs");
    stubOrigin({ "https://docs.example.com/llms.txt": () => redirect(`http://127.0.0.1:${port}/admin/reboot?x=1`) });
    expect(await getLibraryDoc({ name: "curated2", urls: ["https://docs.example.com/llms.txt"] })).toBeUndefined();
    expect(listenerHits).toEqual([]);
  });

  /** PAR-851 — this test's own behaviour moved. Before PAR-851, a CURATED entry's primary URL
   *  had no resolved-address preflight at fetch time: the operator-
   *  configured first request WAS made even to a literal loopback address, and only the
   *  REDIRECT hop was refused (`hopAllowed` is unconditional; it does not distinguish a
   *  curated primary from any other URL). `loopbackLookup` makes the curated call take the
   *  real PAR-851 resolved-address refusal path: a curated primary has `publicFinalUrl: false`,
   *  so `fetchUrl` rejects its 127.0.0.1 result before `fetch`. A resolved entry has
   *  `publicFinalUrl: true`, so its http literal is refused by `isPublicHttpsUrl` before the
   *  lookup. In both cases `listenerHits` proves no connection was made. See
   *  `test/address-policy.test.ts` and the `allowInternalHosts` regression test below for the
   *  case this does NOT refuse. */
  it("a real listener at a loopback address: the primary is refused before any connection, curated or resolved alike", async () => {
    vi.stubGlobal("fetch", realFetch);
    const start = `http://127.0.0.1:${port}/start`;
    const loopbackLookup = async () => [{ address: "127.0.0.1", family: 4 }];
    expect(await getLibraryDoc({ name: "cur-local", urls: [start] }, { lookup: loopbackLookup })).toBeUndefined();
    expect(listenerHits).toEqual([]); // refused before any connection — not merely before the /admin/reboot hop
    expect(await getLibraryDoc({ name: "res-local", urls: [start], resolved: resolvedMeta }, { lookup: loopbackLookup })).toBeUndefined();
    expect(listenerHits).toEqual([]);
  });

  it("PAR-1038: curated loopback primary is refused by the resolved-address policy", async () => {
    vi.stubGlobal("fetch", realFetch);
    const start = `http://127.0.0.1:${port}/start`;
    const lookup = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]);
    expect(await getLibraryDoc({ name: "curated-loopback-policy", urls: [start] }, { lookup })).toBeUndefined();
    expect(lookup).toHaveBeenCalled();
    expect(listenerHits).toEqual([]);
  });

  it("PAR-1038: resolved loopback primary is refused by public URL policy before address lookup", async () => {
    vi.stubGlobal("fetch", realFetch);
    const start = `http://127.0.0.1:${port}/start`;
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    // Positive control: the same real listener is reachable when only the curated
    // first-hop address policy applies. The redirect is still refused.
    expect(await getLibraryDoc({ name: "curated-public-lookup-control", urls: [start] }, { lookup })).toBeUndefined();
    expect(lookup).toHaveBeenCalled();
    expect(listenerHits).toEqual(["GET /start"]);
    lookup.mockClear(); listenerHits = [];
    expect(await getLibraryDoc({ name: "resolved-loopback-policy", urls: [start], resolved: resolvedMeta }, { lookup })).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
    expect(listenerHits).toEqual([]);
  });

  it("a 302 to an allowed https host is followed; relative Locations resolve against the current URL; the page is cached under the link URL", async () => {
    const spy = stubOrigin({
      [link]: () => redirect("https://sub.example.org/v2/guide.md"),
      "https://sub.example.org/v2/guide.md": () => redirect("../v3/guide.md"),
      "https://sub.example.org/v3/guide.md": "# Guide v3",
    });
    expect(await fetchLinkedPage("lib", link, source, 168, false, policy)).toMatchObject({ status: "ok", page: { content: "# Guide v3", url: link } });
    expect(spy.mock.calls.map((c) => String(c[0]))).toEqual([link, "https://sub.example.org/v2/guide.md", "https://sub.example.org/v3/guide.md"]);
    expect(readCache("lib", link, 999)?.content).toBe("# Guide v3");
  });

  it("a hop to a disallowed host in the MIDDLE of a chain is refused before it is requested", async () => {
    const spy = stubOrigin({
      [link]: () => redirect("https://sub.example.org/a.md"),
      "https://sub.example.org/a.md": () => redirect("https://evil.example.net/b.md"),
      "https://evil.example.net/b.md": "SECRET",
    });
    expect(await fetchLinkedPage("lib", link, source, 168, false, policy)).toEqual({ status: "refused" });
    expect(spy.mock.calls.map((c) => String(c[0]))).not.toContain("https://evil.example.net/b.md");
  });

  it(`more than ${MAX_REDIRECT_HOPS} hops is a miss, and the next hop is not requested`, async () => {
    const routes: Record<string, () => Response> = {};
    routes[link] = () => redirect("https://docs.example.com/r1.md");
    for (let i = 1; i <= MAX_REDIRECT_HOPS + 2; i++) routes[`https://docs.example.com/r${i}.md`] = () => redirect(`https://docs.example.com/r${i + 1}.md`);
    const spy = stubOrigin(routes);
    expect(await fetchLinkedPage("lib", link, source, 168, false, policy)).toEqual({ status: "unavailable" });
    expect(spy).toHaveBeenCalledTimes(1 + MAX_REDIRECT_HOPS);
    expect(MAX_REDIRECT_HOPS).toBe(5);
  });

  it("a 3xx without a Location, or with an unparseable one, is a miss and nothing further is requested", async () => {
    let spy = stubOrigin({ [link]: () => new Response(null, { status: 302 }) });
    expect(await fetchLinkedPage("lib", link, source, 168, false, policy)).toEqual({ status: "unavailable" });
    expect(spy).toHaveBeenCalledTimes(1);
    spy = stubOrigin({ [link]: () => redirect("http://[::1") });
    expect(await fetchLinkedPage("lib", link, source, 168, false, policy)).toEqual({ status: "unavailable" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("the existing final-URL check still applies when the runtime reports a different res.url", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => responseAt("http://169.254.169.254/latest/meta-data", "SECRET")));
    expect(await fetchLinkedPage("lib", link, source, 168, false, policy)).toEqual({ status: "refused" });
  });

  it("R1: trailing-dot hosts (localhost., x.internal., x.local., foo.) are refused as redirect targets on the publicFinalUrl path", async () => {
    const primary = "https://evil-pkg.example.com/llms.txt";
    for (const host of ["localhost.", "x.internal.", "x.local.", "foo."]) {
      const spy = stubOrigin({ [primary]: () => redirect(`https://${host}/x`) });
      expect(await getLibraryDoc({ name: "evil", urls: [primary], resolved: resolvedMeta }), host).toBeUndefined();
      expect(spy, host).toHaveBeenCalledTimes(1);
    }
  });

  /** security-architect, PAR-776 round 1, N-3: `isPublicHttpsUrl` is the redirect path's own
   *  gate (`hopAllowed`), and was the one URL-trust check in this codebase that didn't reject
   *  userinfo — unlike `sanitizeRemoteUrl`, `validateLibraryUrl` and `isAllowedLink`. Matters
   *  more since PAR-776: a redirect target carrying `user:pass@` used to be accepted, then
   *  PERSISTED (`cache.ts`'s `finalUrl`) and RENDERED (the `Source:` stamp) — not just used and
   *  discarded the way it was before `finalUrl` existed. */
  it("(security-architect, PAR-776 round 1, N-3) a redirect target carrying userinfo is refused, not silently accepted", async () => {
    const primary = "https://evil-pkg.example.com/llms.txt";
    const spy = stubOrigin({ [primary]: () => redirect("https://user:pass@docs.example.com/x") });
    expect(await getLibraryDoc({ name: "evil", urls: [primary], resolved: resolvedMeta })).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("fetchUrl — httpStatus (A16/PAR-725)", () => {
  it("carries the real HTTP status on an ordinary 404 (the 'http-status' miss reason)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    const out = await fetchUrl("https://registry.npmjs.org/does-not-exist/latest", { maxBytes: 1024, publicFinalUrl: true });
    expect(out).toEqual({ status: "miss", httpStatus: 404 });
  });

  it("carries a non-404 status too (500) — the caller decides which codes mean 'does not exist'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const out = await fetchUrl("https://registry.npmjs.org/x/latest", { maxBytes: 1024, publicFinalUrl: true });
    expect(out).toEqual({ status: "miss", httpStatus: 500 });
  });

  it("leaves httpStatus undefined for every OTHER miss reason — a thrown network error carries no real status to report", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const out = await fetchUrl("https://registry.npmjs.org/x/latest", { maxBytes: 1024, publicFinalUrl: true });
    expect(out.status).toBe("miss");
    expect(out.httpStatus).toBeUndefined();
  });

  it("leaves httpStatus undefined on refused (never reached the network) and on ok", async () => {
    const refused = await fetchUrl("http://insecure.example.com/x", { maxBytes: 1024, publicFinalUrl: true });
    expect(refused).toEqual({ status: "refused" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("# ok", { status: 200, headers: { "content-type": "text/plain" } })));
    const ok = await fetchUrl("https://registry.npmjs.org/x/latest", { maxBytes: 1024, publicFinalUrl: true });
    expect(ok.httpStatus).toBeUndefined();
  });
});

/** PAR-832a — real-site shapes found in the PAR-832 investigation, reproduced as fixtures:
 *  hono.dev/motion.dev/nextjs.org's non-tutorial pages negotiate `Accept` correctly.
 *  ui.shadcn.com and nextjs.org's `/learn/*` tutorial pages do not (Accept-negotiation alone
 *  reports `unavailable` for those) — see the PAR-838 `.md`-suffix retry describe block below,
 *  which is what actually closes ui.shadcn.com's shape (D-82 in docs/decisions.md has the full
 *  account of the deferral and the rebuild). */
describe("fetchLinkedPage content negotiation via Accept (PAR-832a)", () => {
  const source = "https://docs.example.com/llms.txt";
  const html = (body = "<!doctype html><html><body>rendered page</body></html>") =>
    new Response(body, { status: 200, headers: { "content-type": "text/html" } });
  const markdown = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/markdown" } });

  it("hono/motion/next.js-docs shape: the site honours Accept, so the request succeeds in one fetch", async () => {
    const link = "https://docs.example.com/guide/middleware";
    const spy = vi.fn(async (url: unknown, init?: RequestInit) => {
      const accept = (init?.headers as Record<string, string> | undefined)?.["accept"];
      return accept?.includes("text/markdown") ? markdown("# Middleware\n\nUse app.use().") : html();
    });
    vi.stubGlobal("fetch", spy);
    const result = await fetchLinkedPage("lib", link, source);
    expect(result).toMatchObject({ status: "ok", page: { content: "# Middleware\n\nUse app.use().", url: link } });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(readCache("lib", link, 999)?.content).toBe("# Middleware\n\nUse app.use().");
    // The actual request carried the negotiated Accept header — pins the behavior, not just
    // the outcome (a spy that ignored `init` entirely could not tell a real negotiation from
    // a coincidence).
    const [, init] = spy.mock.calls[0];
    expect((init?.headers as Record<string, string> | undefined)?.["accept"]).toBe(
      "text/markdown, text/plain;q=0.9, */*;q=0.1",
    );
  });

  it("shadcn/next.js-learn shape: Accept is ignored on the plain path, but the .md retry succeeds", async () => {
    const link = "https://docs.example.com/components/button";
    const spy = vi.fn(async (url: unknown) => (String(url).endsWith(".md") ? markdown("# Button\n\nUse <Button />.") : html()));
    vi.stubGlobal("fetch", spy);
    const result = await fetchLinkedPage("lib", link, source);
    expect(result).toMatchObject({ status: "ok", page: { content: "# Button\n\nUse <Button />.", url: `${link}.md` } });
    expect(spy).toHaveBeenCalledTimes(2); // the original attempt, then exactly one .md retry
    expect(readCache("lib", `${link}.md`, 999)?.content).toBe("# Button\n\nUse <Button />.");
  });

  /**
   * Blocking #3 (review round 2, security-architect — independently reproduced live by the
   * coordinator with the actual `doctor --library shadcn --json` then `--offline --json`
   * sequence: online warm gave `followed: 5, dropped: 0, healthy: true`; the SAME cache offline
   * gave `followed: 0, dropped: 5, healthy: false`). This test exercises the REAL,
   * un-mocked `fetchLinkedPage` — the same stubbed-`fetch` convention every other test in this
   * file already uses, not a `vi.mock` of the function under test — through the exact
   * online-then-offline sequence the coordinator ran: content that only the `.md` retry
   * successfully fetches must be found OFFLINE too, from the SAME cache directory, with no
   * further network access at all.
   */
  it("Blocking #3: content that only the .md retry fetches online is found OFFLINE too, from the same cache — the real online-then-offline sequence", async () => {
    const link = "https://docs.example.com/components/button";
    const onlineSpy = vi.fn(async (url: unknown) => (String(url).endsWith(".md") ? markdown("# Button\n\nUse <Button />.") : html()));
    vi.stubGlobal("fetch", onlineSpy);
    // Step 1 — warm ONLINE, exactly like `doctor --library shadcn --json` (no --offline).
    const online = await fetchLinkedPage("lib", link, source);
    expect(online).toMatchObject({ status: "ok", page: { content: "# Button\n\nUse <Button />.", url: `${link}.md` } });
    // Step 2 — the ORIGINAL url's own cache entry never exists (its own fetch never succeeds —
    // that is the whole reason the retry exists); only the retry's does. This is the root cause
    // Blocking #3 named: an offline read that only ever consulted `link`'s own entry would
    // always miss.
    expect(readCache("lib", link, 999)).toBeUndefined();
    expect(readCache("lib", `${link}.md`, 999)?.content).toBe("# Button\n\nUse <Button />.");
    // Step 3 — OFFLINE, from the SAME cache, no network at all: a fetch call here would be the
    // test failing for the wrong reason, so it throws rather than silently answering.
    const offlineSpy = vi.fn(async () => {
      throw new Error("Blocking #3 regression: offline mode must never touch the network");
    });
    vi.stubGlobal("fetch", offlineSpy);
    const offline = await fetchLinkedPage("lib", link, source, 999, true);
    expect(offlineSpy).not.toHaveBeenCalled();
    expect(offline).toMatchObject({ status: "ok", page: { content: "# Button\n\nUse <Button />.", url: `${link}.md`, stale: false } });
  });

  it("a site that is HTML everywhere, even at the .md path, is unavailable after exactly the original attempt plus one retry", async () => {
    const link = "https://docs.example.com/components/nowhere";
    const spy = vi.fn(async () => html());
    vi.stubGlobal("fetch", spy);
    const result = await fetchLinkedPage("lib", link, source);
    expect(result).toEqual({ status: "unavailable", reason: "html-response" });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(readCache("lib", link, 999)).toBeUndefined();
    expect(readCache("lib", `${link}.md`, 999)).toBeUndefined();
  });

  it("a followed link's primary-document counterpart (getLibraryDoc) never sends Accept — the scope is followed links only", async () => {
    const spy = vi.fn(async () => html());
    vi.stubGlobal("fetch", spy);
    const entry = { name: "lib", urls: ["https://docs.example.com/llms.txt"] };
    const doc = await getLibraryDoc(entry);
    // An HTML response on the PRIMARY path is (unchanged by this item) still a plain miss —
    // no candidate URL left, no cache, so the call returns undefined. What this test pins is
    // the REQUEST: exactly one, and it carries no `accept` header.
    expect(doc).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    const [, init] = spy.mock.calls[0];
    expect((init?.headers as Record<string, string> | undefined)?.["accept"]).toBeUndefined();
  });
});

/**
 * PAR-838 — the standing-stop-rule fixtures. This is the literal proof the `.md`-suffix retry
 * is BOUNDED: a followed link carrying a query string or a fragment, against an origin that
 * answers EVERY path (including the synthesized `.md` one) with HTML, must make EXACTLY TWO
 * requests — the original attempt, then exactly one retry — and report `unavailable`, never
 * loop. The rejected prior submission inferred "is this the retry" from `url.endsWith(".md")`
 * on the WHOLE href, which never matches once a `?query` or `#fragment` follows the mutated
 * pathname, so the guard never fired and the request count was unbounded. These two tests are
 * the ones both prior reviews (code-reviewer, security-architect) named as mandatory, not
 * optional; see this file's own mutation-test note directly below them.
 */
describe("PAR-838 — .md-suffix retry is bounded even when the followed link carries a query string or fragment", () => {
  const source = "https://docs.example.com/llms.txt";
  const alwaysHtml = () => new Response("<!doctype html><html><body>always html, every path</body></html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });

  it("a link with a ?query string: exactly two requests, then unavailable — never an unbounded retry loop", async () => {
    const link = "https://docs.example.com/guide?v=1";
    const spy = vi.fn(async () => alwaysHtml());
    vi.stubGlobal("fetch", spy);
    const result = await fetchLinkedPage("lib", link, source);
    expect(result).toEqual({ status: "unavailable", reason: "html-response" });
    expect(spy).toHaveBeenCalledTimes(2);
    // Pin WHERE the retry landed, not just the count: pathname gets `.md`, the query survives.
    expect(String(spy.mock.calls[1][0])).toBe("https://docs.example.com/guide.md?v=1");
  });

  it("a link with a #fragment: exactly two requests, then unavailable — never an unbounded retry loop", async () => {
    const link = "https://docs.example.com/guide#install";
    const spy = vi.fn(async () => alwaysHtml());
    vi.stubGlobal("fetch", spy);
    const result = await fetchLinkedPage("lib", link, source);
    expect(result).toEqual({ status: "unavailable", reason: "html-response" });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(String(spy.mock.calls[1][0])).toBe("https://docs.example.com/guide.md#install");
  });

  it("does not drop the ORIGINAL url's own stale-cache fallback when the retry also fails (compounding defect #2)", async () => {
    const link = "https://docs.example.com/guide?v=1";
    writeCache("stale-retry-lib", link, "# Old cached guide");
    const before = readCache("stale-retry-lib", link, 999)!.meta.fetchedAt;
    const spy = vi.fn(async () => alwaysHtml());
    vi.stubGlobal("fetch", spy);
    // ttlHours: 0 forces past-TTL so the fresh-cache-hit short-circuit at the top of
    // fetchLinkedPage does not fire and the network path (then the retry, then the fallback)
    // actually runs.
    const result = await fetchLinkedPage("stale-retry-lib", link, source, 0);
    expect(spy).toHaveBeenCalledTimes(2);
    if (result.status === "ok") {
      expect(result.page).toMatchObject({ content: "# Old cached guide", url: link, stale: true, fetchedAt: before });
      expect(result.page.staleNote).toMatch(/^STALE:/);
    } else {
      expect.unreachable(`expected the original url's stale cache to be served, got ${JSON.stringify(result)}`);
    }
  });

  // review round 2, security-architect S3 — the exact test that would have caught Blocking #2's
  // mis-stated worst-case bound directly: a followed link whose ENTIRE redirect chain is itself
  // redirects (never resolves) exercises BOTH attempts' own full `MAX_REDIRECT_HOPS` chain, not
  // just "two attempts" — total requests is 2 x (1 + MAX_REDIRECT_HOPS), not 2.
  it("a link whose entire redirect chain is redirects (never resolves): total requests stay bounded at 2 x (1 + MAX_REDIRECT_HOPS), matching the corrected worst-case bound, never unbounded", async () => {
    const link = "https://docs.example.com/guide";
    const retryLink = "https://docs.example.com/guide.md";
    const routes: Record<string, string> = {};
    // Two independent, same-shaped redirect chains — one for the original url, one for the
    // `.md` retry — each long enough to exhaust MAX_REDIRECT_HOPS on its own.
    for (const base of [link, retryLink]) {
      routes[base] = `${base}?hop=1`;
      for (let i = 1; i <= MAX_REDIRECT_HOPS + 2; i++) routes[`${base}?hop=${i}`] = `${base}?hop=${i + 1}`;
    }
    const spy = vi.fn(async (url: unknown) => {
      const location = routes[String(url)];
      return new Response(null, { status: 302, headers: { location } });
    });
    vi.stubGlobal("fetch", spy);
    const result = await fetchLinkedPage("lib", link, source);
    expect(result).toEqual({ status: "unavailable" });
    // Exactly 2 x (1 + MAX_REDIRECT_HOPS) = 12 at MAX_REDIRECT_HOPS=5 — the CORRECTED bound
    // (review round 2, Blocking #2), not the "2 requests total" the original, mis-stated
    // comment would have implied.
    expect(spy).toHaveBeenCalledTimes(2 * (1 + MAX_REDIRECT_HOPS));
    expect(MAX_REDIRECT_HOPS).toBe(5); // pins the constant this arithmetic depends on
  });

  it("a link whose pathname ALREADY ends in .md: exactly one request, no retry is attempted (mdRetryUrl has nothing useful to retry)", async () => {
    const link = "https://docs.example.com/guide.md";
    const spy = vi.fn(async () => alwaysHtml());
    vi.stubGlobal("fetch", spy);
    const result = await fetchLinkedPage("lib", link, source);
    expect(result).toEqual({ status: "unavailable", reason: "html-response" });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

/**
 * Phase 4 (URL privacy, end to end) — test plan #13: non-regression, broad. Redaction is a
 * display/storage-only concern; the actual HTTP request must still carry the RAW, query-intact
 * URL exactly as before this phase, for every candidate in the chain — a query string is the
 * only mechanism this tool has for reaching an authenticated internal endpoint (retrieval.ts's
 * own `sourceStampLine` comment), and redacting it before the request itself would silently
 * break that one real use case rather than merely hide it from output.
 */
describe("Phase 4 non-regression — redaction never reaches the actual fetch request", () => {
  it("getLibraryDoc sends the RAW, query-intact candidate URL to fetch, unmodified", async () => {
    const tokenUrl = "https://docs.internal.example.com/llms.txt?token=super-secret-fetch";
    const spy = vi.fn(async () => new Response("# Guide", { status: 200, headers: { "content-type": "text/plain" } }));
    vi.stubGlobal("fetch", spy);
    const doc = await getLibraryDoc({ name: "acme", urls: [tokenUrl] });
    expect(doc?.content).toBe("# Guide");
    expect(spy).toHaveBeenCalledTimes(1);
    const [requestedUrl] = spy.mock.calls[0];
    expect(String(requestedUrl)).toBe(tokenUrl); // exactly the raw url, query and all
  });

  it("a revalidation (If-None-Match) also sends the RAW candidate URL, not a redacted one", async () => {
    const tokenUrl = "https://docs.internal.example.com/llms.txt?token=super-secret-revalidate";
    writeCache("acme", tokenUrl, "# Guide (cached)", "etag-1");
    const spy = vi.fn(async () => new Response(null, { status: 304 }));
    vi.stubGlobal("fetch", spy);
    // Force past TTL 0 so getLibraryDoc actually revalidates over the network rather than
    // serving the fresh cache hit with no request at all.
    const doc = await getLibraryDoc({ name: "acme", urls: [tokenUrl], ttlHours: 0 });
    expect(doc?.notModified).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toBe(tokenUrl);
  });
});

/**
 * PAR-851 — the resolved-address check. Host policy (`isAllowedLink`/`isForbiddenHost`) is
 * TEXTUAL: `attacker.example.com` is not a private hostname string, so it sails through every
 * textual check above. The adjacent public-looking-name test injects a loopback DNS answer
 * and proves refusal before any connection reaches its real listener. Every test here
 * injects a stubbed resolver (`opts.lookup`) rather than depending on live DNS, so this suite
 * stays offline and deterministic.
 */
describe("PAR-851 — resolved-address check (DNS-rebinding-class gap)", () => {
  const publicName = "attacker.example.com";

  it("a public-looking name resolving to a LOOPBACK address is refused before any connection reaches a real listener", async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      res.end("SECRET");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const lookup = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]);
      // A real request WOULD land on the listener if the resolved-address check were absent —
      // proven by the "regression guard" test below, which allows exactly this shape through
      // when the entry opts in.
      vi.stubGlobal("fetch", async () => {
        throw new Error("must never be called: the resolved-address check must refuse first");
      });
      const out = await fetchUrl(`https://${publicName}:${port}/docs`, { maxBytes: 1024, lookup });
      expect(out).toEqual({ status: "refused" });
      expect(hits).toBe(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it.each([
    ["an RFC1918 address", { address: "10.1.2.3", family: 4 }],
    ["a link-local address", { address: "169.254.1.1", family: 4 }],
    ["an IPv6 unique-local address", { address: "fd12:3456:789a::1", family: 6 }],
  ])("%s answer is refused before any connection", async (_label, addr) => {
    const spy = vi.fn(async () => new Response("SECRET", { status: 200 }));
    vi.stubGlobal("fetch", spy);
    const lookup = vi.fn(async () => [addr]);
    const out = await fetchUrl(`https://${publicName}/docs`, { maxBytes: 1024, lookup });
    expect(out).toEqual({ status: "refused" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("a legitimate public address still connects — a fix that refuses everything is not a fix", async () => {
    const spy = vi.fn(async () => new Response("# Docs", { status: 200, headers: { "content-type": "text/plain" } }));
    vi.stubGlobal("fetch", spy);
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    const out = await fetchUrl(`https://${publicName}/docs`, { maxBytes: 1024, lookup });
    expect(out).toMatchObject({ status: "ok", body: "# Docs" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("strict DNS refuses a failed preliminary lookup before fetch is called", async () => {
    const spy = vi.fn(async () => new Response("must not fetch", { status: 200 }));
    vi.stubGlobal("fetch", spy);
    const lookup = vi.fn(async () => {
      throw new Error("ENOTFOUND");
    });
    const out = await fetchUrl(`https://${publicName}/docs`, { maxBytes: 1024, lookup, strictDns: true });
    expect(out).toEqual({ status: "refused" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("a config-derived strictDns entry carries the policy through getLibraryDoc", async () => {
    const spy = vi.fn(async () => new Response("must not fetch", { status: 200 }));
    vi.stubGlobal("fetch", spy);
    const lookup = vi.fn(async () => []);
    const doc = await getLibraryDoc({ name: "strict-entry", urls: [`https://${publicName}/docs`], strictDns: true }, { lookup });
    expect(doc).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it("VIBECTX_STRICT_DNS=1 enables the same fail-closed behavior without a config", async () => {
    const registry = loadDiscoveredRegistry({
      cwd: dir,
      env: { VIBECTX_STRICT_DNS: "1" },
      home: dir,
      includeResolved: false,
      warn: () => {},
    });
    expect(registry.strictDns).toBe(true);
    const spy = vi.fn(async () => new Response("must not fetch", { status: 200 }));
    vi.stubGlobal("fetch", spy);
    const lookup = vi.fn(async () => []);
    const out = await fetchUrl(`https://${publicName}/docs`, { maxBytes: 1024, lookup, strictDns: registry.strictDns });
    expect(out).toEqual({ status: "refused" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("redirect hop: first hop public+public, second hop public-name-resolving-private — refused at the second hop specifically", async () => {
    const start = `https://${publicName}/start`;
    const hop2 = "https://public-looking.example.net/private";
    const spy = vi.fn(async (url: unknown) => {
      if (String(url) === start) return new Response(null, { status: 302, headers: { location: hop2 } });
      throw new Error("must never reach the second hop's own request");
    });
    vi.stubGlobal("fetch", spy);
    const lookup = vi.fn(async (host: string) => (host === publicName ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "127.0.0.1", family: 4 }]));
    const out = await fetchUrl(start, { maxBytes: 1024, lookup });
    expect(out).toEqual({ status: "refused" });
    expect(spy).toHaveBeenCalledTimes(1); // the first hop WAS requested; the second never was
    expect(lookup).toHaveBeenCalledWith(publicName);
    expect(lookup).toHaveBeenCalledWith("public-looking.example.net");
  });

  it("REGRESSION GUARD (the shipped feature): an allowInternalHosts:true entry whose primary resolves privately still fetches successfully", async () => {
    const spy = vi.fn(async () => new Response("# Internal docs", { status: 200, headers: { "content-type": "text/plain" } }));
    vi.stubGlobal("fetch", spy);
    const lookup = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]);
    const url = "https://internal.acme.example.com/llms.txt";
    const doc = await getLibraryDoc({ name: "acme-internal", urls: [url], allowInternalHosts: true }, { lookup });
    expect(doc?.content).toBe("# Internal docs");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  /** PAR-1034 (final audit M-3): a bare-origin config url (no trailing slash) is answered with
   *  `res.url` in WHATWG form (`…/`). Comparing that against the raw config string made the
   *  operator's own first URL look like a redirect, and `hopAllowed` refused it as `final-host`.
   *  The stubbed Response carries the runtime's serialised `url`, so no network is used. */
  describe("PAR-1034: a bare-origin allowInternalHosts url is not refused as its own final host", () => {
    const answeredAs = (url: string) => {
      const res = new Response("# Internal docs", { status: 200, headers: { "content-type": "text/plain" } });
      Object.defineProperty(res, "url", { value: url });
      return res;
    };

    it("PAR-1034: https://127.0.0.1:<port> with no trailing slash is fetched, not refused as final-host", async () => {
      const spy = vi.fn(async () => answeredAs("https://127.0.0.1:8443/"));
      vi.stubGlobal("fetch", spy);
      const doc = await getLibraryDoc({ name: "acme-bare", urls: ["https://127.0.0.1:8443"], allowInternalHosts: true });
      expect(doc?.content).toBe("# Internal docs");
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("PAR-1034: a configured internal url with a #fragment is fetched; res.url carries no fragment", async () => {
      const spy = vi.fn(async () => answeredAs("https://127.0.0.1:8443/docs"));
      vi.stubGlobal("fetch", spy);
      const doc = await getLibraryDoc({ name: "acme-frag", urls: ["https://127.0.0.1:8443/docs#intro"], allowInternalHosts: true });
      expect(doc?.content).toBe("# Internal docs");
      expect(spy).toHaveBeenCalledTimes(1);
    });

    // Identical to the test above except for the host in `res.url`, so the only thing that can
    // turn its success into `undefined` here is the final-host check judging that host.
    it("PAR-1034 guard: a final url on a different internal host is still refused as final-host", async () => {
      const spy = vi.fn(async () => answeredAs("https://127.0.0.2:8443/"));
      vi.stubGlobal("fetch", spy);
      expect(await getLibraryDoc({ name: "acme-moved", urls: ["https://127.0.0.1:8443"], allowInternalHosts: true })).toBeUndefined();
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe("Tom's extension (docs/decisions.md): allowInternalHosts covers this entry's redirect hops and its own followed links", () => {
    const primary = "https://internal.acme.example.com/index.txt";
    const otherOrigin = "https://other.example.org/private";
    const privateLookup = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]);

    it("the entry's primary redirecting to a private address succeeds", async () => {
      const spy = vi.fn(async (url: unknown) => {
        if (String(url) === primary) return new Response(null, { status: 302, headers: { location: "https://internal.acme.example.com/v2.txt" } });
        return new Response("# v2", { status: 200, headers: { "content-type": "text/plain" } });
      });
      vi.stubGlobal("fetch", spy);
      const doc = await getLibraryDoc({ name: "acme-internal", urls: [primary], allowInternalHosts: true }, { lookup: privateLookup });
      expect(doc?.content).toBe("# v2");
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it("a followed link from that entry's document, on the SAME origin the opt-in covers, succeeds", async () => {
      const link = "https://internal.acme.example.com/guide.md";
      const spy = vi.fn(async () => new Response("# Guide", { status: 200, headers: { "content-type": "text/plain" } }));
      vi.stubGlobal("fetch", spy);
      const entry = { name: "acme-internal", urls: [primary], allowInternalHosts: true };
      const result = await fetchLinkedPage("acme-internal", link, primary, 168, false, entry, { lookup: privateLookup });
      expect(result).toMatchObject({ status: "ok", page: { content: "# Guide" } });
    });

    it("a followed link targeting a private address on a DIFFERENT, non-opted-in origin is still refused", async () => {
      const spy = vi.fn(async () => new Response("SECRET", { status: 200 }));
      vi.stubGlobal("fetch", spy);
      const entry = { name: "acme-internal", urls: [primary], allowInternalHosts: true };
      // isAllowedLink itself refuses a cross-origin link with no matching allowedHosts entry —
      // this never even reaches the resolved-address check, exactly as for any other entry.
      const result = await fetchLinkedPage("acme-internal", otherOrigin, primary, 168, false, entry, { lookup: privateLookup });
      expect(result).toEqual({ status: "refused" });
      expect(spy).not.toHaveBeenCalled();
    });

    /** security-architect S3 (review round 2) — every OTHER refusal test on the followed-link
     *  path is refused by `isAllowedLink`'s own textual host-admission rule BEFORE the
     *  resolved-address check ever runs (the test right above this one included: cross-origin,
     *  refused by text alone). None of them actually exercise `checkResolvedAddress` on the
     *  followed-link path. This one does: SAME origin as the source document (so `isAllowedLink`
     *  admits it on textual grounds alone, entry NOT opted in), but that same-origin hostname
     *  resolves privately — refusal here can only come from the resolved-address check itself. */
    it("a followed link on the SAME origin as the source document, NOT opted in, whose host resolves privately, is refused BY THE ADDRESS CHECK (not by isAllowedLink)", async () => {
      const sourceUrl = "https://docs.example.com/index.txt";
      const link = "https://docs.example.com/guide.md"; // same origin as sourceUrl — isAllowedLink admits this on text alone
      const spy = vi.fn(async () => new Response("SECRET", { status: 200 }));
      vi.stubGlobal("fetch", spy);
      // No allowInternalHosts on this policy — confirms isAllowedLink's own admission is NOT
      // gated on the flag (it never was); refusal must come from the address check that follows.
      const entryNotOptedIn = { name: "docs", urls: [sourceUrl] };
      expect(isAllowedLink(link, sourceUrl, entryNotOptedIn)).toBe(true); // admitted on text alone, before any DNS is consulted
      const result = await fetchLinkedPage("docs", link, sourceUrl, 168, false, entryNotOptedIn, { lookup: privateLookup });
      expect(result).toEqual({ status: "refused" });
      expect(spy).not.toHaveBeenCalled(); // refused before any connection — the address check, not a network failure
    });
  });
});

/**
 * PAR-853 — the whole-operation deadline (`getLibraryDoc`'s `opts.operationDeadlineMs`, a test
 * seam over the real `OPERATION_DEADLINE_MS`) and the shared fetch-concurrency semaphore
 * (`FETCH_CONCURRENCY_LIMIT`, `fetcher.ts`'s module-level limiter every `fetchUrl` call
 * acquires). Every assertion is on a REQUEST COUNT or an observed-concurrency counter, never on
 * elapsed wall-clock time — the tiny `operationDeadlineMs` values below make the
 * deadline fire almost immediately in real time so the tests stay fast, but what is ASSERTED is
 * always "how many requests were issued", not "how long did this take".
 */
describe("PAR-853 — whole-operation deadline and shared fetch concurrency", () => {
  /** A fetch stub that never resolves on its own — it only settles by rejecting when the
   *  request's own `signal` aborts, exactly like real `fetch()` against a genuinely hung
   *  server. This is what makes "every candidate is slow" a REAL scenario the deadline must
   *  cut off, not a mock that resolves instantly regardless of the signal. */
  function hangingUntilAborted() {
    return vi.fn((_url: unknown, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(Object.assign(new Error("aborted"), { name: (signal.reason as { name?: string } | undefined)?.name ?? "AbortError" }));
          return;
        }
        signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: (signal.reason as { name?: string } | undefined)?.name ?? "AbortError" }));
        });
      });
    });
  }

  // (code-reviewer B1, round 2) — a fast, injected lookup, the SAME test seam and the SAME
  // reason the semaphore test below already uses it: without it, a real `dns.lookup()` runs
  // on Node's libuv threadpool (default 4 slots) and races whatever short, artificial deadline
  // or timing assertion the test makes — MEASURED by the reviewer at 5.3ms idle but
  // 39.5-337ms under 4-48 concurrent lookups (this test suite's own concurrency saturates that
  // threadpool), comfortably enough to blow past a 15ms `operationDeadlineMs` — or a 500ms
  // liveness margin — before hop 0 even happens, making the assertion a function of machine
  // load, not of the code under test.
  const fastLookup = async () => [{ address: "93.184.216.34", family: 4 }];

  it("a many-candidate entry where EVERY candidate is slow terminates at the operation deadline — only the first candidate is ever requested", async () => {
    const spy = hangingUntilAborted();
    vi.stubGlobal("fetch", spy);
    const urls = Array.from({ length: 5 }, (_, i) => `https://slow${i}.example.com/llms.txt`);
    const doc = await getLibraryDoc({ name: "many-slow", urls }, { operationDeadlineMs: 15, lookup: fastLookup });
    expect(doc).toBeUndefined();
    // The deadline is SHARED across every candidate: once it fires (while candidate 1 is still
    // hanging), candidates 2-5 are refused at fetchUrl's own top-of-function check before a
    // second request is ever issued -- not "each candidate gets its own chance to hang too".
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("a redirect chain terminates at the OPERATION deadline, not the (irrelevant, much longer) per-hop timeout — the second hop is requested, then aborted, and no third hop follows", async () => {
    const start = "https://chain.example.com/start";
    const hop2 = "https://chain.example.com/hop2";
    const hangSpy = hangingUntilAborted();
    const spy = vi.fn((url: unknown, init?: RequestInit) => {
      if (String(url) === start) return Promise.resolve(new Response(null, { status: 302, headers: { location: hop2 } }));
      return hangSpy(url, init);
    });
    vi.stubGlobal("fetch", spy);
    const doc = await getLibraryDoc({ name: "chain", urls: [start] }, { operationDeadlineMs: 15, lookup: fastLookup });
    expect(doc).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(2); // start, then hop2 -- hop2 is the one the deadline aborts
  });

  it("non-regression: an ordinary single-candidate fetch is not slowed or serialised behind the new limits", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("# Docs", { status: 200, headers: { "content-type": "text/plain" } })));
    const startedAt = Date.now();
    const doc = await getLibraryDoc({ name: "ordinary", urls: ["https://ordinary.example.com/llms.txt"] }, { lookup: fastLookup });
    expect(doc?.content).toBe("# Docs");
    expect(Date.now() - startedAt).toBeLessThan(500); // liveness margin, not a performance budget (F-2's own convention)
  });

  it(`the shared semaphore never lets more than FETCH_CONCURRENCY_LIMIT (${FETCH_CONCURRENCY_LIMIT}) requests be in flight at once, across M independent getLibraryDoc calls`, async () => {
    let inFlight = 0;
    let maxObserved = 0;
    const spy = vi.fn(async () => {
      inFlight += 1;
      maxObserved = Math.max(maxObserved, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      return new Response("# Docs", { status: 200, headers: { "content-type": "text/plain" } });
    });
    vi.stubGlobal("fetch", spy);
    // fastLookup (declared above) — without it, real `dns.lookup`'s libuv THREADPOOL (default
    // 4 threads) would itself cap observed concurrency below FETCH_CONCURRENCY_LIMIT, which
    // would test the thread pool, not the semaphore.
    const M = FETCH_CONCURRENCY_LIMIT * 3; // comfortably more callers than slots
    await Promise.all(
      Array.from({ length: M }, (_, i) => getLibraryDoc({ name: `concurrent-${i}`, urls: [`https://concurrent-${i}.example.com/llms.txt`] }, { lookup: fastLookup })),
    );
    expect(spy).toHaveBeenCalledTimes(M); // every call eventually got through
    expect(maxObserved).toBeLessThanOrEqual(FETCH_CONCURRENCY_LIMIT);
    expect(maxObserved).toBe(FETCH_CONCURRENCY_LIMIT); // exact, not just "within bounds" -- proves the ceiling is actually reached, not merely never exceeded by accident
  });
});

describe("PAR-1044 (final audit I-1, I-2): followed-link length and conditional headers across hosts", () => {
  const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
  afterEach(() => vi.unstubAllGlobals());

  it("PAR-1044 (I-1): a followed link longer than the URL length bound is refused before any request", async () => {
    const spy = vi.fn(async () => new Response("# page", { status: 200 }));
    vi.stubGlobal("fetch", spy);
    const long = `https://docs.example.com/${"a".repeat(MAX_REMOTE_URL_LENGTH)}`;
    expect(await fetchLinkedPage("lib", long, "https://docs.example.com/llms.txt", 168, false, undefined)).toEqual({ status: "refused" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("PAR-1044 (I-1) guard: a link exactly at the bound is still allowed", () => {
    const base = "https://docs.example.com/";
    const atBound = `${base}${"a".repeat(MAX_REMOTE_URL_LENGTH - base.length)}`;
    expect(atBound.length).toBe(MAX_REMOTE_URL_LENGTH);
    expect(isAllowedLink(atBound, "https://docs.example.com/llms.txt")).toBe(true);
    expect(isAllowedLink(`${atBound}a`, "https://docs.example.com/llms.txt")).toBe(false);
  });

  it("PAR-1044 (I-1): a redirect Location longer than the bound is refused before it is requested", async () => {
    const start = "https://docs.example.com/start";
    const spy = vi.fn(async (url: unknown) => (String(url) === start
      ? new Response(null, { status: 302, headers: { location: `https://docs.example.com/${"b".repeat(MAX_REMOTE_URL_LENGTH)}` } })
      : new Response("# never", { status: 200 })));
    vi.stubGlobal("fetch", spy);
    expect(await fetchUrl(start, { maxBytes: 1024, lookup: publicLookup })).toEqual({ status: "refused" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("PAR-1044 (I-2): If-None-Match is not sent to a redirect target on another host; a 304 from it is a miss", async () => {
    const start = "https://docs.example.com/llms.txt";
    const moved = "https://other.example.org/llms.txt";
    const sent: (string | null)[] = [];
    const spy = vi.fn(async (url: unknown, init?: RequestInit) => {
      sent.push(new Headers(init?.headers).get("if-none-match"));
      return String(url) === start ? new Response(null, { status: 302, headers: { location: moved } }) : new Response(null, { status: 304 });
    });
    vi.stubGlobal("fetch", spy);
    const out = await fetchUrl(start, { maxBytes: 1024, etag: '"v1"', lookup: publicLookup, accept: "text/markdown" });
    expect(sent).toEqual(['"v1"', null]);
    expect(out.status).toBe("miss");
    // Only the validator is withheld: the request still says what it accepts.
    expect(new Headers(spy.mock.calls[1][1]?.headers).get("accept")).toBe("text/markdown");
  });

  it("PAR-1044 (I-2): a validator issued by the redirect target's host is sent there, and its 304 is unchanged", async () => {
    const start = "https://docs.example.com/llms.txt";
    const moved = "https://other.example.org/llms.txt";
    const sent: (string | null)[] = [];
    const spy = vi.fn(async (url: unknown, init?: RequestInit) => {
      sent.push(new Headers(init?.headers).get("if-none-match"));
      return String(url) === start ? new Response(null, { status: 302, headers: { location: moved } }) : new Response(null, { status: 304 });
    });
    vi.stubGlobal("fetch", spy);
    const out = await fetchUrl(start, { maxBytes: 1024, etag: '"v1"', etagUrl: moved, lookup: publicLookup });
    expect(sent).toEqual([null, '"v1"']); // never to the host that did not issue it
    expect(out.status).toBe("not-modified");
  });

  it("PAR-1044 (I-2): with no redirect, a 304 from a host that did not issue the validator is a miss", async () => {
    const sent: (string | null)[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      sent.push(new Headers(init?.headers).get("if-none-match"));
      return new Response(null, { status: 304 });
    }));
    const out = await fetchUrl("https://docs.example.com/llms.txt", { maxBytes: 1024, etag: '"v1"', etagUrl: "https://other.example.org/llms.txt", lookup: publicLookup });
    expect(sent).toEqual([null]);
    expect(out.status).toBe("miss");
  });

  it("PAR-1044 (I-2): getLibraryDoc revalidates a cross-host redirected primary with its own validator", async () => {
    const start = "https://docs.example.com/llms.txt";
    const moved = "https://other.example.org/llms.txt";
    writeCache("i2lib", start, "# Cached docs", '"v1"', moved);
    const sent: { url: string; inm: string | null }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
      sent.push({ url: String(url), inm: new Headers(init?.headers).get("if-none-match") });
      return String(url) === start ? new Response(null, { status: 302, headers: { location: moved } }) : new Response(null, { status: 304 });
    }));
    const doc = await getLibraryDoc({ name: "i2lib", urls: [start], ttlHours: 0 }, { lookup: publicLookup });
    expect(sent).toEqual([{ url: start, inm: null }, { url: moved, inm: '"v1"' }]);
    expect(doc?.content).toBe("# Cached docs");
    expect(doc?.staleNote).toBeUndefined(); // revalidated, not served as an unreachable stale copy
  });

  it("PAR-1044 (I-2) guard: a same-host redirect still revalidates with If-None-Match", async () => {
    const start = "https://docs.example.com/llms.txt";
    const moved = "https://docs.example.com/v2/llms.txt";
    const sent: (string | null)[] = [];
    const spy = vi.fn(async (url: unknown, init?: RequestInit) => {
      sent.push(new Headers(init?.headers).get("if-none-match"));
      return String(url) === start ? new Response(null, { status: 302, headers: { location: moved } }) : new Response(null, { status: 304 });
    });
    vi.stubGlobal("fetch", spy);
    expect((await fetchUrl(start, { maxBytes: 1024, etag: '"v1"', lookup: publicLookup })).status).toBe("not-modified");
    expect(sent).toEqual(['"v1"', '"v1"']);
  });
});
