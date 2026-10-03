import type { LibraryEntry } from "./registry.js";
import { readCache, writeCache, touchCache, type CacheHit } from "./cache.js";
import { isAllowedLink, isForbiddenHost, type LinkPolicy, MAX_REMOTE_URL_LENGTH } from "./link-policy.js";
import { USER_AGENT } from "./version.js";
import { classifyFetchError, debugEvent } from "./debug.js";
import { checkResolvedAddress, type AddressLookup } from "./address-policy.js";
import { Semaphore } from "./concurrency.js";

export { isAllowedLink, type LinkPolicy } from "./link-policy.js";

export interface DocResult {
  content: string;
  /** The CANDIDATE URL this document was requested under — one of `entry.urls`, or the link
   *  extracted from an index page. Stays the cache/search-index key throughout (D-74, PAR-776):
   *  `writeCache`/`readCache` are keyed by this value, and `search-index.ts`'s hash+url gate
   *  correlates against it, so it must never be silently replaced by `finalUrl` below — doing
   *  so would make every redirected document's index entry permanently "not this URL" and
   *  force a full re-tokenization on every search, forever. */
  url: string;
  /** PAR-776 (D-74) — the URL this content was ACTUALLY served from: `url` above unless a
   *  redirect moved the fetch elsewhere, in which case this is where it landed. `get-docs.ts`
   *  uses THIS, not `url`, to resolve the document's own relative links and to decide which
   *  hosts its followed links may reach — a primary document that redirects cross-host used to
   *  resolve its relative links against the ORIGINAL host, which is wrong (they were never
   *  served from there) and could refuse a link that is actually same-origin with the document
   *  as fetched, or (less likely, but not excluded) allow one that is not. Equal to `url` when
   *  there was no redirect, including every cache-hit path that never asked the network at all
   *  and has no live `fetchUrl` result to consult — see `cache-meta.ts`'s `CacheMeta.finalUrl`
   *  for how this survives past the fetch that first observed it. */
  finalUrl: string;
  /** A17/PAR-726: when this document's cache meta was last written, ISO — the exact value
   *  persisted by `writeCache`/`touchCache`, not a freshly-taken `new Date()` that could
   *  disagree with it. */
  fetchedAt: string;
  /** A17/PAR-726: past this document's TTL. Structurally identical to `staleNote !== undefined`
   *  today (every path below that omits `staleNote` also served a definitely-fresh copy), kept
   *  as its own field rather than re-derived so a caller reads staleness without parsing prose.
   *  Distinct from `notModified` below, not a THIRD copy of the same fact (code-reviewer, A17
   *  round 1, S4): `stale`/`staleNote` answer "is this copy past TTL" (true only on the
   *  network-unreachable fallback path); `notModified` answers "was THIS fetch a 304
   *  revalidation of already-fresh content" (true only on that path) — the two conditions are
   *  mutually exclusive by construction, never set together. */
  stale: boolean;
  /** PAR-744 (F-7) — true when this content is the SAME bytes already cached, confirmed by a
   *  304 Not Modified revalidation rather than downloaded fresh. `refresh.ts` uses this
   *  (alongside `staleNote`, see `isDocUnchanged` below) to decide whether a refresh actually
   *  changed anything: a caller that drops a library's followed-page cache on every
   *  "successful" refresh, without this distinction, drops it even when nothing changed (see
   *  `dropFollowedPageCache`'s own doc comment in cache.ts). ETag-only (code-reviewer, round
   *  1, S3): `fetchUrl` sends `if-none-match` and nothing else — no `if-modified-since` /
   *  `last-modified` support exists anywhere in this codebase — so a docs site that serves no
   *  `etag` can never produce a 304 here and still drops its followed pages on every refresh,
   *  exactly as before this item. */
  notModified?: true;
  /** Present when the network failed and cached content past its TTL was served. */
  staleNote?: string;
}

/** PAR-744 (F-7, code-reviewer round 1, N1) — the one predicate for "this `DocResult` is not
 *  NEW content", used identically by both `refresh.ts` (guarding the direct-fetch drop) and
 *  `resolve.ts` (deriving `ResolveOutcome.unchanged` for the resolved-entry drop), so the two
 *  guards are structurally the same rule rather than two hand-written spellings that happen to
 *  agree. True for a 304 revalidation (`notModified`) or a stale-cache fallback because the
 *  network was unreachable (`staleNote`) — in both cases the primary document on disk was not
 *  rewritten (see `dropFollowedPageCache`'s doc comment in cache.ts for why that is the
 *  correct predicate, not "did the origin server confirm nothing changed"). */
export function isDocUnchanged(doc: Pick<DocResult, "notModified" | "staleNote">): boolean {
  return doc.notModified === true || doc.staleNote !== undefined;
}

const DEFAULT_TTL_HOURS = 168; // 7 days

/** Largest primary document (llms-full.txt etc.) we will download. Prisma's
 *  llms-full.txt is ~5 MB (CITED: PAR-706 rework note), so this leaves headroom. */
export const PRIMARY_DOC_MAX_BYTES = 25 * 1024 * 1024;
/** Largest single followed index page we will download. */
export const LINKED_PAGE_MAX_BYTES = 2 * 1024 * 1024;

export interface FetchOutcome {
  /** `refused`: a redirect target or the final URL failed the guard (left the allowed
   *  hosts, or was not https on a public host) — never requested, body never read.
   *  `too-large`: exceeded `maxBytes`. `miss`: HTTP failure, > MAX_REDIRECT_HOPS, or no Location. */
  status: "ok" | "not-modified" | "miss" | "refused" | "too-large";
  body?: string;
  etag?: string;
  /** A16/PAR-725 — the response's HTTP status code, set only on the `"http-status"` miss
   *  reason (a real response was received and `!res.ok`). Every OTHER `miss` reason (a
   *  redirect loop, an unparsable Location, html-served-as-200, a thrown network error) has
   *  no real status to report and leaves this undefined — a caller that needs "was this
   *  genuinely a 404" (the registry-metadata existence check `resolve.ts` needs to
   *  distinguish "package does not exist" from "network unreachable") must check this field,
   *  not merely `status === "miss"`, which conflates both. */
  httpStatus?: number;
  /** Safe failure class for update guidance. Never contains a raw URL or exception text. */
  failureKind?: "network" | "aborted" | "html-response";
  /** PAR-776 (D-74) — the URL this request actually landed on after following redirects
   *  (`final` below), present whenever a response was actually obtained (`ok` and
   *  `not-modified` — a 304 still follows redirects to reach whichever server answered it).
   *  Equal to the requested `url` when nothing redirected. Absent on `refused`/`too-large`/
   *  `miss`: no content was ever accepted from those, so there is nothing for a caller to
   *  attribute to a "final" URL. */
  finalUrl?: string;
}

export interface FetchOptions {
  etag?: string;
  /** PAR-1044 (final audit I-2): the URL whose host issued `etag` (the cached copy's final URL;
   *  defaults to the first URL). The validator is sent only to that host, on whichever hop
   *  reaches it, and never to any other. */
  etagUrl?: string;
  /** Hard cap on the downloaded body; enforced via Content-Length and while streaming. */
  maxBytes: number;
  /** When set, the response's final URL must pass `isAllowedLink` against this source
   *  document and policy — the same function the pre-fetch guard applied to the link. */
  linkGuard?: { sourceUrl: string; policy?: LinkPolicy };
  /** When set, the FIRST URL is content-derived too (resolved entries, registry metadata):
   *  the final URL must be https on a non-forbidden host even when no redirect happened.
   *  Redirect targets are held to that baseline for every caller (see hopAllowed). */
  publicFinalUrl?: boolean;
  /** PAR-832a — sent as the `Accept` header, when set; absent (the default) sends no `Accept`
   *  header at all, exactly as before this option existed. SCOPE: `fetchLinkedPage` sets this
   *  for followed index links; `getLibraryDoc` (the primary-document path) deliberately never
   *  does — content negotiation on the primary path could change what gets cached for a
   *  library that already works today, a far larger blast radius than the followed-link gap
   *  this exists to close. */
  accept?: string;
  /** PAR-851 (Tom's decision, docs/decisions.md) — when true, a resolved address that is private,
   *  loopback, link-local or unique-local is ACCEPTED rather than refused, for this whole call:
   *  the primary fetch, every redirect hop it follows, and (via `fetchLinkedPage`'s own use of
   *  this option) a followed link whose source document belongs to the same opted-in entry.
   *  Absent/false (the default): any private resolved address is refused regardless of what
   *  the hostname TEXT says (`isForbiddenHost` already refuses the textually-obvious cases;
   *  this is the second, DNS-aware layer — see `address-policy.ts`'s own module comment). */
  allowInternalHosts?: boolean;
  /** Off by default: refuse if the preliminary DNS lookup fails, is empty, or times out.
   * This closes the fail-open pre-check path but does not pin the later HTTPS connection. */
  strictDns?: boolean;
  /** Test seam (PAR-851): overrides the DNS lookup `checkResolvedAddress` uses. Production
   *  code never sets this — see `address-policy.ts`. */
  lookup?: AddressLookup;
  /** PAR-853 — combined with the per-hop 20 s timeout via `AbortSignal.any`: whichever fires
   *  first aborts the in-flight request. Shared across every hop and candidate of ONE logical
   *  operation (one `getLibraryDoc` call, in practice — see that function) so a redirect chain
   *  or a many-candidate entry cannot outlast a stated ceiling by restarting the clock on each
   *  hop the way the per-hop timeout alone does (F-8: measured 120 s worst case per `fetchUrl`
   *  call, unbounded across an entry's candidate list before this). Also doubles as caller
   *  cancellation: `server.ts` threads the MCP request's own `AbortSignal` in here for
   *  `get_docs`/`refresh`, so a client that gives up actually stops the in-flight fetch rather
   *  than it running to completion unobserved. */
  operationSignal?: AbortSignal;
}

/** https, no userinfo, on a host `isForbiddenHost` does not name; false for anything
 *  unparseable. The userinfo check (security-architect, PAR-776 round 1, N-3) matches every
 *  other URL-trust gate in this codebase (`link-policy.ts`'s `sanitizeRemoteUrl`,
 *  `validateLibraryUrl`, `isAllowedLink`) — this was the one gate in the redirect path that
 *  didn't, so a hop or final URL carrying `user:pass@` (the redirecting server's own, not the
 *  caller's) was accepted, then persisted (`cache.ts`'s `finalUrl`) and rendered into the
 *  response. Not a credential-theft primitive either way — this process never had a credential
 *  of its own to leak — but there's no reason this one check should be the odd one out. */
export function isPublicHttpsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.username === "" && u.password === "" && !isForbiddenHost(u.hostname);
  } catch {
    return false;
  }
}

/** Redirect hops followed per request; beyond this the fetch is a miss. */
export const MAX_REDIRECT_HOPS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** PAR-853 — the whole-operation deadline: shared across every candidate URL AND every
 *  redirect hop of ONE `getLibraryDoc` call, so the clock does not restart per hop or per
 *  candidate the way the per-hop `AbortSignal.timeout(20_000)` below does on its own (F-8:
 *  measured worst case 120 s for one `fetchUrl` call — a redirect chain each hop just under the
 *  per-hop timeout — times an UNCAPPED candidate count before this). ASSUMED (docs/decisions.md):
 *  not a measurement of real-world docs-site latency, a judgement that one operation's total
 *  network time should be boundable to "about a minute, worst case" regardless of how many
 *  candidates or hops it takes to get there — generous next to a single legitimate fetch
 *  (typically well under a second), firm against a pathological candidate list or redirect
 *  chain. The per-hop timeout stays: it is still what bounds ONE stalled request against a
 *  server that accepts the connection and then never answers. */
export const OPERATION_DEADLINE_MS = 60_000;

/** PAR-853 — the one process-wide fan-out ceiling every network fetch this process makes goes
 *  through (`fetchUrl`, below): `get_docs`, `refresh`, `resolve_library`, `warm_project`,
 *  `doctor` and the startup autowarm all fetch through this same function, so this is a
 *  genuinely SHARED limit, not a second, uncoordinated one layered next to `AUTOWARM_CONCURRENCY`
 *  (2, `autowarm.ts`), `WARM_CONCURRENCY` (4, `warm.ts`) or `DOCTOR_CONCURRENCY` (3, `doctor.ts`)
 *  — those bound how many ENTRIES one of those operations processes in parallel; this bounds how
 *  many requests are in flight across the WHOLE process at once, which none of them, and no
 *  interactive `get_docs`/`refresh` call, had before this (F-8: N concurrent tool calls could
 *  each spawn their own unbounded fan-out with no common ceiling). ASSUMED (docs/decisions.md): set
 *  above every individual operation's own local cap (so a single operation is never serialised
 *  BELOW its own already-tested concurrency by this outer limit landing in the same PR) while
 *  still bounding the aggregate a local, single-user machine reasonably fields at once. */
export const FETCH_CONCURRENCY_LIMIT = 6;

const fetchLimiter = new Semaphore(FETCH_CONCURRENCY_LIMIT);

/**
 * May a redirect target (or the final URL) be requested under `opts`? Every redirect
 * target — whoever configured the first URL — must be https on a public host: an
 * operator's curated primary may redirect across hosts (D-04) but never to http, an IP
 * literal or localhost. On top of that, the caller's guard applies: `linkGuard` runs
 * `isAllowedLink` (the same function as the pre-fetch check); `publicFinalUrl` is the
 * baseline itself.
 */
function hostOf(u: string): string | undefined {
  try {
    return new URL(u).host;
  } catch {
    return undefined;
  }
}

function hopAllowed(target: string, opts: FetchOptions): boolean {
  if (target.length > MAX_REMOTE_URL_LENGTH) return false; // PAR-1044 (I-1)
  if (!isPublicHttpsUrl(target)) return false;
  if (opts.linkGuard !== undefined && !isAllowedLink(target, opts.linkGuard.sourceUrl, opts.linkGuard.policy)) return false;
  return true;
}

/** PAR-1034 (final audit M-3): `res.url` is WHATWG-serialised (`https://127.0.0.1:8443/`) and
 *  carries no fragment; a configured url may be neither (`https://127.0.0.1:8443`, `…/a#b`).
 *  Compare serialised forms without the fragment, so the operator's own first URL is never
 *  mistaken for a redirect to another host. */
function sameUrl(final: string, configured: string): boolean {
  if (final === configured) return true;
  try {
    const href = new URL(configured);
    href.hash = "";
    return final === href.href;
  } catch {
    return false;
  }
}

/** Read a body up to `maxBytes`; `undefined` once the cap is exceeded (the stream
 *  is cancelled so no further bytes are pulled). */
async function readBodyCapped(res: Response, maxBytes: number): Promise<string | undefined> {
  if (!res.body) {
    const text = await res.text();
    return text.length > maxBytes ? undefined : text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/** One capped, timed-out GET. Exported for the resolver's registry-metadata lookups
 *  (which need the same byte cap and HTML-as-200 detection); everything else goes
 *  through getLibraryDoc / fetchLinkedPage. */
export async function fetchUrl(url: string, opts: FetchOptions): Promise<FetchOutcome> {
  // PAR-652 item 7b: VIBECTX_DEBUG diagnostics are ADDITIVE — every `debugEvent` below is a
  // stderr line and nothing else. No policy, redirect decision, byte cap or returned value
  // in this function is read from, or changed by, any of them. Nor can one THROW past a
  // return: `debugEvent` never raises (PAR-652b), which is what makes the call in the catch
  // block below safe — a diagnostic must not turn a handled failure into an unhandled one.
  //
  // Three event names, one per outcome, and `reason` names the specific cause within it
  // (PAR-652c, review R4 — `refused` and `too-large` used to return silently while the README
  // promised a line for every fetch failure, so the two outcomes a user is most likely to need
  // explained were the two with nothing to explain them):
  //   fetch.miss       http-status · html-not-text · empty-body · redirect-no-location ·
  //                    redirect-hops · redirect-unparsable · not-modified-uncached (PAR-789 —
  //                    a 304 answered with no If-None-Match sent) · and the thrown-error reasons
  //                    `classifyFetchError` returns (timeout, dns, connection-refused, …)
  //   fetch.refused    not-public · redirect-host · final-host · link-policy ·
  //                    resolved-address (PAR-851 — a textually-fine hostname resolved to a
  //                    private, loopback, link-local or unique-local address)
  //   fetch.too-large  content-length (declared, refused before the body is read) · body-cap
  //                    (the cap hit mid-stream, so the true size is unknown)
  // A `refused` line names the target it refused in `to=` when a redirect moved it — that is
  // the whole diagnostic value, and it is the URL the guard already decided against, never a
  // URL that was fetched. Every return path in this function now emits exactly one line.
  const startedAt = Date.now();
  // PAR-853 — checked BEFORE even queueing for a concurrency slot: once the whole-operation
  // deadline (or the caller's own cancellation) has already fired, a fresh candidate URL in the
  // same `getLibraryDoc` loop must fail immediately, not spend a DNS lookup and a fetch attempt
  // finding that out — this is what turns "many-candidate entry, all slow" into a bounded total
  // regardless of how many candidates remain, rather than one abort per candidate in sequence.
  if (opts.operationSignal?.aborted) {
    debugEvent("fetch.miss", { url, reason: "operation-deadline", ms: Date.now() - startedAt });
    return { status: "miss" };
  }
  // PAR-853 — the one process-wide fetch-concurrency ceiling. Acquired for the FULL lifetime
  // of this call (every hop, not just the first request) and released via `finally` below so a
  // thrown error, an early `return`, or the address/host guards refusing before any request is
  // ever made all still free the slot.
  const releaseFetchSlot = await fetchLimiter.acquire();
  try {
    const headers: Record<string, string> = {
      "user-agent": USER_AGENT, // src/version.ts — the manifest's version, not a second copy of it
    };
    if (opts.accept) headers["accept"] = opts.accept;
    let etagHost: string | undefined;
    try {
      etagHost = opts.etag ? new URL(opts.etagUrl ?? url).host : undefined;
    } catch {
      etagHost = undefined;
    }
    // Redirects are followed by hand (S1, PAR-655 security gate): with redirect:"follow"
    // the runtime would issue the request to the Location before any check could run —
    // a blind SSRF for a 302 to http://127.0.0.1/. Each Location is checked BEFORE it is
    // requested; on refusal no request is made.
    if (opts.publicFinalUrl && !isPublicHttpsUrl(url)) {
      // content-derived first URL: checked before requesting, so no request is made
      debugEvent("fetch.refused", { url, reason: "not-public", ms: Date.now() - startedAt });
      return { status: "refused" };
    }
    let current = url;
    let res: Response;
    for (let hop = 0; ; hop++) {
      // PAR-853 — the deadline may have fired while a PREVIOUS hop's own 20 s request was
      // in flight (its `AbortSignal.any` already caught that case) or between hops (this
      // check). Same reasoning as the pre-loop check above, one level down.
      if (opts.operationSignal?.aborted) {
        debugEvent("fetch.miss", { url, reason: "operation-deadline", to: current, ms: Date.now() - startedAt });
        return { status: "miss" };
      }
      // PAR-851 — resolve THIS hop's hostname and check the answer immediately before
      // connecting: `isForbiddenHost` (above, `isPublicHttpsUrl`/`hopAllowed`) is textual only
      // and never sees a name that RESOLVES privately (`127.0.0.1.nip.io` is the audit's own
      // example). Applied on every hop, not just the first — a redirect target is exactly as
      // able to resolve privately as the entry's own primary URL. An unparseable `current`
      // (should not happen — every producer of it already round-tripped through `new URL()`)
      // skips the check rather than refusing: the ordinary `fetch()` call two lines down will
      // throw on the same malformed value and be classified by the existing catch below,
      // exactly as it was before this check existed.
      const hopHostname = (() => {
        try {
          return new URL(current).hostname;
        } catch {
          return undefined;
        }
      })();
      if (hopHostname !== undefined) {
        const addrCheck = await checkResolvedAddress(hopHostname, {
          allowInternalHosts: opts.allowInternalHosts,
          strictDns: opts.strictDns,
          lookup: opts.lookup,
        });
        if (!addrCheck.ok) {
          debugEvent("fetch.refused", { url, reason: "resolved-address", to: current, detail: addrCheck.reason, ms: Date.now() - startedAt });
          return { status: "refused" };
        }
      }
      const signal = opts.operationSignal ? AbortSignal.any([AbortSignal.timeout(20_000), opts.operationSignal]) : AbortSignal.timeout(20_000);
      // PAR-1044 (I-2): the validator goes only to the host that issued it.
      if (opts.etag && etagHost !== undefined && hostOf(current) === etagHost) headers["if-none-match"] = opts.etag;
      else delete headers["if-none-match"];
      res = await fetch(current, {
        headers,
        redirect: "manual",
        signal,
      });
      if (!REDIRECT_STATUSES.has(res.status)) break;
      const location = res.headers.get("location");
      await res.body?.cancel();
      if (location === null || hop >= MAX_REDIRECT_HOPS) {
        debugEvent("fetch.miss", {
          url,
          reason: location === null ? "redirect-no-location" : "redirect-hops",
          status: res.status,
          ms: Date.now() - startedAt,
        });
        return { status: "miss" };
      }
      let next: string;
      try {
        next = new URL(location, current).href; // relative Locations resolve against the current URL
      } catch {
        debugEvent("fetch.miss", { url, reason: "redirect-unparsable", status: res.status, ms: Date.now() - startedAt });
        return { status: "miss" };
      }
      if (!hopAllowed(next, opts)) {
        debugEvent("fetch.refused", { url, reason: "redirect-host", to: next, status: res.status, ms: Date.now() - startedAt });
        return { status: "refused" };
      }
      current = next;
    }
    // Final-URL check kept: should a runtime report a different res.url, judge that too.
    // (No redirect happened when res.url equals the operator's own first URL.)
    const final = res.url || current;
    if (!sameUrl(final, url) && !hopAllowed(final, opts)) {
      await res.body?.cancel();
      debugEvent("fetch.refused", { url, reason: "final-host", to: final, status: res.status, ms: Date.now() - startedAt });
      return { status: "refused" };
    }
    if (opts.linkGuard !== undefined && !isAllowedLink(final, opts.linkGuard.sourceUrl, opts.linkGuard.policy)) {
      await res.body?.cancel();
      debugEvent("fetch.refused", { url, reason: "link-policy", to: final, status: res.status, ms: Date.now() - startedAt });
      return { status: "refused" };
    }
    if (opts.publicFinalUrl && !isPublicHttpsUrl(final)) {
      await res.body?.cancel();
      debugEvent("fetch.refused", { url, reason: "not-public", to: final, status: res.status, ms: Date.now() - startedAt });
      return { status: "refused" };
    }
    if (res.status === 304) {
      // PAR-789 — every other early return in this function consumes the body (`res.body?.cancel()`)
      // before returning; this one did not. A 304 response is defined to carry no body, but
      // relying on that rather than the same discipline every other branch already follows is
      // exactly the kind of asymmetry this phase's own theme is about closing.
      await res.body?.cancel();
      // PAR-789 — an UNSOLICITED 304 (this call sent no `If-None-Match` at all — `opts.etag` is
      // undefined — yet the server answered 304 anyway) is silently skipped by every caller
      // (`getLibraryDoc`/`fetchLinkedPage` only act on `not-modified` when they ALSO have a
      // cached copy to revalidate), unlike every other skip/refusal/miss reason this function
      // already logs. Diagnostic only — `status` is still `not-modified`, unchanged for callers.
      if (opts.etag === undefined) {
        debugEvent("fetch.miss", { url, reason: "not-modified-uncached", status: res.status, ms: Date.now() - startedAt });
      } else if (headers["if-none-match"] === undefined) {
        // PAR-1044 (I-2): the host that answered was not sent the validator (it did not issue
        // it), so this 304 does not vouch for the cached copy: a miss, not "unchanged".
        debugEvent("fetch.miss", { url, reason: "not-modified-after-host-change", to: final, status: res.status, ms: Date.now() - startedAt });
        return { status: "miss" };
      }
      return { status: "not-modified", finalUrl: final };
    }
    if (!res.ok) {
      debugEvent("fetch.miss", { url, reason: "http-status", status: res.status, ms: Date.now() - startedAt });
      return { status: "miss", httpStatus: res.status };
    }
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      await res.body?.cancel();
      debugEvent("fetch.too-large", {
        url,
        reason: "content-length",
        bytes: declared,
        limit: opts.maxBytes,
        ms: Date.now() - startedAt,
      });
      return { status: "too-large" };
    }
    const body = await readBodyCapped(res, opts.maxBytes);
    if (body === undefined) {
      // No declared length, or a lying one: the cap was hit while streaming, so the exact
      // size is unknown — `limit` is what is known and `bytes` is deliberately absent.
      debugEvent("fetch.too-large", { url, reason: "body-cap", limit: opts.maxBytes, ms: Date.now() - startedAt });
      return { status: "too-large" };
    }
    // PAR-843 (security audit) — TWO gaps in the prior version of this guard: (1) it only
    // scanned the first 500 characters, so a doctype declaration preceded by enough content (a
    // long HTML `<head>`, or any real HTML page whose `<!doctype html` landed past byte 500)
    // went undetected; (2) it was skipped ENTIRELY for a `.md`-suffixed URL, on the assumption
    // that a `.md` extension implies markdown content — which a redirect (or a misconfigured/
    // hostile server) can trivially defeat, serving actual HTML at a `.md`-suffixed URL. Both
    // gaps let an HTML response — typically a site's 404 or error page served with a 200 status
    // — be cached and served as if it were real document content.
    //
    // code-reviewer (round 2, BLOCKING) — a first fix here scanned the WHOLE body for the
    // literal substring, dropping the `.md` special-case and the `content-type` requirement
    // too. That reintroduced a DIFFERENT failure of the same class: several shipped defaults'
    // first candidate is a full `llms-full.txt` dump (Astro, SvelteKit, and plausibly others),
    // and real documentation for a web framework can legitimately quote `<!doctype html`
    // somewhere in tens of thousands of lines (a documented HTML layout example) — a substring
    // search over the WHOLE body would refuse that candidate outright, falling through to a
    // thinner one, the exact "correctly-stamped, materially worse document" failure this phase
    // exists to close, just reached through a different function. The prior comment excused
    // this with "no shipped default has been observed to contain that string" — a claim this
    // offline test suite cannot actually measure (it never fetches shipped defaults' live
    // content) and that real upstream content can invalidate at any time with no warning; a
    // control whose correctness depends on an unmeasurable claim about third-party content
    // is not a control.
    //
    // Fixed instead by checking only the LEADING portion of the (already-bounded) body: a real
    // HTML response — an error/landing page served with a 200, or an actual HTML document at a
    // `.md`-suffixed URL — has its doctype/tag at the very start; a markdown document that
    // happens to quote one somewhere in a code fence does not START with one. Still drops the
    // `.md` special-case and the `content-type` requirement entirely (a server's declared
    // content-type is not trusted for this decision any more than the URL's own suffix is) —
    // this is a narrower, not a weaker, version of that fix. Also avoids a real, secondary cost
    // the whole-body version had: `.toLowerCase()` over up to `PRIMARY_DOC_MAX_BYTES` (25 MB) is
    // a genuine, transient ~50 MB allocation on every primary fetch, in a codebase whose own
    // runbook cites a measured 2.35 GB RSS regression as a serious finding elsewhere.
    const head = body.trimStart().slice(0, 256).toLowerCase();
    if (head.startsWith("<!doctype html") || head.startsWith("<html")) {
      debugEvent("fetch.miss", { url, reason: "html-not-text", status: res.status, ms: Date.now() - startedAt });
      return { status: "miss", failureKind: "html-response" };
    }
    if (body.trim().length === 0) {
      debugEvent("fetch.miss", { url, reason: "empty-body", status: res.status, ms: Date.now() - startedAt });
      return { status: "miss" };
    }
    return { status: "ok", body, etag: res.headers.get("etag") ?? undefined, finalUrl: final };
  } catch (e) {
    // The one place a 404, a timeout and a DNS failure stop being distinguishable. They stay
    // one `miss` to the caller — the diagnostic line is what tells them apart.
    const failure = classifyFetchError(e);
    debugEvent("fetch.miss", {
      url,
      reason: failure.reason,
      code: failure.code,
      error: failure.message,
      ms: Date.now() - startedAt,
    });
    return { status: "miss", failureKind: failure.reason === "aborted" ? "aborted" : "network" };
  } finally {
    releaseFetchSlot();
  }
}

/** A URL-free summary of why every attempted primary candidate failed. */
export interface DocumentFetchFailure {
  kind: "not-found" | "network" | "aborted" | "html-response" | "mixed";
  candidates: number;
}

/**
 * Resolve a library's primary document: probe candidate URLs in order,
 * serving from cache within TTL, revalidating with If-None-Match when stale
 * (a 304 refreshes the TTL without re-downloading), and serving stale content
 * (flagged) when the network is unavailable.
 */
export async function getLibraryDoc(
  entry: LibraryEntry,
  opts: {
    forceRefresh?: boolean;
    /** Cache-only: the network is never attempted. */
    offline?: boolean;
    /** PAR-853 — the caller's own cancellation (an MCP request's abort signal, when the
     *  transport exposes one); combined with the operation deadline below via `AbortSignal.any`
     *  inside `fetchUrl`, so a client that gives up actually stops the in-flight fetch. */
    signal?: AbortSignal;
    /** Test seam (PAR-851): overrides the DNS lookup `checkResolvedAddress` uses. Production
     *  code never sets this. */
    lookup?: AddressLookup;
    /** Propagates a discovered global strict-DNS policy to dynamically resolved entries. */
    strictDns?: boolean;
    /** Optional diagnostic after all attempted candidates fail; never affects the fetch. */
    onFailure?: (failure: DocumentFetchFailure) => void;
    /** Test seam (PAR-853): overrides `OPERATION_DEADLINE_MS` so a test can trigger the
     *  deadline with a short REAL wait rather than the production 60 s value — the assertion
     *  that follows is still on a request/hop COUNT, never on elapsed wall-clock time.
     *  Production code never sets this. */
    operationDeadlineMs?: number;
  } = {},
): Promise<DocResult | undefined> {
  const ttl = entry.ttlHours ?? DEFAULT_TTL_HOURS;
  const failures: Array<DocumentFetchFailure["kind"]> = [];

  if (!opts.forceRefresh) {
    for (const url of entry.urls) {
      const hit = readCache(entry.name, url, ttl);
      // PAR-776 (D-74): `hit.meta.finalUrl` is the redirect target this same document last
      // landed on, PERSISTED from whichever fetch first observed it — a fresh cache hit makes
      // no network call at all, so this is the only way it can still be reported here.
      if (hit && !hit.stale) return { content: hit.content, url, finalUrl: hit.meta.finalUrl ?? url, fetchedAt: hit.meta.fetchedAt, stale: false };
    }
  }

  // Cache miss, stale, or forced: try the network in candidate order,
  // revalidating against any cached etag first.
  if (!opts.offline) {
    // PAR-853 — ONE deadline for every candidate URL AND every hop within this call: created
    // here, not inside `fetchUrl`, precisely so it does NOT reset per candidate — see
    // `OPERATION_DEADLINE_MS`'s own comment for the measured worst case this closes. Combined
    // with the caller's own cancellation, when it supplied one.
    const deadline = AbortSignal.timeout(opts.operationDeadlineMs ?? OPERATION_DEADLINE_MS);
    const operationSignal = opts.signal ? AbortSignal.any([deadline, opts.signal]) : deadline;
    for (const url of entry.urls) {
      const cached = readCache(entry.name, url, ttl);
      // No origin pin here: primary URLs legitimately redirect across hosts
      // (docs.anthropic.com → platform.claude.com) — D-04; redirect targets must still be https
      // on a public host (fetchUrl). A resolved entry's URLs came from package metadata, so
      // its first URL is held to that baseline as well.
      const out = await fetchUrl(url, {
        etag: cached?.meta.etag,
        etagUrl: cached?.meta.finalUrl, // PAR-1044 (I-2): the host that issued the validator
        maxBytes: PRIMARY_DOC_MAX_BYTES,
        publicFinalUrl: entry.resolved !== undefined,
        // PAR-851 (Tom's decision) — this entry's own opt-in covers its primary fetch and every
        // redirect hop `fetchUrl` follows for it, uniformly across every candidate URL.
        allowInternalHosts: entry.allowInternalHosts,
        strictDns: opts.strictDns ?? entry.strictDns,
        operationSignal,
        lookup: opts.lookup,
      });
      if (out.status === "not-modified" && cached) {
        // content unchanged upstream: refresh the TTL. touchCache can no-op (a concurrent
        // evict/corruption between the read above and here) — cached.meta.fetchedAt is the
        // last value this process actually knows to be true in that case. `out.finalUrl` is
        // passed through so a redirect target that changed since the last fetch (or newly
        // appeared/disappeared) is re-persisted on every revalidation, not just the first fetch.
        const touchedAt = touchCache(entry.name, url, out.finalUrl) ?? cached.meta.fetchedAt;
        // PAR-814 (PAR-776 cleanup) — `out.finalUrl` is ALWAYS set here: `fetchUrl`'s
        // `not-modified` return always computes and sets `finalUrl` (`const final = res.url ||
        // current`), so the `cached.meta.finalUrl` fallback is provably unreachable on this
        // branch — deleted rather than kept as dead defensive code (`out.finalUrl ?? url` is
        // the real fallback chain: only `url` itself is reached when there was no redirect).
        return { content: cached.content, url, finalUrl: out.finalUrl ?? url, fetchedAt: touchedAt, stale: false, notModified: true };
      }
      if (out.status === "ok" && out.body !== undefined) {
        const fetchedAt = writeCache(entry.name, url, out.body, out.etag, out.finalUrl);
        return { content: out.body, url, finalUrl: out.finalUrl ?? url, fetchedAt, stale: false };
      }
      failures.push(out.httpStatus === 404 ? "not-found" : out.failureKind ?? "mixed");
    }
  }

  if (failures.length > 0 && opts.onFailure) {
    const first = failures[0]!; // failures.length > 0 above
    const kind = failures.every((value) => value === first) ? first : "mixed";
    // Diagnostics must never turn a fetch failure into a thrown tool error.
    try { opts.onFailure({ kind, candidates: failures.length }); } catch { /* diagnostic only */ }
  }

  // Network failed everywhere (or offline): serve stale cache if any candidate has one.
  for (const url of entry.urls) {
    const hit = readCache(entry.name, url, ttl);
    if (hit) {
      return {
        content: hit.content,
        url,
        finalUrl: hit.meta.finalUrl ?? url,
        fetchedAt: hit.meta.fetchedAt,
        stale: true,
        staleNote: opts.offline
          ? `STALE: served from cache fetched ${hit.meta.fetchedAt}; offline mode, network not attempted.`
          : `STALE: served from cache fetched ${hit.meta.fetchedAt}; all candidate URLs unreachable just now.`,
      };
    }
  }
  return undefined;
}

export type LinkedPageResult =
  | { status: "ok"; page: DocResult }
  /** Guard refusal: link outside the allowed hosts (see link-policy.ts), before or after redirects. */
  | { status: "refused" }
  /** Response exceeded LINKED_PAGE_MAX_BYTES; nothing cached. */
  | { status: "too-large" }
  /** Network / HTTP failure with nothing cached to fall back on. */
  | { status: "unavailable"; reason?: "html-response" };

/** PAR-832a — the Accept header sent on every request `fetchLinkedPage` makes (the original
 *  attempt, and the `.md`-suffix retry below): several doc-site frameworks serve raw markdown
 *  for exactly this header on a page whose default response is the rendered HTML (MEASURED
 *  against hono.dev, motion.dev and nextjs.org's own non-tutorial pages, 2026-09-18). This does
 *  NOT cover every convention found in the PAR-832 investigation: ui.shadcn.com ignores Accept
 *  entirely and serves markdown only at the same path plus `.md` — that convention is what the
 *  retry below (PAR-838) exists to close. */
const LINKED_PAGE_ACCEPT = "text/markdown, text/plain;q=0.9, */*;q=0.1";

/** PAR-838 — pathname-only `.md`-suffix retry target for `fetchLinkedPage`'s single retry, or
 *  `undefined` when `url` is unparseable or its PATHNAME already ends in `.md` (nothing useful
 *  to retry). Mutates `pathname` alone via the `URL` object — `search` and `hash` are carried
 *  through untouched on `.href`, which is precisely what makes this immune to the original
 *  defect: the prior (rejected) implementation tested `url.endsWith(".md")` against the WHOLE
 *  href to decide whether to stop, which a query string or fragment defeats forever
 *  (`guide?v=1` → `guide.md?v=1`, which still does not end in `.md`). This function is never
 *  used to decide whether to STOP retrying — `fetchLinkedPage` threads an explicit `isMdRetry`
 *  boolean for that — only to compute where the one permitted retry goes. */
function mdRetryUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.pathname.toLowerCase().endsWith(".md")) return undefined;
    u.pathname = `${u.pathname}.md`;
    return u.href;
  } catch {
    return undefined;
  }
}

/** Build an `ok` `LinkedPageResult` from a cache hit read at `atUrl` — the url the cache
 *  entry actually lives under (the original followed link, or PAR-838's `.md`-retried
 *  variant, whichever this call is serving), never silently reported as a different url than
 *  the one the content was actually keyed under (security-architect, review round 2, S1). */
function pageFromCacheHit(atUrl: string, hit: CacheHit, stale: boolean): LinkedPageResult {
  const page: DocResult = {
    content: hit.content,
    url: atUrl,
    finalUrl: hit.meta.finalUrl ?? atUrl,
    fetchedAt: hit.meta.fetchedAt,
    stale,
  };
  if (stale) page.staleNote = `STALE: served from cache fetched ${hit.meta.fetchedAt}.`;
  return { status: "ok", page };
}

/** PAR-838, PAR-853 — options for `fetchLinkedPage`'s trailing, less-commonly-set parameters.
 *  Review round 2, security-architect S2: these used to be three separate positional
 *  parameters, ending in `isMdRetry` — a security-relevant boolean whose only production
 *  producer is `fetchLinkedPage`'s OWN recursive call, passed as a bare positional `true`.
 *  Inserting a new parameter anywhere before it in a future change would silently misalign
 *  that `true` onto the wrong parameter, type-checking cleanly while reintroducing the exact
 *  unbounded-retry defect PAR-838 exists to close. A single named options object removes that
 *  whole class of risk: `isMdRetry: true` cannot be misaligned by an unrelated signature
 *  change elsewhere in this object. */
export interface FetchLinkedPageOptions {
  /** PAR-921: `get-docs.ts` passes one shared link-phase deadline combined with the MCP
   *  caller's cancellation. The signal stops the current redirect/retry chain and prevents
   *  later links from starting. Other callers may omit it. */
  operationSignal?: AbortSignal;
  /** Test seam (PAR-851): overrides the DNS lookup `checkResolvedAddress` uses. Production
   *  code never sets this. */
  lookup?: AddressLookup;
  /** PAR-838 — true ONLY for the single, internal `.md`-suffix retry this function issues to
   *  itself; production callers never pass this. See `fetchLinkedPage`'s own doc comment for
   *  why this must be an explicit, named field and never re-derived from `url`. */
  isMdRetry?: boolean;
}

/** Fetch a single linked page (for llms.txt index files), cache-backed with the
 *  same revalidation policy. Refuses links the allowed-host policy rejects (the source
 *  document's host plus `policy.allowedHosts`; https only) both before the fetch and
 *  after redirects; refused responses are never read or cached. Without a policy this
 *  is the 0.1.3 same-origin rule. With `offline`, the network is never attempted: cached
 *  pages (fresh or stale) are served and anything else is `unavailable`.
 *
 *  PAR-832a — asks for markdown via `Accept` (`LINKED_PAGE_ACCEPT`): several doc-site
 *  frameworks serve raw markdown for exactly this header on a page whose default response is
 *  rendered HTML (MEASURED against hono.dev, motion.dev and nextjs.org's own non-tutorial
 *  pages, 2026-09-18).
 *
 *  PAR-838 (D-82 supersedes the deferral) — a response that is STILL not usable (`fetchUrl`
 *  returns `"miss"`: still `text/html` despite the Accept header above, a 404, or any other
 *  non-2xx/non-304 outcome) is retried EXACTLY ONCE, at `mdRetryUrl(url)`, for sites
 *  (ui.shadcn.com is the measured case) that ignore `Accept` entirely and serve markdown only
 *  at a literal `.md`-suffixed path. The retry is implemented as ONE recursive call with
 *  `isMdRetry: true` — that flag, not any inspection of `url`'s own shape, is what stops a
 *  second recursion (`if (!isMdRetry)` below): this is the exact point two independent reviews
 *  (code-reviewer, security-architect) rejected the original submission over. That version
 *  inferred "is this the retry" from `url.endsWith(".md")` tested against the WHOLE href, which
 *  never matches for a followed link carrying a query string or fragment (ordinary in real
 *  `llms.txt` indexes — 31 such links were measured in hono's own cached index alone), so the
 *  guard never fired and the mutation repeated forever (`guide?v=1` → `guide.md?v=1` →
 *  `guide.md.md?v=1` → ...), one fresh 20 s-timeout request per iteration, against ANY origin
 *  that answers every path with something other than a literal `.md`-suffixed exact match
 *  (any catch-all-HTML SPA fallback qualifies). Threading the flag explicitly, rather than
 *  re-deriving it from the URL, makes the recursion depth exactly one by construction regardless
 *  of what the followed link looks like — see `test/fetcher.test.ts`'s PAR-838 fixtures
 *  (query-string, fragment and all-redirect chains against an always-HTML/always-redirect
 *  origin) for the literal proof, and docs/decisions.md D-90 for the full account including why no
 *  `rejectHtml`-style option was added to `fetchUrl` for this: its HTML-leading-bytes guard
 *  (see the PAR-843 comment above, in `fetchUrl`) is already unconditional for every caller and
 *  every URL shape — including this retry — so a second, gateable flag would only create a
 *  lever to weaken it later, not close a gap that exists today.
 *
 *  The retry also does not drop the ORIGINAL url's own stale-cache fallback: when the retry
 *  itself fails too, control returns to the ORIGINAL call, which still tries `hit` (its own
 *  cache entry for `url`, not the retry's, separately keyed) before finally reporting
 *  `unavailable` — an earlier draft returned the retry's own (necessarily cache-miss) result
 *  directly, silently regressing availability for any library holding a stale cached copy of
 *  `url` at the moment the retry was attempted.
 *
 *  Blocking #3 (review round 2, security-architect, independently reproduced live by the
 *  coordinator: warm a cache online for a shadcn-shaped entry, `followed: 5, dropped: 0,
 *  healthy: true`; re-run the SAME cache `--offline`, `followed: 0, dropped: 5, healthy:
 *  false`) — content the retry successfully fetches is cached under `mdRetryUrl(url)`, never
 *  under the ORIGINAL `url` (its own fetch never succeeds — that is the whole reason the retry
 *  exists). Every cache lookup in this function therefore now consults BOTH `url`'s own entry
 *  and `mdRetryUrl(url)`'s, at every point this function can serve from cache (the fresh-hit
 *  check, the offline branch, and the final stale fallback) — preferring `url`'s own entry when
 *  both exist (it is the REAL url; the retry is a fallback), so offline mode (and a cache-only
 *  fresh hit) can find content that only ever got cached via the retry, exactly as online mode
 *  already could. Reported under `page.url = mdRetryUrl(url)` when serving from the retry's own
 *  entry (never re-labelled as the original `url`) — see `pageFromCacheHit`'s own comment
 *  (security-architect S1) and `get-docs.ts`'s "Followed index links:" note, which reads this
 *  same field for the same reason: a hostile origin could serve different content at the two
 *  paths, and provenance must name which one actually answered. */
export async function fetchLinkedPage(
  library: string,
  url: string,
  sourceUrl: string,
  ttlHours = DEFAULT_TTL_HOURS,
  offline = false,
  policy?: LinkPolicy,
  opts: FetchLinkedPageOptions = {},
): Promise<LinkedPageResult> {
  const { operationSignal, lookup, isMdRetry = false } = opts;
  if (!isAllowedLink(url, sourceUrl, policy)) return { status: "refused" };
  // Blocking #3 — computed up front and consulted alongside `url`'s own cache entry at every
  // serving point below, not only inside the online retry branch. `retryUrl` is `undefined`
  // when `url`'s own pathname already ends in `.md` (this IS the retry call, or the original
  // link already pointed at a `.md` path) — `readCache` is never asked to look up `undefined`.
  const retryUrl = mdRetryUrl(url);
  const hit = readCache(library, url, ttlHours);
  const retryHit = retryUrl !== undefined ? readCache(library, retryUrl, ttlHours) : undefined;
  if (hit && !hit.stale) return pageFromCacheHit(url, hit, false);
  if (retryHit && !retryHit.stale) return pageFromCacheHit(retryUrl!, retryHit, false);
  if (offline) {
    if (hit) return pageFromCacheHit(url, hit, true);
    if (retryHit) return pageFromCacheHit(retryUrl!, retryHit, true);
    return { status: "unavailable" };
  }
  const out = await fetchUrl(url, {
    etag: hit?.meta.etag,
    etagUrl: hit?.meta.finalUrl, // PAR-1044 (I-2)
    maxBytes: LINKED_PAGE_MAX_BYTES,
    linkGuard: { sourceUrl, policy },
    accept: LINKED_PAGE_ACCEPT,
    // PAR-851 (Tom's decision) — a link followed from an opted-in entry's own document is
    // covered by the SAME opt-in `isAllowedLink` (above) already used to admit it into scope
    // (same-origin as `sourceUrl`, or an explicitly configured `allowedHosts` entry) — this
    // does not widen WHICH hosts a link may target, only what happens when a host already
    // admitted resolves privately.
    allowInternalHosts: policy?.allowInternalHosts,
    strictDns: policy?.strictDns,
    operationSignal,
    lookup,
  });
  if (out.status === "refused") return { status: "refused" };
  if (out.status === "too-large") return { status: "too-large" };
  if (out.status === "not-modified" && hit) {
    // See getLibraryDoc's identical comment: touchCache's no-op fallback is hit.meta.fetchedAt.
    // `out.finalUrl` re-persists a redirect target that may have changed since the last fetch.
    const touchedAt = touchCache(library, url, out.finalUrl) ?? hit.meta.fetchedAt;
    // PAR-744 (F-7, code-reviewer round 1, S5): no production caller reads `notModified` on a
    // followed page today — `get-docs.ts`'s only consumer of a `LinkedPageResult` reads
    // `.page.content`, never `.page.notModified`. Set anyway for `DocResult` symmetry with
    // `getLibraryDoc`, so a future caller that DOES need "was this followed page actually
    // re-fetched" does not have to add a fifth status variant to get it. Covered by
    // `test/fetcher.test.ts`.
    // PAR-814 — same provably-unreachable middle fallback deleted here; see getLibraryDoc's
    // identical comment above.
    return { status: "ok", page: { content: hit.content, url, finalUrl: out.finalUrl ?? url, fetchedAt: touchedAt, stale: false, notModified: true } };
  }
  if (out.status === "ok" && out.body !== undefined) {
    const fetchedAt = writeCache(library, url, out.body, out.etag, out.finalUrl);
    return { status: "ok", page: { content: out.body, url, finalUrl: out.finalUrl ?? url, fetchedAt, stale: false } };
  }
  // PAR-838 — `out.status` here is `"miss"` (HTML-as-200, 404, or any other non-2xx/non-304
  // outcome `fetchUrl` did not already special-case above). Retry once, at the `.md`-suffixed
  // pathname, BEFORE falling back to this url's own stale cache — a fresh attempt at real
  // content beats serving something possibly much older. `isMdRetry` guards re-entry: this
  // recursive call always passes `true`, so a miss on the retry itself cannot recurse again.
  let retryReturnedHtml = false;
  if (!isMdRetry && retryUrl !== undefined) {
    const retryResult = await fetchLinkedPage(library, retryUrl, sourceUrl, ttlHours, offline, policy, { operationSignal, lookup, isMdRetry: true });
    if (retryResult.status === "ok") return retryResult;
    retryReturnedHtml = retryResult.status === "unavailable" && retryResult.reason === "html-response";
    // Retry also failed (refused / too-large / unavailable) — fall through to THIS url's own
    // stale-cache fallback below, not the retry's. See this function's doc comment, compounding
    // defect #2.
  }
  if (hit) return pageFromCacheHit(url, hit, true);
  // Blocking #3 — the retry's OWN cache entry, consulted here too: if the retry attempt above
  // failed on THIS call (network down, or refused) but a PREVIOUS successful retry already
  // cached content under `retryUrl`, that is still genuinely available and must not be
  // reported `unavailable` just because `url`'s own entry (which may never exist at all for a
  // site like shadcn) is absent.
  if (retryHit) return pageFromCacheHit(retryUrl!, retryHit, true);
  return out.failureKind === "html-response" || retryReturnedHtml
    ? { status: "unavailable", reason: "html-response" }
    : { status: "unavailable" };
}
// PAR-855 (security audit) — `getLinkedPage`, a thin wrapper (`fetchLinkedPage` + unwrap to
// `.page`/`undefined`), was exported with NO production caller (grepped: only `fetchLinkedPage`
// is reached from `get-docs.ts`; `getLinkedPage` appeared only in this module's own test file) —
// "a success-formatting/simple-form path no user-facing command presently reaches," the audit's
// own phrase. Its contract was also weaker than the real path's: it took no `LinkPolicy`/entry,
// so it could never honour `allowInternalHosts` or the `offline`/`lookup` seams `fetchLinkedPage`
// takes. Deleted rather than exported-and-left, per the audit's "remove or hide" instruction;
// `test/fetcher.test.ts`'s two tests that called it now call `fetchLinkedPage` directly.
