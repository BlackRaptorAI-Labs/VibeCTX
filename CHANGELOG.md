# Changelog

Releases of VibeCTX that were published. Versions 0.1.3 and 0.2.x were development versions
and were never published to npm or as a GitHub release. Design decisions are recorded by
number in [docs/decisions.md](docs/decisions.md); open limits are in
[docs/known-limitations.md](docs/known-limitations.md).

## 0.3.1 — 2026-10-07

Honesty and notice fixes found in the 2026-10-05 field audit of 0.3.0. Upgrading from 0.3.0
needs no config change.

### Version matching

- When a requested `version` cannot be matched, the reply now says what that means first:
  "Not version-matched: you asked for <name> <version>, but VibeCTX has only the latest <name>
  docs for this library. Check APIs against <version>." Every such reply's `Source:` line ends
  with `· not version-matched`; a reply too small to hold that marker is refused instead.
  (D-110)
- A built-in or config entry can list sources per major version (`versionUrls`). An explicit
  `version` whose major is listed is served from them, and the reply says
  `Version-matched: major N (from <url>)`. Shipped: prisma 6 and 7, ai-sdk 4 (D-110), and
  TanStack Query 4 (D-113). If those sources cannot be fetched and nothing is cached, the reply
  says so and does not fall back to the latest docs. (D-110)

### Notices

- The five libraries built in through 0.1.2 (fastify, fastify-type-provider-zod, timescaledb,
  pgvector, aws-cdk) are named once per process when requested with no config entry, with a
  link to the example config. timescaledb, pgvector and aws-cdk are no longer looked up on npm
  or PyPI, where those names lead to a different package, and a record 0.3.0 saved for them is
  ignored. (D-112)
- A config entry with the same name as a built-in still replaces the whole built-in entry. This
  is now stated once on stderr at load and once in that library's first `get_docs` reply.
- A primary candidate refused for being larger than 25 MiB is now named in the `get_docs`
  reply, in a notice of at most 500 characters (a count summary when space is tight, left out
  when the budget cannot hold it beside the answer), and in `vibectx doctor`. A stale copy served
  after such a refusal no longer says the sources were unreachable. (D-114)

### Retrieval

- Section selection skips a non-empty section body that is byte-identical to one already
  chosen, then keeps filling the budget. Heading-only sections are never dropped. (D-111)
- TanStack Query starts from its Query-specific index, `https://tanstack.com/query/latest/llms.txt`,
  with the earlier sources kept as fallbacks. (D-111)

### Security

- Bundled dependencies updated: `@modelcontextprotocol/sdk` 1.29.0 → 1.31.0 (GHSA-6qxp-vccf-f47h) and `proxy-addr` 2.0.7 → 2.0.8 through an override (GHSA-jqcg-44mw-7w3h). VibeCTX's own code reaches neither vulnerable path. (D-118)

### Local paths

- The cache-permission repair command shows the real cache path only when stderr is a real
  terminal. Elsewhere it reads `chmod 700 "$VIBECTX_CACHE_DIR"` with a note naming the config
  folder. `vibectx doctor`'s human output redacts local paths when stdout is not a terminal.
  MCP tool replies stay redacted. (D-109)

### Docs

- README: the upgrade notes list the five removed built-ins; a cached `npx` launch is documented
  as still checking the npm registry, with `npx --offline @blackraptorai/vibectx@0.3.1` as the
  no-network form; unattended consent is documented (`vibectx consent allow` or `deny` with the
  same `VIBECTX_CACHE_DIR`, before the server starts); a same-name config entry is documented as
  replacing the built-in entry.

## 0.3.0 — 2026-10-03

The first release from github.com/BlackRaptorAI-Labs/VibeCTX and the first npm release since
0.1.2 (published 2026-10-03). A large hardening release. Highlights:

- **Consent:** the first tool call that needs the network asks once (or discloses once when the
  client cannot ask), and the answer is remembered in `consent.json`. Connecting makes no
  network request.
- **Version matching:** `get_docs` accepts `version` and matches an exact pinned release where a
  versioned document exists, saying so when it falls back to the latest docs.
- **Project-scoped warming:** background warming covers the project's own dependencies; the
  full warm is opt-in (`VIBECTX_AUTOWARM=all`).
- **Search:** accented words and Chinese, Japanese and Korean text are tokenized.
- **Honest answers:** every served document names its source, fetch time and freshness;
  retrieved text is fenced and labelled as data; failed tool calls return a fixed error message.
- **`vibectx doctor`:** probes every built-in library with developer questions.
- **Activity log:** rotates into linked archives instead of being erased; `vibectx log --trail`.
- **Bug reports:** `report_bug` shows an anonymized preview; only your confirmation creates an
  issue link.
- **Safety:** cache symlink refusal, owner-only files and bounded reads; private and reserved
  address ranges refused after DNS resolution; bounded links and redirects.
- **Default registry:** 30 libraries chosen for the product's audience. Five earlier built-ins
  (fastify, fastify-type-provider-zod, timescaledb, pgvector, aws-cdk) moved to
  `docs/examples/node-api-stack.vibectx.config.json`.
- **Breaking:** every config URL must be `https:`; automatic discovery reads
  `vibectx.config.json` (rename an old `docs-cache.config.json`).

On 2026-10-03, after 0.3.0 was published, `@blackraptorai/vibectx` 0.1.2 and the older
`@blackraptorai/docs-cache-mcp` package were removed from npm (D-108). A pinned launch of either
no longer starts; use `@blackraptorai/vibectx@0.3.0` or later.

## 0.1.2 — 2026-07-18

Published to npm on 2026-07-18 as `@blackraptorai/vibectx`, renamed from
`@blackraptorai/docs-cache-mcp` (versions 0.1.0 and 0.1.1). A local MCP server that fetches
official library documentation (llms.txt first), caches it to disk and serves matching sections,
with the tools `get_docs`, `refresh` and `list_libraries` and a default registry of nine
libraries, including the five that later moved to the example config (fastify,
fastify-type-provider-zod, timescaledb, pgvector, aws-cdk).

0.1.2 predates fixes for a redirect escape in the fetcher, a slow link pattern that could stall
on hostile input, and unbounded response sizes. It was removed from npm on 2026-10-03 (D-108).
