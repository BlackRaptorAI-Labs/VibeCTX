import { entryForVersion, installResolvedEntry, nearestLibraryName, resolveLibrary, unknownLibraryMessage, type LibraryEntry, type Registry } from "./registry.js";
import { lookupLibrary, redactResolvePathForModel, resolvePackage, type ResolveOutcome } from "./resolve.js";
import {
  getLibraryDoc,
  fetchLinkedPage,
  isAllowedLink,
  LINKED_PAGE_MAX_BYTES,
  OPERATION_DEADLINE_MS,
} from "./fetcher.js";
import type { AddressLookup } from "./address-policy.js";
import {
  rankSplitSections,
  renderSection,
  SECTION_ASSEMBLE_JOIN,
  selectSections,
  splitSections,
  rankSplitSnippets,
  assembleSnippetsDetailed,
  selectSnippets,
  looksLikeIndex,
  rankLinks,
  extractLinks,
  followLimit,
  noMatchNote,
  thinMatchNote,
  versionFallbackNote,
  requiredHeader,
  fitRetrievedTextDetailed,
  BUDGET_CUT_MARKER,
  fenceEchoedIdentifier,
  stripStampQuery,
  MAX_STAMP_VERSION_CHARS,
  MAX_FOLLOWED_BYTES,
  type SplitSection,
  type StampFacts,
} from "./retrieval.js";
import { indexCachedDocument, documentHash } from "./search-index.js";
import { clipText } from "./text.js";
import { redactUrlForDisplay } from "./link-policy.js";
import { recordActivity, type ActivityOutcome } from "./activity-log.js";
import { readDoctorVerdicts } from "./doctor-store.js";
import { bugFailureOffer } from "./bug-report.js";
import { VERSION } from "./version.js";
import { MAX_TOPIC_CHARS, validateTokenBudget } from "./limits.js";

/** D-26: what a topic search returns — whole matching sections (the default), or just
 *  the runnable code blocks inside them. */
export type GetDocsMode = "sections" | "snippets";

/** PAR-852 — longest `topic` this function will tokenize/rank. A topic is a short phrase
 *  ("server actions revalidate"), not a document — matches the existing precedent for a
 *  topic-shaped field: `retrieval.ts`'s `MAX_NOTE_TOPIC_CHARS` (the no-match echo bound) and
 *  `activity-log.ts`'s `MAX_QUERY_CHARS` (the logged-topic bound) are both already 200. ASSUMED
 *  (docs/decisions.md), same reasoning as `search.ts`'s `MAX_QUERY_CHARS` (1000) — tighter here
 *  because `search.query` is a free-text search phrase across many libraries where a slightly
 *  longer query is still plausible, while `topic` narrows ONE already-identified library's
 *  document, which needs less. Before this bound existed, `topic` reached the tokenizer/ranker
 *  completely unclipped: MEASURED (a 400-section fixture document, one OFFLINE `get_docs` call,
 *  topic built from distinct pseudo-word terms so none are deduplicated by the tokenizer) — 18
 *  chars: 11.7 ms wall, 86 MB RSS; 2 MB of unique terms: 1.76 s wall, 1.0 GB RSS; 5 MB of unique
 *  terms: 4.68 s wall, 2.35 GB RSS. Cost scales with topic size and, for distinct terms, memory —
 *  the RESPONSE stays bounded throughout (the no-match path clips the echoed topic), only the
 *  processing cost was unbounded. */
export { MAX_TOPIC_CHARS } from "./limits.js";

export interface GetDocsArgs {
  /** What to search this library's document for. Bounded at `MAX_TOPIC_CHARS` — enforced at
   *  the MCP schema (`server.ts`) AND again here, at the function boundary (`getDocsDetailed`),
   *  since this function is reachable directly from the CLI and from tests, bypassing the
   *  schema entirely (D-48/PAR-840's own lesson: "a guard in one layer is not a guard"). An
   *  over-limit topic is REFUSED with a stated reason before any fetch or tokenization —
   *  never silently truncated (silent truncation would change which sections rank, its own
   *  honesty problem: two different topics could then return identical results). */
  topic?: string;
  /** Approximate response budget in tokens (default 4000). */
  maxTokens?: number;
  /** Cache-only: never touch the network (doctor --offline). */
  offline?: boolean;
  /** "sections" (default) or "snippets" (D-26). Only meaningful with a topic: without
   *  one, both modes return the table of contents and the document head. */
  mode?: GetDocsMode;
  /** A11/PAR-724 — match documentation to this exact version (a GitHub tag README, an
   *  npm/PyPI version-pinned metadata lookup), typically the version a project's manifest
   *  pins. Applies only when `library` is unknown (resolved fresh by this call) or already a
   *  RESOLVED (non-curated) entry — `resolvePackage`'s version-matched chain is what this
   *  threads into; see `getDocsToolText`. A curated (default-registry or config) entry is
   *  never re-resolved for a version: its `urls` are hand-picked doc sources, not derived from
   *  registry metadata, so there is no version-specific candidate to try — the response says so
   *  explicitly rather than silently ignoring the argument. When no version-specific document
   *  is found, the fallback to the latest available document is stated, never silent (D-50). */
  version?: string;
}

/** What get_docs did, as data — the text plus the accounting behind its notes,
 *  so `doctor` can classify retrieval without parsing prose. */
export interface GetDocsOutcome {
  /** Exactly the text the get_docs tool responds with. */
  text: string;
  /** The primary document that was served; undefined when nothing was fetched and nothing
   *  cached. `fetchedAt`/`curated` added at A17/PAR-726 alongside the rendered stamp, so a
   *  structured consumer (doctor) reads the same facts the text states without parsing it.
   *  `url` stays the CANDIDATE URL `doctor.ts` looks the cache up by — never `finalUrl` — so
   *  it must not be repointed at the post-redirect URL; `finalUrl` (PAR-776, D-74) is added
   *  alongside it, present only when a redirect actually moved the fetch somewhere else.
   *  `version` (A11/PAR-724) is the version this document was matched to, set only on a
   *  genuine version-specific match. */
  source?: { url: string; stale: boolean; fetchedAt: string; curated: boolean; finalUrl?: string; version?: string };
  /** `documentHash` (search-index.ts) of the primary document's content — set exactly when
   *  `source` is (A20/PAR-729, D-51: what the activity log records instead of the text). */
  contentHash?: string;
  /** looksLikeIndex(primary document). */
  isIndex: boolean;
  /** Sections — or, in snippets mode, code blocks — that matched the topic across the
   *  primary document plus followed pages (0 without a topic). */
  matched: number;
  /** Of the sections actually returned under the budget, how many came from a followed page
   *  rather than the primary document. > 0 means following links is what produced the answer. */
  returnedFromFollowed: number;
  /** Followed index links, in follow order. */
  followed: string[];
  /** Index links that were candidates but not followed, by reason. `outsideOrigin` counts
   *  links the allowed-host policy refused (before or after redirects); the key keeps its
   *  0.1.3 name because doctor's JSON sums it. */
  dropped: { outsideOrigin: number; tooLarge: number; unavailable: number };
  /** PAR-848/849 (Phase 3) — set when `text` is a budget refusal (`maxTokens` could not hold
   *  the mandatory source stamp and, when one was requested, the version verdict) rather than
   *  any of the ordinary render paths. A distinct, structured fact rather than something a
   *  consumer (the activity log, `doctor`) would otherwise have to infer by parsing `text` for
   *  the refusal sentence — the same reasoning A20/PAR-729 already applies to every other
   *  outcome this interface states as data. PAR-852 — ALSO set when `text` is the
   *  over-long-`topic` refusal (`topicTooLongText`): both are "this call could not be rendered
   *  as an ordinary result, and said so" rather than two structurally different reasons a
   *  consumer needs to tell apart; neither reaches `source`/`matched` in a way `getDocsOutcome`
   *  would otherwise misclassify. */
  refused?: boolean;
  /** PAR-804 — true when real matches existed (`matched > 0`) but the budget left nothing to
   *  actually render (the `thinMatch` closure below): distinct from a genuine answer even
   *  though `text` still holds a real, honest sentence (`thinMatchNote`) rather than an empty
   *  string. Before this field existed, `doctor` and this module's own `getDocsOutcome`
   *  activity-log classifier both read this case exactly like a full answer — `"answered"`/
   *  `"matched"` — because both only checked `matched > 0`, never whether anything was actually
   *  RETURNED under budget. Absent (never `false`) on every other path — the ordinary shape for
   *  "this does not apply," matching `urlHadQuery`'s own convention in `activity-log.ts`. */
  thin?: boolean;
  /** PAR-844 (Blocking #1, review round 2) — true ONLY when `isIndex` is true, nothing was
   *  returned from a followed page (`returnedFromFollowed === 0`), AND the sections actually
   *  RETURNED are themselves link-list-shaped (`looksLikeIndex` applied to their own combined
   *  heading+body text, not the whole document). This is the narrow condition `doctor`'s
   *  `"index-only-match"` status needs — a genuine "the probe only matched the table of
   *  contents" case — and it is DELIBERATELY NOT the same fact as `isIndex` alone: `isIndex`
   *  is computed by sampling the document's first 200 non-empty lines (`looksLikeIndex`'s own
   *  documented, size-independent design, unchanged by this fix), which MEASURED, live,
   *  false-positives on a document that is index-shaped ONLY in an early stretch — a sponsors/
   *  users table, a large table of contents — while its actual body, elsewhere in the SAME
   *  document, is substantive prose the query genuinely matched. hono.dev's own llms-full.txt
   *  (372 KB, 805 headings) and docs.convex.dev's own llms-full.txt (2.54 MB, 4,526 headings)
   *  are both measured, real instances: `isIndex` is `true` for both (an early users/sponsors
   *  table and a large table of contents respectively push the 200-line sample's link density
   *  over the 0.4 threshold), but the SPECIFIC sections a real probe query matched and returned
   *  are ordinary prose with real code examples, not link lists — `doctor` must not call that
   *  `index-only-match`. Also true when the returned sections are HOLLOW — a followed page's
   *  own synthetic `# <link title>` heading matched the query verbatim while that page's real
   *  content ranked into a different, unselected section, leaving an empty body selected (
   *  MEASURED while building this item's regression fixtures) — a bodyless "match" is exactly
   *  as untrustworthy as a link-list one. Absent (never `false`) whenever it does not apply —
   *  `returnedFromFollowed > 0`, `matched === 0`, or the returned text is substantive prose. */
  indexMatchLooksLikeToc?: boolean;
}

const DEFAULT_BUDGET_TOKENS = 4000;

const sectionKey = (s: { heading: string; body: string }) => `${s.heading}\n${s.body}`;

/** A6 (PAR-719) — the note block (followed links, skipped-link categories) is priced into the
 *  budget like everything else, but its own natural size is unbounded (real URLs, real link
 *  text) — capped here rather than exempted, per the rollback trigger: generous headroom over
 *  five followed URLs plus three skip-category lines at realistic URL lengths, bounded so it
 *  can never itself starve the answer on an ordinary call. ASSUMED, not measured. */
const MAX_NOTE_BLOCK_CHARS = 1000;

/** A17 (PAR-726), code-reviewer round 1, S1 — `resolutionNote` carries the resolved package's
 *  own (untrusted) description, unbounded beyond `resolved-store.ts`'s ~200-char
 *  `MAX_DESCRIPTION` plus homepage/docs/repository facts. `noMatch` is deliberately exempt
 *  from `clipToBudget` (below, "a short, fixed-shape diagnostic, not content") — true of the
 *  message itself, but `resolutionNote` is neither short by construction nor fixed-shape, so
 *  threading it through unclipped breaks that path's own invariant. Capped here, once, so
 *  every render path — budgeted or exempt — sees the same bounded worst case. */
const MAX_RESOLUTION_NOTE_CHARS = 500;

/** security-architect, A17 round 2, SF-1 — `entry.name` and `entry.urls` are config-authored
 *  raw strings (`link-policy.ts`'s `validateLibraryUrl` checks scheme/host but never
 *  re-serializes, unlike `sanitizeRemoteUrl`'s `url.href` on the resolved path) and, unlike
 *  every stamp field, were never cleaned or clipped before landing in the could-not-fetch and
 *  no-match messages — the same forgery class `sourceStampLine`'s own `url` cleaning (S-1)
 *  closed, one interpolation over. One shared bound for both fields here (not npm's tighter
 *  214-char name limit `search.ts`'s `MAX_LIBRARY_CHARS` uses) — simplicity over precision,
 *  since a config-defined name is not npm-validated the way a resolved one is. */
const MAX_STAMP_FIELD_CHARS = 300;

/** A6 (PAR-719) — the final backstop every render path in this file applies: whatever the
 *  header (stale-note prefix, `Source:` line, table of contents or note block) and body come
 *  to, the combined response never exceeds the budget. D-29's rule, unchanged: the cap always
 *  wins, no field or header escapes it — this is what makes that literally true here even in
 *  the case an oversized header alone would otherwise exceed budget. */
function clipToBudget(text: string, budgetChars: number): string {
  return text.length > budgetChars ? text.slice(0, budgetChars) : text;
}

/** PAR-848/849 (Phase 3) — the plain, honest text for the one outcome `requiredHeader`
 *  (retrieval.ts) can produce: `maxTokens` cannot hold the mandatory source stamp — and, when
 *  one was requested, the version verdict — even at their shortest complete form. Names
 *  roughly how large a budget would need to be when that's cheap to compute
 *  (`requiredHeader`'s own `minTokensNeeded`, a lower bound: the real minimum also depends on
 *  the resolution/stale prefixes already spent before `requiredHeader` was called, and, on a
 *  path that goes on to render document text, the PAR-850 fence overhead — neither of which
 *  this function has to hand), and tells the caller what to do about it rather than leaving it
 *  to guess. */
function budgetRefusalText(minTokensNeeded: number | undefined, versionRequested: boolean): string {
  const what = versionRequested ? "the document's source and the requested version's outcome" : "the document's source";
  const guidance = versionRequested ? "Raise maxTokens, or omit version." : "Raise maxTokens.";
  const need = minTokensNeeded !== undefined ? ` (roughly ${minTokensNeeded} or more)` : "";
  return `maxTokens is too small to state ${what}${need}. ${guidance}`;
}

/** PAR-852 — the plain, honest text for a `topic` over `MAX_TOPIC_CHARS`: refused, not
 *  silently truncated (see `GetDocsArgs.topic`'s own comment for why truncation is its own
 *  honesty problem, not merely a smaller one). */
function topicTooLongText(length: number): string {
  return `The topic is ${length} UTF-16 units; the maximum is ${MAX_TOPIC_CHARS}. Shorten it — a topic is a short phrase, not a document.`;
}

/**
 * PAR-799: a thin `getDocsDetailed` wrapper returning text only — NOT the production `get_docs`
 * tool body (that is `getDocsToolText`, below, which resolves the library and records the
 * activity-log entry before ever reaching `getDocsDetailed`; `server.ts`, `doctor.ts` and the
 * CLI all call `getDocsDetailed` directly, never this function). Its only remaining caller
 * today is `test/get-docs.test.ts`, which exercises `getDocsDetailed`'s text output against an
 * already-resolved `entry` without needing `getDocsToolText`'s registry-lookup layer around it.
 * Kept as a named export rather than inlined into the test file itself in case a future,
 * non-MCP caller wants the same "already have an entry, just want the text" shape this
 * function's own signature already states.
 */
export async function getDocs(entry: LibraryEntry, args: GetDocsArgs, resolutionNote?: string): Promise<string> {
  return (await getDocsDetailed(entry, args, resolutionNote)).text;
}

/** A20/PAR-729, D-51: `refused` (PAR-848, Phase 3) when `maxTokens` could not hold the
 *  mandatory source stamp — and, when one was requested, the version verdict — even though a
 *  document was reached; `not-cached` when nothing was fetched or cached; `no-match` when a
 *  topic was given and nothing in the document matched it; `matched` otherwise (including
 *  the no-topic table-of-contents path — a document WAS successfully served, even though
 *  nothing was topic-matched to produce it). Checked in this order: a refusal takes priority
 *  over the other three, since `outcome.source` and `outcome.matched` can both be set on a
 *  refusal (see `GetDocsOutcome.refused`'s own comment) and would otherwise misclassify it.
 *
 *  PAR-804 — this function's RETURN VALUE (the closed `ActivityOutcome` vocabulary,
 *  `activity-log.ts`) deliberately still reads a thin match as `"matched"`: it genuinely did
 *  match something, and widening this closed vocabulary for a case that fits inside "matched,
 *  but see the sibling field" would cost a schema-version bump (`activity-log.ts`'s own K3 rule)
 *  for something additive. The call site below instead passes `thin: outcome.thin` as its OWN
 *  new, purely-additive `ActivityEntry` field (no bump needed — new keys may be appended,
 *  same README rule PAR-813/PAR-807 already used for `finalUrl`/`urlHadQuery`) — so a reader can
 *  still tell a thin match apart from a real one without this function silently upgrading it. */
function getDocsOutcome(topic: string | undefined, outcome: GetDocsOutcome): ActivityOutcome {
  if (outcome.refused) return "refused";
  if (!outcome.source) return "not-cached";
  if (topic !== undefined && outcome.matched === 0) return "no-match";
  return "matched";
}

/** The MCP `get_docs` tool body: resolve `library` (canonical name or alias) and run
 *  getDocs. An unknown name is resolved implicitly through resolve_library (PAR-655) —
 *  npm / PyPI metadata → llms.txt → GitHub README — and, when that works, the entry
 *  joins the live registry so the next call is a plain hit; when it does not, the
 *  could-not-resolve line is returned. Offline, an unknown name gets the unknown-library
 *  text without touching the network.
 *
 *  A20/PAR-729 (D-51): every call writes exactly one activity-log entry, whichever branch
 *  it takes — including the two that never reach a document at all (unknown offline,
 *  unresolvable) — because those are consultations too: an agent asked for a library and
 *  this is what actually happened. `library` is the requested name, cleaned by the log's
 *  own field bound, in those two branches (nothing canonical exists yet to record instead);
 *  the canonical `entry.name` once one does. */
export async function getDocsToolText(
  registry: Registry,
  args: GetDocsArgs & { library: string },
  /** PAR-853 — the MCP request's own cancellation (`server.ts` passes `extra.signal` from the
   *  `get_docs` tool callback); threaded down to `getDocsDetailed`/`getLibraryDoc`, combined
   *  there with the whole-operation deadline. `undefined` on every non-MCP caller (the CLI,
   *  `doctor`, tests) — those paths have no request to cancel and are unaffected. */
  signal?: AbortSignal,
): Promise<string> {
  validateTokenBudget(args.maxTokens);
  const { library, version, ...rest } = args;
  let entry = lookupLibrary(registry, library);
  let resolutionNote: string | undefined;
  // A11/PAR-724 — the already-resolved verdict `getDocsDetailed` renders into the stamp/note;
  // computed here (never inside `getDocsDetailed` itself, which never calls `resolvePackage` —
  // see its own doc comment) because only THIS layer knows whether `library` needed resolving
  // at all.
  let versionContext: { requested: string; matched: boolean; note?: string } | undefined;
  if (!entry) {
    if (rest.offline) {
      recordActivity({ tool: "get_docs", library, query: rest.topic, outcome: "unresolved" });
      return unknownLibraryMessage(registry, library);
    }
    const out = await resolvePackage(library, { version, strictDns: registry.strictDns, signal });
    if (!out.ok || !out.entry) {
      recordActivity({ tool: "get_docs", library, query: rest.topic, outcome: "unresolved" });
      const failure = out.operationalFailure && !out.notFound && !out.limited && !out.versionShapeRejected
        ? `\n\n${bugFailureOffer({ operation: "get_docs", where: out.operationalFailure, errorClass: out.operationalFailure === "cache" ? "CacheError" : "NetworkError", version: VERSION, platform: process.platform, nodeVersion: process.version })}`
        : "";
      return `${redactResolvePathForModel(out.text)}${failure}`;
    }
    // S2: a resolved entry never replaces a curated one; if a curated entry owns the name
    // (it cannot, since the lookup above missed — but the guard is the invariant), serve that.
    entry = installResolvedEntry(registry, out.persistedEntry ?? out.entry)
      ? (registry.strictDns ? { ...out.entry, strictDns: true } : out.entry)
      : (resolveLibrary(registry, out.entry.name) ?? out.entry);
    resolutionNote = provenanceLine(registry, library, out);
    if (version !== undefined) {
      versionContext = {
        requested: version,
        matched: out.versionMatched === true,
        // PAR-824 (item 5) — `out.versionShapeRejected` means the version was rejected OUTRIGHT
        // (hostile or malformed) before any candidate was ever tried — `versionFallbackNote`'s
        // generic "no document found for version X" would otherwise imply a real search
        // happened when it did not. Honest wording instead, using `out.attempts`' own signal
        // rather than re-deriving it: the version was not valid, and was ignored.
        note: out.versionShapeRejected
          ? `${clipText(version, MAX_STAMP_VERSION_CHARS)} is not a valid version and was ignored.`
          : undefined,
      };
    }
  } else if (version !== undefined && entry.resolved !== undefined) {
    if (rest.offline) {
      // A11/PAR-724 (code-reviewer round 1, #4) — `offline` means "never touch the network"
      // on this branch too, exactly as the unknown-name branch above already honours it;
      // re-resolving for a version is itself a network operation.
      const versionedEntry = entryForVersion(entry, version);
      if (versionedEntry) {
        entry = versionedEntry;
        versionContext = { requested: version, matched: true };
      } else {
        versionContext = {
          requested: version,
          matched: false,
          note: `Version ${clipText(version, MAX_STAMP_VERSION_CHARS)} was requested, but this call is offline — version-matching needs the network. Showing the cached document instead.`,
        };
      }
    } else {
      // A11/PAR-724 — an already-resolved (non-curated) entry gets re-resolved for the pinned
      // version, the same D-11-established pattern `warm.ts` already uses to re-resolve for a
      // different ecosystem: this entry's own provenance came from `resolvePackage` in the
      // first place, so it has an ecosystem + name to re-resolve against.
      const out = await resolvePackage(library, { version, ecosystem: entry.resolved.source, strictDns: registry.strictDns, signal });
      if (out.ok && out.entry) {
        entry = installResolvedEntry(registry, out.persistedEntry ?? out.entry)
          ? (registry.strictDns ? { ...out.entry, strictDns: true } : out.entry)
          : (resolveLibrary(registry, entry.name) ?? out.entry);
        versionContext = { requested: version, matched: out.versionMatched === true };
      } else {
        // A11/PAR-724 (code-reviewer round 1, B2) — the re-resolution itself failed outright
        // (network down, rate-limited): this is NOT "checked and found no versioned document"
        // — nothing was actually checked. Rendering the ordinary fallback wording here would
        // be an affirmative claim the run never earned, worse than the silent substitution
        // D-50 forbids. A distinct, honest note instead: what happened, and that the cached
        // document (if any) is what is being served.
        const reason = out.limited ? "the resolution limit was reached" : "the check failed";
        versionContext = {
          requested: version,
          matched: false,
          note: `Could not check version ${clipText(version, MAX_STAMP_VERSION_CHARS)} — ${reason}; showing the previously cached document instead.`,
        };
      }
    }
  } else if (version !== undefined && entry.resolved === undefined) {
    // A11/PAR-724 — a curated (default-registry or config) entry's `urls` are hand-picked doc
    // sources, not derived from registry metadata, so there is no version-specific candidate to
    // try. Stated explicitly rather than silently ignoring `version` (D-50's non-silent rule
    // applies to "no version support here" exactly as it does to "no versioned document found").
    versionContext = {
      requested: version,
      matched: false,
      note: entry.name.includes('"')
        ? `Version ${clipText(version, MAX_STAMP_VERSION_CHARS)} was requested for this curated entry:\n${fenceEchoedIdentifier(entry.name, MAX_STAMP_FIELD_CHARS)}\nVersion-matching applies only to packages resolved automatically.`
        : `Version ${clipText(version, MAX_STAMP_VERSION_CHARS)} was requested, but "${clipText(entry.name, MAX_STAMP_FIELD_CHARS)}" is a curated entry — version-matching applies only to packages resolved automatically.`,
    };
  }
  // security-architect round 2, S4 — a security-relevant fact (this entry's identity was
  // decided by an explicit config-authored override, not its own name — PAR-854/D-90's
  // `replaces` field, see `registry.ts`'s `applyLayer`) previously reached only stderr (which
  // most MCP clients swallow) and `list_libraries`' header (a tool an agent may never call).
  // Reusing `resolutionNote`'s existing, already budget-priced disclosure slot puts it where an
  // agent actually reading `get_docs`'s own response — and the person watching it — will see
  // it, the same channel `STALE:`/redirect/curated-entry-skip notes already use. Never
  // overwrites a note this call already has something more specific to say (the resolution-
  // provenance and version-fallback branches above).
  if (resolutionNote === undefined && entry?.replaces !== undefined) {
    resolutionNote = entry.name.includes('"') || entry.replaces.includes('"')
      ? "Note: this entry was configured to explicitly replace another name (a punctuation-twin override, vibectx.config.json). Inspect the config for the exact names."
      : `Note: "${clipText(entry.name, MAX_STAMP_FIELD_CHARS)}" was configured to explicitly replace "${clipText(entry.replaces, MAX_STAMP_FIELD_CHARS)}" (a punctuation-twin override, vibectx.config.json).`;
  }
  // A17 (PAR-726): resolutionNote used to be prepended here, entirely outside getDocsDetailed's
  // own budget accounting — exactly A6's original mistake, repeated. It is now passed down and
  // priced as part of the header alongside the standing stamp, so on every path `clipToBudget`
  // actually applies to (no-topic, and topic-given success/snippets), `resolutionNote + body`
  // together never exceed `maxTokens*4`, not merely `body` alone. `noMatch` stays the one
  // pre-existing, DELIBERATE exception to that cap (A6's own "short, fixed-shape diagnostic"
  // design, unchanged here) — `resolutionNote` is bounded before it reaches that path too
  // (code-reviewer round 1, S1: `MAX_RESOLUTION_NOTE_CHARS`), so "exempt from the hard cap"
  // no longer also means "unbounded".
  //
  // A20/PAR-729: `getDocsDetailed` directly, not the `getDocs` text-only wrapper — the
  // structured outcome is what the activity-log entry is built from; `detailed.text` already
  // carries `resolutionNote` baked into its own priced header, so nothing is prepended here.
  const detailed = await getDocsDetailed(entry, rest, resolutionNote, versionContext, signal);
  const loggedTopic = rest.topic?.trim() || undefined;
  recordActivity({
    tool: "get_docs",
    library: entry.name,
    query: loggedTopic,
    url: detailed.source?.url,
    // PAR-813 (Phase 4) — `finalUrl` (PAR-776) is added alongside `url` so the activity log
    // carries the same redirect provenance the rendered stamp does, rather than that fact
    // being reachable only through prose that degrades under budget pressure (see
    // `StampFacts.redirectedFrom`'s own comment: the newest, most-optional stamp field drops
    // first, which makes it a poor AUDIT signal on its own). Both are redacted and bounded the
    // same way by `activity-log.ts`'s own `toActivityEntry` — this call site just supplies the
    // raw values.
    finalUrl: detailed.source?.finalUrl,
    contentHash: detailed.contentHash,
    fresh: detailed.source ? !detailed.source.stale : undefined,
    outcome: getDocsOutcome(loggedTopic, detailed),
    // PAR-804 — see getDocsOutcome's own comment: additive field, not a new outcome value.
    thin: detailed.thin,
  });
  return !rest.offline && !detailed.source && !detailed.refused
    ? `${detailed.text}\n\n${bugFailureOffer({ operation: "get_docs", where: "network", errorClass: "NetworkError", version: VERSION, platform: process.platform, nodeVersion: process.version })}`
    : detailed.text;
}

/** R3: one line the agent sees before docs that were resolved on this very call — where
 *  the package came from, its own (untrusted) description, and a nearby curated name
 *  when the request looks like a typo of one. A17 (PAR-726): this is the ONE-TIME extra
 *  detail a fresh resolution adds; the STANDING stamp every call gets (source, fetched-at,
 *  fresh/stale, curated/resolved — see `sourceStampLine`) is separate and unconditional,
 *  added inside `getDocsDetailed` itself.
 *
 *  A5 (PAR-718): also the ONLY place `get_docs`'s implicit-resolution path surfaces
 *  `out.saved === false` (a write failure the process could not avoid — a read-only
 *  `$HOME` or a full disk — now caught in `resolvePackage` instead of thrown). The
 *  document is still returned and the call still exits 0: the resolution lives in memory
 *  for the rest of this process even when `resolved.json` could not be written, so losing
 *  the save is not losing the answer. */
function provenanceLine(registry: Registry, requested: string, out: ResolveOutcome): string {
  const label = out.source === "pypi" ? "PyPI" : "npm";
  const facts: string[] = [];

  if (out.homepage) facts.push(`homepage ${out.homepage}`);
  if (out.docsUrl) facts.push(`docs ${out.docsUrl}`);
  if (out.repository) facts.push(`repository github.com/${out.repository.owner}/${out.repository.repo}`);
  const near = nearestLibraryName(registry, requested);
  if (near) facts.push(`nearest curated name: "${near}"`);
  if (out.saved === false) {
    const reason = out.saveNote?.includes("newer schemaVersion")
      ? "local store has a newer schemaVersion; upgrade vibectx or inspect in a terminal"
      : out.saveNote?.includes("EACCES")
        ? "local store unavailable (EACCES); inspect with vibectx resolve in a terminal"
        : "local store unavailable; inspect with vibectx resolve in a terminal";
    facts.push(`resolution not saved: ${reason}`);
  }
  const summary = `> Resolved "${requested}" via ${label} on this call — not a curated entry; verify this is the package you meant. `;
  if (!out.entry?.description) return `${summary}${facts.join(" · ")}`.trimEnd();
  // Reuse the existing variable-width fence as an inline data span. Reserve the
  // complete span before clipping trusted facts so no budget can expose its contents
  // as new provenance fields. Package text is never a fact authored by this tool.
  let descriptionLimit = 200;
  let description = fenceEchoedIdentifier(out.entry.description, descriptionLimit).split("\n").slice(1).join(" ");
  while (description.length > 300) {
    descriptionLimit = Math.floor(descriptionLimit / 2);
    description = fenceEchoedIdentifier(out.entry.description, descriptionLimit).split("\n").slice(1).join(" ");
  }
  const labelText = "(package-supplied) description: ";
  const room = MAX_RESOLUTION_NOTE_CHARS - description.length - labelText.length - 1;
  return `${clipText(summary + facts.join(" · "), room)} ${labelText}${description}`;
}

/** True when `entry` was synthesized by `resolve_library` this session rather than coming
 *  from the default registry or a config file (list-libraries.ts:54 established this exact
 *  reading of the field first; A17/PAR-726 reuses it for the standing stamp). */
function isCurated(entry: LibraryEntry): boolean {
  return entry.resolved === undefined;
}

/** PAR-814 (PAR-776 cleanup) — "did this document actually redirect" compares NORMALISED URLs
 *  (`new URL(...).href`), not the raw strings. A raw `doc.finalUrl !== doc.url` treats a config
 *  URL with, say, an uppercase host or a trailing default port as a "redirect" even though
 *  nothing redirected — the fetch simply landed on the byte-for-byte equivalent, differently
 *  spelled, URL it was given. Cosmetic/wording only (a spurious "redirected from" note), never a
 *  security concern: both values already passed through this codebase's own URL sanitisation
 *  before reaching here. Falls back to the raw comparison if either fails to parse (should not
 *  happen for either field by the time it reaches this function, but this is a display nicety,
 *  not a security check, so failing open to the OLD behaviour is the safe default here). */
function didRedirect(candidateUrl: string, finalUrl: string): boolean {
  try {
    return new URL(finalUrl).href !== new URL(candidateUrl).href;
  } catch {
    return finalUrl !== candidateUrl;
  }
}

/** getDocs with its structured outcome (see GetDocsOutcome). `resolutionNote`: the one-time
 *  extra prose `getDocsToolText` computed when THIS call is what resolved `entry` implicitly
 *  (see `provenanceLine`) — undefined on every other call. Priced into the budget alongside
 *  the standing stamp, not prepended outside it (A17/PAR-726). */
export async function getDocsDetailed(
  entry: LibraryEntry,
  args: GetDocsArgs,
  resolutionNote?: string,
  // A11/PAR-724 — the already-resolved version verdict; see `getDocsToolText`'s own comment for
  // why this function itself never calls `resolvePackage` to compute it.
  versionContext?: { requested: string; matched: boolean; note?: string },
  /** PAR-853 — the MCP request's own cancellation, when the transport exposes one
   *  (`server.ts` threads `extra.signal` in here for the `get_docs` tool): combined with the
   *  whole-operation deadline inside `getLibraryDoc`, so a client that gives up actually stops
   *  the in-flight fetch rather than it running unobserved to completion. */
  signal?: AbortSignal,
  /** Test seam (PAR-851, threaded here at CI-hardening round 3 for `doctor.ts`'s own
   *  concurrency test — the same class of DNS/libuv-threadpool nondeterminism round 2 fixed in
   *  `fetcher.ts`/`server.ts`/`autowarm.ts` was still latent here, since `checkLibrary` had no
   *  path to inject a fake lookup into the `getLibraryDoc`/`fetchLinkedPage` calls this function
   *  makes). Overrides the DNS lookup `checkResolvedAddress` uses. Production code never sets
   *  this. */
  lookup?: AddressLookup,
): Promise<GetDocsOutcome> {
  validateTokenBudget(args.maxTokens);
  const noDropped = { outsideOrigin: 0, tooLarge: 0, unavailable: 0 };
  // PAR-852 — checked FIRST, before any fetch or tokenization: this is the function boundary
  // the MCP schema's own `.max(MAX_TOPIC_CHARS)` (server.ts) is defense-in-depth FOR, since
  // this function is reachable directly (the CLI, `doctor`'s probe queries, and every test)
  // bypassing that schema entirely. `refused: true` reuses the SAME activity-log outcome
  // PAR-848's budget refusal uses (`getDocsOutcome`, below) — both are "the call could not be
  // rendered as an ordinary result and said so, rather than guessing or truncating silently";
  // this is a considered widening of what `refused` covers, not an accidental one.
  if (args.topic !== undefined && args.topic.length > MAX_TOPIC_CHARS) {
    return {
      text: topicTooLongText(args.topic.length),
      isIndex: false,
      matched: 0,
      returnedFromFollowed: 0,
      followed: [],
      dropped: noDropped,
      refused: true,
    };
  }
  const topic = args.topic?.trim() || undefined;
  const resolutionPrefix = resolutionNote ? `${clipText(resolutionNote, MAX_RESOLUTION_NOTE_CHARS)}\n` : "";
  const curated = isCurated(entry);
  const doc = await getLibraryDoc(entry, { offline: args.offline, signal, lookup });
  if (!doc) {
    // PAR-849 (Phase 3), superseding the A17 (PAR-726) addendum below — this was the one
    // response in this file with no `Source:`-shaped line at all: nothing was fetched, so
    // there is genuinely no url/fetchedAt/stale to state, but "make the claim true" means this
    // path states that absence in the SAME grammar every other path uses, not a second,
    // differently-worded vocabulary for "here is what I know about where this came from". A
    // structurally distinct value (`none`) rather than an empty or omitted field, so a reader
    // (or a `Source:`-scanning script) cannot mistake this for a real URL that happened to
    // render short — curated/resolved is still a fact about `entry` regardless of whether a
    // document was ever reached, carried over unchanged from the A17 addendum this replaces.
    // Nit (code-reviewer, Phase 3 round 2): field order matches `sourceStampLine`'s own
    // convention (`url · fetched · fresh · curated`, curated/resolved LAST), not curated
    // second.
    const noDocStamp = `Source: none · nothing cached · ${curated ? "curated" : "resolved"}`;
    // PAR-849 — folded in from independent verification: the second line always claimed "all
    // candidate URLs unreachable", which is false on a fully offline call (`args.offline`) —
    // zero fetches were ever attempted, so nothing was "unreachable"; that word describes a
    // fetch that was tried and failed, not a fetch that was never sent. Threaded through
    // `args.offline` (already received by this function) to say which of the two actually
    // happened, rather than one fixed sentence covering both.
    //
    // code-reviewer S8 (Phase 3, round 2) — wording aligned with `fetcher.ts`'s own
    // `staleNote` (D-48's "one grammar, one place" lesson: this distinction — offline/never-
    // attempted vs. attempted/unreachable — already has an established phrasing there,
    // "offline mode, network not attempted" / "all candidate URLs unreachable"; reused
    // verbatim rather than inventing a third vocabulary for the same fact).
    const attemptLine = entry.name.includes('"')
      ? `${args.offline ? "Offline mode, network not attempted" : "All candidate URLs unreachable"} for this library — nothing is cached.\n${fenceEchoedIdentifier(entry.name, MAX_STAMP_FIELD_CHARS)}\n${args.offline ? "Candidates:" : "Candidates tried:"}`
      : args.offline
        ? `Offline mode, network not attempted, for "${clipText(entry.name, MAX_STAMP_FIELD_CHARS)}" — nothing is cached. Candidates:`
        : `All candidate URLs unreachable for "${clipText(entry.name, MAX_STAMP_FIELD_CHARS)}", and nothing is cached. Candidates tried:`;
    // security-architect, A17 round 2, SF-1: `entry.name`/`entry.urls` come straight from a
    // config file's raw strings — `validateLibraryUrl` (link-policy.ts) checks scheme/host but
    // never re-serializes, so a URL is validated, not normalised, the same gap S-1 closed for
    // the stamp's own `url`. Cleaned and clipped here too, so this response can't carry the
    // same forged-second-line risk right next to the marker that names it "no document".
    // security-architect S-1 (Phase 3, round 2) — `stripStampQuery` (retrieval.ts) applied here
    // too: a config-authored candidate URL can carry a `?token=…` exactly as `doc.url`/
    // `doc.finalUrl` can, and PAR-811 exists precisely so that never reaches a model's context —
    // this is the branch most likely to fire for a token-bearing URL (the fetch failed, or the
    // call is offline), and it was echoing the query string in full.
    return {
      text: `${resolutionPrefix}${noDocStamp}\n${attemptLine}\n${entry.urls.map((u) => clipText(stripStampQuery(u), MAX_STAMP_FIELD_CHARS)).join("\n")}`,
      isIndex: false,
      matched: 0,
      returnedFromFollowed: 0,
      followed: [],
      dropped: noDropped,
    };
  }
  // A11/PAR-724 — the version this document is actually matched to, when it is; computed once
  // and reused by `source` (the structured outcome) and `stampFacts` (the rendered line) so the
  // two can never disagree.
  const matchedVersion = versionContext?.matched ? versionContext.requested : undefined;
  // PAR-776 (D-74) — `source.url` stays the CANDIDATE `doc.url`, unconditionally: `doctor.ts`
  // reads it straight into `readCache(entry.name, source.url, ttlHours)`, which requires the
  // exact candidate the cache is keyed by, never the post-redirect `finalUrl`. `finalUrl` is
  // added alongside it, only when it actually differs, so a structured consumer can learn the
  // same redirect fact the rendered stamp below states, without parsing prose for it — the
  // same design A17/PAR-726 already established for `stale`/`fetchedAt`/`curated`.
  const source = {
    url: doc.url,
    stale: doc.stale,
    fetchedAt: doc.fetchedAt,
    curated,
    version: matchedVersion,
    ...(didRedirect(doc.url, doc.finalUrl) ? { finalUrl: doc.finalUrl } : {}),
  };
  // A20/PAR-729: the same hash the search index already computes to detect a changed
  // document (D-33) is what the activity log records in place of the text itself.
  const contentHash = documentHash(doc.content);
  // D-34 (PAR-659): every writer of a PRIMARY cached document keeps the cross-library search
  // index current — a document get_docs just fetched is one `search` would otherwise have to
  // tokenize on its own. Only the primary document: followed index pages are per-query and
  // would make the index unbounded. Memoized by content hash inside the hook, so the ordinary
  // cache-hit call does no file work at all, and best effort throughout (D-13). Keyed by the
  // CANDIDATE `doc.url`, matching `search.ts`'s own `primaryCached` (D-74, PAR-776): the search
  // index's hash+url gate correlates against `entry.urls`, never a post-redirect URL.
  indexCachedDocument(entry.name, doc.url, doc.content);
  const isIndex = looksLikeIndex(doc.content);
  const budget = args.maxTokens ?? DEFAULT_BUDGET_TOKENS;
  const budgetChars = budget * 4;
  // code-reviewer, A17 round 2, SF2 — the same B2 defect `fitStampLine` exists to prevent
  // (a real, well-formed, WRONG date from a mid-value character slice: `doc.staleNote` embeds
  // `fetchedAt` in prose, e.g. "STALE: served from cache fetched 2026-09-1…") was still
  // reachable here, pre-existing and unaffected by A6/A17 alike, because this banner was never
  // priced against a "fits or omit" rule the way every OTHER header piece now is. All-or-
  // nothing, not a field-by-field degrade like the stamp: the STRUCTURED fact ("stale") still
  // survives in `docStamp` below whenever docStamp itself fits, so dropping this prose
  // explanation first (never truncating it) loses elaboration, not the fact.
  const staleBanner = doc.staleNote ? `> ${doc.staleNote}\n\n` : "";
  const prefix = staleBanner.length <= Math.max(0, budgetChars - resolutionPrefix.length) ? staleBanner : "";
  // A11 (PAR-724) — the version verdict text: either the fallback statement (a version was
  // requested, none was matched — D-50, never silent) or the curated-entry-skip explanation.
  // `versionContext.matched === true` needs no verdict here — that fact lives in `docStamp`'s
  // own `version` field instead (`stampFacts` below), so the two never say the same thing
  // twice. PAR-848 (Phase 3) — no longer independently droppable when it doesn't fit: priced
  // together with the stamp by `requiredHeader` below, never truncated into a misleading
  // partial sentence (unchanged from before this item), but "drop the verdict, keep the stamp"
  // is no longer a legal outcome either — see `requiredHeader`'s own comment (retrieval.ts) for
  // why both survive together or the call refuses.
  const versionVerdict = versionContext && !versionContext.matched ? (versionContext.note ?? versionFallbackNote(versionContext.requested)) : undefined;
  // A18 (PAR-727): built once, reused by both the standing `docStamp` below and `thinMatch`'s
  // own re-fitted stamp further down — the same facts, just re-degraded around less room.
  // PAR-776 (D-74): `url` here is the URL the content actually came from (`doc.finalUrl`), not
  // the candidate that was requested — unlike the structured `source` above, this is what a
  // human or a model reading the response needs to know the document's real origin is.
  // `redirectedFrom` carries the candidate too, only when it differs, so the line states BOTH
  // when they diverge rather than silently substituting one for the other.
  // A19/PAR-728 — doctor's LAST verdict for this entry (PAR-704: a source can be cleanly
  // cached and still fail every probe), read once here rather than re-probed on this call.
  // Set only when unhealthy, same rule `list-libraries.ts`'s `[doctor: ...]` note applies.
  // `doctorCheckedAt` always travels with `doctorKind` (code-reviewer round 1, B3) — an
  // unhealthy verdict with no date would read as present-tense forever, even long after a fix.
  const doctorVerdict = readDoctorVerdicts().get(entry.name);
  const doctorUnhealthy = doctorVerdict && !doctorVerdict.healthy;
  const stampFacts: StampFacts = {
    url: doc.finalUrl,
    redirectedFrom: didRedirect(doc.url, doc.finalUrl) ? doc.url : undefined,
    fetchedAt: doc.fetchedAt,
    stale: doc.stale,
    curated,
    version: matchedVersion,
    doctorKind: doctorUnhealthy ? doctorVerdict.kind : undefined,
    doctorCheckedAt: doctorUnhealthy ? doctorVerdict.checkedAt : undefined,
  };
  // PAR-848/849 (Phase 3), amending D-50 — the mandatory reservation shared by the no-topic,
  // no-match and success headers below (all three price the SAME room: whatever
  // `resolutionPrefix`/`prefix` left of `budgetChars`). `thinMatch` reserves its own, smaller
  // room around its note and calls `requiredHeader` again on its own terms — see its own
  // closure below for why that path's priority order is different. Either the version verdict
  // (when one is needed) and the stamp both fit, or this whole call refuses outright: see
  // `requiredHeader`'s own comment (retrieval.ts) for why "drop one, keep the other" is no
  // longer a legal outcome for either half.
  const mandatory = requiredHeader(stampFacts, versionVerdict, Math.max(0, budgetChars - resolutionPrefix.length - prefix.length));
  if (mandatory.refuse) {
    // code-reviewer B1 (Phase 3, round 2) — the refusal is a short, fixed-shape diagnostic, the
    // same class `noMatch` already is (see its own comment below): bounded by construction
    // (a fixed template plus one small number), not content, and it fires ONLY at small
    // `maxTokens` — exactly where `clipToBudget` bites hardest. Wrapping it in `clipToBudget`
    // reintroduced PAR-848's own defect one line later: MEASURED, the refusal lost "Raise
    // maxTokens, or omit version." (the only actionable content) below `maxTokens: 37` on a
    // 28-char-URL fixture, and the "(roughly N or more)" figure below 27 — a partially-
    // truncated refusal is exactly the "misstate the outcome" failure `requiredHeader`'s own
    // comment already warns against for the version verdict. Exempt, like `noMatch`, not
    // clipped.
    return {
      text: `${resolutionPrefix}${prefix}${budgetRefusalText(mandatory.minTokensNeeded, versionVerdict !== undefined)}`,
      source,
      contentHash,
      isIndex,
      matched: 0,
      returnedFromFollowed: 0,
      followed: [],
      dropped: noDropped,
      refused: true,
    };
  }
  // A17 (PAR-726) — the version verdict (if any) and the fitted stamp, ready to prepend: the
  // room actually available was whatever the one-time resolution note and the stale prefix
  // already left, so a small budget degrades the stamp to a shorter COMPLETE line rather than
  // leaving it to the final `clipToBudget` backstop to cut a field in half (measured pre-fix:
  // `maxTokens: 14` rendered `fetched 2026-09-1` — a real, well-formed, WRONG date).
  const docStamp = mandatory.text;

  if (!topic) {
    const headings = splitSections(doc.content).filter((s) => s.level > 0).slice(0, 60).map((s) => `${"#".repeat(s.level)} ${s.heading}`);
    // Round 2 (code-reviewer, Nit 4) — the SAME D-43 half-share discipline the note block
    // already gets, applied to the table of contents: before this, the TOC was priced as
    // header (unconditionally ahead of the document head) but never capped as a SHARE of the
    // budget, only at a fixed 60-line ceiling — so on a document with many/long headings, the
    // TOC alone could consume the entire response and leave no document head at all, the same
    // failure D-43 was written to prevent for the note block.
    //
    // NARROWED CLAIM (round 3, test-auditor, F6) — round 2's own comment here overstated this
    // as a GUARANTEE of half of `budgetChars` for the document head. It was not one: the loop
    // took its first heading line unconditionally regardless of length, so a single heading
    // longer than `tocBudget` (unbounded — nothing upstream of this slice bounds a heading
    // line's length) reproduced the exact starvation this fix exists to prevent, by a
    // different route. Fixed here per D-29 ("the cap always wins, no field escapes it",
    // already the rule for `selectSections`/`assembleSnippets`): the first line is now CLIPPED
    // to `tocBudget` rather than taken whole when it alone exceeds it — this is not a "take at
    // least one heading" exception, it is the same cap the rest of the loop already obeys.
    // What this buys, precisely (round 4, test-auditor F7 — round 3's own replacement
    // claim here was ALSO wrong, off by roughly a factor of 2, caught the same way as F6):
    // the TOC content itself never exceeds `tocBudget` (half of `budgetChars`), full stop —
    // that part IS an exact guarantee. It is NOT a guarantee that the document head is ever
    // non-empty: `doc.finalUrl` (PAR-776 — what the stamp renders; see below) is itself
    // unbounded, so the fixed overhead around the TOC
    // (`Source:` line, label, separator — NOT charged against `tocBudget`) can still exceed
    // what's left once the TOC saturates its own half-share. When it saturates (a heading at
    // or past `tocBudget`), head is non-empty only once `budgetChars` clears roughly TWICE
    // that fixed overhead, not merely "the overhead plus one character" — MEASURED for
    // `test/get-docs.test.ts`'s `INDEX_URL` fixture (64-char fixed overhead): `head` stays empty through
    // `maxTokens: 32` (`budgetChars` 128, `header` 128) and only turns non-empty at
    // `maxTokens: 33` (`budgetChars` 132, `header` 130, `head` 2 chars) — not at
    // `budgetChars >= 65`, which is what "overhead plus one character" would predict. Below
    // that boundary, the final `clipToBudget` backstop is what keeps the response in budget,
    // same as every other path — it does not keep the head non-empty. No universal formula is
    // asserted here for that reason: the fixed overhead varies with `doc.finalUrl`'s own length, so
    // the real boundary is per-document and pinned by test at a real url, not claimed as a
    // constant.
    const tocBudget = Math.floor(budgetChars / 2);
    let toc = "";
    for (const line of headings) {
      const next = toc.length === 0 ? line : `${toc}\n${line}`;
      if (next.length > tocBudget) {
        if (toc.length === 0) toc = line.slice(0, tocBudget);
        break;
      }
      toc = next;
    }
    // security-architect B-1 (Phase 3, round 2) — the TOC's heading lines come straight from
    // `doc.content` (the loop above), exactly as untrusted as the document head below them, but
    // used to be folded into `header` UNFENCED — up to `tocBudget` (half of `budgetChars`, so up
    // to 8000 chars at the default `maxTokens: 4000`) of retrieved text rendered between the
    // real `Source:` line and the fenced/labelled region, contradicting this file's own "every
    // response wherever it appears" claim (`src/server.ts`, `README.md`) for the one path that
    // still violated it. Fixed by treating the TOC and the document head as ONE retrieved-text
    // region: `header` now carries only the mandatory stamp (never document-derived), and the
    // "Table of contents:" label plus the TOC plus the document head are built as a single
    // string and wrapped ONCE by `fitRetrievedText` below — the same atomic guarantee PAR-850
    // established for the sections-mode body. "Table of contents:" is VibeCTX's own literal
    // text, not document-derived, but rides inside the SAME fence as the headings it introduces
    // rather than getting a fence of its own — D-30 is not affected either way (only retrieved
    // text is ever cleaned/uncleaned; a literal label is neither).
    const header = `${resolutionPrefix}${prefix}${docStamp}\n\n`;
    // A6 (PAR-719) — the OVERSIGHT FINDING this item exists to close: `head` used to be
    // computed as `doc.content.slice(0, budget * 4)` — the ENTIRE allowance — and the stale
    // prefix, `Source:` line and table of contents were then prepended ON TOP of that, so the
    // rendered response could run to kilobytes over budget on an ordinary call. The header is
    // priced FIRST now; the retrieved-text region gets only what is left. `Math.max(0, ...)`,
    // not a floor that lets the header itself grow unbounded — D-29's rule applies here too: the
    // cap always wins, so the final clip below is the backstop for the case where even the
    // header alone is over budget, which the retrieved-text region alone being empty cannot fix.
    //
    // PAR-850 (Phase 3) — `doc.content` (and, per the security-architect finding above, the TOC
    // built from it) is retrieved, untrusted document text (D-30: never cleaned or filtered).
    // `fitRetrievedText` (retrieval.ts) wraps the whole region in the same fence technique
    // `mode: "snippets"` already uses for code blocks, preceded by a VibeCTX-authored label, so
    // a forged `Source:` line or an injected instruction anywhere in it — the TOC's own heading
    // text included — is structurally, visibly INSIDE the delimited region rather than sitting
    // in the same undelimited stream as the response's own `Source:` line above it — and
    // guarantees the label+fence never appear without room for at least one real character of
    // body, so the boundary itself cannot be the thing a tight budget silently drops (that would
    // be PAR-848's defect in a new place).
    const retrievedText = toc ? `Table of contents:\n${toc}\n\n---\n\n${doc.content}` : doc.content;
    const body = fitRetrievedTextDetailed(retrievedText, Math.max(0, budgetChars - header.length), true).text;
    return {
      text: clipToBudget(`${header}${body}`, budgetChars),
      source,
      contentHash,
      isIndex,
      matched: 0,
      returnedFromFollowed: 0,
      followed: [],
      dropped: noDropped,
    };
  }

  // Topic given: if the doc is an index of links, pull the best-matching pages too.
  //
  // D-31: the primary document and each followed page are split into sections
  // SEPARATELY and the section LISTS concatenated. Concatenating the TEXT and splitting
  // once meant an unclosed fence in one document swallowed everything appended after it
  // — the next page's sections, its heading path and its answer with them. Each page
  // still keeps the "# <link title>" marker as its own root heading, so its heading
  // paths read under the page they came from.
  const primarySections = splitSections(doc.content);
  const followedSections: SplitSection[] = [];
  const followed: string[] = [];
  const failed: string[] = [];
  let failedHtml = 0;
  const tooLarge: string[] = [];
  let skippedOutsideOrigin = 0;
  if (isIndex) {
    const deadline = AbortSignal.timeout(OPERATION_DEADLINE_MS);
    const followSignal = signal ? AbortSignal.any([deadline, signal]) : deadline;
    // PAR-776 (D-74) — `doc.finalUrl`, not `doc.url`, resolves relative links and gates the
    // host policy: a relative link in the document text resolves against the URL it was
    // ACTUALLY served from, not the candidate that was requested before any redirect. A
    // primary document that redirects cross-host (docs.anthropic.com → platform.claude.com,
    // D-04) used to resolve its own relative links against the ORIGINAL host — wrong, since
    // nothing was ever served from there — which could refuse a link that is genuinely
    // same-origin with the document as fetched, or (not excluded either) admit one that only
    // LOOKS same-origin against the wrong base. `doc.finalUrl` equals `doc.url` when nothing
    // redirected, so this is a no-op change for the common case.
    const limit = followLimit(extractLinks(doc.content, doc.finalUrl).length);
    // Rank every matching link, drop guard-refused ones (counted for the note),
    // THEN take the budget — so cross-origin links never crowd out followable ones.
    // fetchLinkedPage re-checks the guard; this is the visible layer, that one is the safety layer.
    const candidates = rankLinks(doc.content, topic, doc.finalUrl, Number.POSITIVE_INFINITY);
    const allowed = candidates.filter((link) => {
      const ok = isAllowedLink(link.url, doc.finalUrl, entry);
      if (!ok) skippedOutsideOrigin += 1;
      return ok;
    });
    let followedBytes = 0;
    for (const link of allowed.slice(0, limit)) {
      if (followSignal.aborted) break;
      if (followedBytes >= MAX_FOLLOWED_BYTES) break;
      // PAR-921: one deadline spans every followed link and its redirects/retry. Keep the
      // pages already gathered if it expires; the caller's cancellation is honored too.
      const result = await fetchLinkedPage(entry.name, link.url, doc.finalUrl, entry.ttlHours, args.offline, entry, { operationSignal: followSignal, lookup });
      switch (result.status) {
        case "ok":
          followedSections.push(...splitSections(`# ${link.title}\n\n${result.page.content}`).filter((s) => s.body.trim().length > 0));
          // security-architect S1 (review round 2) — `result.page.url`, not `link.url`: when
          // PAR-838's `.md` retry is what actually answered, `result.page.url` is the
          // `.md`-suffixed url the content truly came from (`fetchLinkedPage`'s own
          // `pageFromCacheHit`/online-success paths both set it that way) — a hostile origin
          // could serve DIFFERENT content at the two paths, and this note is the one place a
          // reader learns which document actually produced what they are reading. Reporting
          // `link.url` here (the link as extracted from the index, always the ORIGINAL,
          // non-retried form) would silently misattribute retried content to a url that never
          // served it.
          followed.push(result.page.url);
          followedBytes += result.page.content.length;
          break;
        case "refused": // redirect left the allowed hosts
          skippedOutsideOrigin += 1;
          break;
        case "too-large":
          tooLarge.push(link.url);
          break;
        case "unavailable":
          failed.push(link.url);
          if (result.reason === "html-response") failedHtml += 1;
          break;
      }
    }
  }
  const dropped = { outsideOrigin: skippedOutsideOrigin, tooLarge: tooLarge.length, unavailable: failed.length };

  // PAR-819 (Phase 4) — the note block is a SECOND get_docs surface a token-bearing URL can
  // reach, distinct from the stamp: `followed`/`tooLarge`/`failed` are the raw links extracted
  // from (or resolved against) the document's own content, never run through `stripStampQuery`
  // the way the stamp's `url`/`redirectedFrom` are, because the whole note BLOCK is deliberately
  // not passed through `clipText` (which would collapse its newlines — see the note-budget
  // comment below, unchanged by this item). Each URL is redacted individually, right here,
  // before it is joined into a note line — a targeted per-URL fix, not a whole-block transform,
  // so the existing newline-preservation behaviour is untouched.
  const followedRedacted = followed.map(redactUrlForDisplay);
  const tooLargeRedacted = tooLarge.map(redactUrlForDisplay);
  const failedRedacted = failed.map(redactUrlForDisplay);
  const notes: string[] = [];
  if (followedRedacted.length) notes.push(`Followed index links: ${followedRedacted.join(", ")}`);
  if (skippedOutsideOrigin > 0) {
    // PAR-776 (D-74): the document's OWN host, for this note, is the one it was actually
    // served from — matching the `isAllowedLink` check just above that produced this count.
    const hosts = [new URL(doc.finalUrl).hostname, ...(entry.allowedHosts ?? [])];
    notes.push(`Skipped ${skippedOutsideOrigin} index links outside allowed hosts (${hosts.join(", ")})`);
  }
  if (tooLargeRedacted.length) {
    notes.push(
      `Skipped ${tooLargeRedacted.length} index links larger than ${LINKED_PAGE_MAX_BYTES / (1024 * 1024)} MiB: ${tooLargeRedacted.join(", ")}`,
    );
  }
  if (failedRedacted.length) notes.push(`Could not fetch ${failedRedacted.length} index links: ${failedRedacted.join(", ")}`);
  if (failedHtml > 0) notes.push(`${failedHtml} linked docs page${failedHtml === 1 ? "" : "s"} returned HTML despite a markdown Accept request and .md retry; check the source's markdown URL or report a stale docs link.`);
  // A6 (PAR-719), done-when #2 (D-43 — the answer outranks the accounting): the note block is
  // capped at the SMALLER of a fixed ceiling and half the call's own budget, never just the
  // fixed ceiling alone. Without the budget-relative half, a maximal note block (a followed
  // link plus all three skip lines) can by itself run past a small `maxTokens`, leaving
  // `assemble`/`assembleSnippets` nothing to work with and the "answer" absent from a response
  // that is mostly accounting — exactly what D-43 forbids. Capping the note block, not
  // exempting it, is the rollback trigger's own instruction.
  //
  // NARROWED CLAIM (round 1, test-auditor, F5; corrected round 2, test-auditor, same F5 —
  // round 1's own correction still overstated the boundary): "at ANY budget" overstates what
  // this buys. The header (prefix, `Source:` line, capped notes) still has its own fixed floor
  // — the `Source:` line alone is never zero — so at a budget too small even for THAT, the
  // header consumes the whole response and the answer is absent, same as D-29 already accepts
  // for snippets ("the cap always wins" has no size-of-answer exception). MEASURED for the
  // maximal-note-block fixture `test/get-docs.test.ts`'s D-43 tests use: the room left for the
  // body is `budgetChars - header.length`, which is POSITIVE — and a real, if truncated, slice
  // of the top section is rendered — from `maxTokens: 20` upward; genuinely ZERO room (no
  // section content of any kind, not even a partial heading) only below `maxTokens: 20`. Round
  // 1's own "33 and below, no content" claim was WRONG: at 33 there IS a 28-character slice of
  // the heading line, truncated one character short of completing the word "hostname" — caught
  // on re-review, not self-caught, and corrected here rather than left standing. Both numbers
  // are per-fixture (the URL lengths, library name and note categories all vary the header's
  // own size), not universal constants — pinned by test, not asserted here as a formula. A
  // plain length clip, NOT
  // `clipText`: `clipText` (via `cleanText`) strips C0 control characters to neutralise hostile
  // derived fields, but `\n` (U+000A) IS a C0 control character — running the WHOLE multi-line
  // block through it would silently delete the newlines between note lines, collapsing four
  // lines into one unreadable run-on string. Each note line is already built from this file's
  // own literal text plus URLs; cleaning those URLs individually (if a hostile document's link
  // text needs it) is unchanged from before this item and out of A6's scope — this only bounds
  // LENGTH.
  const noteBudget = Math.min(MAX_NOTE_BLOCK_CHARS, Math.max(0, Math.floor(budgetChars / 2) - BUDGET_CUT_MARKER.length - 1));
  const noteBlock = notes.length ? `\n${notes.join("\n")}`.slice(0, noteBudget) : "";

  // Everything above this line is identical for both modes (D-26): the same document,
  // the same followed links, the same notes. Only the ranking and the rendering differ.
  // A6 (PAR-719), round 1 (test-auditor, F4): the no-match response is a fourth render path
  // D-39 was silent about, and `topic` is echoed back RAW with no length bound anywhere above
  // the MCP schema (unlike `search`'s `query`, capped at 1000 chars at the schema itself) — an
  // attacker-length topic could otherwise make this response arbitrarily large. NOT wrapped in
  // `clipToBudget` like the other three paths: this message is a short, fixed-shape diagnostic
  // ("no match, try X"), not content, and an existing test (`getDocsToolText`, "passes topic
  // and maxTokens through") correctly expects it to survive even a very small `maxTokens` in
  // full — clipping it to the full budget would make a tiny-budget call silently lose the
  // ADVICE that tells the caller what to try next, which is the one thing worth keeping. The
  // genuinely unbounded PER-CALL field, `topic`, is clipped on its own instead (round 4,
  // code-reviewer S4 — earlier wording here claimed `topic` was the only unclipped field,
  // which the `noMatch` template below directly contradicts). Neither `doc.url` nor (PAR-776)
  // `doc.finalUrl` appears in this template at all (A17/PAR-726 — see below) and, everywhere
  // either DOES still appear (`docStamp`), both are cleaned and clipped by
  // `sourceStampLine`/`fitStampLine` (security-architect, A17 round 1, S-1 — extended to
  // `redirectedFrom` by PAR-776, the same lesson applied to the newer field). `entry.name` is
  // clipped below too (round 2, SF-1) — it was
  // bounded to 214 chars only on the resolve path (`npmNameError`/`pypiNameError`), not for a
  // config-defined entry, the same gap S-1 closed for `url`.
  const noMatch = (what: string, advice: string): GetDocsOutcome => ({
    // A17 (PAR-726): the lowercase inline "(source: url)" fragment this used to carry is gone
    // — replaced by the same `docStamp` line every other path renders, closing a wording
    // inconsistency this file's own ground-truth review flagged (capitalized `Source:` line
    // everywhere else, lowercase inline fragment only here). A18 (PAR-727): the sentence
    // itself is now `retrieval.ts`'s `noMatchNote` — the one grammar shared by both modes,
    // cleaning/clipping `topic`/`entry.name` centrally instead of this file doing it inline.
    text: `${resolutionPrefix}${prefix}${docStamp}\n${noMatchNote(what, topic ?? "", entry.name)}${
      noteBlock ? `${noteBlock}\n` : " "
    }${advice}`,
    contentHash,
    source,
    isIndex,
    matched: 0,
    returnedFromFollowed: 0,
    followed,
    dropped,
  });

  /** How many of the rendered chunks came from a followed page rather than the primary
   *  document. A body-less section is never counted: the "# <link title>" marker
   *  get_docs prefixes to each followed page matches the topic by construction without
   *  carrying any answer. Only computed when something was actually followed. */
  const fromFollowed = (chosen: { heading: string; body: string }[]): number => {
    if (followed.length === 0) return 0;
    const primaryKeys = new Set(primarySections.map(sectionKey));
    return chosen.filter((s) => s.body.trim().length > 0 && !primaryKeys.has(sectionKey(s))).length;
  };

  /** PAR-844 (Blocking #1) — is what was ACTUALLY RETURNED itself link-list-shaped, or hollow?
   *  See `GetDocsOutcome.indexMatchLooksLikeToc`'s own doc comment for why this must be checked
   *  on the returned sections specifically, never inferred from `isIndex` (a whole-document,
   *  200-line-sampled fact) alone. `chosenFromFollowedCount` is passed in rather than
   *  recomputed so this never disagrees with the `returnedFromFollowed` the same call already
   *  reports.
   *
   *  MEASURED while building this item's own regression fixtures (review round 2): a followed
   *  page whose real content did not rank top-1, but whose SYNTHETIC `# <link title>` marker
   *  (`get-docs.ts`'s own link-following loop prefixes this to every followed page, verbatim
   *  from the index's link text) verbatim-matches the query, can rank top-1 on the heading
   *  alone with an EMPTY body once its own real content lands in a lower-ranked, unselected
   *  section. That is not link-list-shaped text (no markdown links in a bare heading), but it
   *  is exactly as untrustworthy as one — a heading-only, bodyless "match" is not a real answer
   *  either, so it is checked here too, not just link density. */
  const indexMatchLooksLikeToc = (chosen: { heading: string; body: string }[], chosenFromFollowedCount: number): boolean => {
    if (!isIndex || chosenFromFollowedCount > 0 || chosen.length === 0) return false;
    const combinedBody = chosen.map((s) => s.body).join("\n").trim();
    if (combinedBody.length === 0) return true;
    return looksLikeIndex(chosen.map((s) => `${s.heading}\n${s.body}`).join("\n"));
  };

  const corpusSections = [...primarySections, ...followedSections];

  // A6 (PAR-719) — the header both topic-given render paths share, priced exactly: the stale
  // prefix, the `Source:` line (and, when one was needed, the version verdict — both now the
  // one `docStamp` value `requiredHeader` produced above) and the (now capped) note block.
  // `assemble`/`assembleSnippets` price their own join separators AND this reserved amount, so
  // the combined text — header plus body — fits `budget*4` by construction; `clipToBudget`
  // below is the same D-29 backstop the no-topic path uses, for the case a maximal header alone
  // is over budget.
  const header = `${resolutionPrefix}${prefix}${docStamp}${noteBlock}\n\n`;
  // PAR-1032: disclose the existing returned-content signal, not the whole-document
  // index heuristic. Successful follows can still yield only a hollow link-title match.
  const indexMatchHeader = (indexOnly: boolean): string => {
    if (!indexOnly) return header;
    const disclosure = followed.length === 0
      ? "matched the index page's own text; no linked page was followed"
      : "matched only index or link-title text; no linked-page content is included";
    return `${resolutionPrefix}${prefix}${docStamp}${noteBlock}\nNote: ${disclosure}.\n\n`;
  };

  // A18 (PAR-727) — the thin-match case: real matches exist (`matchedCount > 0`) but the
  // budget left `assemble`/`assembleSnippets` NOTHING to render once the (full-size) header
  // above was paid for. That silence is exactly the condition D-29 already forces this file to
  // treat as "the header alone reached the budget" — which means the OUTER `clipToBudget`
  // backstop would swallow any body text at that same point regardless of what it contained.
  // A `thinMatchNote` appended to the SAME oversized header would therefore never be visible:
  // dead code, not a fix. So this path builds its OWN, smaller header instead — the note's own
  // length is reserved FIRST, and the mandatory version-verdict-plus-stamp pair re-fits (via
  // `requiredHeader`, the SAME function the shared header above calls, just with less room)
  // around what is left: D-43's "the answer outranks the accounting" applies here too — when
  // there is no room for the real answer, the EXPLANATION of why outranks the follow/skip
  // bookkeeping (`noteBlock`, dropped entirely on this path) that no longer matters as much.
  //
  // PAR-848 (Phase 3) — this closure used to leave TWO gaps here, both closed now:
  //   1. the stamp itself was silently DROPPED (not degraded) once even its shortest form
  //      didn't fit beside the note (code-reviewer, A18 round 1, S1's own fix, applied when
  //      `thinMatch` was first built) — that silent drop is no longer legal for the mandatory
  //      pair; `requiredHeader` returning `refuse: true` here means this SPECIFIC response
  //      refuses instead, per the same rule the shared header above already enforces.
  //   2. `versionBanner` was deliberately EXCLUDED from this closure altogether (an in-code
  //      comment here used to name this an accepted gap: a versioned request that fell back to
  //      latest and landed on this path reported the fallback nowhere). PAR-848's own
  //      Done-when — "the thin-match path carries the same guarantee as the match path" —
  //      requires exactly this to stop being accepted; the version verdict is now part of the
  //      SAME mandatory pair the note competes with for room, not silently omitted from the
  //      competition.
  const thinMatch = (what: string, matchedCount: number): GetDocsOutcome => {
    const note = thinMatchNote(what, matchedCount);
    const room = Math.max(0, budgetChars - resolutionPrefix.length - prefix.length - note.length - 1);
    const thinMandatory = requiredHeader(stampFacts, versionVerdict, room);
    if (thinMandatory.refuse) {
      // code-reviewer B1 (Phase 3, round 2) — same exemption as the early refusal above, same
      // reason: a bounded, fixed-shape diagnostic should not be handed to `clipToBudget`, which
      // exists to cap CONTENT, not to truncate the one honest sentence a small budget gets.
      return {
        text: `${resolutionPrefix}${prefix}${budgetRefusalText(thinMandatory.minTokensNeeded, versionVerdict !== undefined)}`,
        source,
        contentHash,
        isIndex,
        matched: matchedCount,
        returnedFromFollowed: 0,
        followed,
        dropped,
        refused: true,
        // PAR-804 — this branch already reports `refused: true`, which `getDocsOutcome` checks
        // FIRST and takes priority over `thin` for the activity-log classification (a refusal is
        // its own, more specific fact). Still set here for `doctor`/any other structured reader
        // that inspects `thin` directly rather than going through `getDocsOutcome` — this branch
        // genuinely IS the thin-match condition too (real matches existed), so leaving it unset
        // would be its own small dishonesty.
        thin: true,
      };
    }
    return {
      text: clipToBudget(`${resolutionPrefix}${prefix}${thinMandatory.text}\n${note}`, budgetChars),
      source,
      contentHash,
      isIndex,
      matched: matchedCount,
      returnedFromFollowed: 0,
      followed,
      dropped,
      thin: true,
    };
  };

  if ((args.mode ?? "sections") === "snippets") {
    const snippets = rankSplitSnippets(corpusSections, topic);
    if (snippets.length === 0) {
      return noMatch("code snippets", 'Try mode "sections" or broader terms.');
    }
    let chosenSnippets = selectSnippets(snippets, budget, header.length).map((s) => corpusSections[s.sectionIndex]!);
    const reservedHeader = indexMatchHeader(indexMatchLooksLikeToc(chosenSnippets, fromFollowed(chosenSnippets)));
    chosenSnippets = selectSnippets(snippets, budget, reservedHeader.length).map((s) => corpusSections[s.sectionIndex]!);
    let returnedFromFollowedSnippets = fromFollowed(chosenSnippets);
    const indexOnly = indexMatchLooksLikeToc(chosenSnippets, returnedFromFollowedSnippets);
    const responseHeader = indexMatchHeader(indexOnly);
    const rendered = assembleSnippetsDetailed(snippets, budget, reservedHeader.length, true);
    const assembled = rendered.text;
    if (assembled.length === 0) return thinMatch("code snippets", snippets.length);
    const withCode = rendered.rendered.filter((s) => s.snippet.code.slice(0, s.codeChars).trim().length > 0);
    if (withCode.length === 0) return thinMatch("code snippets", snippets.length);
    returnedFromFollowedSnippets = fromFollowed(withCode.map((s) => corpusSections[s.snippet.sectionIndex]!));
    return {
      text: clipToBudget(`${responseHeader}${assembled}`, budgetChars),
      source,
      contentHash,
      isIndex,
      matched: snippets.length,
      returnedFromFollowed: returnedFromFollowedSnippets,
      followed,
      dropped,
      indexMatchLooksLikeToc: indexOnly || undefined,
    };
  }

  const ranked = rankSplitSections(corpusSections, topic);
  if (ranked.length === 0) {
    return noMatch("sections", "Try broader terms or call get_docs without a topic for the table of contents.");
  }
  // Classify only sections whose actual bodies survived the same fence/cut budget.
  // The complete original section identifies a clipped link-list prefix; the visible
  // prefix additionally catches a link-only slice of an otherwise substantive section.
  const renderChosen = (responseHeader: string) => {
    const chosen = selectSections(ranked, budget, responseHeader.length);
    const assembled = chosen.map(renderSection).join(SECTION_ASSEMBLE_JOIN);
    const fitted = fitRetrievedTextDetailed(assembled, Math.max(0, budgetChars - responseHeader.length), true);
    let offset = 0, returned = 0;
    const actual: { original: typeof chosen[number]; visibleBody: string }[] = [];
    for (const section of chosen) {
      const rendered = renderSection(section);
      const bodyStart = offset + rendered.length - section.body.length;
      const visibleBody = section.body.slice(0, Math.max(0, fitted.bodyChars - bodyStart));
      if (visibleBody.trim().length > 0) {
        actual.push({ original: section, visibleBody });
        returned += fromFollowed([section]);
      }
      offset += rendered.length + SECTION_ASSEMBLE_JOIN.length;
    }
    const originals = actual.map((s) => s.original);
    const visible = actual.map((s) => ({ heading: s.original.heading, body: s.visibleBody }));
    const indexOnly = indexMatchLooksLikeToc(originals, returned) || indexMatchLooksLikeToc(visible, returned);
    return { text: fitted.text, returned, indexOnly, thin: actual.length === 0 };
  };
  let responseHeader = header;
  let rendered = renderChosen(responseHeader);
  if (rendered.indexOnly) {
    // Reserve the truthful disclosure, then price/reclassify the smaller actual prefix.
    responseHeader = indexMatchHeader(true);
    rendered = renderChosen(responseHeader);
    // Repricing can select different sections or a narrower data fence. If that now
    // exposes substantive content, keep the already bounded body and remove the false
    // disclosure. Re-rendering with the shorter header could oscillate the selection.
    if (!rendered.indexOnly) responseHeader = header;
  }
  if (!rendered.text) return thinMatch("sections", ranked.length);
  return {
    text: clipToBudget(`${responseHeader}${rendered.text}`, budgetChars),
    source,
    contentHash,
    isIndex,
    matched: ranked.length,
    returnedFromFollowed: rendered.returned,
    thin: rendered.thin || undefined,
    followed,
    dropped,
    indexMatchLooksLikeToc: rendered.indexOnly || undefined,
  };
}
