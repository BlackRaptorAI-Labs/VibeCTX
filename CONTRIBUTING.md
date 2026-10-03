# Contributing to VibeCTX

VibeCTX is a local MCP (Model Context Protocol) server: it fetches official library
documentation (llms.txt-first), caches it to disk, and serves the relevant sections to coding
agents — offline, deterministically, at no recurring cost.

If you are evaluating the project or about to change it, read [Before you write code](#before-you-write-code-what-vibectx-is-and-is-not)
and [Claim discipline](#claim-discipline--binding-on-all-text-not-just-marketing) below.

## Before you write code: what VibeCTX is, and is not

**VibeCTX is a documentation cache and stays one.** It will not grow memory of past
conversations, spec or plan writing, architecture-rule checking, code symbol search, or task
tracking. Each of those has a strong incumbent, and the last was measured to make results worse.
The scope and claims the product may not make are in this section and
[Claim discipline](#claim-discipline--binding-on-all-text-not-just-marketing).

A pull request that adds capability outside that boundary will be declined on scope, however good
the code is. Open an issue first and make the scope case.

### Four design principles

- **Zero-config.** Clone, install, build — then it works, with 30 libraries built in. No database,
  no API key, no config file required.
- **Deterministic by default.** No embeddings and no network calls at query time. Retrieval is
  markdown heading-split plus BM25 over a camelCase-aware, lightly stemmed tokenizer. The same
  query returns the same answer every run.
- **Offline-first.** A cached corpus answers with the network unplugged.
- **Honest defaults.** A stale cache is served *flagged* `STALE:`, never silently. When VibeCTX
  has nothing on a topic it says so rather than returning something adjacent.

## Setup

```bash
git clone https://github.com/BlackRaptorAI-Labs/VibeCTX.git
cd VibeCTX
npm ci
npm run build
```

Contributors work from this source setup. Users can also install the published package,
`npm install -g @blackraptorai/vibectx` (0.3.0 or later). **Do not install
`@blackraptorai/vibectx` 0.1.2 or `@blackraptorai/docs-cache-mcp`:** they predate fixes for a
redirect-escape SSRF, a ReDoS link regex and unbounded response bodies.

### Node versions

`package.json` declares `engines: "^20.19.0 || ^22.12.0 || >=24.0.0"` — the INTERSECTION of
what the test toolchain's own two dependencies need (`vite` and `vitest` each declare their
own range; this is derived from both, not one) — rather than the server itself, which builds
and runs on less. The range excludes three bands a naive floor would have admitted: Node 21.x
and 22.0.0–22.11.x (`vite`'s own requirement — a plain `>=20.19.0` floor silently admitted
both) and Node 23.x (`vitest`'s own requirement — a bare `>=22.12.0`, derived from `vite`
alone, silently admitted this one; "the Node 23 hole," D-80). `engines` now correctly
documents all three as unsupported (R-1/PAR-829). This is advisory, not enforced: no `.npmrc`
here sets `engine-strict`, so `npm ci` on an excluded version still only warns (`EBADENGINE`)
rather than failing — the value of the fix is accuracy of the stated requirement, same as
D-75's own reasoning for the plain floor it replaces. CI (`.github/workflows/ci.yml`) builds
and tests all three supported bands — the **20.19 line**, **22** (resolving to the latest,
≥22.12), and **24** (resolving to the latest, ≥24.0.0) — but not the excluded bands: the
manifest documents them as unsupported, and there is nothing supported there for CI to run.
`test/engines.test.ts` asserts `engines.node` is a `semver` SUBSET of both `vite`'s and
`vitest`'s own ranges (not merely equal to one of them, and not narrower than either band
either — a fourth assertion checks the range isn't needlessly tight), so a future dependency
bump that narrows either range again fails the suite instead of silently reopening a hole.

## Build, test, lint

```bash
npm run build   # tsc → dist/
npm test        # vitest run  (needs Node ^20.19.0 || ^22.12.0 || >=24.0.0)
npm run lint    # tsc --noEmit
npm run dev     # tsc --watch
```

**The suite must be fully green with no skips.** Deliberately not stated here: how many tests
there are. Every hand-copied restatement of that number in this project has eventually gone stale,
so measure it — `npm test` prints it — rather than reading it from a document.

CI runs two workflows: `ci.yml` (build, lint, test) and `doctor.yml` (a weekly retrieval health
check).

## Testing conventions

- **No assertion may compare two wall-clock measurements.** A ratio between two timed runs is the
  most flake-prone shape there is, and it has bitten this repository. Print a `[MEASURED]` line
  and assert an **absolute** ceiling instead — the number is the record, the threshold is not.
- **Prefer measuring behaviour over mocking it.** Spy on real call counts (index reads, fetches)
  rather than asserting on elapsed time.
- **A test that passes on day one against unchanged code tests nothing.** If you add an assertion,
  confirm it fails against the code as it is now.
- Cache, config and index files are **trust boundaries**. Anything read back from disk is
  re-validated field by field; a corrupt file degrades the caller, it never throws out of it.
- Honest output: stale cache is served flagged `STALE:`; fallbacks are stated, never silent.
- Security invariants (do not weaken): https-only URLs; every library URL and redirect clears
  `src/link-policy.ts` host policy; internal hosts only via `allowInternalHosts`; symlinks are
  refused, never followed, in discovery, config walk-up and cache eviction; response bodies and
  inputs are bounded. DNS address checks fail open by default; `VIBECTX_STRICT_DNS=1` or
  top-level config `strictDns: true` makes failed/empty/timed-out preliminary lookups fail closed,
  but does not make the pre-check a connection pin.

## The project record

See [Design and release decisions](docs/decisions.md) and
[Known limitations](docs/known-limitations.md). Run [`RELEASING.md`](RELEASING.md)'s pre-tag
reconciliation checklist before cutting any release tag.

## Claim discipline — binding on all text, not just marketing

This applies to README changes, code comments and issues alike.

**No text in this project may say VibeCTX keeps an agent on task, prevents scope creep, prevents
architectural drift, or stops hallucination in general.** It prevents one evidenced kind of
hallucination — invented package names — and removes one cause of stale-context work: wrong-version
documentation. Nothing wider.

Three specific claims are barred outright because they do not survive checking: that AI makes
developers 19% slower (the authors' own revision puts it near −4%, with a confidence interval
crossing zero); that AI degrades software architecture over time (the only causal study found no
degradation); and anything attributed to "a 2026 Stack Overflow Developer Survey" (no such survey
exists).

If you cite a number, cite where it came from and prefer a primary source. "Measured" means you
ran something and can say what.

## Pull requests

- **One concern per pull request.** A refactor and a behaviour change in the same diff cannot be
  reviewed as either.
- **A pure refactor must not change behaviour.** If the suite needed edits to go green, that is a
  defect in the refactor, not an improvement to the tests.
- Say what you **measured**, not what you expect. Include the command and its output.
- Changes to `.github/` or `package.json` — raise an issue first; they affect how everyone builds.
- Note anything you could not verify. An honest "not tested" is worth more than a confident guess,
  and this project's review culture treats an unverified claim as the defect.

## Reporting a problem

Open an issue at <https://github.com/BlackRaptorAI-Labs/VibeCTX/issues>. Useful reports include: the
library name, the URL VibeCTX resolved, your Node version, and what you expected instead. If
retrieval returned the wrong section, paste the query and the heading path it returned — that is
usually enough to reproduce.

Private-documentation, air-gapped and enterprise deployment needs are worth raising too; real
setups shape what gets built.

## License

MIT © 2026 Tom Hanks / BlackRaptorAI. By contributing you agree your contribution is licensed
under the same terms.
