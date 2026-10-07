import { homedir } from "node:os";
import {
  ConfigError,
  configLocator,
  discoverConfig,
  displayPath,
  readConfigFile,
  MAX_CONFIG_VALUE_CHARS,
  type ConfigFile,
  type ConfigResolution,
} from "./config.js";
import { clipText, envFlag } from "./text.js";
import { fenceEchoedIdentifier } from "./retrieval.js";
import { normaliseAllowedHost } from "./link-policy.js";
import { mergedVersionedDocuments, readResolvedEntries } from "./resolved-store.js";
import { isExactVersionTagUrl, normalisePyPiName, MAX_NAME_LENGTH, VERSION_SHAPE } from "./package-names.js";

/** Provenance of an entry synthesized by resolve_library (PAR-655). Set only by the
 *  resolver and the persisted store; stripped from config entries. */
export interface ResolvedMeta {
  source: "npm" | "pypi";
  /** ISO timestamp of the resolution. */
  resolvedAt: string;
  /** The registry metadata document the entry was derived from. */
  metadataUrl: string;
  /** Sanitized https URLs from that metadata; the allowed-host set is derived from these. */
  homepage?: string;
  docsUrl?: string;
}

/** A version-specific document which is cached under its tag URL. Kept apart from `urls` so
 * an ordinary lookup can never silently become a version-pinned lookup. */
export interface VersionedDocument {
  version: string;
  url: string;
}

export interface LibraryEntry {
  /** Canonical name agents use to request docs. Lowercase. See NAMING RULE below. */
  name: string;
  /** Other names agents commonly use for this library (`next`, `nextjs` → `next.js`). Lowercase.
   *  An alias must not equal any canonical name in the registry; `[]` means none. */
  aliases?: string[];
  /** Ordered candidate URLs. First reachable one wins. Prefer llms-full.txt, then llms.txt, then curated pages. */
  urls: string[];
  /** PAR-1269 (D6) — candidate URLs per MAJOR version, keyed by the major as a whole number
   *  (`{ "6": [...] }`). Used only when `get_docs` is given an explicit `version` whose major is
   *  listed; those URLs then replace `urls` as the candidate list for that call. Never read for
   *  a call without `version`, and never derived from a project manifest. Same URL policy as
   *  `urls` (config.ts). */
  versionUrls?: Record<string, string[]>;
  /** PAR-1272 (decided 2026-10-05) — set by `applyLayer`, never by a config author (the config
   *  schema strips unknown keys, and `normaliseLayer` drops it): the display name of the config
   *  file whose entry replaced the built-in entry of this exact name. `get_docs` states it once. */
  replacedBuiltin?: string;
  /** Cache time-to-live in hours. Default 168 (7 days). */
  ttlHours?: number;
  /** One-line description shown by list_libraries. */
  description?: string;
  /** Topics `vibectx doctor` runs through get_docs to prove retrieval works for this
   *  entry. Pick something the docs certainly cover; one is enough. When absent — or
   *  an empty array, which is accepted and behaves exactly as absent — doctor derives
   *  a query from the description and marks it "(derived)". */
  probeQueries?: string[];
  /** Hosts, besides the source document's own, that followed index links may target.
   *  Bare hostnames (no scheme / port / path), lowercase; `*.example.com` matches
   *  subdomains, never the apex. IP literals, localhost, `.local`, `.internal` and
   *  single-label names are rejected. See src/link-policy.ts. */
  allowedHosts?: string[];
  /** Present only on entries resolve_library synthesized (never on defaults or config). */
  resolved?: ResolvedMeta;
  /** Version-specific documents a resolved entry has actually cached. Never used without an
   * exact requested/project-pinned version. */
  versionedDocuments?: VersionedDocument[];
  /** D-11: the ecosystem a shipped default, or a config author's own entry, is the package
   *  for. Every `DEFAULT_REGISTRY` entry sets it (all npm today). PAR-854/D-90 REVERSES D-63
   *  ("never config-settable"): it is now config-settable (`config.ts`'s `EntrySchema`) because
   *  `registry.ts`'s cross-layer merge and `resolveLibrary`'s lookup key PEP 503 (PyPI
   *  punctuation) normalisation on it — declared `"pypi"` folds `-`/`_`/`.` spellings together
   *  (two spellings, one project); `"npm"` or undeclared never folds (two independently
   *  registrable names must never collapse into one — the PAR-854 defect). See `applyLayer`'s
   *  merge-loop comment for the full rationale. */
  ecosystem?: "npm" | "pypi";
  /** PAR-851 (Phase 5) — the explicit, config-author-written opt-in for the air-gapped /
   *  internal-docs case (D-47): this entry's own primary fetch, every redirect hop it follows,
   *  and links followed from its documents may resolve to a private, loopback, link-local or
   *  unique-local address without being refused for that reason alone (Tom's decision,
   *  2026-09-19 — docs/decisions.md — extends the flag's original config-parse-only scope to cover
   *  hops and followed links too). Set only by a config author (`config.ts`'s schema); shipped
   *  `DEFAULT_REGISTRY` entries never set it, and `normaliseLayer` (below) never strips it —
   *  unlike `resolved`/`ecosystem`, this is an ordinary entry-shaped field a config layer is
   *  meant to carry through untouched. See `link-policy.ts`'s `validateLibraryUrl` for the
   *  textual (config-parse-time) half of this opt-in, and `address-policy.ts` for the runtime
   *  (fetch-time, DNS-aware) half this field now also governs. */
  allowInternalHosts?: boolean;
  /** Runtime-derived global policy from a discovered config; never accepted per entry. */
  strictDns?: boolean;
  /** PAR-854/D-90 — config-authored, explicit opt-in for a cross-layer override whose name is
   *  only a PEP 503 punctuation spelling apart from an existing npm/undeclared-ecosystem entry
   *  (`next_js` naming `next.js`): the name of the entry (by its canonical name BEFORE this
   *  override, i.e. the key it is replacing) this entry supersedes. Not needed for an exact-name
   *  override (unchanged) or a genuine PyPI twin (auto-collapses, unaffected — see D-78). Ignored
   *  once the merge that consumes it has run; never appears on a default. Folded (`fold()`) by
   *  `normaliseLayer`, same as `name`/`aliases`, so it compares like-for-like against a folded
   *  existing key. */
  replaces?: string;
}

/** Return the one cached candidate known to match an exact version pin. The unversioned
 * candidates are deliberately not included: if this cached tag document was removed, serving
 * latest would be a silent version fallback on an offline request. */
export function entryForVersion(entry: LibraryEntry, version: string): LibraryEntry | undefined {
  const document = entry.versionedDocuments?.find((candidate) => candidate.version === version && isExactVersionTagUrl(version, candidate.url));
  return document ? { ...entry, urls: [document.url] } : undefined;
}

/** PAR-1269 (D6): the whole-number major of a requested version (`6.19.2`, `v6.0.0` → "6"), or
 *  undefined when the version fails `VERSION_SHAPE` (D-48: the one version shape) or does not
 *  start with a number. */
function requestedMajor(version: string): string | undefined {
  if (!VERSION_SHAPE.test(version)) return undefined;
  const m = /^v?(0|[1-9][0-9]*)(?:[.+_-]|$)/i.exec(version);
  return m?.[1];
}

/** PAR-1269 (D6, amends D-76): the sources a curated entry lists for the requested version's
 *  major (`versionUrls`), or undefined when it lists none for that major. */
export function majorVersionSources(entry: LibraryEntry, version: string): { major: string; urls: string[] } | undefined {
  const major = requestedMajor(version);
  if (major === undefined || entry.versionUrls === undefined || !Object.hasOwn(entry.versionUrls, major)) return undefined;
  const urls = entry.versionUrls[major];
  return urls !== undefined && urls.length > 0 ? { major, urls } : undefined;
}

/** PAR-1268 (D4, decided 2026-10-05) — the five names built into VibeCTX through 0.1.2 and moved
 *  to `docs/examples/node-api-stack.vibectx.config.json` (PAR-654). Read only by `get_docs`' unknown-name
 *  path: a config entry with one of these names is an ordinary entry, and `warm`/autowarm never
 *  consult this table (a project dependency is an explicit identity). `resolves: false` names are
 *  never looked up on npm or PyPI, because that lookup finds a different package (a Python
 *  wrapper for timescaledb, pgvector-node, the CDK CLI repository for aws-cdk). */
export const RETIRED_BUILTINS: Readonly<Record<string, { readonly resolves: boolean }>> = Object.freeze({
  fastify: { resolves: true },
  "fastify-type-provider-zod": { resolves: true },
  timescaledb: { resolves: false },
  pgvector: { resolves: false },
  "aws-cdk": { resolves: false },
});

/** The retired built-in a requested name refers to (registry folding: case and surrounding
 *  spaces), or undefined. */
export function retiredBuiltin(name: string): { name: string; resolves: boolean } | undefined {
  const key = name.trim().toLowerCase();
  return Object.hasOwn(RETIRED_BUILTINS, key) ? { name: key, resolves: RETIRED_BUILTINS[key]!.resolves } : undefined;
}

/*
 * DEFAULT REGISTRY — the vibe-coder top-30 (PAR-654).
 *
 * Who it is for: solo vibe coders and small teams. The original example stack (fastify, timescaledb, pgvector, aws-cdk,
 * fastify-type-provider-zod) moved to docs/examples/node-api-stack.vibectx.config.json — the
 * "keep a private stack via committed config" example.
 *
 * NAMING RULE. `name` is lowercase and is the npm package name — unless that package is
 * scoped (`@supabase/supabase-js`, `@trpc/server`, `@clerk/nextjs`, `@anthropic-ai/sdk`,
 * `@playwright/test`, `@sveltejs/kit`, `@tanstack/react-query`), too generic to recognise on
 * its own (`ai`), or not what people call the product (`next` → Next.js). Then `name` is the
 * product's widely used short name in lowercase (`supabase`, `trpc`, `clerk`, `anthropic-sdk`,
 * `playwright`, `sveltekit`, `tanstack-query`, `ai-sdk`, `next.js`). `aliases` carry the other
 * names agents actually send; they are shipped only where such a name is common. Since
 * PAR-656 (`vibectx warm` reads package.json) every entry whose canonical name is not the
 * npm package name also carries that package name as an alias (`@supabase/supabase-js`,
 * `@trpc/server`, `@clerk/nextjs`, `@anthropic-ai/sdk`, `@playwright/test`, `@sveltejs/kit`,
 * `@tanstack/react-query`; `react-dom` → react), so a manifest name is a curated hit.
 *
 * URL RULE. Candidates are probed in order: `{docs-base}/llms-full.txt`, `{docs-base}/llms.txt`,
 * then a curated fallback (a raw GitHub README or docs page). The docs base is the package's
 * npm `homepage` (registry.npmjs.org, read 2026-09-06) or, when that is a GitHub URL, the docs
 * site its README links to. Where the docs base is a sub-path (`supabase.com/docs`), the site
 * root's `llms.txt` is also tried, because llmstxt.org places the file at the root.
 *
 * VERIFICATION STATUS (2026-09-06, build sandbox). Every raw.githubusercontent.com fallback
 * below returned HTTP 200 with real markdown content when fetched from the build sandbox
 * (MEASURED). No docs-site `llms-full.txt` / `llms.txt` candidate could be reached from the
 * sandbox (docs hosts are blocked there): those are NOT VERIFIED here. `vibectx doctor` run
 * from a machine with normal network access is the verification (PAR-653); the fetcher probes
 * candidates in order and falls back, so an entry whose site lacks or later gains llms.txt
 * keeps working either way. Prisma's llms-full.txt (~5 MB) and the Anthropic candidates were
 * reachable per the PAR-704 field report (2026-09-05, 0.1.x registry) and are carried over unchanged.
 */
export const DEFAULT_REGISTRY: LibraryEntry[] = [
  {
    name: "next.js",
    ecosystem: "npm",
    aliases: ["next", "nextjs"],
    urls: [
      "https://nextjs.org/docs/llms-full.txt",
      "https://nextjs.org/docs/llms.txt",
      "https://raw.githubusercontent.com/vercel/next.js/canary/packages/next/README.md",
    ],
    description: "Next.js — React framework (App Router, server actions, routing)",
    probeQueries: ["server actions revalidate", "layouts and pages"],
  },
  {
    name: "react",
    ecosystem: "npm",
    aliases: ["react-dom"],
    urls: [
      // Prefer working text; later candidates retain existing offline cache identities.
      "https://react.dev/llms.txt",
      "https://react.dev/llms-full.txt",
      "https://raw.githubusercontent.com/reactjs/react.dev/main/src/content/reference/react/useEffect.md",
    ],
    description: "React 19 documentation",
    probeQueries: ["useEffect cleanup", "context provider"],
  },
  {
    name: "supabase",
    ecosystem: "npm",
    aliases: ["supabase-js", "@supabase/supabase-js"],
    urls: [
      // Prefer working text; later candidates retain existing offline cache identities.
      "https://supabase.com/llms-full.txt",
      "https://supabase.com/llms.txt",
      "https://supabase.com/docs/llms-full.txt",
      "https://supabase.com/docs/llms.txt",
      "https://raw.githubusercontent.com/supabase/supabase-js/master/packages/core/supabase-js/README.md",
    ],
    description: "Supabase — Postgres, auth, storage, realtime (supabase-js)",
    probeQueries: ["row level security policy", "auth sign in with oauth"],
  },
  {
    name: "tailwindcss",
    ecosystem: "npm",
    aliases: ["tailwind", "@tailwindcss/postcss"],
    urls: [
      // Prefer the live branch URL while retaining earlier candidate/cache identities.
      "https://raw.githubusercontent.com/tailwindlabs/tailwindcss.com/main/src/docs/responsive-design.mdx",
      "https://raw.githubusercontent.com/tailwindlabs/tailwindcss/refs/heads/main/README.md",
      "https://tailwindcss.com/llms-full.txt",
      "https://tailwindcss.com/llms.txt",
      "https://raw.githubusercontent.com/tailwindlabs/tailwindcss/main/README.md",
    ],
    description: "Tailwind CSS utility-first framework",
    probeQueries: ["responsive breakpoints", "container queries"],
  },
  {
    name: "shadcn",
    ecosystem: "npm",
    aliases: ["shadcn-ui", "shadcn/ui"],
    urls: [
      // Prefer working text; later candidates retain existing offline cache identities.
      "https://ui.shadcn.com/llms.txt",
      "https://ui.shadcn.com/llms-full.txt",
      "https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/content/docs/installation/next.mdx",
    ],
    description: "shadcn/ui — copy-paste React components on Radix + Tailwind",
    probeQueries: ["add button component", "theming css variables"],
  },
  {
    name: "stripe",
    ecosystem: "npm",
    urls: [
      // Prefer working text; later candidates retain existing offline cache identities.
      "https://docs.stripe.com/llms.txt",
      "https://docs.stripe.com/llms-full.txt",
      "https://raw.githubusercontent.com/stripe/stripe-node/master/README.md",
    ],
    description: "Stripe payments API (stripe-node)",
    probeQueries: ["checkout session create", "webhook signature verify"],
  },
  {
    name: "ai-sdk",
    ecosystem: "npm",
    aliases: ["ai", "vercel-ai"],
    urls: [
      // Prefer working text; later candidates retain existing offline cache identities.
      "https://ai-sdk.dev/llms.txt",
      "https://ai-sdk.dev/docs/llms-full.txt",
      "https://ai-sdk.dev/docs/llms.txt",
      "https://raw.githubusercontent.com/vercel/ai/main/packages/ai/README.md",
    ],
    // PAR-1269 (D6): the v4 docs site (checked live 2026-10-05: 200, text/plain, 789,157 bytes).
    versionUrls: { "4": ["https://v4.ai-sdk.dev/llms.txt"] },
    description: "Vercel AI SDK (npm `ai`) — streamText, generateObject, useChat",
    probeQueries: ["streamText tool calling", "useChat hook"],
  },
  {
    name: "expo",
    ecosystem: "npm",
    urls: [
      "https://docs.expo.dev/llms-full.txt",
      "https://docs.expo.dev/llms.txt",
      "https://raw.githubusercontent.com/expo/expo/main/packages/expo/README.md",
    ],
    description: "Expo — React Native apps, Expo Router, EAS",
    probeQueries: ["expo router navigation", "push notifications"],
  },
  {
    name: "drizzle-orm",
    ecosystem: "npm",
    aliases: ["drizzle"],
    urls: [
      "https://orm.drizzle.team/llms-full.txt",
      "https://orm.drizzle.team/llms.txt",
      "https://raw.githubusercontent.com/drizzle-team/drizzle-orm/main/README.md",
    ],
    description: "Drizzle ORM — TypeScript SQL ORM and migrations",
    probeQueries: ["select with where", "migrations generate"],
  },
  {
    name: "prisma",
    ecosystem: "npm",
    urls: [
      "https://www.prisma.io/docs/llms-full.txt",
      "https://www.prisma.io/docs/llms.txt",
      "https://raw.githubusercontent.com/prisma/prisma/main/README.md",
    ],
    // PAR-1269 (D6): Prisma's own per-major indexes, linked from its docs/llms.txt (checked live
    // 2026-10-05: orm-v6.txt 200, 36,838 bytes; orm-v7.txt 200, 40,461 bytes). llms-full.txt has
    // no v6 pages at all.
    versionUrls: {
      "6": ["https://www.prisma.io/docs/llms/orm-v6.txt"],
      "7": ["https://www.prisma.io/docs/llms/orm-v7.txt"],
    },
    description: "Prisma ORM documentation",
    probeQueries: ["upsert", "relation include"],
  },
  {
    name: "trpc",
    ecosystem: "npm",
    aliases: ["@trpc/server", "@trpc/client"],
    urls: [
      "https://trpc.io/llms-full.txt",
      "https://trpc.io/llms.txt",
      "https://raw.githubusercontent.com/trpc/trpc/main/README.md",
    ],
    description: "tRPC — end-to-end typesafe APIs",
    probeQueries: ["create router procedure", "react query client"],
  },
  {
    name: "zod",
    ecosystem: "npm",
    urls: [
      "https://zod.dev/llms-full.txt",
      "https://zod.dev/llms.txt",
      "https://raw.githubusercontent.com/colinhacks/zod/main/packages/zod/README.md",
    ],
    description: "Zod — TypeScript-first schema validation",
    probeQueries: ["parse object schema", "refine custom validation"],
  },
  {
    name: "hono",
    ecosystem: "npm",
    urls: [
      "https://hono.dev/llms-full.txt",
      "https://hono.dev/llms.txt",
      "https://raw.githubusercontent.com/honojs/hono/main/README.md",
    ],
    description: "Hono — small web framework for any JS runtime",
    probeQueries: ["middleware", "route params"],
  },
  {
    name: "bun",
    ecosystem: "npm",
    urls: [
      "https://bun.com/llms-full.txt",
      "https://bun.com/llms.txt",
      // README is a 300-link index; docs live in-repo under docs/ as .mdx.
      "https://raw.githubusercontent.com/oven-sh/bun/main/docs/runtime/http/server.mdx",
    ],
    description: "Bun — JavaScript runtime, bundler, test runner, package manager",
    probeQueries: ["bun install", "Bun.serve http server"],
  },
  {
    name: "vite",
    ecosystem: "npm",
    urls: [
      "https://vite.dev/llms-full.txt",
      "https://vite.dev/llms.txt",
      "https://raw.githubusercontent.com/vitejs/vite/main/docs/guide/index.md",
    ],
    description: "Vite — frontend build tool and dev server",
    probeQueries: ["env variables", "config proxy"],
  },
  {
    name: "clerk",
    ecosystem: "npm",
    aliases: ["@clerk/nextjs"],
    urls: [
      "https://clerk.com/docs/llms.txt",
      "https://clerk.com/llms-full.txt",
      "https://clerk.com/llms.txt",
      "https://raw.githubusercontent.com/clerk/javascript/main/packages/nextjs/README.md",
    ],
    description: "Clerk — authentication and user management (@clerk/nextjs)",
    probeQueries: ["protect routes", "useUser hook"],
  },
  {
    name: "convex",
    ecosystem: "npm",
    urls: [
      "https://docs.convex.dev/llms-full.txt",
      "https://docs.convex.dev/llms.txt",
      "https://convex.dev/llms.txt",
      "https://raw.githubusercontent.com/get-convex/convex-backend/main/README.md",
    ],
    description: "Convex — reactive backend with queries, mutations and schema",
    probeQueries: ["mutation query function", "schema define table"],
  },
  {
    name: "firebase",
    ecosystem: "npm",
    aliases: ["firebase-js"],
    urls: [
      // Prefer the live branch URL while retaining earlier candidate/cache identities.
      "https://firebase.google.com/docs/llms.txt",
      "https://raw.githubusercontent.com/firebase/firebase-js-sdk/refs/heads/main/README.md",
      "https://firebase.google.com/llms-full.txt",
      "https://firebase.google.com/llms.txt",
      "https://raw.githubusercontent.com/firebase/firebase-js-sdk/main/README.md",
    ],
    description: "Firebase JS SDK — Firestore, Auth, Storage, Functions",
    probeQueries: ["firestore query where", "authenticate with google javascript"],
  },
  {
    name: "openai",
    ecosystem: "npm",
    urls: [
      "https://platform.openai.com/docs/llms-full.txt",
      "https://platform.openai.com/docs/llms.txt",
      "https://platform.openai.com/llms.txt",
      "https://raw.githubusercontent.com/openai/openai-node/master/README.md",
    ],
    description: "OpenAI API (openai-node) — responses, chat completions, streaming",
    probeQueries: ["streaming responses", "structured outputs"],
  },
  {
    name: "anthropic-sdk",
    ecosystem: "npm",
    aliases: ["anthropic", "@anthropic-ai/sdk"],
    urls: [
      "https://platform.claude.com/llms.txt",
      "https://docs.anthropic.com/llms-full.txt",
      "https://docs.anthropic.com/llms.txt",
      "https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/README.md",
    ],
    description: "Anthropic API / Claude SDK documentation",
    probeQueries: ["streaming messages", "tool use"],
  },
  {
    name: "playwright",
    ecosystem: "npm",
    aliases: ["@playwright/test"],
    urls: [
      // Prefer the live branch URL while retaining earlier candidate/cache identities.
      "https://raw.githubusercontent.com/microsoft/playwright/refs/heads/main/README.md",
      "https://playwright.dev/llms-full.txt",
      "https://playwright.dev/llms.txt",
      "https://raw.githubusercontent.com/microsoft/playwright/main/README.md",
    ],
    description: "Playwright browser automation and end-to-end testing",
    probeQueries: ["run tests", "expect toBeVisible"],
  },
  {
    name: "vitest",
    ecosystem: "npm",
    urls: [
      "https://vitest.dev/llms-full.txt",
      "https://vitest.dev/llms.txt",
      "https://raw.githubusercontent.com/vitest-dev/vitest/main/docs/guide/index.md",
    ],
    description: "Vitest — Vite-native unit test framework",
    probeQueries: ["mock function", "config coverage"],
  },
  {
    name: "react-router",
    ecosystem: "npm",
    aliases: ["remix", "react-router-dom"],
    urls: [
      // Prefer the live branch URL while retaining earlier candidate/cache identities.
      "https://raw.githubusercontent.com/remix-run/react-router/refs/heads/main/docs/start/framework/routing.md",
      "https://reactrouter.com/llms-full.txt",
      "https://reactrouter.com/llms.txt",
      "https://raw.githubusercontent.com/remix-run/react-router/main/docs/start/framework/routing.md",
    ],
    description: "React Router v7 (the Remix successor) — routing, loaders, actions",
    probeQueries: ["dynamic segments params", "nested routes outlet"],
  },
  {
    name: "astro",
    ecosystem: "npm",
    urls: [
      // Prefer the live branch URL while retaining earlier candidate/cache identities.
      "https://raw.githubusercontent.com/withastro/docs/refs/heads/main/src/content/docs/en/basics/astro-components.mdx",
      "https://docs.astro.build/llms-full.txt",
      "https://docs.astro.build/llms.txt",
      "https://astro.build/llms.txt",
      "https://raw.githubusercontent.com/withastro/docs/main/src/content/docs/en/basics/astro-components.mdx",
    ],
    description: "Astro — content-driven web framework with islands",
    probeQueries: ["component props", "named slots"],
  },
  {
    name: "sveltekit",
    ecosystem: "npm",
    aliases: ["svelte", "@sveltejs/kit"],
    urls: [
      "https://svelte.dev/llms-full.txt",
      "https://svelte.dev/llms.txt",
      "https://svelte.dev/docs/kit/llms.txt",
      "https://raw.githubusercontent.com/sveltejs/kit/main/documentation/docs/20-core-concepts/10-routing.md",
    ],
    description: "SvelteKit — Svelte application framework (routing, load, form actions)",
    probeQueries: ["load function", "form actions"],
  },
  {
    name: "nuxt",
    ecosystem: "npm",
    urls: [
      "https://nuxt.com/llms-full.txt",
      "https://nuxt.com/llms.txt",
      "https://raw.githubusercontent.com/nuxt/nuxt/main/README.md",
    ],
    description: "Nuxt — Vue full-stack framework",
    probeQueries: ["useFetch data fetching", "server api routes"],
  },
  {
    name: "vue",
    ecosystem: "npm",
    urls: [
      "https://vuejs.org/llms-full.txt",
      "https://vuejs.org/llms.txt",
      "https://raw.githubusercontent.com/vuejs/docs/main/src/guide/introduction.md",
    ],
    description: "Vue 3 documentation",
    probeQueries: ["computed reactive ref", "component props emit"],
  },
  {
    name: "tanstack-query",
    ecosystem: "npm",
    aliases: ["react-query", "@tanstack/react-query"],
    urls: [
      "https://tanstack.com/query/latest/llms.txt",
      // Prefer the Query-specific index; retain every earlier source as a fallback.
      "https://tanstack.com/query/latest/docs/framework/react/guides/queries.md",
      "https://tanstack.com/llms.txt",
      "https://tanstack.com/query/llms-full.txt",
      "https://tanstack.com/query/llms.txt",
      "https://raw.githubusercontent.com/TanStack/query/main/README.md",
    ],
    versionUrls: { "4": ["https://tanstack.com/query/v4/llms.txt"] },
    description: "TanStack Query (React Query) — async state, caching, mutations",
    probeQueries: ["optimistic updates", "query invalidation mutations"],
  },
  {
    name: "motion",
    ecosystem: "npm",
    aliases: ["framer-motion"],
    urls: [
      // Prefer working text; later candidates retain existing offline cache identities.
      "https://motion.dev/llms.txt",
      "https://motion.dev/llms-full.txt",
      "https://raw.githubusercontent.com/motiondivision/motion/main/README.md",
    ],
    description: "Motion (formerly Framer Motion) — animation library for React and JS",
    probeQueries: ["animate variants", "layout animation"],
  },
  {
    name: "resend",
    ecosystem: "npm",
    urls: [
      "https://resend.com/docs/llms-full.txt",
      "https://resend.com/docs/llms.txt",
      "https://resend.com/llms.txt",
      "https://raw.githubusercontent.com/resend/resend-node/main/readme.md",
    ],
    description: "Resend — transactional email API (resend-node)",
    probeQueries: ["send email react template", "domains verify"],
  },
];

/** PAR-1272: the built-in names, for telling a same-name config replacement from an additive one. */
const DEFAULT_NAMES: ReadonlySet<string> = new Set(DEFAULT_REGISTRY.map((e) => e.name));

export interface Registry {
  entries: Map<string, LibraryEntry>;
  /** The config sources this registry was built from (PAR-657), for the list_libraries header.
   *  Absent on a hand-built registry (tests, callers that assemble entries themselves). */
  config?: ConfigResolution;
  /** The effective strict-DNS setting, resolved once by the registry loader from the
   * config-file value (highest priority) or `VIBECTX_STRICT_DNS=1`. */
  strictDns?: boolean;
  /** Effective C5 opt-in, config value (when present) over the environment. */
  checkUpdates?: boolean;
  /** PAR-1039: the user-config `logArchives` value, unvalidated (activity-log.ts checks it). */
  logArchives?: unknown;
  /** PAR-1048: the user-config `autowarm` value, unvalidated (autowarm.ts checks it). */
  autowarm?: unknown;
}

/** Registry keys (names and aliases) are compared and stored in this form. */
const fold = (s: string): string => s.trim().toLowerCase();

/**
 * Every alias must be unique across the registry and must not equal any canonical name
 * (compared on folded keys, and — PAR-777 (D-78) — on their PEP 503 form too:
 * `typing_extensions` as an alias collides with a canonical `typing-extensions` exactly as an
 * exact-spelling alias would). `normalisePyPiName` (package-names.ts) is already this file's
 * answer to "is this the same PyPI project under a different spelling" — used since PAR-655
 * by `resolveLibrary`'s lookup fallback and by `curatedKeys`/`isTaken` to keep a resolved
 * record from shadowing a curated pin. This item, and `applyLayer` below, apply that SAME,
 * already-accepted rule to the two places PAR-777's own Problem statement names as still
 * comparing by exact fold only.
 *
 * Applied with no ecosystem check, deliberately, matching the precedent those three existing
 * call sites already set: two npm names that happen to differ only by a `-`/`_`/`.` run
 * (`resend-node` vs a hypothetical `resend.node`) collide under this rule exactly as two PyPI
 * spellings of the same project do. The shipped defaults contain no such pair (checked by
 * hand across every name/alias in `DEFAULT_REGISTRY`, and pinned by a direct test — see
 * "the shipped defaults contain no PEP 503 twin pair" in registry.test.ts — since THIS
 * function only checks alias-vs-canonical, not canonical-vs-canonical). A scoped npm name
 * (`@scope/pkg`) is unaffected: `@`/`/` are not folded, so it can only ever collide with
 * another spelling of the SAME scoped name.
 *
 * The failure mode differs by call site, and this function's own is the safe half: THIS
 * function only ever errors (never silently serves a wrong document) or, via D-06, drops an
 * alias a config already meant to reclaim under its exact spelling. `applyLayer`'s merge
 * (below) is NOT equally safe — it can DELETE an existing canonical entry and replace it with
 * a different one under a twin spelling, which the three read-only precedent call sites never
 * do (`resolveLibrary`'s fallback only finds an entry a lookup would otherwise miss;
 * `curatedKeys`/`isTaken` only refuse an install). If two genuinely different packages ever
 * shared a PEP 503 form, that merge would silently answer one library's queries with the
 * other's docs — accepted as a documented, low-likelihood residual risk (D-78 in
 * `docs/decisions.md`), not something this comment claims cannot happen.
 *
 * D-71 (PAR-749) treats `foo.bar`/`foo_bar` as "two DISTINCT, independently valid npm names"
 * for CACHE-DIRECTORY key derivation (`urlSlug`/`libDirName`) — that is not in tension with
 * this rule: a cache key only needs to be collision-RESISTANT (it is hash-suffixed regardless
 * of spelling), while a REGISTRY identity needs to recognise two spellings of one PyPI project
 * as the same package. Two different questions, answered consistently within each: cache keys
 * never fold punctuation (avoiding a real collision between unrelated names), registry names
 * always do (recognising a real twin). Recorded together at D-78 so the two decisions read as
 * a deliberate pair, not a contradiction.
 *
 * Runs on every load, config or not, so the shipped defaults are checked too. By the time
 * this runs, D-06 has already removed the default aliases a config claimed — so a collision
 * here is always something the config must change. `configNames` tells the message whether
 * the colliding canonical is a default or config entry.
 */
/** True when `e` is identified as a PyPI package — a declared curated `ecosystem`, or a
 *  resolved record whose registry source is PyPI. Shared by `validateAliases` and `applyLayer`
 *  (PAR-854/D-90, security-architect round 2): the one predicate every PEP-503-fold gate in this
 *  file keys on, so "which side of a fold counts as PyPI" is answered identically everywhere. */
function isPypiEntry(e: LibraryEntry): boolean {
  return e.ecosystem === "pypi" || e.resolved?.source === "pypi";
}

function validateAliases(
  entries: Map<string, LibraryEntry>,
  configNames: ReadonlySet<string>,
  fileOf: ReadonlyMap<string, ConfigSite>,
): void {
  const owner = new Map<string, string>();
  const ownerPep = new Map<string, { alias: string; entry: string }>();
  const canonicalPep = new Map<string, string>();
  // PAR-854/D-90 (security-architect round 2, BLOCKING #1 companion fix) — `canonicalPep` (and
  // `ownerPep`, below) now only ever holds a PyPI entry's own pep-form, and the pep-form checks
  // below are only ever CONSULTED for an alias declared on a PyPI entry. Left unconditional (the
  // ORIGINAL D-78 behaviour), this function would reject a legitimate npm alias that happens to
  // share a PEP 503 form with an unrelated npm canonical or alias — the exact load-failure shape
  // PAR-777's own round-1 review (B1) already fixed once, reintroduced here if the companion
  // `applyLayer` claim-step fix (above) ships without this one: with that fix alone, an
  // npm/undeclared alias is never SILENTLY dissolved by a punctuation twin any more, but without
  // gating this function too, the same twin would instead make the WHOLE CONFIG FAIL TO LOAD —
  // still safe (never a silent substitution), but wrong for two independently-valid npm names
  // that were never meant to collide. Two entries that really are PyPI still collide here
  // exactly as before (D-78's own point, unaffected).
  for (const [key, e] of entries) {
    if (isPypiEntry(e)) canonicalPep.set(normalisePyPiName(key), key);
  }
  /** D-22: a config-caused failure is `<file>: libraries[i].aliases ("name"): <detail>`; a
   *  defaults-only one has no file and no index, so it names the entry in the detail. */
  const fail = (name: string, detail: string): never => {
    const site = fileOf.get(fold(name));
    if (site === undefined) throw new Error(`alias on entry "${name}": ${detail}`);
    throw new ConfigError(site.display, `${configLocator(site.index, "aliases", name)}: ${detail}`);
  };
  /** Which kind of canonical `key` is, for the collision message: the entry's own name, a
   *  name another CONFIG entry declared, or a shipped default. */
  const kindOf = (key: string, e: LibraryEntry): string =>
    key === fold(e.name) ? "the entry itself" : configNames.has(key) ? "another config entry" : "a default library";
  for (const e of entries.values()) {
    const pypi = isPypiEntry(e);
    for (const raw of e.aliases ?? []) {
      const a = fold(raw);
      const pep = normalisePyPiName(a);
      if (entries.has(a)) {
        fail(
          e.name,
          `alias "${a}" collides with the canonical name "${a}" (${kindOf(a, e)}); ` +
            `rename the alias, or override "${a}" (with its urls) and set aliases: [] on that entry`,
        );
      }
      // PAR-777 (D-78): the same collision, one punctuation spelling apart — `a` itself is
      // not a canonical key (the exact check above already ruled that out), but its PEP 503
      // form matches one. PAR-854/D-90: only consulted when THIS alias's own entry is PyPI —
      // see this function's own comment above `canonicalPep`.
      if (pypi) {
        const twinCanonical = canonicalPep.get(pep);
        if (twinCanonical !== undefined) {
          fail(
            e.name,
            `alias "${a}" is a PEP 503 twin of the canonical name "${twinCanonical}" (${kindOf(twinCanonical, e)}); ` +
              `rename the alias, or override "${twinCanonical}" (with its urls) and set aliases: [] on that entry`,
          );
        }
      }
      const other = owner.get(a);
      if (other !== undefined) fail(e.name, `alias "${a}" is also declared on "${other}"`);
      if (pypi) {
        const otherPep = ownerPep.get(pep);
        if (otherPep !== undefined) {
          fail(e.name, `alias "${a}" is a PEP 503 twin of alias "${otherPep.alias}" declared on "${otherPep.entry}"`);
        }
      }
      owner.set(a, e.name);
      if (pypi) ownerPep.set(pep, { alias: a, entry: e.name });
    }
  }
}

/** Where a config entry came from: the file as the messages show it, and the entry's index
 *  in that file's `libraries` array — together, D-22's locator. */
interface ConfigSite {
  display: string;
  index: number;
}

/**
 * Normalise one config file's entries: keys folded, allowed hosts normalised, any `resolved`
 * marker dropped (only the resolver may set it). Shape was already validated by
 * `readConfigFile`; what can still fail here is a host VALUE the link policy refuses.
 *
 * PAR-854/D-90 — `ecosystem` SURVIVES from here on (D-63 reversed; see `config.ts`'s
 * `EntrySchema` comment for why): `registry.ts`'s cross-layer merge needs a config author's own
 * declaration to know whether a name is PyPI (PEP 503 twins are the same project — fold and
 * auto-collapse) or not (two independently-registrable names — never fold). `replaces` is folded
 * the same way `name`/`aliases` are, so `applyLayer` can compare it against a folded existing key.
 *
 * The refusal is re-worded into D-22's grammar, with the offending value clipped: it is a
 * string from a file this process did not write, and link-policy quotes it back whole.
 */
function normaliseLayer(libraries: LibraryEntry[], display: string): LibraryEntry[] {
  return libraries.map((e, index) => {
    const normalised: LibraryEntry = { ...e, name: fold(e.name) };
    if (e.aliases !== undefined) normalised.aliases = e.aliases.map(fold);
    if (e.replaces !== undefined) normalised.replaces = fold(e.replaces);
    if (e.allowedHosts !== undefined) {
      normalised.allowedHosts = e.allowedHosts.map((host) => {
        try {
          return normaliseAllowedHost(host);
        } catch (err) {
          const why = whyHostRefused(err, host);
          const value = clipText(typeof host === "string" ? host : JSON.stringify(host), MAX_CONFIG_VALUE_CHARS);
          throw new ConfigError(display, `${configLocator(index, "allowedHosts", e.name)}: "${value}" ${why}`);
        }
      });
    }
    delete normalised.resolved;
    delete normalised.replacedBuiltin;
    return normalised;
  });
}

/** link-policy says `allowedHosts: "<value>" <why>`; the value is re-quoted clipped, so
 *  only the reason is taken from its message (and the whole message when it is shaped
 *  differently — a message is never dropped). */
function whyHostRefused(err: unknown, host: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const prefix = `allowedHosts: ${typeof host === "string" ? `"${host}"` : `"${JSON.stringify(host)}"`} `;
  return message.startsWith(prefix) ? message.slice(prefix.length) : message;
}

/**
 * Merge one config layer over everything loaded so far — the same D-06 / D-07 rules that
 * applied between a config and the defaults, now applied between layers (PAR-657 D-14):
 * project over user over defaults. `entries` is mutated; `configNames` and `fileOf`
 * accumulate across layers so an error can say which file and which kind of entry. `notes`
 * (PAR-854/D-90) collects one line per EXPLICIT cross-layer punctuation-twin override this
 * layer performs, so the replacement is disclosed (the D-19/D-16 channel: `list_libraries`'
 * header and the loader's stderr warnings), never silent.
 */
function applyLayer(
  entries: Map<string, LibraryEntry>,
  layer: LibraryEntry[],
  configNames: Set<string>,
  fileOf: Map<string, ConfigSite>,
  display: string,
  notes: string[],
): void {
  // PAR-1272: names an EARLIER config layer already set. A same-name entry in this layer replaces
  // a built-in only when the name is a default and no earlier layer replaced it first. (A default
  // can be copied when an alias is dropped, so object identity cannot tell.)
  const configuredBefore = new Set(configNames);
  const notedBuiltinReplacements = new Set<string>();
  // PAR-777 (D-78): two entries in the SAME layer whose canonical names are PEP 503 twins are
  // ambiguous — D-06/D-07's precedence rules decide which of two LAYERS wins, not which of two
  // entries declared side by side in one file should. Checked before anything else in this
  // layer is applied, so a config error here never leaves a partial merge behind. NOT the same
  // case as two entries with the EXACT same folded name (`{name:"Foo"}, {name:"foo "}`) —
  // that stays the existing, tested "last one wins" override, since there is nothing
  // ambiguous about two spellings that fold to the SAME string; only a genuine twin (same
  // PEP 503 form, different fold) is the new, ambiguous case this item adds an error for.
  const seenPep = new Map<string, number>(); // normalisePyPiName(name) -> first index with that pep-form
  for (const [index, e] of layer.entries()) {
    const pep = normalisePyPiName(e.name);
    const firstIndex = seenPep.get(pep);
    if (firstIndex !== undefined && layer[firstIndex]!.name !== e.name) {
      const first = layer[firstIndex]!.name;
      throw new ConfigError(
        display,
        `${configLocator(index, "name", e.name)}: "${e.name}" is a PEP 503 twin of "${first}" (libraries[${firstIndex}]) — ` +
          `the same package under two spellings; rename one, or delete the duplicate`,
      );
    }
    if (firstIndex === undefined) seenPep.set(pep, index);
  }
  // D-06: every key this layer claims — as a name or an alias — leaves the layers below, on
  // its EXACT spelling always.
  //
  // PAR-777 (D-78) originally also claimed on the PEP 503 form, unconditionally, so that a
  // config `react_dom` would dissolve the default alias `react-dom` before `validateAliases`
  // ran (code-reviewer, PAR-777 round 1, B1). PAR-854/D-90 (security-architect, round 2 —
  // BLOCKING) found that unconditional fold reopened the exact defect this whole item exists
  // to close, through the ALIAS path instead of the canonical-name path: a crafted config entry
  // `{ name: "react_dom", ecosystem: "pypi", urls: [EVIL] }` has no CANONICAL twin anywhere (the
  // canonical-name merge gate below, correctly ecosystem-gated already, never sees it) — but the
  // unconditional claim step here dissolved `react`'s own npm alias `react-dom` regardless,
  // silently, before the merge gate ever ran. `react_dom` then installed as an ordinary new
  // entry, and `resolveLibrary(reg, "react-dom")` — its exact/alias legs both now missing their
  // target — fell through to the PEP-503 leg, which admits any entry whose OWN `ecosystem` is
  // declared `"pypi"`, and returned the attacker's entry. Declaring `ecosystem: "pypi"` on an
  // entry is not purely self-narrowing (as cluster 1's merge-gate design assumed): it ALSO
  // widens that entry's own reach at read time to every punctuation spelling of its name,
  // including names it never wrote — the claim step must gate on it too.
  //
  // Fixed the same two-sided way `isTaken`/`curatedKeys` (this file) and `resolved-store.ts`'s
  // `isTwin` already do: the PEP 503 form is claimed here ONLY when the CLAIMING entry declares
  // `ecosystem: "pypi"`, and consulted against an existing entry's alias ONLY when that existing
  // entry is ALSO PyPI (`belowPypi`) — a fold is PyPI identity only when both sides agree it is
  // one. An npm/undeclared entry's alias can now only ever be dissolved by an EXACT spelling
  // claim, never a punctuation twin — matching this whole item's own rule for every other site.
  const claimed = new Set<string>();
  const claimedPep = new Set<string>(); // only ever populated from an `ecosystem: "pypi"` entry
  for (const [index, e] of layer.entries()) {
    const pypi = e.ecosystem === "pypi";
    claimed.add(e.name);
    if (pypi) claimedPep.add(normalisePyPiName(e.name));
    configNames.add(e.name);
    fileOf.set(e.name, { display, index });
    for (const a of e.aliases ?? []) {
      claimed.add(a);
      if (pypi) claimedPep.add(normalisePyPiName(a));
    }
  }
  const isClaimed = (a: string, ownerIsPypi: boolean): boolean => claimed.has(a) || (ownerIsPypi && claimedPep.has(normalisePyPiName(a)));
  const rewritten: [string, LibraryEntry][] = [];
  for (const [key, below] of entries) {
    const belowPypi = isPypiEntry(below);
    // copy: never mutate the shipped defaults (or a lower layer's entry)
    if (below.aliases?.some((a) => isClaimed(a, belowPypi))) {
      rewritten.push([key, { ...below, aliases: below.aliases.filter((a) => !isClaimed(a, belowPypi)) }]);
    }
  }
  for (const [key, e] of rewritten) entries.set(key, e);
  // Merge, this layer wins on name; D-07 alias inheritance from the layer it replaces.
  // PAR-777 (D-78) / PAR-854 (D-90) — "wins on name" also means "wins on the PEP 503 twin of an
  // existing canonical name", but ONLY when that twin relationship is PyPI identity, not
  // coincidence: two spellings of a PyPI project ARE the same package (fold and auto-collapse,
  // D-78's original rule, unaffected below); two npm — or ecosystem-undeclared — names that
  // merely share a PEP 503 form are NOT (`next.js` / `next_js`, the PAR-854 defect: normalising
  // punctuation regardless of ecosystem let a config layer silently REPLACE one real package's
  // shipped docs with an unrelated package's, under a name it never asked for). So a punctuation
  // twin across layers now only auto-collapses when the EXISTING (lower-layer) entry is
  // `ecosystem === "pypi"` — the authoritative side, since it is what a query for either spelling
  // will actually resolve to; otherwise the merge is REFUSED, naming both spellings and both
  // layers, unless THIS entry explicitly declares `replaces: "<existing key>"` — a config-authored,
  // disclosed opt-in (never inferred) that this really is an intentional replacement, config.ts's
  // `EntrySchema` comment and this file's `LibraryEntry.replaces` explain the field itself.
  //
  // An exact-name match (`entries.has(e.name)`) is untouched by any of this — "last layer wins"
  // on the SAME spelling was never the ambiguous case; only a twin's DIFFERENT spelling is.
  //
  // Rebuilding the map in place at the replaced entry's own position (rather than delete-then-
  // append) keeps list_libraries' registry-order rendering, and nearestLibraryName's documented
  // registry-order tie-break, from silently reordering around a spelling change alone
  // (code-reviewer, PAR-777 round 1, S3).
  const canonicalPep = new Map<string, string>();
  for (const key of entries.keys()) canonicalPep.set(normalisePyPiName(key), key);
  for (const [index, e] of layer.entries()) {
    const pep = normalisePyPiName(e.name);
    let existingKey = entries.has(e.name) ? e.name : undefined;
    if (existingKey === undefined) {
      const twinKey = canonicalPep.get(pep);
      if (twinKey !== undefined) {
        const existingEntry = entries.get(twinKey)!;
        if (existingEntry.ecosystem === "pypi") {
          existingKey = twinKey; // genuine PyPI twin (D-78): auto-collapse, as before this item
        } else if (e.replaces === twinKey) {
          existingKey = twinKey; // explicit, disclosed opt-in (PAR-854/D-90)
          const origin = fileOf.get(twinKey)?.display ?? "a default library";
          // security-architect round 2, S1 — `twinKey`/`e.name` re-interpolated below, not just
          // inside `configLocator` (which already clips its own `name` argument): a config's
          // `name` has no length cap at the schema level, so left raw here a very long value
          // could do the same thing the sibling error message's clip guards against (see that
          // branch's own comment) — this line isn't user-facing error text, but it IS what
          // `list_libraries`/`get_docs` render, so the same discipline applies.
          notes.push(
            `vibectx: ${display}: ${configLocator(index, "name", e.name)} replaces "${clipText(twinKey, MAX_CONFIG_VALUE_CHARS)}" (${origin}) — ` +
              `explicit cross-layer punctuation-twin override (declared via "replaces")`,
          );
        } else {
          const origin = fileOf.get(twinKey)?.display ?? "a default library";
          // Kept short (MAX_CONFIG_ERROR_CHARS = 300 caps the whole ConfigError message,
          // display path included) while still naming both spellings, both layers and the
          // remedy — see the doc comment above this loop for the full rationale.
          //
          // security-architect round 2, S1 (independently also found by code-reviewer, from the
          // opposite direction: a long name could truncate the remedy text away) — `e.name`
          // (already clipped once inside `configLocator`) is not repeated a second time, and
          // `twinKey` is clipped and interpolated exactly ONCE, not twice: `EntrySchema.name`
          // has no length cap, and this whole message is later clipped a SECOND time, as a
          // unit, to `MAX_CONFIG_ERROR_CHARS` (300) by `ConfigError`'s constructor — combined
          // with a real (potentially long) file path, a naive message that repeats a long name
          // or a long `twinKey` multiple times can exceed that combined budget even after each
          // individual interpolation is clipped. The REMEDY ("add \"replaces\": ...") is placed
          // immediately after the locator, before the explanatory tail — `clipText` truncates
          // from the END, so whatever must survive belongs first: an operator who only sees the
          // truncated prefix still sees the one actionable instruction, never just the
          // explanation with the fix cut off.
          const twinShown = clipText(twinKey, MAX_CONFIG_VALUE_CHARS);
          throw new ConfigError(
            display,
            `${configLocator(index, "name", e.name)}: add "replaces": "${twinShown}" to override the punctuation twin ` +
              `at ${origin}, or rename this entry — not PyPI, so these are not automatically the same package`,
          );
        }
      }
    }
    const replaced = existingKey !== undefined ? entries.get(existingKey) : undefined;
    if (e.aliases === undefined && replaced?.aliases !== undefined) e.aliases = replaced.aliases;
    // PAR-1272 (decided 2026-10-05): the exact-name replacement itself is unchanged — the whole
    // entry is replaced, only aliases are inherited — but it is no longer silent.
    if (existingKey === e.name && replaced !== undefined && DEFAULT_NAMES.has(e.name) && !configuredBefore.has(e.name)) {
      e.replacedBuiltin = display;
      if (!notedBuiltinReplacements.has(e.name)) {
        notedBuiltinReplacements.add(e.name);
        notes.push(
          `vibectx: ${display}: "${clipText(e.name, MAX_CONFIG_VALUE_CHARS)}" replaces the built-in entry of the same name (its URLs and probes are not merged)`,
        );
      }
    }
    if (existingKey !== undefined && existingKey !== e.name) {
      const rebuilt = [...entries].map(([k, v]) => (k === existingKey ? ([e.name, e] as const) : ([k, v] as const)));
      entries.clear();
      for (const [k, v] of rebuilt) entries.set(k, v);
    } else {
      entries.set(e.name, e);
    }
    canonicalPep.set(pep, e.name);
  }
}

/**
 * Build the registry: defaults, optionally merged/overridden by a JSON config file of
 * shape { "libraries": LibraryEntry[] }. Unknown top-level keys (e.g. "$comment") are ignored.
 *
 * Config names and aliases are normalised with trim().toLowerCase() before validation and
 * storage, so {name: "Next.js"} overrides "next.js" rather than adding an entry.
 *
 * Precedence (decisions D-06 / D-07, 2026-09-06):
 * - D-06 — config beats default alias. A config entry whose name or alias equals a DEFAULT
 *   alias is not an error: the config wins and that alias is silently dropped from the default
 *   (a 0.1.3 config with {name: "next"} keeps loading). Still errors: a config alias equal to
 *   any CANONICAL name (default or config), the same alias on two config entries, an alias equal
 *   to its own entry's name.
 * - D-07 — an override that OMITS `aliases` inherits the replaced entry's aliases;
 *   `aliases: []` clears them; an explicit list replaces them.
 * - PAR-655 — persisted resolutions (`<cacheRoot>/resolved.json`) merge BELOW both: a
 *   record whose name equals any canonical name or alias above is ignored, so a real
 *   registry or config entry always wins and a persisted resolution never overrides one.
 *   `includeResolved: false` skips the file (tests; tools that must not read the cache).
 */
export function loadRegistry(configPath?: string, opts: LoadRegistryOptions = {}): Registry {
  const files: ConfigFile[] = configPath ? [{ path: configPath, scope: "flag", legacy: false }] : [];
  return loadRegistryFrom({ files, notes: [] }, opts);
}

export interface LoadRegistryOptions {
  includeResolved?: boolean;
  /** Strict-DNS policy already resolved from the caller's environment (normally
   *  `VIBECTX_STRICT_DNS=1`). A config-file value takes precedence when present. */
  strictDns?: boolean;
  checkUpdates?: boolean;
  /** Directory config paths are shown relative to in messages (default: process.cwd()). */
  cwd?: string;
  /** Home directory those paths are `~`-abbreviated against (default: os.homedir()). */
  home?: string;
}

/**
 * The one loader (PAR-657): defaults, then every config file in `resolution.files` applied in
 * order — LOWEST precedence first, so user layers over the defaults and project over user.
 * `loadRegistry(path)` is this with a single `--config` layer, which is why every 0.1.x
 * behaviour above is unchanged for an explicit config.
 */
export function loadRegistryFrom(resolution: ConfigResolution, opts: LoadRegistryOptions = {}): Registry {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  /** D-19: discovered files that failed, by path, with the one-line reason. */
  const skipped = new Map<string, string>();
  let entries: Map<string, LibraryEntry>;
  let strictDns: boolean | undefined;
  let checkUpdates: boolean | undefined;
  let logArchives: unknown;
  let autowarm: unknown;
  let mergeNotes: string[] = [];
  for (;;) {
    const active = resolution.files.filter((f) => !skipped.has(f.path));
    try {
      ({ entries, notes: mergeNotes, strictDns, checkUpdates, logArchives, autowarm } = buildEntries(active, cwd, home));
      break;
    } catch (failure) {
      // An explicit source (flag or env) that cannot be honoured is fatal — the user asked
      // for that file by name. A discovered one is dropped and the rest is rebuilt without
      // it, so an ambient file cannot take the server down for everyone who launches it.
      if (!(failure instanceof LayerFailure) || failure.file.scope === "flag" || failure.file.scope === "env") {
        throw failure instanceof LayerFailure ? failure.error : failure;
      }
      skipped.set(failure.file.path, failure.reason);
    }
  }
  strictDns = strictDns ?? opts.strictDns;
  checkUpdates = checkUpdates ?? opts.checkUpdates ?? false;
  if (strictDns) {
    entries = new Map([...entries].map(([name, entry]) => [name, { ...entry, strictDns: true }]));
  }
  if (opts.includeResolved !== false) {
    const taken = curatedKeys(entries);
    for (const r of readResolvedEntries()) {
      if (!isTaken(taken, r.name, r.resolved?.source)) entries.set(r.name, strictDns ? { ...r, strictDns: true } : r);
    }
  }
  const files = resolution.files.map((f) => {
    const display = displayPath(f.path, cwd, home);
    const error = f.error ?? skipped.get(f.path); // discovery's own verdict, else the loader's
    return error === undefined ? { ...f, display } : { ...f, display, error };
  });
  // PAR-854/D-90: `mergeNotes` (the explicit cross-layer punctuation-twin overrides this load
  // performed) join the D-16/D-18 discovery notes in the same disclosed channel — both are
  // printed by `loadDiscoveredRegistry` and shown on `list_libraries`' header.
  return { entries, config: { files, notes: [...resolution.notes, ...mergeNotes] }, ...(strictDns !== undefined ? { strictDns } : {}), checkUpdates, ...(logArchives !== undefined ? { logArchives } : {}), ...(autowarm !== undefined ? { autowarm } : {}) };
}

/** A config layer that failed, and which file it was — so the caller can decide between
 *  "fatal" and "skip it and rebuild" (D-19) without re-parsing the message. */
class LayerFailure extends Error {
  constructor(
    readonly file: ConfigFile,
    readonly error: Error,
  ) {
    super(error.message);
    this.name = "LayerFailure";
  }
  /** The message without the file path: what the D-18 header shows after NOT LOADED. */
  get reason(): string {
    return this.error instanceof ConfigError ? this.error.detail : this.error.message;
  }
}

/**
 * The shipped defaults with `files` applied over them in order (lowest precedence first).
 * Throws `LayerFailure` for anything attributable to one config file — including the
 * cross-layer alias validation, which runs once at the end so that the D-06 alias claims a
 * later layer makes are already in effect, exactly as when every file loads.
 */
function buildEntries(
  files: readonly ConfigFile[],
  cwd: string,
  home: string,
): { entries: Map<string, LibraryEntry>; notes: string[]; strictDns?: boolean; checkUpdates?: boolean; logArchives?: unknown; autowarm?: unknown } {
  const entries = new Map<string, LibraryEntry>();
  for (const e of DEFAULT_REGISTRY) entries.set(e.name, e);
  const configNames = new Set<string>();
  const fileOf = new Map<string, ConfigSite>();
  const byDisplay = new Map<string, ConfigFile>();
  const notes: string[] = [];
  let strictDns: boolean | undefined;
  let checkUpdates: boolean | undefined;
  let logArchives: unknown;
  let autowarm: unknown;
  for (const file of files) {
    if (file.error !== undefined) continue; // discovery already decided this one is unusable (D-19)
    const display = displayPath(file.path, cwd, home);
    byDisplay.set(display, file);
    try {
      const parsed = readConfigFile(file.path, display);
      const { libraries } = parsed;
      if (parsed.strictDns !== undefined) strictDns = parsed.strictDns;
      // PAR-1040: a project config (possibly a cloned repo's) cannot turn the update check on;
      // only user config, an explicitly chosen file, or VIBECTX_CHECK_UPDATES=1 can.
      if (parsed.checkUpdates !== undefined && !(file.scope === "project" && parsed.checkUpdates)) checkUpdates = parsed.checkUpdates;
      // PAR-1039: a user-config key. A project config (possibly a cloned repo's) cannot set how
      // much of the user's own activity history is kept.
      if (parsed.logArchives !== undefined && file.scope !== "project") logArchives = parsed.logArchives;
      // PAR-1048: a cloned repo's project config must not opt a user into warming every library.
      if (parsed.autowarm !== undefined && file.scope !== "project") autowarm = parsed.autowarm;
      applyLayer(entries, normaliseLayer(libraries, display), configNames, fileOf, display, notes);
    } catch (e) {
      throw new LayerFailure(file, e as Error);
    }
  }
  try {
    validateAliases(entries, configNames, fileOf);
  } catch (e) {
    const file = e instanceof ConfigError ? byDisplay.get(e.display) : undefined;
    if (file === undefined) throw e; // a defaults-only collision is nobody's file
    throw new LayerFailure(file, e as Error);
  }
  return { entries, notes, ...(strictDns !== undefined ? { strictDns } : {}), ...(checkUpdates !== undefined ? { checkUpdates } : {}), ...(logArchives !== undefined ? { logArchives } : {}), ...(autowarm !== undefined ? { autowarm } : {}) };
}

export interface DiscoveredRegistryOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** The `--config` value, when one was passed. */
  flag?: string;
  /** Home directory for the user-level file (default: os.homedir()). */
  home?: string;
  includeResolved?: boolean;
  /** Where the D-16 deprecation notes go, once, at load (stderr for the server and the CLI). */
  warn?: (message: string) => void;
}

/**
 * `discoverConfig` + `loadRegistryFrom` — the single entry point the stdio server (index.ts)
 * and every CLI subcommand use, so a committed `vibectx.config.json` reaches an MCP client
 * that can only ever launch a fixed command line (PAR-657).
 */
export function loadDiscoveredRegistry(opts: DiscoveredRegistryOptions): Registry {
  const resolution = discoverConfig({ cwd: opts.cwd, env: opts.env, flag: opts.flag, home: opts.home });
  const registry = loadRegistryFrom(resolution, {
    includeResolved: opts.includeResolved,
    // PAR-1044 (I-3): the shared on/off reading; anything unrecognized leaves the opt-in off.
    strictDns: envFlag(opts.env.VIBECTX_STRICT_DNS) === true ? true : undefined,
    checkUpdates: envFlag(opts.env.VIBECTX_CHECK_UPDATES) === true,
    cwd: opts.cwd,
    home: opts.home ?? homedir(),
  });
  // PAR-854/D-90: `registry.config.notes`, not `resolution.notes` — it also carries the
  // explicit cross-layer punctuation-twin overrides `applyLayer` recorded (`resolution.notes`
  // only ever held the D-16/D-18 discovery notes).
  for (const note of registry.config?.notes ?? resolution.notes) opts.warn?.(note);
  // D-19: one line per discovered file that was skipped. Most MCP clients swallow stderr,
  // which is exactly why the same fact is also on the list_libraries header and in doctor.
  for (const file of registry.config?.files ?? []) {
    if (file.error !== undefined) {
      opts.warn?.(`vibectx: ${file.display ?? file.path}: ${file.error} — file skipped, continuing without it`);
    }
  }
  return registry;
}

/** Every key a curated (non-resolved) entry claims: names, aliases, and — PAR-854/D-90, ONLY for
 *  an entry declared `ecosystem: "pypi"` — each one's PEP 503 form too, so a config pin
 *  `typing_extensions` (declared pypi) also owns `typing-extensions` (schema gate, PAR-655). An
 *  npm or ecosystem-undeclared curated entry claims its own spelling only: folding it would
 *  wrongly block a genuinely different, independently-registrable package (the PAR-854 defect,
 *  applied here). */
function curatedKeys(entries: Map<string, LibraryEntry>): Set<string> {
  const keys = new Set<string>();
  for (const e of entries.values()) {
    if (e.resolved) continue;
    for (const k of [e.name, ...(e.aliases ?? [])]) {
      keys.add(k);
      if (e.ecosystem === "pypi") keys.add(normalisePyPiName(k));
    }
  }
  return keys;
}

/** PAR-854/D-90 — `candidateEcosystem` (the incoming resolved record's own `resolved.source`)
 *  gates the PEP 503 fold on `candidate`'s OWN side too: a PyPI candidate's pep-form is checked
 *  against `keys` (which already only contains pep-forms for `ecosystem: "pypi"` curated
 *  entries — see `curatedKeys`), so two npm/undeclared names never fold into a false collision,
 *  and a PyPI candidate is still caught by a same-project curated PyPI pin under a different
 *  spelling, exactly as before this item. */
function isTaken(keys: ReadonlySet<string>, candidate: string, candidateEcosystem?: "npm" | "pypi"): boolean {
  return keys.has(candidate) || (candidateEcosystem === "pypi" && keys.has(normalisePyPiName(candidate)));
}

/**
 * Install a just-resolved entry into a live registry (S2). Refused — nothing changes —
 * when the entry is not marked resolved, or when `resolveLibrary` maps its name to a
 * curated entry (default, config, or either's alias): a resolved record can replace only
 * another resolved record. Mirrors the load-time precedence. Returns whether it was installed.
 */
export function installResolvedEntry(registry: Registry, entry: LibraryEntry): boolean {
  if (!entry.resolved) return false;
  // incl. the PEP 503 twin of a curated PyPI key (PAR-854/D-90: gated by the candidate's own
  // resolved.source, never a blanket fold — see isTaken's/curatedKeys' own comments)
  if (isTaken(curatedKeys(registry.entries), entry.name, entry.resolved.source)) return false;
  // Installation uses package identity, not the user lookup's PyPI spelling fallback.
  // A differently spelled npm package must coexist with a resolved PyPI punctuation twin.
  const owner = registry.entries.get(entry.name) ?? (entry.resolved.source === "pypi"
    ? [...registry.entries.values()].find((candidate) => candidate.resolved?.source === "pypi"
      && normalisePyPiName(candidate.name) === normalisePyPiName(entry.name))
    : undefined);
  if (owner && !owner.resolved) return false;
  if (owner && owner.name !== entry.name) registry.entries.delete(owner.name);
  const versionedDocuments = mergedVersionedDocuments(owner, entry);
  const installed = { ...entry, ...(versionedDocuments ? { versionedDocuments } : {}) };
  registry.entries.set(entry.name, registry.strictDns ? { ...installed, strictDns: true } : installed);
  return true;
}

/** The text every tool returns for a name that resolves to nothing. Lists canonical names
 *  only (aliases are shown by list_libraries).
 *
 *  PAR-822 (security-audit #1-ranked finding) — `library` is an MCP tool argument (get_docs,
 *  doctor, refresh) or a CLI argument, echoed here on a purely local, no-network path whenever
 *  the name does not resolve. `clipText(library, MAX_NAME_LENGTH)` — the same primitive and
 *  the same bound `resolve.ts`'s `couldNotResolveMessage` applies to `name` — so the caller's
 *  value is cleaned and bounded. The Known: list is separate and grows with registry size. */
export function unknownLibraryMessage(registry: Registry, library: string): string {
  const known = [...registry.entries.keys()];
  if (known.some((name) => name.includes('"'))) {
    return `Unknown library:\n${fenceEchoedIdentifier(library, MAX_NAME_LENGTH)}\nKnown:\n${known.map((name) => fenceEchoedIdentifier(name, MAX_NAME_LENGTH)).join("\n")}`;
  }
  if (library.includes('"')) return `Unknown library:\n${fenceEchoedIdentifier(library, MAX_NAME_LENGTH)}\nKnown: ${known.join(", ")}`;
  return `Unknown library "${clipText(library, MAX_NAME_LENGTH)}". Known: ${known.join(", ")}`;
}

/**
 * The one lookup every tool uses (get_docs, refresh, doctor, list). Order:
 * exact canonical name → exact alias → the same two again on the trimmed,
 * lower-cased input (agents send "Next.js" and "Supabase") → finally the PEP 503
 * form of the input against the PEP 503 form of every curated PyPI name/alias and every
 * resolved PyPI entry's (`Typing.Extensions` reaches a `typing_extensions` pin; a pin always
 * beats a resolved record). Undefined when unknown.
 *
 * PAR-854/D-90 — that last leg is scoped to `ecosystem === "pypi"` (curated) or
 * `resolved?.source === "pypi"` (a resolver-produced record): an npm or ecosystem-undeclared
 * entry's spelling is matched EXACTLY (the two legs above) or not at all, never folded — folding
 * it here would let a query for `foo.bar` reach an npm `foo_bar` entry with no relation to it,
 * the same "wrong document under the requested name" failure `applyLayer`'s merge gate (above)
 * closes for the load-time case; this closes the read-time one.
 */
export function resolveLibrary(registry: Registry, name: string): LibraryEntry | undefined {
  const lookup = (key: string): LibraryEntry | undefined => {
    const direct = registry.entries.get(key);
    if (direct) return direct;
    for (const e of registry.entries.values()) if (e.aliases?.includes(key)) return e;
    return undefined;
  };
  const exact = lookup(name);
  if (exact) return exact;
  const folded = fold(name);
  if (folded.length === 0) return undefined;
  if (folded !== name) {
    const hit = lookup(folded);
    if (hit) return hit;
  }
  const pep = normalisePyPiName(folded);
  let resolvedMatch: LibraryEntry | undefined;
  for (const e of registry.entries.values()) {
    if (e.ecosystem !== "pypi" && e.resolved?.source !== "pypi") continue; // PAR-854/D-90 gate
    if ([e.name, ...(e.aliases ?? [])].some((k) => normalisePyPiName(k) === pep)) {
      if (!e.resolved) return e;
      resolvedMatch ??= e;
    }
  }
  return resolvedMatch;
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag! + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** The curated name or alias within edit distance 2 of `name` (folded), closest first,
 *  registry order on ties; undefined when nothing is close or the name is an exact key.
 *  Used by get_docs to flag a likely typo next to an implicit resolution (R3). */
export function nearestLibraryName(registry: Registry, name: string): string | undefined {
  const needle = fold(name);
  let best: { key: string; d: number } | undefined;
  for (const e of registry.entries.values()) {
    if (e.resolved) continue;
    for (const key of [e.name, ...(e.aliases ?? [])]) {
      const d = editDistance(needle, key);
      if (d === 0) return undefined;
      if (d <= 2 && (best === undefined || d < best.d)) best = { key, d };
    }
  }
  return best?.key;
}
