import { describe, it, expect } from "vitest";
import {
  isAllowedLink,
  isForbiddenHost,
  normaliseAllowedHost,
  registrableDomain,
  derivedAllowedHosts,
  redactUrlForDisplay,
  sanitizeRemoteUrl,
  validateLibraryUrl,
} from "../src/link-policy.js";

const source = "https://docs.example.com/llms.txt";

describe("isAllowedLink without a policy (the 0.1.3 same-origin rule, made stricter)", () => {
  it("allows same-host https links on any path", () => {
    expect(isAllowedLink("https://docs.example.com/guide.md", source)).toBe(true);
    expect(isAllowedLink("https://docs.example.com/", source)).toBe(true);
  });

  it("rejects http even on the same host, and unparseable input", () => {
    expect(isAllowedLink("http://docs.example.com/guide.md", source)).toBe(false);
    expect(isAllowedLink("not a url", source)).toBe(false);
    expect(isAllowedLink("javascript:alert(1)", source)).toBe(false);
    expect(isAllowedLink("https://docs.example.com/x", "not a url")).toBe(false);
  });

  it("rejects other hosts, including parents, siblings and lookalikes", () => {
    expect(isAllowedLink("https://example.com/guide.md", source)).toBe(false);
    expect(isAllowedLink("https://api.example.com/guide.md", source)).toBe(false);
    expect(isAllowedLink("https://docs.example.com.evil.net/guide.md", source)).toBe(false);
    expect(isAllowedLink("https://evil.example.net/guide.md", source)).toBe(false);
  });

  it("matches the source host case-insensitively (URL folds hostnames)", () => {
    expect(isAllowedLink("https://DOCS.Example.com/guide.md", source)).toBe(true);
  });

  it("port rule: an explicit port is allowed only when host AND port equal the source's", () => {
    expect(isAllowedLink("https://docs.example.com:8443/x", source)).toBe(false);
    expect(isAllowedLink("https://docs.example.com:443/x", source)).toBe(true); // default port normalises away
    const portedSource = "https://docs.example.com:8443/llms.txt";
    expect(isAllowedLink("https://docs.example.com:8443/x", portedSource)).toBe(true);
    expect(isAllowedLink("https://docs.example.com/x", portedSource)).toBe(false);
  });

  it("rejects IP literals, localhost, .local/.internal and single-label hosts even when they equal the source host", () => {
    for (const bad of [
      "https://169.254.169.254/latest/meta-data",
      "https://127.0.0.1/x",
      "https://10.0.0.1/x",
      "https://2130706433/x", // decimal IPv4 → normalised to 127.0.0.1 by URL
      "https://0x7f.1/x",
      "https://[::1]/x",
      "https://[fd00::1]/x",
      "https://localhost:8080/admin",
      "https://localhost/admin",
      "https://foo.localhost/admin",
      "https://printer.local/x",
      "https://vault.internal/x",
      "https://intranet/x",
    ]) {
      expect(isAllowedLink(bad, source), bad).toBe(false);
      // Even a source document that lives there does not make the link OK.
      expect(isAllowedLink(bad, bad), `${bad} (self)`).toBe(false);
    }
  });

  it("rejects userinfo in the link", () => {
    expect(isAllowedLink("https://user:pw@docs.example.com/x", source)).toBe(false);
    expect(isAllowedLink("https://docs.example.com@evil.net/x", source)).toBe(false);
  });
});

describe("isAllowedLink with an allowedHosts policy", () => {
  const policy = { allowedHosts: ["api.example.com", "*.example.org"] };

  it("allows an explicitly listed host and *.-wildcard subdomains, https only, default port only", () => {
    expect(isAllowedLink("https://api.example.com/v1.md", source, policy)).toBe(true);
    expect(isAllowedLink("https://a.example.org/x", source, policy)).toBe(true);
    expect(isAllowedLink("https://deep.a.example.org/x", source, policy)).toBe(true);
    expect(isAllowedLink("http://api.example.com/v1.md", source, policy)).toBe(false);
    expect(isAllowedLink("https://api.example.com:8443/v1.md", source, policy)).toBe(false);
  });

  it("*.example.org does not match the apex example.org, and a plain host does not match its subdomains", () => {
    expect(isAllowedLink("https://example.org/x", source, policy)).toBe(false);
    expect(isAllowedLink("https://v2.api.example.com/x", source, policy)).toBe(false);
  });

  it("still rejects unrelated hosts, lookalikes, IPs, localhost and userinfo", () => {
    expect(isAllowedLink("https://api.example.com.evil.net/x", source, policy)).toBe(false);
    expect(isAllowedLink("https://evilexample.org/x", source, policy)).toBe(false);
    expect(isAllowedLink("https://user@api.example.com/x", source, policy)).toBe(false);
    expect(isAllowedLink("https://127.0.0.1/x", source, { allowedHosts: ["127.0.0.1"] })).toBe(false);
    expect(isAllowedLink("https://localhost/x", source, { allowedHosts: ["localhost"] })).toBe(false);
    expect(isAllowedLink("https://a.localhost/x", source, { allowedHosts: ["*.localhost"] })).toBe(false);
  });

  it("treats policy entries case-insensitively and ignores malformed entries instead of matching them", () => {
    expect(isAllowedLink("https://api.example.com/x", source, { allowedHosts: ["API.Example.COM"] })).toBe(true);
    expect(isAllowedLink("https://api.example.com/x", source, { allowedHosts: ["https://api.example.com"] })).toBe(false);
    expect(isAllowedLink("https://api.example.com/x", source, { allowedHosts: ["*"] })).toBe(false);
    expect(isAllowedLink("https://api.example.com/x", source, { allowedHosts: [""] })).toBe(false);
  });

  it("the source host is always allowed, policy or not", () => {
    expect(isAllowedLink("https://docs.example.com/x", source, policy)).toBe(true);
  });
});

describe("isForbiddenHost", () => {
  it("names the private / non-routable shapes", () => {
    for (const h of ["127.0.0.1", "[::1]", "::1", "localhost", "x.localhost", "a.local", "b.internal", "nodot", ""]) {
      expect(isForbiddenHost(h), h).toBe(true);
    }
    for (const h of ["example.com", "docs.example.com", "a-b.co.uk"]) expect(isForbiddenHost(h), h).toBe(false);
  });

  it("R1: a trailing dot does not bypass the checks — such hosts are forbidden outright", () => {
    for (const h of ["localhost.", "x.internal.", "x.local.", "foo.", "example.com.", "LOCALHOST."]) {
      expect(isForbiddenHost(h), h).toBe(true);
      expect(isAllowedLink(`https://${h}/x`, source), h).toBe(false);
      expect(sanitizeRemoteUrl(`https://${h}/x`), h).toBeUndefined();
    }
  });
});

describe("normaliseAllowedHost (config / persisted validation)", () => {
  it("accepts hostnames and a single leading *. wildcard, folded to lowercase", () => {
    expect(normaliseAllowedHost(" Docs.Example.com ")).toBe("docs.example.com");
    expect(normaliseAllowedHost("*.Example.com")).toBe("*.example.com");
    expect(normaliseAllowedHost("a-b.co.uk")).toBe("a-b.co.uk");
  });

  it.each([
    ["a scheme", "https://docs.example.com"],
    ["a path", "docs.example.com/x"],
    ["a port", "docs.example.com:443"],
    ["a mid-string wildcard", "docs.*.example.com"],
    ["a bare wildcard", "*"],
    ["a wildcard on a single label", "*.com"],
    ["a wildcard on a single label (dot only)", "*."],
    ["a single label", "intranet"],
    ["an IPv4 literal", "10.0.0.1"],
    ["an IPv6 literal", "[::1]"],
    ["localhost", "localhost"],
    ["a .local name", "printer.local"],
    ["a .internal name", "vault.internal"],
    ["userinfo", "u@docs.example.com"],
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["a leading dot", ".example.com"],
    ["a trailing dot", "example.com."],
    ["an empty label", "docs..example.com"],
    ["an underscore", "my_host.example.com"],
  ])("rejects %s", (_label, value) => {
    expect(() => normaliseAllowedHost(value)).toThrow(/allowedHosts/);
  });

  it("rejects a hostname over 253 characters", () => {
    const long = `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.example.com`;
    expect(() => normaliseAllowedHost(long)).toThrow(/allowedHosts/);
  });
});

describe("validateLibraryUrl (A1, PAR-714; D-47, D-49): config `urls`, not just https", () => {
  it("accepts a well-formed public https URL", () => {
    expect(() => validateLibraryUrl("https://docs.example.com/llms.txt")).not.toThrow();
  });

  it.each([
    ["not a string", 42],
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["unparseable", "not a url"],
    ["http, not https", "http://docs.example.com/x"],
    ["ftp", "ftp://docs.example.com/x"],
    ["userinfo", "https://user:pw@docs.example.com/x"],
    ["a loopback address", "https://127.0.0.1/x"],
    ["an IPv4 literal", "https://10.0.0.1/x"],
    ["an IPv6 literal", "https://[::1]/x"],
    ["localhost", "https://localhost/x"],
    ["localhost with a port", "https://localhost:8443/x"],
    ["a .local host", "https://printer.local/x"],
    ["a .internal host", "https://vault.internal/x"],
    ["a single-label host", "https://intranet/x"],
  ])("rejects %s", (_label, value) => {
    expect(() => validateLibraryUrl(value)).toThrow(/^urls:/);
  });

  it("allowInternalHosts:true permits the same forbidden hosts, but not http or userinfo", () => {
    for (const url of ["https://127.0.0.1/x", "https://169.254.169.254/x", "https://localhost:8443/x", "https://intranet/x"]) {
      expect(() => validateLibraryUrl(url, { allowInternalHosts: true }), url).not.toThrow();
    }
    expect(() => validateLibraryUrl("http://169.254.169.254/x", { allowInternalHosts: true })).toThrow(/must use https:/);
    expect(() => validateLibraryUrl("https://user:pw@169.254.169.254/x", { allowInternalHosts: true })).toThrow(/must not include userinfo/);
  });

  it("allowInternalHosts:false behaves exactly like omitting it", () => {
    expect(() => validateLibraryUrl("https://127.0.0.1/x", { allowInternalHosts: false })).toThrow(/is a private, loopback or non-routable host/);
  });

  it("names the offending value in the message, clipped to nothing here (short values pass through)", () => {
    expect(() => validateLibraryUrl("https://127.0.0.1/x")).toThrow('urls: "https://127.0.0.1/x" is a private, loopback or non-routable host');
  });
});

describe("registrableDomain (conservative: last two labels, or three for a known two-part suffix)", () => {
  it("strips subdomains", () => {
    expect(registrableDomain("www.python-httpx.org")).toBe("python-httpx.org");
    expect(registrableDomain("tanstack.com")).toBe("tanstack.com");
    expect(registrableDomain("a.b.c.hono.dev")).toBe("hono.dev");
  });

  it("knows a small list of two-part public suffixes", () => {
    expect(registrableDomain("docs.acme.co.uk")).toBe("acme.co.uk");
    expect(registrableDomain("foo.com.au")).toBe("foo.com.au");
    expect(registrableDomain("someone.github.io")).toBe("someone.github.io");
    expect(registrableDomain("x.someone.github.io")).toBe("someone.github.io");
  });

  it("returns undefined for anything it cannot make a registrable domain of", () => {
    expect(registrableDomain("localhost")).toBeUndefined();
    expect(registrableDomain("co.uk")).toBeUndefined();
    expect(registrableDomain("127.0.0.1")).toBeUndefined();
    expect(registrableDomain("")).toBeUndefined();
  });
});

describe("derivedAllowedHosts (what a resolved entry may follow links to)", () => {
  it("is the homepage host, the docs host and docs.<registrable domain of homepage>, deduplicated", () => {
    expect(derivedAllowedHosts({ homepage: "https://hono.dev", docsUrl: undefined })).toEqual(["hono.dev", "docs.hono.dev"]);
    expect(derivedAllowedHosts({ homepage: "https://github.com/encode/httpx", docsUrl: "https://www.python-httpx.org" })).toEqual([
      "github.com",
      "www.python-httpx.org",
      "docs.github.com",
    ]);
    expect(derivedAllowedHosts({ homepage: "https://docs.acme.co.uk/", docsUrl: "https://docs.acme.co.uk/" })).toEqual([
      "docs.acme.co.uk",
    ]);
  });

  it("never derives a forbidden host and copes with missing input", () => {
    expect(derivedAllowedHosts({})).toEqual([]);
    expect(derivedAllowedHosts({ homepage: "https://localhost/", docsUrl: "https://10.0.0.1/" })).toEqual([]);
    expect(derivedAllowedHosts({ homepage: "http://hono.dev" })).toEqual([]); // not https → not trusted
  });
});

describe("sanitizeRemoteUrl (metadata values are attacker-influenced)", () => {
  it("returns a normalised https URL string for a sane value", () => {
    expect(sanitizeRemoteUrl("https://hono.dev")).toBe("https://hono.dev/");
    expect(sanitizeRemoteUrl(" https://tanstack.com/query ")).toBe("https://tanstack.com/query");
    expect(sanitizeRemoteUrl("https://Docs.Example.com/A#frag")).toBe("https://docs.example.com/A");
  });

  it.each([
    ["http", "http://hono.dev"],
    ["javascript", "javascript:alert(1)"],
    ["file", "file:///etc/passwd"],
    ["ftp", "ftp://hono.dev/x"],
    ["an IPv4 literal", "https://169.254.169.254/"],
    ["an IPv6 literal", "https://[::1]/"],
    ["localhost", "https://localhost:3000/"],
    ["a .internal host", "https://vault.internal/"],
    ["userinfo", "https://u:p@hono.dev/"],
    ["a single-label host", "https://hono/"],
    ["garbage", "not a url"],
    ["a non-string", 42],
    ["null", null],
    ["an over-long value", `https://hono.dev/${"a".repeat(2100)}`],
  ])("rejects %s", (_label, value) => {
    expect(sanitizeRemoteUrl(value)).toBeUndefined();
  });
});

/** PAR-817/PAR-816/PAR-818 (Phase 4) — the one shared redaction helper every display/storage
 *  surface in this phase calls. Findings #1, #11, #12 in the phase's own test plan. */
describe("redactUrlForDisplay (PAR-817 consolidation)", () => {
  it("strips the query string and fragment", () => {
    expect(redactUrlForDisplay("https://docs.internal.example.com/llms.txt?token=super-secret#section-2")).toBe(
      "https://docs.internal.example.com/llms.txt",
    );
  });

  it("(PAR-816) strips userinfo, not only the query string", () => {
    const redacted = redactUrlForDisplay("https://svc:s3cr3t-password@docs.internal.example.com/llms.txt?token=also-secret");
    expect(redacted).toBe("https://docs.internal.example.com/llms.txt");
    expect(redacted).not.toContain("s3cr3t-password");
    expect(redacted).not.toContain("svc");
    expect(redacted).not.toContain("@");
  });

  it("(PAR-816) on a parse failure, cuts at the first ? or # rather than returning the raw string whole", () => {
    expect(redactUrlForDisplay("not a valid url?token=super-secret")).toBe("not a valid url");
    expect(redactUrlForDisplay("not a valid url#token=super-secret")).toBe("not a valid url");
    // No `?` or `#` at all: nothing to cut, the original (still unparseable) string is returned.
    expect(redactUrlForDisplay("not a valid url at all")).toBe("not a valid url at all");
  });

  it("(PAR-818) documents the new-URL().href normalization side effect: lower-cased host, punycode, default port dropped", () => {
    expect(redactUrlForDisplay("https://Docs.Example.COM:443/x")).toBe("https://docs.example.com/x");
  });

  it("(PAR-818) punycodes a non-ASCII host as a side effect of the round trip", () => {
    expect(redactUrlForDisplay("https://例え.jp/x")).toBe("https://xn--r8jz45g.jp/x");
  });

  it("never returns nothing: a redacted value is always a non-empty string when the input was", () => {
    expect(redactUrlForDisplay("https://example.com?a=1")).toBeTypeOf("string");
    expect(redactUrlForDisplay("garbage?a=1")).toBeTypeOf("string");
  });

  /** code-reviewer S3 (Phase 4 round 2) — several call sites rely on a non-null assertion
   *  (`out.chosen!`) that is safe today only because of an unstated cross-module invariant; this
   *  function must not throw or render "undefined" if that invariant is ever wrong at runtime. */
  it("(code-reviewer S3) is defensive against a non-string input at runtime, despite its declared type", () => {
    expect(redactUrlForDisplay(undefined as unknown as string)).toBe("");
    expect(redactUrlForDisplay(null as unknown as string)).toBe("");
    expect(redactUrlForDisplay(42 as unknown as string)).toBe("");
  });
});
