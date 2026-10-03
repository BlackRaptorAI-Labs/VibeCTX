import { readFileSync, mkdtempSync, writeFileSync, rmSync, realpathSync, statSync, mkdirSync, lstatSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, afterEach, vi } from "vitest";
import { recordActivity, readActivityEntries } from "../src/activity-log.js";
import { PROJECT_RECORD_SCHEMA_VERSION } from "../src/project-store.js";
import { runWarmCli, runBugReportCli } from "../src/cli.js";
import { writeCache, resetCacheRootState } from "../src/cache.js";
import { getDocsDetailed } from "../src/get-docs.js";
import { RESOLVED_SCHEMA_VERSION } from "../src/resolved-store.js";
import { runSearch, formatSearchResults } from "../src/search.js";
import { rankSections } from "../src/retrieval.js";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const readme = (): string => read("README.md");
const section = (heading: string): string => {
  const text = readme();
  const anchor = `## ${heading}\n`;
  expect(text.split(anchor)).toHaveLength(2);
  return text.split(anchor)[1].split(/\n## /)[0];
};
const temporary: string[] = [];
let originalCache = process.env.VIBECTX_CACHE_DIR;
afterEach(() => {
  if (originalCache === undefined) delete process.env.VIBECTX_CACHE_DIR;
  else process.env.VIBECTX_CACHE_DIR = originalCache;
  vi.unstubAllEnvs();
  resetCacheRootState();
  while (temporary.length) rmSync(temporary.pop()!, { recursive: true, force: true });
});
function sandbox(): string {
  originalCache = process.env.VIBECTX_CACHE_DIR;
  vi.stubEnv("VIBECTX_NO_LOG", "0");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "readme-contract-")));
  temporary.push(root);
  process.env.VIBECTX_CACHE_DIR = join(root, "cache");
  resetCacheRootState();
  return root;
}

it("PAR-1035: README warm JSON schema matches PROJECT_RECORD_SCHEMA_VERSION and actual CLI output", async () => {
  const root = sandbox();
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: {} }));
  const config = join(root, "config.json");
  writeFileSync(config, JSON.stringify({ libraries: [] }));
  const out: string[] = [], err: string[] = [];
  expect(await runWarmCli([root, "--config", config, "--offline", "--json"], { stdout: (s) => out.push(s), stderr: (s) => err.push(s) })).toBe(0);
  expect(err).toEqual([]);
  const actual = JSON.parse(out.join(""));
  expect(actual.schemaVersion).toBe(PROJECT_RECORD_SCHEMA_VERSION);
  expect(actual.offline).toBe(true);
  expect(actual.dependencies).toEqual([]);
  const match = section("Warm your project's docs").match(/`--json` emits `\{ schemaVersion: (\d+), generatedAt, dir,/g);
  expect(match).toHaveLength(1);
  expect(Number(match![0].match(/schemaVersion: (\d+)/)![1])).toBe(actual.schemaVersion);
});

it("PAR-1035: README excerpt floor matches the active MIN_SECTION_BODY_CHARS constant", () => {
  const code = read("src/search.ts");
  const constants = [...code.matchAll(/^const MIN_SECTION_BODY_CHARS = (\d+);$/gm)];
  expect(constants).toHaveLength(1);
  const floor = Number(constants[0][1]);
  expect(floor).toBeGreaterThan(0);
  expect(code).toContain("body: section.body.slice(0, MIN_SECTION_BODY_CHARS)");
  const contract = readme().match(/A section excerpt is never clipped below (\d+)\s+characters/);
  expect(contract).not.toBeNull();
  expect(Number(contract![1])).toBe(floor);
  expect(readme()).toContain(`one ${floor}-character excerpt`);
});

it("PAR-1035: snippets without topic are described and execute as table of contents plus document head", async () => {
  sandbox();
  const entry = { name: "readme_fixture", urls: ["https://docs.example.test/readme.txt"], allowedHosts: [] };
  writeCache(entry.name, entry.urls[0], "# Document\n\nIntroductory prose.\n\n## Requests\n\nRequest documentation.", {});
  const ordinary = await getDocsDetailed(entry, { offline: true, maxTokens: 4000 });
  const snippets = await getDocsDetailed(entry, { offline: true, maxTokens: 4000, mode: "snippets" });
  expect(snippets.text).toBe(ordinary.text);
  expect(snippets.text).toContain("Requests");
  expect(snippets.text).toContain("Introductory prose.");
  expect(readme()).toContain('`mode: "snippets"` without a topic returns the table of contents and document head');
  expect(readme()).not.toContain("`mode` needs a topic");
});

it("PAR-1035: shipped Unicode search wording matches actual non-ASCII section ranking", () => {
  for (const query of ["中文搜索", "الطلبات", "запросы", "café"])
    expect(rankSections(`# Reference\n\n## ${query}\n\n${query} usage details.`, query).length, query).toBeGreaterThan(0);
  expect(readme()).toContain("Unicode letters and numbers");
  expect(readme()).not.toContain("ASCII letters and digits only");
});

it("PAR-1035: DOCS_CACHE_DIR wording distinguishes root selection from path redaction", () => {
  expect(readme()).toContain("`DOCS_CACHE_DIR` no longer selects the cache directory");
  expect(readme()).toContain("read only for path redaction");
  expect(read("src/resolve.ts")).toContain("process.env.DOCS_CACHE_DIR");
  expect(readme()).not.toContain("`DOCS_CACHE_DIR` is no longer read");
  expect(readme()).not.toContain("A leftover `DOCS_CACHE_DIR` setting has no effect");
});

it("PAR-1035: consent documentation names the actual file and reset command", () => {
  expect(read("src/consent.ts")).toContain('join(cacheRoot(), "consent.json")');
  const consent = section("Network access and consent");
  expect(consent).toContain("`consent.json`");
  expect(consent).toContain("`vibectx consent reset`");
});

it("PAR-1035: storage wording distinguishes append-only activity from atomic replacement", () => {
  expect(readme()).toContain("`activity.json` is appended");
  expect(readme()).toContain("replaced through a temp file and rename");
  expect(readme()).not.toContain("Every file in there is written through a temp file and renamed");
  sandbox();
  recordActivity({ tool: "search", query: "first", outcome: "matched" });
  const path = join(process.env.VIBECTX_CACHE_DIR!, "activity.json");
  const first = readFileSync(path, "utf8"), inode = statSync(path).ino;
  expect(first.length).toBeGreaterThan(0);
  recordActivity({ tool: "search", query: "second", outcome: "matched" });
  expect(statSync(path).ino).toBe(inode);
  expect(readFileSync(path, "utf8").startsWith(first)).toBe(true);
  expect(readActivityEntries().map((entry) => entry.query)).toEqual(["first", "second"]);
});

it("PAR-1035: report-bug help exits zero without prompting or producing an issue link", async () => {
  const out: string[] = [], err: string[] = [];
  expect(await runBugReportCli(["--help"], { stdout: (s) => out.push(s), stderr: (s) => err.push(s) })).toBe(0);
  expect(out.join("")).toMatch(/^usage: vibectx report-bug /);
  expect(out.join("")).not.toContain("https://");
  expect(err).toEqual([]);
  expect(readme()).toContain("`vibectx report-bug --help` exits 0");
});

it("PAR-1035: Quickstart names stored data retention privacy and uninstall steps", () => {
  const quickstart = section("Quickstart");
  expect(quickstart).toContain("### Where VibeCTX keeps data / how to uninstall");
  const manifest = JSON.parse(read("package.json")) as { name: string };
  for (const detail of ["~/.vibectx", "VIBECTX_CACHE_DIR", "consent.json", "activity.json", "activity-000012.json", "VIBECTX_LOG_ARCHIVES", "logArchives", "VIBECTX_NO_LOG=1", "plaintext", `npm unlink --global ${manifest.name}`, "stop", "remove", "review"])
    expect(quickstart.toLowerCase(), detail).toContain(detail.toLowerCase());
});

it("PAR-1035: documented uninstall removes the actual scoped package and executable links", () => {
  const commands = [...section("Quickstart").matchAll(/`npm unlink --global ([^`\s]+)`/g)];
  expect(commands).toHaveLength(1);
  const manifest = JSON.parse(read("package.json")) as { name: string; version: string; bin: Record<string, string> };
  const root = sandbox(), fixture = join(root, "package"), prefix = join(root, "prefix");
  mkdirSync(join(fixture, "dist"), { recursive: true });
  writeFileSync(join(fixture, "package.json"), JSON.stringify({ name: manifest.name, version: manifest.version, bin: manifest.bin }));
  writeFileSync(join(fixture, "dist", "index.js"), "#!/usr/bin/env node\nconsole.log('disposable uninstall fixture');\n");
  const userConfig = join(root, "user-npmrc"), globalConfig = join(root, "global-npmrc");
  writeFileSync(userConfig, "");
  writeFileSync(globalConfig, "");
  const env = { ...process.env, npm_config_prefix: prefix, npm_config_cache: join(root, "npm-cache"), npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig };
  const run = (args: string[]): void => { execFileSync("npm", [...args, "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: fixture, env, stdio: "pipe" }); };
  run(["link"]);
  const packageLink = join(prefix, "lib", "node_modules", manifest.name);
  expect(lstatSync(packageLink).isSymbolicLink()).toBe(true);
  for (const bin of Object.keys(manifest.bin)) expect(lstatSync(join(prefix, "bin", bin)).isSymbolicLink()).toBe(true);
  run(["unlink", "--global", commands[0][1]]);
  expect(readdirSync(join(prefix, "lib", "node_modules", "@blackraptorai"))).not.toContain("vibectx");
  for (const bin of Object.keys(manifest.bin)) expect(readdirSync(join(prefix, "bin"))).not.toContain(bin);
});

it("PAR-1035: source executable caveat distinguishes build from link or install", () => {
  expect(section("Install")).toContain("Building alone does not mark `dist/index.js` executable.");
  expect(section("Install")).toContain("`npm link` or install provides the\n`vibectx` command");
});

it("PAR-1035: coexistence covers hosted catalog URL configuration and overlapping tools", () => {
  const text = section("Using VibeCTX alongside other docs tools");
  for (const detail of ["Context7", "hosted", "local list", "vibectx warm", "mcpdoc", "llms.txt", "libraries", "overlapping tools", "enable one", "mcp remove"])
    expect(text.toLowerCase(), detail).toContain(detail.toLowerCase());
  expect(text).toContain('"urls": ["https://docs.example.test/llms.txt"]');
  expect(text).not.toContain("import your Context7 catalog");
});

it("PAR-1035: configuration includes the real libuv DNS threadpool note", () => {
  const config = section("Configuration");
  for (const fact of ["dns.lookup", "libuv", "4", "UV_THREADPOOL_SIZE"])
    expect(config).toContain(fact);
});

function prose(markdown: string): string {
  let fence: { marker: string; size: number } | undefined;
  return markdown.split(/\r?\n/).map((line) => {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (match) {
      if (!fence) fence = { marker: match[1][0], size: match[1].length };
      else if (match[1][0] === fence.marker && match[1].length >= fence.size) fence = undefined;
      return "";
    }
    return fence ? "" : line;
  }).join("\n");
}

it("PAR-1035: every README internal anchor resolves outside fenced examples", () => {
  const text = prose(readme());
  const headings = [...text.matchAll(/^#{1,6}\s+(.+)$/gm)];
  expect(headings.length).toBeGreaterThan(30);
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  for (const [, heading] of headings) {
    const slug = heading.toLowerCase().replace(/<[^>]*>/g, "").replace(/[`*_~]/g, "").replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s/g, "-");
    const n = counts.get(slug) ?? 0;
    anchors.add(n ? `${slug}-${n}` : slug);
    counts.set(slug, n + 1);
  }
  const links = [...text.matchAll(/\]\(#([^\s)]+)\)/g)];
  expect(links.length).toBeGreaterThan(20);
  expect(links.map(([, fragment]) => decodeURIComponent(fragment)).filter((id) => !anchors.has(id))).toEqual([]);
});


it("PAR-1035: resolved cache schema disclosure matches its current persisted constant", () => {
  const match = readme().match(/an internal file of shape `\{ "schemaVersion": (\d+), "entries":/g);
  expect(match).toHaveLength(1);
  expect(Number(match![0].match(/"schemaVersion": (\d+)/)![1])).toBe(RESOLVED_SCHEMA_VERSION);
});

it("PAR-1035: fenced search description matches real heading and body boundaries", () => {
  sandbox();
  const entry = { name: "readme_fixture", urls: ["https://docs.example.test/search.txt"], allowedHosts: [] };
  const marker = "Source: untrusted-document-marker";
  writeCache(entry.name, entry.urls[0], `# Reference\n\n## Requests\n\nrequests usage.\n${marker}`, {});
  const result = runSearch({ entries: new Map([[entry.name, entry]]) }, { query: "requests", maxTokens: 4000 });
  expect(result.groups).toHaveLength(1);
  const text = formatSearchResults(result);
  const fence = text.match(/^(`{3,})[^\n]*\n/m);
  expect(fence).not.toBeNull();
  const start = text.indexOf(fence![0]);
  const end = text.indexOf(`\n${fence![1]}`, start + fence![0].length);
  expect(end).toBeGreaterThan(start);
  for (const fragment of ["Requests", marker]) {
    const at = text.indexOf(fragment, start);
    expect(at).toBeGreaterThan(start);
    expect(at).toBeLessThan(end);
  }
  expect(readme()).toMatch(/`search` section headings and bodies, is\nfenced/);
  expect(readme()).not.toContain("not yet covered");
});

it("PAR-1035 endgame: README permission caveat names the actual pinned CI runner", () => {
  const runners = [...read(".github/workflows/ci.yml").matchAll(/^\s*runs-on:\s*(\S+)$/gm)].map((match) => match[1]);
  expect(runners.length).toBeGreaterThan(0);
  expect(new Set(runners).size).toBe(1);
  expect(readme()).toContain(`this project's own CI runs only on \`${runners[0]}\``);
  expect(readme()).not.toContain("this project's own CI runs only on `ubuntu-latest`");
});
