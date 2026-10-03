import { describe, it, expect, vi } from "vitest";
import {
  isPrivateIPv4,
  isPrivateIPv6,
  isPrivateAddress,
  expandIPv6,
  checkResolvedAddress,
  ADDRESS_LOOKUP_TIMEOUT_MS,
} from "../src/address-policy.js";

describe("isPrivateIPv4", () => {
  it("flags RFC1918 private ranges", () => {
    expect(isPrivateIPv4("10.0.0.1")).toBe(true);
    expect(isPrivateIPv4("172.16.0.1")).toBe(true);
    expect(isPrivateIPv4("172.31.255.255")).toBe(true);
    expect(isPrivateIPv4("192.168.1.1")).toBe(true);
  });
  it("flags loopback and link-local", () => {
    expect(isPrivateIPv4("127.0.0.1")).toBe(true);
    expect(isPrivateIPv4("127.255.255.255")).toBe(true);
    expect(isPrivateIPv4("169.254.1.1")).toBe(true);
  });
  it("does not flag a public address, or a near-miss just outside a private range", () => {
    expect(isPrivateIPv4("8.8.8.8")).toBe(false);
    expect(isPrivateIPv4("93.184.216.34")).toBe(false);
    expect(isPrivateIPv4("172.32.0.1")).toBe(false); // just above 172.16.0.0/12
    expect(isPrivateIPv4("172.15.255.255")).toBe(false); // just below it
  });
  it("returns false for anything that is not a well-formed dotted quad", () => {
    expect(isPrivateIPv4("not-an-ip")).toBe(false);
    expect(isPrivateIPv4("999.0.0.1")).toBe(false);
  });

  /** Review round 2 (security-architect B1 / code-reviewer, independently converging): missing
   *  at least two live cloud-metadata endpoints before this. */
  it("flags 100.64.0.0/10 (Shared Address Space / CGNAT, RFC6598) at both ends of the range, including Alibaba Cloud's real metadata endpoint", () => {
    expect(isPrivateIPv4("100.64.0.0")).toBe(true);
    expect(isPrivateIPv4("100.100.100.200")).toBe(true); // Alibaba Cloud instance-metadata endpoint
    expect(isPrivateIPv4("100.127.255.255")).toBe(true);
  });
  it("does not flag just outside 100.64.0.0/10", () => {
    expect(isPrivateIPv4("100.63.255.255")).toBe(false);
    expect(isPrivateIPv4("100.128.0.0")).toBe(false);
  });
  it("flags 192.0.0.0/24 (IETF Protocol Assignments, RFC6890), including Oracle Cloud's real metadata endpoint", () => {
    expect(isPrivateIPv4("192.0.0.0")).toBe(true);
    expect(isPrivateIPv4("192.0.0.192")).toBe(true); // Oracle Cloud instance-metadata endpoint
    expect(isPrivateIPv4("192.0.0.255")).toBe(true);
  });
  it("does not flag just outside 192.0.0.0/24 (192.0.1.0 and 191.255.255.255)", () => {
    expect(isPrivateIPv4("192.0.1.0")).toBe(false);
    expect(isPrivateIPv4("191.255.255.255")).toBe(false);
  });
});

describe("expandIPv6", () => {
  it("expands a fully-written address unchanged (zero-padded)", () => {
    expect(expandIPv6("fe80:0:0:0:0:0:0:1")).toEqual(["fe80", "0000", "0000", "0000", "0000", "0000", "0000", "0001"]);
  });
  it("expands '::1' and '::'", () => {
    expect(expandIPv6("::1")).toEqual(["0000", "0000", "0000", "0000", "0000", "0000", "0000", "0001"]);
    expect(expandIPv6("::")).toEqual(["0000", "0000", "0000", "0000", "0000", "0000", "0000", "0000"]);
  });
  it("expands a leading/trailing/middle '::' compression", () => {
    expect(expandIPv6("2001:db8::1")).toEqual(["2001", "0db8", "0000", "0000", "0000", "0000", "0000", "0001"]);
    expect(expandIPv6("fe80::")).toEqual(["fe80", "0000", "0000", "0000", "0000", "0000", "0000", "0000"]);
  });
  it("expands an embedded trailing IPv4 literal", () => {
    expect(expandIPv6("::ffff:127.0.0.1")).toEqual(["0000", "0000", "0000", "0000", "0000", "ffff", "7f00", "0001"]);
  });
  it("strips a zone id and brackets", () => {
    expect(expandIPv6("[fe80::1%eth0]")).toEqual(["fe80", "0000", "0000", "0000", "0000", "0000", "0000", "0001"]);
  });
  it("returns undefined for garbage, an IPv4 address, or more than one '::'", () => {
    expect(expandIPv6("not-an-ip")).toBeUndefined();
    expect(expandIPv6("127.0.0.1")).toBeUndefined();
    expect(expandIPv6("::1::2")).toBeUndefined();
  });
});

describe("isPrivateIPv6", () => {
  it("flags loopback and the unspecified address", () => {
    expect(isPrivateIPv6("::1")).toBe(true);
    expect(isPrivateIPv6("::")).toBe(true);
  });
  it("flags unique-local (fc00::/7) at both ends of the range", () => {
    expect(isPrivateIPv6("fc00::1")).toBe(true);
    expect(isPrivateIPv6("fd12:3456:789a::1")).toBe(true);
    expect(isPrivateIPv6("fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff")).toBe(true);
  });
  it("flags link-local (fe80::/10) at both ends of the range", () => {
    expect(isPrivateIPv6("fe80::1")).toBe(true);
    expect(isPrivateIPv6("febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff")).toBe(true);
  });
  it("flags the boundaries around the unique-local / link-local ranges correctly (the boundary that is easy to get wrong)", () => {
    expect(isPrivateIPv6("fbff::1")).toBe(false); // just below fc00::/7
    expect(isPrivateIPv6("fe00::1")).toBe(false); // just below fe80::/10
    // Just above fe80::/10 is 0xfec0, the deprecated site-local range: PAR-1044 (final audit L-3)
    // refuses it too, so this boundary now answers private (see the L-3 tests below).
    expect(isPrivateIPv6("fec0::1")).toBe(true);
  });
  it("flags an IPv4-mapped address whose embedded v4 is private", () => {
    expect(isPrivateIPv6("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIPv6("::ffff:10.0.0.5")).toBe(true);
  });
  it("does not flag an IPv4-mapped address whose embedded v4 is public, or a real public IPv6 address", () => {
    expect(isPrivateIPv6("::ffff:8.8.8.8")).toBe(false);
    expect(isPrivateIPv6("2001:4860:4860::8888")).toBe(false); // a real public address (Google DNS)
  });

  /** Review round 2 (security-architect B1 / code-reviewer, independently converging via a
   *  brute-force reference check and the live IANA special-purpose-address registries). */
  it("flags the deprecated IPv4-compatible form (::a.b.c.d, distinct from ::ffff:a.b.c.d) when the embedded v4 is private", () => {
    expect(isPrivateIPv6("::10.0.0.1")).toBe(true);
    expect(isPrivateIPv6("::127.0.0.1")).toBe(true);
  });
  it("does not flag the IPv4-compatible form when the embedded v4 is public", () => {
    expect(isPrivateIPv6("::8.8.8.8")).toBe(false);
  });

  it("flags NAT64 (64:ff9b::/96, RFC6052) when the embedded v4 is private — the exact mechanism a DNS64 network would use to re-derive a loopback address from a public-looking name", () => {
    expect(isPrivateIPv6("64:ff9b::7f00:1")).toBe(true); // embeds 127.0.0.1
    expect(isPrivateIPv6("64:ff9b::a00:1")).toBe(true); // embeds 10.0.0.1
  });
  it("does not flag NAT64 when the embedded v4 is public", () => {
    expect(isPrivateIPv6("64:ff9b::808:808")).toBe(false); // embeds 8.8.8.8
  });
  it("flags the NAT64 local-use prefix (64:ff9b:1::/48, RFC8215) unconditionally — reserved for local NAT64 only", () => {
    expect(isPrivateIPv6("64:ff9b:1::1")).toBe(true);
    expect(isPrivateIPv6("64:ff9b:1:ffff:ffff:ffff:ffff:ffff")).toBe(true);
  });

  it("flags 6to4 (2002::/16, RFC3056) when the embedded v4 is private", () => {
    expect(isPrivateIPv6("2002:a00:1::")).toBe(true); // embeds 10.0.0.1
    expect(isPrivateIPv6("2002:7f00:1::")).toBe(true); // embeds 127.0.0.1
  });
  it("does not flag 6to4 when the embedded v4 is public", () => {
    expect(isPrivateIPv6("2002:808:808::")).toBe(false); // embeds 8.8.8.8
  });

  it("flags Teredo (2001:0000::/32, RFC4380) when the XOR-obfuscated embedded v4 is private", () => {
    expect(isPrivateIPv6("2001::3f57:fefe")).toBe(true); // obfuscated 192.168.1.1
  });
  it("does not flag Teredo when the obfuscated embedded v4 is public, and does not confuse a real public 2001:: address for Teredo", () => {
    expect(isPrivateIPv6("2001::f7f7:f7f7")).toBe(false); // obfuscated 8.8.8.8
    expect(isPrivateIPv6("2001:4860:4860::8888")).toBe(false); // groups[1] != 0000, not Teredo's own prefix
  });
});

describe("isPrivateAddress", () => {
  it("dispatches on family", () => {
    expect(isPrivateAddress("127.0.0.1", 4)).toBe(true);
    expect(isPrivateAddress("8.8.8.8", 4)).toBe(false);
    expect(isPrivateAddress("::1", 6)).toBe(true);
    expect(isPrivateAddress("2001:4860:4860::8888", 6)).toBe(false);
  });
});

describe("checkResolvedAddress", () => {
  it("refuses a public-looking name that resolves to a loopback address", async () => {
    const lookup = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]);
    const out = await checkResolvedAddress("attacker.example.com", { lookup });
    expect(out.ok).toBe(false);
    expect(lookup).toHaveBeenCalledWith("attacker.example.com");
  });

  it("refuses an RFC1918 answer, a link-local answer, and an IPv6 unique-local answer — four cases total with loopback above", async () => {
    for (const addr of [
      { address: "10.1.2.3", family: 4 },
      { address: "169.254.1.1", family: 4 },
      { address: "fd00::1", family: 6 },
    ]) {
      const lookup = vi.fn(async () => [addr]);
      const out = await checkResolvedAddress("attacker.example.com", { lookup });
      expect(out.ok, JSON.stringify(addr)).toBe(false);
    }
  });

  /** Review round 2 — end-to-end proof that `checkResolvedAddress` itself (not just the
   *  classification functions in isolation) refuses each newly-added range. */
  it("refuses a CGNAT (100.64.0.0/10) answer, an IETF-protocol-assignments (192.0.0.0/24) answer, and a NAT64-synthesized answer", async () => {
    for (const addr of [
      { address: "100.100.100.200", family: 4 }, // Alibaba Cloud metadata, inside 100.64.0.0/10
      { address: "192.0.0.192", family: 4 }, // Oracle Cloud metadata, inside 192.0.0.0/24
      { address: "64:ff9b::7f00:1", family: 6 }, // NAT64-synthesized loopback
    ]) {
      const lookup = vi.fn(async () => [addr]);
      const out = await checkResolvedAddress("attacker.example.com", { lookup });
      expect(out.ok, JSON.stringify(addr)).toBe(false);
    }
  });

  it("accepts a legitimate public address", async () => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    const out = await checkResolvedAddress("docs.example.com", { lookup });
    expect(out.ok).toBe(true);
  });

  it("honours allowInternalHosts: a private answer is accepted when the caller opted in", async () => {
    const lookup = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]);
    const out = await checkResolvedAddress("internal.example.com", { lookup, allowInternalHosts: true });
    expect(out.ok).toBe(true);
  });

  it("refuses when ANY resolved address is private, even if another is public", async () => {
    const lookup = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    const out = await checkResolvedAddress("multi.example.com", { lookup });
    expect(out.ok).toBe(false);
  });

  it("fails OPEN (proceeds) when the lookup throws — a hostname that cannot be resolved is not a rebinding risk", async () => {
    const lookup = vi.fn(async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    });
    const out = await checkResolvedAddress("nonexistent.example.test", { lookup });
    expect(out.ok).toBe(true);
  });

  it("fails OPEN when the lookup returns an empty array", async () => {
    const lookup = vi.fn(async () => []);
    const out = await checkResolvedAddress("empty.example.test", { lookup });
    expect(out.ok).toBe(true);
  });

  it.each([
    ["throws", async () => {
      throw new Error("ENOTFOUND");
    }],
    ["returns no addresses", async () => []],
  ])("strict DNS refuses when the lookup %s", async (_caseName, lookup) => {
    const out = await checkResolvedAddress("unavailable.example.test", { lookup, strictDns: true });
    expect(out).toMatchObject({ ok: false });
  });

  it("fails OPEN when the lookup never resolves within the timeout", async () => {
    const lookup = vi.fn(() => new Promise<never>(() => {})); // never settles
    const out = await checkResolvedAddress("slow.example.test", { lookup });
    expect(out.ok).toBe(true);
  }, ADDRESS_LOOKUP_TIMEOUT_MS + 2000);

  it("strict DNS refuses when the lookup times out", async () => {
    vi.useFakeTimers();
    try {
      const lookup = vi.fn(() => new Promise<never>(() => {}));
      const pending = checkResolvedAddress("slow.example.test", { lookup, strictDns: true });
      await vi.advanceTimersByTimeAsync(ADDRESS_LOOKUP_TIMEOUT_MS);
      expect(await pending).toMatchObject({ ok: false });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("PAR-1044 (final audit L-3): the remaining special-purpose ranges are refused", () => {
  it("PAR-1044 (L-3): benchmarking, multicast, reserved, broadcast and the three TEST-NET ranges are private IPv4", () => {
    for (const address of ["198.18.0.1", "198.19.255.254", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255", "192.0.2.10", "198.51.100.10", "203.0.113.10"]) {
      expect(isPrivateIPv4(address), address).toBe(true);
    }
  });

  it("PAR-1044 (L-3): site-local, multicast and documentation IPv6 ranges are private", () => {
    for (const address of ["fec0::1", "feff::1", "ff02::1", "ff00::", "2001:db8::1", "2001:0db8:ffff::1"]) {
      expect(isPrivateIPv6(address), address).toBe(true);
    }
  });

  it("PAR-1044 (L-3): the new IPv4 ranges are refused inside IPv4-mapped, NAT64 and 6to4 forms too", () => {
    for (const address of ["::ffff:198.18.0.1", "64:ff9b::c612:1", "2002:c612:1::1", "::ffff:224.0.0.1", "::ffff:203.0.113.5"]) {
      expect(isPrivateIPv6(address), address).toBe(true);
    }
  });

  it("PAR-1044 (L-3) guard: the neighbouring public addresses stay public", () => {
    for (const address of ["198.17.255.255", "198.20.0.1", "223.255.255.254", "192.0.3.1", "198.51.101.1", "203.0.114.1", "93.184.216.34"]) {
      expect(isPrivateIPv4(address), address).toBe(false);
    }
    for (const address of ["2001:db9::1", "2606:4700::1111", "fe7f::1"]) {
      expect(isPrivateIPv6(address), address).toBe(false);
    }
  });
});
