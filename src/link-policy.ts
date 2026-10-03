/**
 * Allowed-host link policy (PAR-655). The single source of truth for "may a
 * content-derived URL be fetched?": the pre-check in get-docs.ts, the guard at the
 * top of fetchLinkedPage and the post-redirect check inside fetchUrl all call
 * `isAllowedLink`, so no caller can apply a weaker rule than another.
 *
 * Content-derived URLs (index links, redirect targets, package-registry metadata)
 * are untrusted input. Without this, a compromised docs page or a malicious package
 * could steer fetches at internal endpoints.
 *
 * This file is also the sole owner of the URL trust decision for a config-authored
 * library entry's `urls` (D-49): `config.ts` calls `validateLibraryUrl` rather than
 * re-implementing any part of the host check. Records D-47 / D-49.
 */

export interface LinkPolicy {
  /** Extra hosts a followed link may target. Bare hostnames, folded lowercase;
   *  `*.example.com` matches any subdomain (not the apex). Malformed entries are
   *  ignored by the matcher (they never match) and rejected by config validation. */
  allowedHosts?: string[];
  /** PAR-851 (Tom's decision, docs/decisions.md) — carried through from the owning entry's own
   *  `LibraryEntry.allowInternalHosts` (a `LibraryEntry` is passed directly as a `LinkPolicy`
   *  at every real call site, so this is not a second, separately-set flag). Read only by
   *  `fetcher.ts`'s resolved-address check (`address-policy.ts`) — this file's OWN functions
   *  (`isAllowedLink` included) never resolve DNS and are unaffected by it: whether a link's
   *  HOST is in scope at all is still decided purely by `isAllowedLink`'s existing textual
   *  rules (same-origin as the source document, or an explicit `allowedHosts` match); this
   *  flag only changes what happens when a host ALREADY in scope resolves to a private
   *  address. */
  allowInternalHosts?: boolean;
  /** Runtime-derived global strict-DNS policy. It does not expand link admission; it only
   * makes a failed preliminary address lookup fail closed for an already-admitted link. */
  strictDns?: boolean;
}

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_HOST_LENGTH = 253;
/** Metadata URL values longer than this are dropped unread. Exported (PAR-809, Phase 4) so
 *  `activity-log.ts`'s own historical `MAX_RAW_URL_CHARS` — an independent, undocumented
 *  duplicate of this exact 2048 value — imports it instead of re-declaring it: two constants
 *  that must always agree are one fact, not two (D-48's "one place states the fact" rule,
 *  applied here rather than merely pinned by a cross-check test — the simpler of PAR-809's two
 *  acceptable fixes, and the one chosen because the two call sites already share every other
 *  part of the shape they bound: a URL string headed for `new URL()`). */
export const MAX_REMOTE_URL_LENGTH = 2048;

/**
 * Hosts that are never fetched from a content-derived URL, whatever any allow-list
 * says: IP literals (v4, and v6 in either `[::1]` or bare form), `localhost` and its
 * subdomains, `.local` / `.internal` names, single-label names (which only
 * resolve inside a private search domain), and any host with a trailing dot.
 * Compared after lowercasing. Note that
 * the WHATWG URL parser normalises decimal / hex / short IPv4 forms
 * (`2130706433`, `0x7f.1`) to dotted quads before this sees them.
 */
export function isForbiddenHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  if (h.length === 0) return true;
  if (h.endsWith(".")) return true; // "localhost." / "x.internal." would slip past the suffix checks; a trailing dot has no legitimate use here
  if (h.startsWith("[") || h.includes(":")) return true; // IPv6 literal
  if (IPV4_RE.test(h)) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (!h.includes(".")) return true;
  return false;
}

/**
 * Validate one `allowedHosts` entry (config or persisted) and return its folded form.
 * Accepts a bare hostname of at least two labels, optionally prefixed by exactly one
 * `*.`; rejects schemes, paths, ports, userinfo, other wildcard positions, IP
 * literals and every host `isForbiddenHost` names. Throws with a message that
 * starts with `allowedHosts:` so config errors read naturally.
 */
export function normaliseAllowedHost(raw: unknown): string {
  const shown = typeof raw === "string" ? raw : JSON.stringify(raw);
  const fail = (why: string): never => {
    throw new Error(`allowedHosts: "${shown}" ${why}`);
  };
  if (typeof raw !== "string") return fail("must be a string");
  const value = raw.trim().toLowerCase();
  if (value.length === 0) return fail("is empty");
  let wildcard = false;
  let host = value;
  if (host.startsWith("*.")) {
    wildcard = true;
    host = host.slice(2);
  }
  if (host.includes("*")) return fail("may only use a single leading *. wildcard");
  if (/[:/@?#\\\s]/.test(host)) return fail("must be a bare hostname (no scheme, port, path or userinfo)");
  if (host.length > MAX_HOST_LENGTH) return fail(`is longer than ${MAX_HOST_LENGTH} characters`);
  const labels = host.split(".");
  if (labels.length < 2) {
    return fail(wildcard ? "needs at least two labels after the *. wildcard" : "must have at least two labels (no single-label hosts)");
  }
  for (const label of labels) if (!LABEL_RE.test(label)) return fail("is not a valid hostname");
  if (isForbiddenHost(host)) return fail("is a private, loopback or non-routable host");
  return wildcard ? `*.${host}` : host;
}

/**
 * Validate one library `urls` entry (D-47, D-49): must be a non-empty string that parses
 * as `https:`, carries no userinfo, and whose host `isForbiddenHost` does not name — unless
 * the config author set `allowInternalHosts` on that entry, the explicit per-entry opt-in for
 * the air-gapped / internal-docs case (documented in README.md's config-field reference). This
 * is the TEXTUAL half of that gate, run once at config-parse time; the config-authored value
 * still passes through this function unconditionally whatever the flag says (a literal IP or
 * `.internal` name in `urls` is always visible here as text). The RUNTIME, DNS-aware half — the
 * flag's now-widened scope (PAR-851, Tom's decision, docs/decisions.md D-89a): this entry's own
 * primary fetch, every redirect hop it follows, AND a link followed from its own document that
 * `isAllowedLink` already admits — lives in `address-policy.ts`'s `checkResolvedAddress`,
 * called from `fetcher.ts` on every hop, not here. This function has no DNS dependency and
 * never will; it stays a pure, synchronous text check. Throws with a message that starts with
 * `urls:` so config errors read naturally; returns nothing on success.
 */
export function validateLibraryUrl(raw: unknown, opts?: { allowInternalHosts?: boolean }): void {
  const shown = typeof raw === "string" ? raw : JSON.stringify(raw);
  const fail = (why: string): never => {
    throw new Error(`urls: "${shown}" ${why}`);
  };
  if (typeof raw !== "string" || raw.trim().length === 0) return fail("must be a non-empty string");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("must be a valid URL");
  }
  if (url.protocol !== "https:") return fail("must use https:");
  if (url.username !== "" || url.password !== "") return fail("must not include userinfo");
  if (!opts?.allowInternalHosts && isForbiddenHost(url.hostname)) return fail("is a private, loopback or non-routable host");
}

/** `pattern` is a value `normaliseAllowedHost` returned; `host` is a lowercase hostname. */
function hostMatchesPattern(host: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1); // ".example.com"
    return host.length > suffix.length && host.endsWith(suffix);
  }
  return host === pattern;
}

/**
 * May `linkUrl`, found in the document at `sourceUrl`, be fetched?
 *
 * - `https:` only; no userinfo; the target host must not be forbidden (see
 *   `isForbiddenHost`) — that holds even when the source document itself lives there.
 * - The source document's own host is always allowed, on the source's port exactly
 *   (an explicit non-default port must match; this is the 0.1.3 same-origin rule).
 * - Any other host must match an entry of `policy.allowedHosts` and use the default
 *   port. Policy entries are validated on the way in; a malformed one never matches.
 *
 * Path and query are not restricted. Returns false for anything unparseable.
 */
export function isAllowedLink(linkUrl: string, sourceUrl: string, policy?: LinkPolicy): boolean {
  // PAR-1044 (final audit I-1): the same bound registry metadata already has; a followed link
  // or redirect of hundreds of kilobytes is never a documentation page.
  if (linkUrl.length > MAX_REMOTE_URL_LENGTH) return false;
  let link: URL;
  let source: URL;
  try {
    link = new URL(linkUrl);
    source = new URL(sourceUrl);
  } catch {
    return false;
  }
  if (link.protocol !== "https:") return false;
  if (link.username !== "" || link.password !== "") return false;
  const host = link.hostname.toLowerCase();
  if (isForbiddenHost(host)) return false;
  if (host === source.hostname.toLowerCase()) return link.port === source.port;
  if (link.port !== "") return false;
  for (const raw of policy?.allowedHosts ?? []) {
    let pattern: string;
    try {
      pattern = normaliseAllowedHost(raw);
    } catch {
      continue;
    }
    if (hostMatchesPattern(host, pattern)) return true;
  }
  return false;
}

/**
 * Two-part public suffixes under which the registrable domain is three labels long.
 * Deliberately small — no dependency on the Public Suffix List. Anything not listed
 * here is treated as a one-part suffix, so `docs.foo.co.jp`-style hosts under an
 * unlisted country suffix derive `docs.co.jp` rather than `docs.foo.co.jp` (a host
 * that either does not exist or is not the project's; harmless but useless).
 */
const TWO_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk",
  "com.au", "net.au", "org.au", "edu.au",
  "co.nz", "net.nz", "org.nz",
  "co.jp", "ne.jp", "or.jp", "ac.jp",
  "co.kr", "co.za", "co.in", "co.il",
  "com.br", "net.br", "org.br",
  "com.cn", "net.cn", "org.cn",
  "com.mx", "com.ar", "com.tr", "com.sg", "com.hk", "com.tw",
  "github.io", "gitlab.io", "netlify.app", "vercel.app", "pages.dev", "web.app",
  "firebaseapp.com", "herokuapp.com", "readthedocs.io", "azurewebsites.net",
  "cloudfront.net", "amazonaws.com",
]);

/**
 * Conservative registrable domain: the last two labels, or the last three when the
 * last two are a listed two-part suffix. Undefined for forbidden hosts (IPs,
 * localhost, single labels) and for a bare suffix (`co.uk`).
 */
export function registrableDomain(hostname: string): string | undefined {
  const host = hostname.trim().toLowerCase();
  if (isForbiddenHost(host)) return undefined;
  const labels = host.split(".");
  if (labels.some((l) => l.length === 0)) return undefined;
  const lastTwo = labels.slice(-2).join(".");
  if (TWO_PART_SUFFIXES.has(lastTwo)) return labels.length >= 3 ? labels.slice(-3).join(".") : undefined;
  return lastTwo;
}

/**
 * PAR-817/PAR-816/PAR-818 (Phase 4) — THE ONE shared "make a URL safe to show or store"
 * function, consolidating what were three independent, near-duplicate implementations:
 * `retrieval.ts`'s `stripStampQuery` (PAR-811), `activity-log.ts`'s `sanitizeLoggedUrl`
 * (PAR-792, which `stripStampQuery`'s own comment already said it "deliberately mirrors"),
 * and this file's own `sanitizeRemoteUrl` (fragment-only, and also a VALIDATOR — see its own
 * comment for why it stays separate: this function does redaction, not trust decisions, and
 * lives here only because `link-policy.ts` is a low-level module every other file can import
 * without a cycle — verified: this file does not import `retrieval.ts` or `activity-log.ts`,
 * and nothing it exports needs to).
 *
 * Clears the query string, the fragment AND userinfo (username/password) — PAR-816's
 * consolidated hardening: neither `stripStampQuery` nor `sanitizeLoggedUrl` cleared userinfo
 * before PAR-811 round 2 added it to the stamp path alone, and this is the one place that
 * gap can no longer reopen in a fourth copy.
 *
 * PAR-816 — FAILS TOWARD SAFETY ON A PARSE FAILURE, NEVER TOWARD "return the raw string
 * whole": every current producer of a value that reaches this function has already been
 * validated by `sanitizeRemoteUrl`/`validateLibraryUrl` upstream, so a parse failure here
 * should be unreachable in practice — but this function's own safety must not rest on an
 * unstated cross-module invariant holding forever. On a parse failure this cuts the string at
 * its first `?` or `#` (PAR-816's own suggested fix) rather than returning it unchanged: a
 * string this function cannot even parse as a URL is exactly the shape most likely to be
 * garbage that still happens to contain a `?token=…`-shaped tail, and cutting it is strictly
 * safer than passing it through whole. This can still leave userinfo in an unparseable string
 * (there is no reliable, generic way to find `user:pass@` without a URL parser succeeding) —
 * a narrower residual than the pre-fix behaviour, not a new one.
 *
 * PAR-818 — DOCUMENTED NORMALIZATION SIDE EFFECT, not a bug to suppress: on a successful
 * parse, `new URL(url).href` also lower-cases the host, punycodes a non-ASCII host, drops an
 * explicit default port, resolves `.`/`..` path segments and adds a trailing slash to a bare
 * origin — all as a consequence of the round-trip this function needs anyway to clear
 * `.search`/`.hash`/`.username`/`.password`. Every one of those is either invisible or a
 * strict improvement for a render/storage path (punycoding in particular defuses an
 * IDN-homograph URL) — see `test/link-policy.test.ts` for the pinned case
 * (`https://Docs.Example.COM:443/x` → `https://docs.example.com/x`).
 */
export function redactUrlForDisplay(url: string): string {
  // code-reviewer S3 (Phase 4 round 2) — defensive against a non-string input reaching here at
  // runtime despite the `string` type this function declares: several call sites rely on a
  // non-null assertion (`out.chosen!`, `doc.chosen!`) that is safe today only because of an
  // unstated cross-module invariant (a particular field is always set on a particular success
  // path). PAR-816 already applied "don't let this function's own safety rest on an unstated
  // invariant" to the parse-failure branch below; the same reasoning extends to the input
  // itself — a stray `undefined`/`null` reaching a redaction call must never throw or print
  // "undefined" into a rendered response, it should simply produce nothing to show.
  if (typeof url !== "string") return "";
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.href;
  } catch {
    const cut = url.search(/[?#]/);
    return cut === -1 ? url : url.slice(0, cut);
  }
}

/**
 * Parse an attacker-influenced URL value (package metadata, persisted records):
 * must be a string of at most 2048 characters that parses as `https:` with no
 * userinfo and a non-forbidden host. Returns the normalised href without its
 * fragment, or undefined — callers skip a bad value, never fail on it.
 */
export function sanitizeRemoteUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (raw.length === 0 || raw.length > MAX_REMOTE_URL_LENGTH) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  if (isForbiddenHost(url.hostname)) return undefined;
  url.hash = "";
  return url.href;
}

/**
 * The hosts a *resolved* entry may follow links to, derived from its metadata and
 * never from anything it stored: the homepage host, the docs-URL host and
 * `docs.<registrable domain of the homepage>`. Deduplicated, forbidden hosts
 * dropped, non-https input ignored. Recomputed on every load of resolved.json so a
 * persisted record cannot widen its own allow-list.
 */
export function derivedAllowedHosts(meta: { homepage?: string; docsUrl?: string }): string[] {
  const hosts: string[] = [];
  const add = (h: string | undefined) => {
    if (h && !isForbiddenHost(h) && !hosts.includes(h)) hosts.push(h);
  };
  const homepage = sanitizeRemoteUrl(meta.homepage);
  const docs = sanitizeRemoteUrl(meta.docsUrl);
  if (homepage) add(new URL(homepage).hostname);
  if (docs) add(new URL(docs).hostname);
  if (homepage) {
    // PAR-1044 (final audit I-4): only when the homepage IS the registrable domain (or its
    // `www.`). On any other subdomain the apex may be shared (sites.google.com, a bucket under
    // s3.amazonaws.com, a nip.io name), and its `docs.` host belongs to someone else.
    const host = new URL(homepage).hostname.toLowerCase();
    const reg = registrableDomain(host);
    if (reg && (host === reg || host === `www.${reg}`)) add(`docs.${reg}`);
  }
  return hosts;
}
