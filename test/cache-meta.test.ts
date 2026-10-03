import { describe, it, expect } from "vitest";
import { urlSlug, urlHashFor, libDirName, metaMatchesSlug, metaMatchesUrl, toCacheMeta } from "../src/cache-meta.js";

/**
 * D-71 (PAR-749, Root 1) — direct unit coverage of the injective transforms, independent of
 * any cache read/write behavior exercised elsewhere. The three pairs below are the exact
 * examples PAR-749's own "the two roots" table used to demonstrate the pre-fix collision: every
 * non-alphanumeric character folded to `_`, so these produced the identical slug.
 */
describe("D-71 (PAR-749, Root 1) — urlSlug is injective", () => {
  it.each([
    ["https://x.dev/a-b", "https://x.dev/a_b"],
    ["https://x.dev/api.v1", "https://x.dev/api-v1"],
    ["https://x.dev/docs/intro", "https://x.dev/docs-intro"],
  ])("%s and %s no longer share a slug", (a, b) => {
    expect(urlSlug(a)).not.toBe(urlSlug(b));
  });

  it("is a pure, deterministic function of the URL alone", () => {
    const url = "https://react.dev/llms.txt";
    expect(urlSlug(url)).toBe(urlSlug(url));
  });

  it("two URLs sharing a 120+ character common prefix (the truncation-collision case) still produce distinct slugs", () => {
    const prefix = "https://example.com/" + "a".repeat(200);
    expect(urlSlug(`${prefix}-one`)).not.toBe(urlSlug(`${prefix}-two`));
  });

  it("stays a bounded, filesystem-safe string — exactly 120 folded chars + 1 separator + 12 hash chars", () => {
    const slug = urlSlug("https://example.com/" + "x".repeat(5000));
    expect(slug.length).toBe(120 + 1 + 12);
    expect(slug).toMatch(/^[a-z0-9_]+$/i);
  });
});

describe("D-71 (PAR-749, Root 1) — libDirName is injective", () => {
  it("two npm names that fold to the same characters no longer share a directory name", () => {
    expect(libDirName("foo.bar")).not.toBe(libDirName("foo_bar"));
  });

  it("is a pure, deterministic function of the library name alone", () => {
    expect(libDirName("react")).toBe(libDirName("react"));
  });

  it("never collapses an empty library name to an empty or root-shaped path segment", () => {
    expect(libDirName("")).not.toBe("");
  });
});

describe("PAR-776 (D-74) — toCacheMeta's finalUrl", () => {
  const url = "https://react.dev/llms.txt";
  const fetchedAt = "2026-01-01T00:00:00.000Z";

  it("is absent when the raw record never had one", () => {
    expect(toCacheMeta({ url, fetchedAt })!.finalUrl).toBeUndefined();
  });

  it("round-trips a valid, parseable finalUrl", () => {
    const finalUrl = "https://docs.react.dev/llms.txt";
    expect(toCacheMeta({ url, fetchedAt, finalUrl })!.finalUrl).toBe(finalUrl);
  });

  it("is dropped alone — not the whole record — when unparseable, oversized, or the wrong type", () => {
    expect(toCacheMeta({ url, fetchedAt, finalUrl: "not a url" })!.finalUrl).toBeUndefined();
    expect(toCacheMeta({ url, fetchedAt, finalUrl: "https://x.dev/" + "a".repeat(2048) })!.finalUrl).toBeUndefined();
    expect(toCacheMeta({ url, fetchedAt, finalUrl: 12345 })!.finalUrl).toBeUndefined();
    // None of these malformed finalUrl values invalidate the record as a whole.
    expect(toCacheMeta({ url, fetchedAt, finalUrl: "not a url" })!.url).toBe(url);
  });

  /** Code-reviewer, PAR-776 round 1, B1 / security-architect, PAR-776 round 1, B-1: `finalUrl`
   *  is used as the same-origin base for `get-docs.ts`'s host-policy check — `link-policy.ts`'s
   *  `isAllowedLink` grants a document's own host unconditionally — so a value merely SHAPED
   *  like a URL is not enough, unlike `url` itself. These are the exact rejections that make it
   *  `sanitizeRemoteUrl`, not `validMetaUrl`: a hand-edited or corrupted `.meta.json` handing a
   *  caller a hostile "trusted" origin. */
  it("(code-reviewer/security-architect, PAR-776 round 1, B1/B-1) rejects http, userinfo, and forbidden-host finalUrl values a hostile or corrupted .meta.json could carry", () => {
    expect(toCacheMeta({ url, fetchedAt, finalUrl: "http://docs.react.dev/llms.txt" })!.finalUrl).toBeUndefined();
    expect(toCacheMeta({ url, fetchedAt, finalUrl: "https://user:pass@docs.react.dev/llms.txt" })!.finalUrl).toBeUndefined();
    expect(toCacheMeta({ url, fetchedAt, finalUrl: "https://127.0.0.1/llms.txt" })!.finalUrl).toBeUndefined();
    expect(toCacheMeta({ url, fetchedAt, finalUrl: "https://localhost/llms.txt" })!.finalUrl).toBeUndefined();
    expect(toCacheMeta({ url, fetchedAt, finalUrl: "file:///etc/passwd" })!.finalUrl).toBeUndefined();
    expect(toCacheMeta({ url, fetchedAt, finalUrl: "javascript:alert(1)" })!.finalUrl).toBeUndefined();
  });

  it("normalises finalUrl the same way sanitizeRemoteUrl does (e.g. strips a fragment) rather than storing the raw string verbatim", () => {
    const meta = toCacheMeta({ url, fetchedAt, finalUrl: "https://docs.react.dev/llms.txt#section" })!;
    expect(meta.finalUrl).toBe("https://docs.react.dev/llms.txt");
  });
});

describe("D-71 (PAR-749, Root 1) — metaMatchesSlug (OLD-FORMAT meta: no urlHash, url is raw)", () => {
  const url = "https://react.dev/llms.txt";
  const meta = toCacheMeta({ url, fetchedAt: "2026-01-01T00:00:00.000Z" })!;

  it("true when the meta's own url round-trips to the given slug via urlSlug", () => {
    expect(meta.urlHash).toBeUndefined();
    expect(metaMatchesSlug(meta, urlSlug(url))).toBe(true);
  });

  it("false for any other slug, including one belonging to a different real URL", () => {
    expect(metaMatchesSlug(meta, urlSlug("https://react.dev/other-page.md"))).toBe(false);
    expect(metaMatchesSlug(meta, "not-a-real-slug")).toBe(false);
  });
});

/**
 * PAR-806 (Phase 4) — the redesigned `urlSlug`/`metaMatchesSlug`/`metaMatchesUrl` that close the
 * `.meta.json` disk leak while preserving D-71's own collision-resistance and mismatch
 * guarantees. See docs/decisions.md for the full design reasoning (raw-vs-redacted comparison).
 */
describe("PAR-806 — urlHash (Phase 4: cache-meta url privacy)", () => {
  const tokenUrl = "https://docs.internal.example.com/llms.txt?token=super-secret-meta";
  const plainUrl = "https://docs.internal.example.com/llms.txt";

  it("urlSlug's PREFIX comes from the redacted url (no token), but the HASH still comes from the full raw url", () => {
    const slug = urlSlug(tokenUrl);
    expect(slug).not.toContain("super-secret-meta");
    expect(slug).not.toContain("token");
    // The hash must still distinguish this from the token-free url — D-71's own guarantee
    // that two candidates differing only by query string are different documents.
    expect(urlSlug(tokenUrl)).not.toBe(urlSlug(plainUrl));
    // The PREFIX portion (everything before the final `_<12-hex>`) is identical to what a
    // token-free, otherwise-identical url would produce, because both redact to the same string.
    const prefixOf = (s: string) => s.replace(/_[0-9a-f]{12}$/, "");
    expect(prefixOf(slug)).toBe(prefixOf(urlSlug(plainUrl)));
  });

  it("toCacheMeta accepts a valid 64-hex urlHash (the FULL digest, not urlSlug's 12-char suffix), and drops JUST that field for a malformed one", () => {
    const good = toCacheMeta({ url: plainUrl, urlHash: urlHashFor(tokenUrl), fetchedAt: "2026-01-01T00:00:00.000Z" });
    expect(good?.urlHash).toBe(urlHashFor(tokenUrl));
    expect(good?.urlHash).toHaveLength(64);
    // security-architect, Phase 4 round 2, B1 — a 12-character value (what this field held,
    // wrongly, for one round of this phase) must now be REJECTED as malformed, not accepted:
    // accepting it would silently resurrect the exact regression this fix closes.
    const twelveChar = toCacheMeta({ url: plainUrl, urlHash: urlHashFor(tokenUrl).slice(0, 12), fetchedAt: "2026-01-01T00:00:00.000Z" });
    expect(twelveChar?.urlHash).toBeUndefined();
    // A malformed urlHash does not drop the whole RECORD (fetchedAt/etc are still real, useful
    // facts) — it drops only this field, so `metaMatchesUrl`/`metaMatchesSlug` fall back to
    // comparing `url` directly (old-format behaviour) rather than trusting a corrupt hash.
    const malformed = toCacheMeta({ url: plainUrl, urlHash: "not-hex-at-all", fetchedAt: "2026-01-01T00:00:00.000Z" });
    expect(malformed).toBeDefined();
    expect(malformed?.urlHash).toBeUndefined();
    expect(toCacheMeta({ url: plainUrl, urlHash: urlHashFor(tokenUrl).slice(0, 63).toUpperCase() + "a", fetchedAt: "2026-01-01T00:00:00.000Z" })?.urlHash).toBeUndefined(); // uppercase, right length
    // Absent entirely (old-format file) is fine — a different, valid record.
    expect(toCacheMeta({ url: plainUrl, fetchedAt: "2026-01-01T00:00:00.000Z" })?.urlHash).toBeUndefined();
  });

  /**
   * security-architect, Phase 4 round 2, B1 — THE REGRESSION TEST FOR THE ACTUAL VULNERABILITY,
   * not merely a shape check: proves that sharing `urlSlug`'s own 12-character/48-bit filename
   * hash (exactly what an attacker who ground a forced ~2^48 collision would have) is NOT
   * sufficient to satisfy the identity check — only an exact 64-character digest match is. A
   * real 48-bit collision cannot be constructed in a unit test (that is the whole point of it
   * costing "single-GPU hours, not zero"), so this proves the STRUCTURAL property directly: a
   * urlHash that agrees with the target's on the first 12 characters (the shared filename hash a
   * successful attack would produce) but differs elsewhere is correctly rejected.
   */
  it("a forced 12-character (48-bit) filename-hash collision does NOT satisfy the identity check — only a full 64-character match does", () => {
    const target = "https://docs.internal.example.com/llms.txt?v=real";
    const attacker = "https://docs.internal.example.com/llms.txt?v=attacker-forced-collision";
    const targetHash = urlHashFor(target);
    const attackerHash = urlHashFor(attacker);
    // Sanity: these are genuinely different 64-character digests (no accidental full collision).
    expect(attackerHash).not.toBe(targetHash);
    // Construct the attack's exact shape: a meta record whose urlHash SHARES the target's
    // filename-hash prefix (what a successful ~2^48 grind produces — this is simulated, not
    // ground, since finding a real one is deliberately expensive) but is the attacker's own
    // full hash otherwise — exactly what `urlSlug`'s filename collision would let through if
    // the identity check still compared only 12 characters.
    const forcedPrefix = targetHash.slice(0, 12) + attackerHash.slice(12);
    expect(forcedPrefix.slice(0, 12)).toBe(targetHash.slice(0, 12)); // shares the FILENAME hash
    expect(forcedPrefix).not.toBe(targetHash); // but is NOT the target's real, full identity
    const attackerMeta = toCacheMeta({ url: plainUrl, urlHash: forcedPrefix, fetchedAt: "2026-01-01T00:00:00.000Z" })!;
    expect(metaMatchesUrl(attackerMeta, target)).toBe(false); // correctly rejected
    // The genuine target record, by contrast, matches — proving this isn't just "always false".
    const genuineMeta = toCacheMeta({ url: plainUrl, urlHash: targetHash, fetchedAt: "2026-01-01T00:00:00.000Z" })!;
    expect(metaMatchesUrl(genuineMeta, target)).toBe(true);
  });

  describe("metaMatchesSlug / metaMatchesUrl — NEW-FORMAT meta (urlHash present, url is redacted)", () => {
    // Exactly what writeCache now constructs: url redacted, urlHash the raw url's hash.
    const meta = toCacheMeta({ url: plainUrl, urlHash: urlHashFor(tokenUrl), fetchedAt: "2026-01-01T00:00:00.000Z" })!;

    it("metaMatchesSlug reconstructs the ORIGINAL slug (the one urlSlug(tokenUrl) produces) with no raw url in hand", () => {
      expect(metaMatchesSlug(meta, urlSlug(tokenUrl))).toBe(true);
    });

    it("metaMatchesSlug is false for a different real URL's slug", () => {
      expect(metaMatchesSlug(meta, urlSlug("https://docs.internal.example.com/other.txt?token=x"))).toBe(false);
    });

    it("metaMatchesUrl: a positive match for the SAME raw url (full fidelity, query included)", () => {
      expect(metaMatchesUrl(meta, tokenUrl)).toBe(true);
    });

    it("metaMatchesUrl: a negative match for a query-only difference — D-71's own guarantee, preserved", () => {
      expect(metaMatchesUrl(meta, "https://docs.internal.example.com/llms.txt?token=DIFFERENT-secret")).toBe(false);
      expect(metaMatchesUrl(meta, plainUrl)).toBe(false); // no query at all
    });

    it("metaMatchesUrl: a negative match for a genuinely different host/path", () => {
      expect(metaMatchesUrl(meta, "https://other.example.com/llms.txt?token=super-secret-meta")).toBe(false);
    });
  });

  describe("metaMatchesSlug / metaMatchesUrl — OLD-FORMAT meta (no urlHash, url is raw) still works unmodified", () => {
    const meta = toCacheMeta({ url: tokenUrl, fetchedAt: "2026-01-01T00:00:00.000Z" })!;

    it("metaMatchesUrl falls back to a direct raw comparison", () => {
      expect(meta.urlHash).toBeUndefined();
      expect(metaMatchesUrl(meta, tokenUrl)).toBe(true);
      expect(metaMatchesUrl(meta, plainUrl)).toBe(false);
    });
  });
});
