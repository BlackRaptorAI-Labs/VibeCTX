import { promises as dnsPromises } from "node:dns";

/**
 * Resolved-address policy (PAR-851). `link-policy.ts`'s host checks are entirely TEXTUAL —
 * `127.0.0.1.nip.io` is a public-looking name that is never forbidden by string inspection,
 * yet resolves to a loopback address; nothing before this module ever asked what address a
 * name actually resolves to before connecting. This is the DNS-rebinding-class gap the
 * external audit verified against a fresh 255b935 build (F-6/G1, 2026-09-18): every host-policy
 * function accepted `127.0.0.1.nip.io`/`127.0.0.1.sslip.io` (host text alone) and no DNS
 * resolution existed anywhere on the fetch path. This module closes it: a fresh resolution
 * just before connecting, checked against real address ranges — not the hostname string.
 *
 * SCOPE. This module answers "is the address this hostname resolves to one we may connect
 * to?" It does not replace `isForbiddenHost` (which still runs first, cheaply, with no DNS,
 * and still refuses literal IPs / `.internal` / `.local` / single-label names by TEXT alone —
 * defense in depth: a name that is textually forbidden is refused before this module is ever
 * asked to resolve it). This module is the second, independent layer: a name that passes the
 * textual gate but resolves privately is what this closes.
 *
 * FAIL-OPEN ON A LOOKUP FAILURE BY DEFAULT, DELIBERATELY (a reasoned trade-off, not a loophole — see
 * point (1) of the residual disclosure below for the trade-off's real cost). A hostname that
 * cannot be resolved (NXDOMAIN, timeout, a sandboxed test double with no network) is not BY
 * ITSELF a rebinding risk. Refusing here on every lookup failure would be redundant with
 * `fetchUrl`'s own network-error handling immediately downstream (`classifyFetchError`'s `dns`
 * reason) and would turn every environment without live DNS — this project's own offline,
 * deterministic test suite among them, which fetches from `*.example.com`/`*.example.test`
 * fixture hosts under a stubbed `fetch` that never touches DNS today — into a mass refusal.
 *
 * RESIDUAL DISCLOSURE — three points, not one, for a complete picture (security-architect
 * review round 2; docs/decisions.md D-89b carries the same three points):
 *
 * (1) NOT A CONNECTION PIN, and the fail-open path above is a BYPASS VECTOR REQUIRING NO RACE
 *     AT ALL, not merely a narrow timing window. This module answers the question once,
 *     immediately before `fetchUrl`'s own `fetch()` call — it does not, and (absent a new
 *     dependency or a from-scratch rewrite of the transport onto `node:http`/`node:https`)
 *     cannot make the runtime's own `fetch()` connect to the EXACT address this module
 *     checked. The classical DNS-rebinding race (a resolver that changes its answer between
 *     this lookup and undici's own internal one a moment later) is one way through. A STRICTLY
 *     EASIER way through needs no race: an attacker's authoritative nameserver can simply fail
 *     or delay OUR lookup (triggering fail-open — "proceed") while answering undici's OWN,
 *     separate lookup a moment later with a private address. Winning a timing race and
 *     controlling which of two sequential queries gets which answer are not the same
 *     difficulty; the latter is well within an attacker-controlled nameserver's normal,
 *     everyday behavior (rate-limiting or NXDOMAIN-ing every Nth query is not exotic).
 * (2) THE WINDOW'S WIDTH IS A HOST-RESOLVER-CONFIGURATION QUESTION, not an elapsed-code-time
 *     one — "a narrow window" understates it on some real deployment targets. On a machine
 *     running a caching stub resolver in front of the real one (macOS's own resolver,
 *     systemd-resolved on most modern Linux desktops) this module's lookup and undici's own
 *     moments-later lookup both hit the LOCAL cache and get the identical, already-cached
 *     answer — genuinely narrow, close to zero in practice. On a host with no local caching
 *     layer (bare glibc `getaddrinfo` against a remote recursive resolver — the common shape
 *     of a minimal Linux container, which is exactly where this server is often deployed) BOTH
 *     lookups go out to the network independently, and the window is effectively as wide as
 *     the attacker's own resolver chooses to make it.
 * (3) IN THE PROJECT'S FAVOR, NOT JUST CAVEATS — vibectx is `https:`-only on every fetch path
 *     (`isPublicHttpsUrl`, `isAllowedLink`, `validateLibraryUrl` all require it, unconditionally,
 *     `allowInternalHosts` or not). A successful rebind therefore requires the INTERNAL host
 *     undici actually connects to to complete a TLS handshake presenting a certificate valid
 *     for the ATTACKER'S PUBLIC hostname — something an ordinary internal HTTP admin panel,
 *     metadata endpoint or dev server cannot do (it has no such certificate, and could not get
 *     one issued for a name it does not control from any publicly-trusted CA). The realistic
 *     residual this leaves is a BLIND, NON-EXFILTRATING SSRF / internal-reachability oracle —
 *     "is something listening at this internal address" via connection timing/success, not "read
 *     this internal service's response body" — not a full data-exfiltration primitive. A
 *     network that also runs its OWN internal PKI trusted by this process (matching the
 *     attacker's hostname to an internally-issued cert) would remove even that mitigation; that
 *     is a property of the deployment, not of this code, and is named here rather than assumed
 *     away.
 */

/** One resolved address, in the shape `node:dns`'s `lookup(host, { all: true })` already
 *  returns — kept as its own type so a test can inject a double with no dependency on `dns`
 *  itself. */
export interface ResolvedAddress {
  address: string;
  family: number;
}

/** Injectable seam (tests only; production code never sets this) — same shape as
 *  `dns.promises.lookup(hostname, { all: true })`. */
export type AddressLookup = (hostname: string) => Promise<ResolvedAddress[]>;

/** How long the DEFAULT lookup may take before this module gives up and fails open (see the
 *  module comment: a lookup that never resolves is not a rebinding risk either) — short enough
 *  that a captive/offline network never makes a `fetchUrl` call hang here waiting on DNS when
 *  the ordinary fetch immediately after would fail fast anyway. ASSUMED (docs/decisions.md).
 *
 *  `dns.promises.lookup` (below) is deliberately what this module uses, not a raw `dns.resolve*`
 *  call — it is the same primitive undici itself resolves hostnames with, so this check answers
 *  with the same semantics (OS resolver, `/etc/hosts`, NSS) the actual connection will use.
 *  ONE COST OF THAT CHOICE, disclosed rather than silently accepted: `dns.lookup` runs on
 *  Node's libuv THREADPOOL, whose default size is 4 regardless of how many fetches this
 *  process runs concurrently — so under sustained DNS pressure, effective fetch concurrency
 *  can bottleneck at 4 even though `fetcher.ts`'s own `FETCH_CONCURRENCY_LIMIT` is set to 6;
 *  that constant's "set above every local cap" rationale holds for the SEMAPHORE'S own limit,
 *  not for whatever the OS/runtime's own resolver concurrency happens to allow underneath it
 *  (see `FETCH_CONCURRENCY_LIMIT`'s own comment in `fetcher.ts`). */
export const ADDRESS_LOOKUP_TIMEOUT_MS = 2000;

async function defaultLookup(hostname: string): Promise<ResolvedAddress[]> {
  return dnsPromises.lookup(hostname, { all: true });
}

/** `hostname` resolved via `lookup` (default: the real one, timeboxed at
 *  `ADDRESS_LOOKUP_TIMEOUT_MS`), or `undefined` on any failure/timeout/empty result — the
 *  fail-open case the module comment documents. Never throws. */
async function resolve(hostname: string, lookup: AddressLookup): Promise<ResolvedAddress[] | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<ResolvedAddress[] | undefined>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(undefined), ADDRESS_LOOKUP_TIMEOUT_MS);
      timer.unref?.();
    });
    const result = await Promise.race([lookup(hostname), timeout]);
    return result && result.length > 0 ? result : undefined;
  } catch {
    return undefined;
  } finally {
    // Tidiness (code-reviewer nit, round 2): the timer is `unref()`'d so it was already
    // harmless left pending, but clearing it explicitly once the lookup wins the race means
    // nothing is left scheduled at all, not merely something that cannot keep the process alive.
    clearTimeout(timer);
  }
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4Octets(address: string): [number, number, number, number] | undefined {
  const m = IPV4_RE.exec(address);
  if (!m) return undefined;
  const parts = m.slice(1, 5).map(Number);
  if (parts.some((p) => p > 255)) return undefined;
  return parts as [number, number, number, number];
}

/**
 * RFC1918 private ranges, loopback (127.0.0.0/8), link-local (169.254.0.0/16, RFC3927), the
 * unspecified/"this network" range (0.0.0.0/8), Shared Address Space / CGNAT (100.64.0.0/10,
 * RFC6598) and the IETF Protocol Assignments block (192.0.0.0/24, RFC6890) — the IPv4 half of
 * the issue's explicit list ("private, loopback, or link-local"), plus two not-globally-
 * reachable ranges found missing at security-architect/code-reviewer review round 2 (both
 * independently, one by brute-forcing the classification against a reference implementation,
 * the other against the live IANA special-purpose-address registry): 100.64.0.0/10 is not a
 * theoretical gap — Alibaba Cloud's own instance-metadata endpoint is `100.100.100.200`,
 * squarely inside it, and would have sailed through the pre-review-round-2 classification
 * unrefused. 192.0.0.0/24 likewise — Oracle Cloud's metadata endpoint is `192.0.0.192`.
 */
export function isPrivateIPv4(address: string): boolean {
  const o = ipv4Octets(address);
  if (!o) return false;
  const [a, b, c] = o;
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24, IETF Protocol Assignments (RFC6890) — e.g. Oracle Cloud metadata (192.0.0.192)
  if (a === 169 && b === 254) return true; // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10, Shared Address Space / CGNAT (RFC6598) — e.g. Alibaba Cloud metadata (100.100.100.200)
  if (a === 0) return true; // "this network"
  // PAR-1044 (final audit L-3): the rest of the IANA special-purpose registry that is never a
  // public documentation host. 198.18.0.0/15 matters most in practice: VPN and proxy clients
  // hand out "fake-IP" answers from it that route to local services.
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15, benchmarking (RFC2544)
  if (a >= 224 && a <= 239) return true; // 224.0.0.0/4, multicast
  if (a >= 240) return true; // 240.0.0.0/4 reserved, incl. 255.255.255.255 broadcast
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1 (RFC5737)
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  return false;
}

/** Expand any valid textual IPv6 address (`::` compression, an embedded trailing IPv4 literal)
 *  to its eight lowercase, zero-padded hextets, or `undefined` if it does not parse. Zone IDs
 *  (`%eth0`) are stripped first — they select an interface, they are not part of the address. */
export function expandIPv6(raw: string): string[] | undefined {
  const address = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  const zoneIdx = address.indexOf("%");
  const a = (zoneIdx === -1 ? address : address.slice(0, zoneIdx)).toLowerCase();
  if (!/^[0-9a-f:.]+$/.test(a)) return undefined;
  const dcIdx = a.indexOf("::");
  if (a.indexOf("::", dcIdx + 1) !== -1) return undefined; // more than one "::"
  const head = dcIdx === -1 ? a : a.slice(0, dcIdx);
  const tail = dcIdx === -1 ? "" : a.slice(dcIdx + 2);
  const headParts = head === "" ? [] : head.split(":");
  const tailParts = tail === "" ? [] : tail.split(":");
  // An embedded IPv4 tail (`::ffff:127.0.0.1`) becomes two hextets.
  const last = tailParts[tailParts.length - 1];
  if (last !== undefined && last.includes(".")) {
    const v4 = ipv4Octets(last);
    if (!v4) return undefined;
    tailParts.pop();
    tailParts.push(((v4[0] << 8) | v4[1]).toString(16));
    tailParts.push(((v4[2] << 8) | v4[3]).toString(16));
  }
  const known = headParts.length + tailParts.length;
  if (dcIdx === -1) {
    if (known !== 8) return undefined;
  } else if (known > 7) {
    return undefined; // "::" must stand for at least one group
  }
  const missing = 8 - known;
  const zeros = dcIdx === -1 ? [] : Array<string>(missing).fill("0");
  const groups = [...headParts, ...zeros, ...tailParts];
  if (groups.length !== 8) return undefined;
  for (const g of groups) if (g.length === 0 || g.length > 4 || !/^[0-9a-f]{1,4}$/.test(g)) return undefined;
  return groups.map((g) => g.padStart(4, "0"));
}

/**
 * Loopback (`::1`), the unspecified address (`::`), unique-local (`fc00::/7` — RFC4193, the
 * IPv6 analogue of RFC1918), link-local (`fe80::/10`, RFC4291) and an IPv4-mapped address
 * (`::ffff:0:0/96`) whose EMBEDDED v4 address is itself private — the IPv6 half of the issue's
 * explicit list, including the ranges its own text warns are the ones "most implementations
 * forget."
 */
/** Two hextets (each `"XXXX"`, lowercase hex) read as a big-endian 32-bit value and rendered
 *  as a dotted-quad — the shared decoder every embedded-IPv4 form below uses. */
function hextetsToV4(hi: string, lo: string): string {
  return [parseInt(hi.slice(0, 2), 16), parseInt(hi.slice(2, 4), 16), parseInt(lo.slice(0, 2), 16), parseInt(lo.slice(2, 4), 16)].join(".");
}

/** `hextetsToV4` after XOR-ing each hextet with `0xffff` first — Teredo's own obfuscation
 *  (RFC4380 §4: the client's real external address is never written in the clear). */
function obfuscatedHextetsToV4(hi: string, lo: string): string {
  return hextetsToV4((parseInt(hi, 16) ^ 0xffff).toString(16).padStart(4, "0"), (parseInt(lo, 16) ^ 0xffff).toString(16).padStart(4, "0"));
}

/**
 * Loopback (`::1`), the unspecified address (`::`), unique-local (`fc00::/7` — RFC4193, the
 * IPv6 analogue of RFC1918), link-local (`fe80::/10`, RFC4291), and every address FORM that
 * carries an embedded IPv4 address — refused when that EMBEDDED address is itself private:
 * IPv4-mapped (`::ffff:0:0/96`), the deprecated IPv4-compatible form (`::a.b.c.d`, RFC4291
 * §2.5.5.1 — distinct from the mapped form only in that byte 10-11 is `0x0000` rather than
 * `0xffff`), NAT64 (`64:ff9b::/96`, RFC6052 — a DNS64 resolver on a NAT64 network SYNTHESIZES
 * exactly this shape for an IPv4-only name, which is what makes this range security-relevant
 * rather than a networking curiosity: on such a network, resolving `127.0.0.1.nip.io` yields
 * `64:ff9b::7f00:1`, the audit's own reproduction one layer down), 6to4 (`2002::/16`, RFC3056 —
 * bits 16-47) and Teredo (`2001::/32`, RFC4380 — bits 96-127, XOR-obfuscated, `hextetsToV4`'s
 * own sibling decodes it). Plus NAT64's LOCAL-USE prefix (`64:ff9b:1::/48`, RFC8215), refused
 * unconditionally rather than decoded — RFC6052's embedding algorithm for a non-/96 prefix
 * length reserves a variable-position all-zero byte that differs by prefix length, and this
 * whole /48 is reserved for local NAT64 use only (never a legitimate public documentation
 * site), so a precise per-address decode buys nothing a blanket refusal of the prefix does not
 * already give more simply. Found missing at security-architect/code-reviewer review round 2
 * (both independently — one via a brute-force check against a reference implementation, the
 * other against the live IANA special-purpose-address registries): NAT64 and 6to4/Teredo can
 * each synthesize or encapsulate a private v4 address behind what LOOKS like an ordinary global
 * IPv6 address, which is exactly the class of gap this module exists to close for IPv4.
 */
export function isPrivateIPv6(address: string): boolean {
  const groups = expandIPv6(address);
  if (!groups) return false;
  if (groups.every((g) => g === "0000")) return true; // "::" — unspecified, never a fetch target
  if (groups.slice(0, 7).every((g) => g === "0000") && groups[7] === "0001") return true; // ::1
  // IPv4-mapped (::ffff:a.b.c.d, groups[5]="ffff") and the deprecated IPv4-compatible form
  // (::a.b.c.d, groups[5]="0000") share one shape (groups[0..4] all zero) and differ only in
  // that one hextet; no real global-unicast address (2000::/3) can ever have groups[0]="0000",
  // so treating both the same way carries no false-positive risk against real public traffic.
  if (groups.slice(0, 5).every((g) => g === "0000") && (groups[5] === "ffff" || groups[5] === "0000")) {
    return isPrivateIPv4(hextetsToV4(groups[6]!, groups[7]!));
  }
  // NAT64 64:ff9b::/96 (RFC6052) — groups[0..1] fixed, groups[2..5] zero, v4 embedded plainly.
  if (groups[0] === "0064" && groups[1] === "ff9b" && groups.slice(2, 6).every((g) => g === "0000")) {
    return isPrivateIPv4(hextetsToV4(groups[6]!, groups[7]!));
  }
  // NAT64 local-use 64:ff9b:1::/48 (RFC8215) — reserved for local NAT64 only; refused outright.
  if (groups[0] === "0064" && groups[1] === "ff9b" && groups[2] === "0001") return true;
  // 6to4 2002::/16 (RFC3056) — v4 embedded in bits 16-47 (groups[1], groups[2]).
  if (groups[0] === "2002") return isPrivateIPv4(hextetsToV4(groups[1]!, groups[2]!));
  // Teredo 2001:0000::/32 (RFC4380) — client's real v4 embedded, XOR-obfuscated, in bits 96-127.
  if (groups[0] === "2001" && groups[1] === "0000") return isPrivateIPv4(obfuscatedHextetsToV4(groups[6]!, groups[7]!));
  const first = parseInt(groups[0]!, 16);
  if (first >= 0xfc00 && first <= 0xfdff) return true; // unique-local fc00::/7
  if (first >= 0xfe80 && first <= 0xfebf) return true; // link-local fe80::/10
  // PAR-1044 (final audit L-3): deprecated site-local (still routed locally by some stacks),
  // multicast, and the documentation prefix.
  if (first >= 0xfec0 && first <= 0xfeff) return true; // site-local fec0::/10 (RFC3879)
  if (first >= 0xff00) return true; // multicast ff00::/8
  if (groups[0] === "2001" && groups[1] === "0db8") return true; // documentation 2001:db8::/32 (RFC3849)
  return false;
}

/** `family` as `node:dns` reports it: `4` or `6` (never the string form some older Node
 *  typings still describe — this codebase's engines range only ever returns the number). */
export function isPrivateAddress(address: string, family: number): boolean {
  return family === 6 ? isPrivateIPv6(address) : isPrivateIPv4(address);
}

export type AddressCheckResult =
  | { ok: true; address?: ResolvedAddress }
  | { ok: false; reason: string };

export interface AddressCheckOptions {
  /** PAR-851 (Tom's decision, docs/decisions.md) — a private/loopback/link-local/unique-local
   *  answer is ACCEPTED, not refused, when true: the entry's own primary fetch, its redirect
   *  hops, and links followed from its documents. Absent/false: any private answer is refused,
   *  whatever the hostname text says. */
  allowInternalHosts?: boolean;
  /** Off by default: when enabled, a failed, empty, or timed-out preliminary lookup is
   * refused rather than allowed through the default fail-open path. This is still a pre-check,
   * not connection pinning: the runtime resolves again when it opens the HTTPS connection. */
  strictDns?: boolean;
  /** Test seam; production code never sets this. */
  lookup?: AddressLookup;
}

/**
 * Resolve `hostname` and decide whether the address(es) it maps to may be connected to.
 * Checks EVERY address the lookup returns (a multi-homed name is refused if any answer is
 * private and the caller has not opted in) — not just the first, since which address a Happy
 * Eyeballs-style connector picks is not this module's to predict. `ok: true` with no `address`
 * means the lookup failed/timed out (fail-open, see the module comment) or every check
 * genuinely passed with nothing to report; the caller does not need to distinguish the two —
 * both mean "proceed."
 */
export async function checkResolvedAddress(hostname: string, opts: AddressCheckOptions = {}): Promise<AddressCheckResult> {
  const results = await resolve(hostname, opts.lookup ?? defaultLookup);
  if (results === undefined) {
    if (opts.strictDns) {
      return { ok: false, reason: `DNS lookup for "${hostname}" failed, returned no addresses, or timed out (strict DNS is enabled)` };
    }
    return { ok: true }; // default fail-open: no answer to judge
  }
  for (const r of results) {
    if (isPrivateAddress(r.address, r.family) && !opts.allowInternalHosts) {
      return { ok: false, reason: `"${hostname}" resolves to ${r.address}, a private, loopback or link-local address` };
    }
  }
  return { ok: true, address: results[0] };
}
