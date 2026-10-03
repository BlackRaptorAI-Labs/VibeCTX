import { describe, it, expect } from "vitest";
import { derivedAllowedHosts } from "../src/link-policy.js";

/**
 * PAR-1044 (final audit I-4) — `docs.<registrable domain>` is derived for a package homepage only
 * when the homepage IS that domain (or its `www.`). A homepage on any other subdomain is on a
 * shared apex as far as this tool can tell (sites.google.com, a bucket under s3.amazonaws.com, a
 * wildcard-DNS name under nip.io), and the apex's `docs.` host belongs to someone else.
 */
describe("PAR-1044 (I-4): docs.<apex> only for the apex's own homepage", () => {
  it("PAR-1044 (I-4): shared-apex homepages derive no docs.<apex> host", () => {
    expect(derivedAllowedHosts({ homepage: "https://sites.google.com/view/pkg" })).not.toContain("docs.google.com");
    expect(derivedAllowedHosts({ homepage: "https://pkg-assets.s3.amazonaws.com/index.html" })).not.toContain("docs.amazonaws.com");
    expect(derivedAllowedHosts({ homepage: "https://169.254.169.254.nip.io/" })).not.toContain("docs.nip.io");
    expect(derivedAllowedHosts({ homepage: "https://sites.google.com/view/pkg" })).toContain("sites.google.com"); // the homepage host itself stays
  });

  it("PAR-1044 (I-4) guard: an apex or www homepage still derives docs.<apex>", () => {
    expect(derivedAllowedHosts({ homepage: "https://hono.dev" })).toContain("docs.hono.dev");
    expect(derivedAllowedHosts({ homepage: "https://www.example.com/pkg" })).toContain("docs.example.com");
  });
});
