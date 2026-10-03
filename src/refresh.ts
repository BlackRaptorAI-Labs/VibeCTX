import { installResolvedEntry, resolveLibrary, unknownLibraryMessage, type LibraryEntry, type Registry } from "./registry.js";
import { getLibraryDoc, isDocUnchanged, type DocumentFetchFailure, type DocResult } from "./fetcher.js";
import { redactUrlForDisplay } from "./link-policy.js";
import { redactResolvePathForModel, resolvePackage } from "./resolve.js";
import { invalidateIndex, openIndexSession, documentHash } from "./search-index.js";
import { cacheRoot, dropFollowedPageCache } from "./cache.js";
import { MAX_FULL_REFRESHES_PER_HOUR } from "./limits.js";
import { createSlidingWindowLimiter } from "./rate-limit.js";
import { recordActivity } from "./activity-log.js";
import { cacheUpdateAdvice, documentUpdateAdvice } from "./update-guidance.js";
import { bugFailureOffer } from "./bug-report.js";
import { VERSION } from "./version.js";
import type { AddressLookup } from "./address-policy.js";

// A3 (PAR-716): the no-argument ("full") form iterates the whole registry — up to thirty
// upstream fetches per call — and is model-callable with no cap before this. Single-library
// refresh stays uncapped; see MAX_FULL_REFRESHES_PER_HOUR.
const fullRefreshLimiter = createSlidingWindowLimiter(MAX_FULL_REFRESHES_PER_HOUR);

/** Test hook: forget the full-refresh window. */
export function resetFullRefreshWindow(): void {
  fullRefreshLimiter.reset();
}

/** The MCP `refresh` tool body, kept out of index.ts so it can be exercised without a
 *  transport: force-refetch one library (canonical name or alias) or every library,
 *  one result line each. An unknown name returns the unknown-library text and fetches
 *  nothing (refresh never resolves new names — get_docs and resolve_library do that).
 *  A resolved entry (PAR-655) is re-resolved through its ecosystem, so a project that
 *  has since published llms.txt or moved its homepage is picked up; on failure the
 *  old entry stays.
 *
 *  A20/PAR-729 (D-51): one activity-log entry per CALL — not per target — matching the
 *  Done-when's own wording. A single-library refresh's entry carries that library's own
 *  `url`/`contentHash` and `fresh` (code-reviewer round 1, B1: NOT unconditionally true —
 *  `forceRefresh: true` can still fall back to a stale cached copy when the network is down,
 *  so `fresh` reflects `single.stale`, tracked per branch below); a full (no-argument)
 *  refresh's entry carries neither `library` nor `url` — no ONE document is "the" one a
 *  caller can cite, the same reasoning `search`'s multi-library case applies (see
 *  search.ts's `runSearch`). `outcome` is `matched` when at least one target actually
 *  refreshed; `unresolved` when the requested name does not exist in the registry (unchanged);
 *  `refused` (PAR-796) when the call was rate-limited, or every target that would otherwise
 *  have counted as a refresh was declined because it would have overridden a curated entry —
 *  the tool declined to act, which is a different fact from "nothing was available"; `not-cached`
 *  otherwise (a genuine fetch failure with nothing to fall back on). */
export async function refreshToolText(
  registry: Registry,
  library?: string,
  opts: {
    now?: () => Date;
    /** PAR-853 — the MCP request's own cancellation (`server.ts` passes `extra.signal` from
     *  the `refresh` tool callback); combined inside `getLibraryDoc` with the whole-operation
     *  deadline for whichever entry is currently being fetched when the client gives up. On a
     *  full (no-argument) refresh this cancels only the CURRENT target's fetch — the loop over
     *  the rest of the registry still runs (each entry gets its own `getLibraryDoc` call, which
     *  re-checks this same signal at `fetchUrl`'s own top-of-function guard, so nothing AFTER
     *  the point of cancellation ever fetches either; entries already fetched before
     *  cancellation keep their result).
     *
     *  ACCEPTED, DOCUMENTED LIMIT (B-14, review round 2) — `getLibraryDoc` mints its
     *  60 s whole-operation deadline PER CALL, so a full refresh spends one fresh 60 s deadline
     *  PER LIBRARY ENTRY, not one 60 s deadline for the whole `refresh` call: a 30-entry default
     *  registry's computed worst case is ~1800 s (30 minutes), not 60 s. B-14 retained decision:
     *  a long batch is preferable to a whole-run cutoff that leaves a half-updated cache. `MAX_FULL_REFRESHES_PER_HOUR`
     *  bounds how often this can be TRIGGERED, not how long one run may take. See
     *  docs/decisions.md D-89c. */
    signal?: AbortSignal;
    /** Test seam: use the same address lookup at every fetch; production leaves it unset. */
    lookup?: AddressLookup;
  } = {},
): Promise<string> {
  let targets: LibraryEntry[];
  if (library !== undefined) {
    const entry = resolveLibrary(registry, library);
    if (!entry) {
      recordActivity({ tool: "refresh", library, outcome: "unresolved" });
      return unknownLibraryMessage(registry, library);
    }
    targets = [entry];
  } else {
    const now = opts.now ?? (() => new Date());
    if (!fullRefreshLimiter.take(now().getTime())) {
      // PAR-796 — this is a REFUSAL (the tool declined to act because of its own rate limit),
      // not `not-cached` (README: "nothing was available to serve"). Nothing was even attempted
      // here, so `not-cached` misstated why: reusing Phase 5's existing `refused` value (added
      // for a different case, `get_docs`'s budget refusal) rather than adding a second one — its
      // stated meaning ("the tool declined to act, not that nothing was found") fits this case
      // exactly, and a schema-vocabulary bump already happened once for this same value.
      // review round 2, code-reviewer S4 — `refusedReason` is what tells this refusal apart
      // from the "declined to override a curated entry" refusal below, from the log alone.
      recordActivity({ tool: "refresh", outcome: "refused", refusedReason: "rate-limited" });
      return `refresh limit reached (${MAX_FULL_REFRESHES_PER_HOUR} full refreshes per hour per process); try again later, or refresh one library at a time`;
    }
    targets = [...registry.entries.values()];
  }
  const results: string[] = [];
  let succeeded = 0;
  let bugWhere: "network" | "cache" | undefined;
  // PAR-796 — counts the "not replaced — curated entry" branch below: the tool DECLINED to
  // override a curated entry, which is a refusal, not "nothing was available" (`not-cached`).
  // Only affects the final aggregate outcome when `succeeded` stays 0 for the whole call.
  let declined = 0;
  let single: { url?: string; contentHash?: string; stale?: boolean } | undefined;
  // R2 (A3, PAR-716): ONE session for the whole loop, not one read-then-write per library —
  // the same fix `warm` and `autowarm` already have (`IndexSession`'s own doc comment in
  // search-index.ts). Scoped to the direct-fetch path below; a RESOLVED entry's indexing is
  // `resolvePackage`'s own single-document write (R1, D-34) and stays outside this session —
  // see the branch below. MEASURED for the direct-fetch path only (round 1, code-reviewer, S4 —
  // a resolved-entry refresh is still O(n): its own `invalidateIndex` plus `resolvePackage`'s
  // own `indexCachedDocument`, unchanged by this item): a 30-library refresh of non-resolved
  // entries costs at most 3 `index.json` reads and 1 write, CONSTANT in library count — not the
  // literal "one read, one write" the issue states. Two of those three reads (the `flush()`
  // re-read that NARROWS, not closes, the window for a concurrent writer — F-3, PAR-740 — and
  // `writeIndex`'s own schema-version check) are intrinsic to the shared session/writeIndex API
  // `warm`/`autowarm` already use and are unchanged here; the
  // third (the lazy snapshot read this item's own `add()`/`remove()` interplay was routing
  // through) is NOT intrinsic — round 1 found it elidable and `search-index.ts`'s `add()` now
  // cancels a pending removal instead of re-reading for it, which also means a refresh that
  // finds nothing changed reads once and writes nothing at all. See the phase report for the
  // full disposition against the go-card's literal wording.
  const session = openIndexSession();
  try {
    for (const entry of targets) {
      if (entry.resolved) {
        // D-34 (PAR-659): invalidate before refetching, so a failed re-resolve leaves the entry
        // gone rather than stale. Left as its own read+write, not folded into `session`:
        // `resolvePackage` re-indexes what it caches on success (R1) as a single-document write
        // this loop does not see coming, so batching this call's removal into `session` risks
        // that later write undoing what `resolvePackage` just did correctly — see the commit
        // message for the case this would break.
        invalidateIndex(entry.name);
        const out = await resolvePackage(entry.name, { ecosystem: entry.resolved.source, strictDns: registry.strictDns, lookup: opts.lookup, signal: opts.signal }); // PAR-1044 (L-2)
        if (out.ok && out.entry) {
          if (!installResolvedEntry(registry, out.persistedEntry ?? out.entry)) {
            declined += 1;
            results.push(
              `${entry.name}: not replaced — "${out.entry.name}" is a curated entry (default, config or alias); a resolved record cannot override it`,
            );
            continue;
          }
          // Round 1 (code-reviewer, S2/S3): keeps every remaining candidate URL, not just the
          // chosen one — `out.entry.urls` is the fallback chain `getLibraryDoc` would use on a
          // future outage, not a followed page, and must not be deleted alongside them.
          // PAR-744 (F-7): guarded on `out.unchanged`, the resolved-branch twin of the
          // direct-fetch guard below — before this, `ResolveOutcome` carried no staleness
          // signal at all, so a re-resolution that only reached a 304 or a stale-cache
          // fallback still dropped followed pages here.
          if (out.chosen && !out.unchanged) {
            const pins = registry.entries.get(out.entry.name)?.versionedDocuments ?? [];
            dropFollowedPageCache(entry.name, [out.chosen, ...out.entry.urls, ...pins.map(({ url }) => url)]);
          }
          // A20/PAR-729: "matched" either way — a 304-confirmed document is as current as a
          // freshly fetched one, and the activity log records what is now known-current, not
          // whether bytes moved on the wire.
          succeeded += 1;
          // `single.url` stays the RAW candidate — `recordActivity`'s own `toActivityEntry`
          // redacts it, the same shared function every other write hook relies on internally
          // (D-51/PAR-792, consolidated into PAR-817). PAR-815 (Phase 4) — the RENDERED line
          // below is a separate surface with no such redaction of its own, so it is redacted
          // here, at the point of render, not by mutating what is logged.
          single = { url: out.chosen, contentHash: out.contentHash, stale: out.stale };
          results.push(out.stale
            ? `${entry.name}: re-resolved via ${entry.resolved.source} — FAILED to update; kept stale cached copy from ${redactUrlForDisplay(out.chosen!)}; ${documentUpdateAdvice(undefined, "retry the MCP refresh tool")}`
            : `${entry.name}: re-resolved via ${entry.resolved.source} — refreshed from ${redactUrlForDisplay(out.chosen!)} (${(out.chars ?? 0).toLocaleString()} chars)`);
          if (out.stale) bugWhere = "network";
        } else {
          results.push(`${entry.name}: FAILED — ${redactResolvePathForModel(out.text, cacheRoot())}`);
          if (!out.notFound && !out.limited && out.operationalFailure) bugWhere = out.operationalFailure;
        }
        continue;
      }
      // D-34: mark this library's entry removed before refetching — batched into `session`
      // rather than `invalidateIndex`'s own read+write, so thirty libraries cost one session,
      // not thirty. A failed refetch leaves the removal as the last word for this library;
      // `add()` below supersedes it on success.
      session.remove(entry.name);
      let failure: DocumentFetchFailure | undefined;
      let doc: DocResult | undefined;
      try {
        doc = await getLibraryDoc(entry, { forceRefresh: true, signal: opts.signal, lookup: opts.lookup, onFailure: (value) => { failure = value; } });
      } catch (error) {
        const guidance = cacheUpdateAdvice(error, "retry the MCP refresh tool");
        if (!guidance) throw error;
        // Preserve the full-refresh mid-loop throw/flush contract: the message is now
        // actionable, while `finally` still commits earlier libraries' index entries.
        if (library === undefined) throw new Error(`${entry.name}: FAILED — ${guidance}`, { cause: error });
        results.push(`${entry.name}: FAILED — ${guidance}`);
        bugWhere = "cache";
        continue;
      }
      if (doc) {
        session.add(entry.name, doc.url, doc.content);
        // A3: the pages followed from the document just replaced no longer describe anything
        // this refresh knows to be current — drop them (and every OTHER candidate URL's cache
        // — round 1, S2) so the next get_docs re-follows fresh links instead of blending old
        // followed pages with the new primary document. Guarded on `isDocUnchanged` (PAR-744,
        // F-7): `staleNote` catches the case where every candidate URL is unreachable and
        // `getLibraryDoc` re-serves the SAME cached primary; `notModified` catches the case
        // this item fixes — a 304 Not-Modified revalidation, which returns the SAME content
        // with no `staleNote` and used to be indistinguishable here from a genuine fresh
        // fetch, dropping followed pages even on an ETag-serving site's ordinary "nothing
        // changed" refresh (round 2, code-reviewer, SF-1 — the dropped page's real cost: one
        // previously served flagged `STALE:` during an upstream outage now reports "Could not
        // fetch N index links" instead, once its cache is gone).
        if (!isDocUnchanged(doc)) dropFollowedPageCache(entry.name, [doc.url, ...entry.urls]);
        // A20/PAR-729: "matched" either way — see the same note on the resolved-entry branch
        // above.
        succeeded += 1;
        single = { url: doc.url, contentHash: documentHash(doc.content), stale: doc.staleNote !== undefined };
      }
      results.push(
        doc
          ? // PAR-744 (F-7, security-architect round 1, L1): a 304 revalidation says so — the
            // whole point of this item is that "unchanged" and "refreshed" are now DIFFERENT,
            // internally distinguishable outcomes, and reporting them identically would hide
            // that from the one place a human actually reads the result.
            // PAR-815 (Phase 4): `doc.url` is the raw candidate — redacted here, at render, the
            // same as the resolved-entry branch above; `single.url` below stays raw for the log.
            doc.staleNote
              ? `${entry.name}: FAILED to update — kept stale cached copy from ${redactUrlForDisplay(doc.url)}; ${documentUpdateAdvice(failure, "retry the MCP refresh tool")}`
              : `${entry.name}: ${doc.notModified ? "unchanged (304 revalidated)" : "refreshed"} from ${redactUrlForDisplay(doc.url)} (${doc.content.length.toLocaleString()} chars)`
          : `${entry.name}: FAILED — ${documentUpdateAdvice(failure, "retry the MCP refresh tool")}`,
      );
      if ((doc?.staleNote || !doc) && failure?.kind !== "aborted") bugWhere = "network";
    }
  } finally {
    // Round 1 (code-reviewer, B2): NOT inside the loop and NOT skippable on a mid-loop throw.
    // `getLibraryDoc` can throw (EACCES/ENOSPC/EROFS out of `writeCache`/`touchCache`, the same
    // class A5 caught one level up) after it has already replaced an EARLIER library's cache
    // file on disk but before this session's `add()` for that library is flushed — without
    // `finally`, that library's cache holds the NEW document while the index still serves its
    // OLD posting list, exactly the state D-34 exists to prevent. `flush()` is documented safe
    // to call more than once and to no-op on an empty session, so this costs nothing on the
    // ordinary path.
    session.flush();
  }
  recordActivity({
    tool: "refresh",
    library: library !== undefined ? targets[0]!.name : undefined,
    url: library !== undefined ? single?.url : undefined,
    contentHash: library !== undefined ? single?.contentHash : undefined,
    // code-reviewer, A20/PAR-729 round 1, B1: NOT unconditionally true on success —
    // `forceRefresh: true` can still fall back to a stale cached copy when the network is
    // down (both branches above track it in `single.stale`, from `out.stale` / `doc.staleNote`).
    fresh: library !== undefined && single ? !single.stale : undefined,
    // PAR-796 — `declined` only decides the outcome when NOTHING succeeded: a call where at
    // least one target genuinely refreshed is still `matched`, exactly as before. Reuses the
    // existing `refused` value (Phase 5) rather than adding a second one for the same reason
    // the rate-limit branch above does — see that branch's own comment.
    outcome: succeeded > 0 ? "matched" : declined > 0 ? "refused" : "not-cached",
    // review round 2, code-reviewer S4 — distinguishes this refusal from the rate-limit one
    // above, which the log could not do before this field existed (both wrote identical
    // `{tool: "refresh", outcome: "refused"}` entries).
    refusedReason: succeeded === 0 && declined > 0 ? "curated" : undefined,
  });
  const offer = bugWhere === undefined ? "" : `\n\n${bugFailureOffer({
    operation: "refresh", where: bugWhere, errorClass: bugWhere === "cache" ? "CacheError" : "NetworkError",
    version: VERSION, platform: process.platform, nodeVersion: process.version,
  })}`;
  return `${results.join("\n")}${offer}`;
}
