import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { DEFAULT_REGISTRY } from "../src/registry.js";
import { PRIMARY_DOC_MAX_BYTES, LINKED_PAGE_MAX_BYTES } from "../src/fetcher.js";
import { MAX_CACHED_CONTENT_BYTES } from "../src/cache.js";
import { MANIFEST_MAX_BYTES } from "../src/project-deps.js";
import { METADATA_MAX_BYTES } from "../src/resolve.js";
import { MAX_CONFIG_BYTES } from "../src/config.js";
import { MAX_INDEXED_DOC_BYTES, MAX_INDEX_FILE_BYTES } from "../src/search-index.js";
import { DEFAULT_CACHE_MAX_MB } from "../src/cache-evict.js";
import { DEFAULT_SEARCH_BUDGET_TOKENS, MAX_QUERY_CHARS } from "../src/search.js";
import { MAX_TOPIC_CHARS, MAX_TOKENS_BUDGET, MAX_RESOLUTIONS_PER_HOUR, MAX_FULL_REFRESHES_PER_HOUR } from "../src/limits.js";
import { PROJECT_RECORD_SCHEMA_VERSION } from "../src/project-store.js";
import { WARM_SCHEMA_VERSION } from "../src/warm.js";
import { RESOLVED_SCHEMA_VERSION } from "../src/resolved-store.js";
import { RETRIEVAL_VERSION } from "../src/tokenize.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const readme = readFileSync(join(root, "README.md"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
const number = (value: number) => value.toLocaleString("en-US");
const mib = (bytes: number) => bytes / (1024 * 1024);

// Collect before the timed callback. The list subprocess imports this file too, so it must
// skip launching another collector. It runs no callbacks; a real test run with that flag
// accidentally set still fails below instead of silently bypassing the count check.
const collected = process.env.VIBECTX_README_COLLECTION === "1" ? undefined
  : JSON.parse(execFileSync(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "list", "--json"], {
    cwd: root, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, VIBECTX_README_COLLECTION: "1" },
  })) as { name: string; file: string }[];

it("final README: verification numbers equal Vitest's actual collected tests and files", () => {
  expect(collected, "the real test run must collect its inventory").toBeDefined();
  if (collected === undefined) throw new Error("README test collection is missing");
  expect(collected.length).toBeGreaterThan(0);
  expect(collected.some((test) => test.file.endsWith("/test/readme-final.test.ts"))).toBe(true);
  const files = new Set(collected.map((test) => test.file));
  expect(readme).toContain(`${pkg.version} verification: **${number(collected.length)} tests in ${number(files.size)} files**.`);
});

it("final README: the shipped registry count and every listed library match the actual registry", () => {
  const block = readme.match(/Ships with a default registry of the (\d+) libraries[\s\S]*?(?=\n\*\*Naming rule\.)/);
  expect(block).not.toBeNull();
  expect(Number(block![1])).toBe(DEFAULT_REGISTRY.length);
  const names = [...block![0].matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  expect(names.sort()).toEqual(DEFAULT_REGISTRY.map((entry) => entry.name).sort());
});

it("final README: limit table numbers agree with the live implementation constants", () => {
  const table = readme.split("## Limits\n")[1]?.split("\n## Development")[0];
  expect(table).toBeDefined();
  expect(MAX_CACHED_CONTENT_BYTES).toBe(PRIMARY_DOC_MAX_BYTES);
  // These controls are private implementation constants; do not export them just for docs.
  const cache = readFileSync(join(root, "src/cache.ts"), "utf8");
  const memoEntries = [...cache.matchAll(/^const MAX_CONTENT_MEMO_ENTRIES = (\d+);$/gm)];
  const memoMib = [...cache.matchAll(/^const MAX_CONTENT_MEMO_BYTES = (\d+) \* 1024 \* 1024;$/gm)];
  expect(memoEntries).toHaveLength(1);
  expect(memoMib).toHaveLength(1);
  const rows = [
    `| Primary fetched or cached document | ${mib(PRIMARY_DOC_MAX_BYTES)} MiB, checked before writing as well as reading |`,
    `| Followed page | ${mib(LINKED_PAGE_MAX_BYTES)} MiB per response;`,
    `| Dependency manifest | ${mib(MANIFEST_MAX_BYTES)} MiB per file;`,
    `| Topic / search query | ${number(MAX_TOPIC_CHARS)} / ${number(MAX_QUERY_CHARS)} units |`,
    `| Response maxTokens | Positive integer up to ${number(MAX_TOKENS_BUDGET)}; default ${number(DEFAULT_SEARCH_BUDGET_TOKENS)};`,
    `| Metadata / project config | ${mib(METADATA_MAX_BYTES)} MiB metadata response / ${mib(MAX_CONFIG_BYTES)} MiB config file |`,
    `| Resolution / full refresh | ${number(MAX_RESOLUTIONS_PER_HOUR)} resolutions / ${number(MAX_FULL_REFRESHES_PER_HOUR)} full refreshes per process per hour |`,
    `| Search index | Documents up to ${mib(MAX_INDEXED_DOC_BYTES)} MiB indexed; index file up to ${mib(MAX_INDEX_FILE_BYTES)} MiB |`,
    `| Verified search body reuse | ${number(Number(memoEntries[0]![1]))} entries and ${Number(memoMib[0]![1])} MiB estimated string storage per process |`,
    `| Cache size | ${number(DEFAULT_CACHE_MAX_MB)} MiB default;`,
  ];
  for (const row of rows) expect(table).toContain(row);
});

it("final README: current schema numbers match code and the dated doctor sample stays historical", () => {
  const warm = readme.split("## Warm your project's docs")[1]?.split("## Any library")[0];
  expect(warm).toContain(`\`--json\` emits \`{ schemaVersion: ${WARM_SCHEMA_VERSION},`);
  expect(warm).toContain(`cache directory — \`{ schemaVersion: ${PROJECT_RECORD_SCHEMA_VERSION}, dirHash,`);
  const resolved = readme.split("## Any library")[1]?.split("## Configuration")[0];
  expect(resolved).toContain(`{ "schemaVersion": ${RESOLVED_SCHEMA_VERSION}, "entries":`);
  expect(readme).toContain(`Retrieval version ${RETRIEVAL_VERSION} rebuilds indexes`);
  expect(readme).toContain("**28/30 describes that historical run, not current health.**");
  expect(readme).not.toContain("current, honest figure");
});
