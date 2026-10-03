import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const self = "test/no-build-tool-references.test.ts";
const sdkProduct = /platform\.openai|docs\.anthropic|platform\.claude|anthropic-sdk|@anthropic-ai|\bopenai\b|\banthropic\b/i;

// Each exception is one named shipping file and one line shape from the product Keep list.
const allowed: ReadonlyArray<{ path: string; line: RegExp }> = [
  ...[
    "src/registry.ts",
    "src/fetcher.ts",
    "src/get-docs.ts",
    "test/registry.test.ts",
    "test/fetcher.test.ts",
    "README.md",
    "docs/decisions.md",
    "docs/eval/2026-09-06-par-658.md",
    "docs/eval/2026-09-20-par-827.md",
    "docs/eval/probe-gold.json",
  ].map((path) => ({ path, line: sdkProduct })),
  { path: "README.md", line: /Claude Code|^claude mcp add/ },
  { path: "test/c3-install-acceptance.test.ts", line: /Claude Code|claude mcp add/ },
  { path: "src/bug-report.ts", line: /app: \["Claude", "ChatGPT", "Codex"/ },
  { path: "test/fetcher.test.ts", line: /expect\(doc\?\.content\)\.toBe\("# Claude docs"\)/ },
  { path: "package.json", line: /^\s*"claude",?\s*$/ },
];

describe("public tracked-tree scrub", () => {
  it("contains no build-tool attribution, real local path, or internal tracked note", () => {
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
      .split("\0").filter(Boolean).filter((path) => path !== "package-lock.json" && path !== self);
    const failures: string[] = [];
    for (const path of files) {
      if (path.startsWith(".vibectx-plan/") || path.startsWith(".claude/") || path === "CLAUDE.md") {
        failures.push(`${path}: tracked internal note`);
        continue;
      }
      const lines = readFileSync(new URL(`../${path}`, import.meta.url), "utf8").split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        const at = `${path}:${index + 1}`;
        if (/\/Volumes\//.test(line) || /\/Users\/(?!me(?:\/|$)|Private(?:\/|$))[^/\s]+/.test(line)) {
          failures.push(`${at}: local path`);
        }
        if (/p[a]r[a]g[o]n/i.test(line)) failures.push(`${at}: project attribution`);
        if (/claude|codex|anthropic|openai|co-authored-by|authored-by/i.test(line)
          && !allowed.some((entry) => entry.path === path && entry.line.test(line))) {
          failures.push(`${at}: build-tool reference`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

// Four process phrases remain forbidden even inside a valid credit.
const creditName = ["T", "om"].join("");
const processPhrases = [creditName + "'s Mac", "the owner" + " reports", "this" + " agent", "verification" + "/"];
const processPhrase = (text: string): boolean => processPhrases.some((phrase) => text.toLowerCase().includes(phrase.toLowerCase()));
const attributionNames = ["clau" + "de", "co" + "dex", "anthro" + "pic", "open" + "ai"];
const attributionExpression = (): RegExp => new RegExp(
  `(?:generated(?:\\s+(?:with|by))?|(?:co-)?authored(?:-by|\\s+by)|written\\s+by|built\\s+by|created\\s+(?:with|by))\\s*[:=]?\\s*(?:${attributionNames.join("|")})`, "i",
);
const attributionText = (text: string): string => text
  .replace(/<\/?[a-z][^>]*>/gi, (tag) => tag.replace(/[^\r\n]/g, ""))
  .replace(/[`*_~"']/g, "");
const attribution = (text: string): boolean => attributionExpression().test(text) || attributionExpression().test(attributionText(text));
// Existing author/decision pin lines are exact text, scoped to one file each.
const retainedCreditLines: ReadonlyArray<readonly [string, string]> = [
  [
    ".github/workflows/ci.yml",
    "# INTERSECTION of `vite`'s and `vitest`'s own declared ranges (\u0054om's decision: fix the"
  ],
  [
    "AUTHORS",
    "\u0054om Hanks / BlackRaptorAI"
  ],
  [
    "CONTRIBUTING.md",
    "MIT \u00a9 2026 \u0054om Hanks / BlackRaptorAI. By contributing you agree your contribution is licensed"
  ],
  [
    "LICENSE",
    "Copyright (c) 2026 \u0054om Hanks / BlackRaptorAI"
  ],
  [
    "README.md",
    "By \u0054om Hanks / [BlackRaptorAI](https://github.com/BlackRaptorAI) \u00b7 MIT"
  ],
  [
    "README.md",
    "fully atomic filesystem boundary. \u0054om's eight answered choices are in the"
  ],
  [
    "README.md",
    "\u0054om retained this B-02 behavior for linked monorepos and dotfile setups: placing such a link"
  ],
  [
    "README.md",
    "MIT \u00a9 2026 \u0054om Hanks / BlackRaptorAI"
  ],
  [
    "docs/decisions.md",
    "## \u0044-57 \u2013 \u0044-67 \u2014 decided 2026-09-10 by \u0054om"
  ],
  [
    "docs/decisions.md",
    "## \u0044-68 \u2014 decided 2026-09-11 by \u0054om"
  ],
  [
    "docs/decisions.md",
    "## \u0044-69 \u2014 decided 2026-09-15 by \u0054om"
  ],
  [
    "docs/decisions.md",
    "## \u0044-70 \u2014 decided 2026-09-17 by \u0054om"
  ],
  [
    "docs/decisions.md",
    "## \u0044-71 \u2014 decided 2026-09-17 by \u0054om"
  ],
  [
    "docs/decisions.md",
    "22.0.0\u201322.11.x, versions `vite`'s own range excludes. \u0054om's decision (2026-09-17): a field"
  ],
  [
    "docs/decisions.md",
    "**The diagnostic \u0054om asked for, before anything was changed:** run `npm test` after the"
  ],
  [
    "docs/decisions.md",
    "anywhere in the tree to reuse, and \u0054om's own instruction was explicit: approximating this by"
  ],
  [
    "docs/decisions.md",
    "\u0054om's"
  ],
  [
    "docs/decisions.md",
    "env-configured root; the DEFAULT root is auto-tightened, per a gate decision \u0054om recorded after"
  ],
  [
    "docs/decisions.md",
    "PAR-862 Low) plus the auto-tighten gate decision below, landed together per \u0054om's own framing at"
  ],
  [
    "docs/decisions.md",
    "**Gate decision (\u0054om, 2026-09-18) \u2014 amends \u0044-84.** \u0044-84 recorded, for EVERY pre-existing loose"
  ],
  [
    "docs/decisions.md",
    "not an oversight.\" That blanket claim is now narrower, by \u0054om's own ruling recorded in Linear on"
  ],
  [
    "docs/decisions.md",
    "documented limitation instead of closing it. \u0054om's decision, taken at the Phase 3 gate."
  ],
  [
    "docs/decisions.md",
    "- **\u0044-89a \u2014 \u0054om's decision (2026-09-19), recorded explicitly, not implied.** `allowInternalHosts`"
  ],
  [
    "docs/decisions.md",
    "`test/fetcher.test.ts` now exercise those paths under the \u0044-89a decision. \u0054om's"
  ],
  [
    "docs/decisions.md",
    "redirect. \u0054om chose the wider scope for that narrower, but real, case: an operator who sets"
  ],
  [
    "docs/decisions.md",
    "## \u0044-96 \u2014 decided 2026-09-23 by \u0054om, PAR-990 / C1"
  ],
  [
    "docs/decisions.md",
    "is opt-in and documented. This is \u0054om's decision, not an ASSUMED release choice."
  ],
  [
    "docs/decisions.md",
    "## \u0044-97 \u2014 decided 2026-09-23 by \u0054om, PAR-1002 / C4"
  ],
  [
    "docs/decisions.md",
    "**ASSUMED implementation details, \u0054om to confirm:** elicitation timeout is 120,000 ms for a"
  ],
  [
    "docs/decisions.md",
    "assumptions are not attributed to \u0054om's decided Option B+."
  ],
  [
    "docs/decisions.md",
    "## \u0044-98 \u2014 decided 2026-09-24 by \u0054om, PAR-1016 / Phase D"
  ],
  [
    "docs/decisions.md",
    "transport denial-of-service boundary. \u0054om accepts this disclosed limit for 0.3.0, conditioned on"
  ],
  [
    "docs/decisions.md",
    "## \u0044-99 \u2014 decided 2026-09-24 by \u0054om"
  ],
  [
    "docs/decisions.md",
    "## \u0044-NEXT \u2014 decided 2026-09-24 by \u0054om, PAR-1040 (amends \u0044-97)"
  ],
  [
    "docs/decisions.md",
    "Tool calls follow \u0044-97 (a) and (b) unchanged.** Confirmed by \u0054om on 2026-09-26 (plan review"
  ],
  [
    "docs/decisions.md",
    "## \u0044-NEXT \u2014 decided 2026-09-24 by \u0054om, PAR-1039 (amends B-24)"
  ],
  [
    "docs/decisions.md",
    "**The activity log rotates with a linked trail instead of erasing history.** Re-confirmed by \u0054om"
  ],
  [
    "docs/known-limitations.md",
    "| B-02 | A symlink to a regular project config is followed. | \u0044-15; `src/config.ts` | \u0054om chose to keep this for linked monorepos and dotfiles. | Accepted behavior | Treat project write access as config-authoring access; review cloned configs. |"
  ],
  [
    "docs/known-limitations.md",
    "| B-04 | Cache migration and followed-page cleanup retain synchronous check-then-act windows. | \u0044-83/\u0044-85; `src/cache.ts` | Descriptor-pinned reads and canonical-root checks close broader escapes; \u0054om accepted the remaining migration/cleanup boundary. \u0044-95 separately covers the configured-root race. | Accepted behavior | Restrict writes to cache ancestors; these operations are not a fully atomic filesystem boundary. |"
  ],
  [
    "docs/known-limitations.md",
    "| B-14 | A full refresh has a deadline per library rather than one overall deadline. | \u0044-89c; `src/refresh.ts` | \u0054om accepted approximately 1,800 seconds for 30 libraries rather than a half-updated cache. | Accepted behavior | Refresh one library at a time when latency matters. |"
  ],
  [
    "docs/known-limitations.md",
    "| B-16 | One URL can share a cache entry across response representations. | \u0044-90j | The cache key has no `Accept` discriminator. \u0054om's separate-project decision places representation-aware keys in VibeCTX 2.0, deferred-by-decision. | Deferred behavior | Avoid a configured endpoint whose response varies by request role or headers. |"
  ],
  [
    "docs/known-limitations.md",
    "| B-23 | Authenticated docs and custom request headers are unsupported. | \u0044-90j; `src/retrieval.ts` | \u0054om chose public docs only for this release. | Accepted behavior | Use public endpoints; do not put credentials in documentation URLs. |"
  ],
  [
    "docs/known-limitations.md",
    "| B-25 | Cache migration and followed-page cleanup retain synchronous check-then-act windows. | \u0044-83/\u0044-85; `src/cache.ts` | \u0054om accepted the remaining migration/cleanup boundary; \u0044-95 separately covers the configured-root race. | Accepted behavior | Restrict parent-directory writes: this is the migration/cleanup boundary, not broad cache-root exposure. |"
  ],
  [
    "docs/known-limitations.md",
    "| B-36 | Echoed retrieval identifiers use variable-width data fences. | `src/retrieval.ts`; `src/get-docs.ts` | \u0054om chose to extend the existing fetched-data fence. This is a text-format boundary, not a universal prompt-injection guarantee. | Resolved safeguard | Keep treating retrieved prose as untrusted; registry descriptions have separate behavior. |"
  ],
  [
    "docs/known-limitations.md",
    "| B-37 | Cache-root refusal is visible through the appropriate output channel. | `src/doctor.ts`; README cache section | \u0054om chose channel-split reporting: terminal detail, redacted model output and default JSON. | Resolved safeguard | Run doctor locally; opt into a full path only when needed. |"
  ],
  [
    "docs/known-limitations.md",
    "memoization retains its VibeCTX 0.2.1 deferral. \u0054om's separate-project direction remains unchanged."
  ],
  [
    "docs/known-limitations.md",
    "These eight behaviors were decided by \u0054om, 2026-09-21. They are compatibility choices for users,"
  ],
  [
    "package.json",
    "\"author\": \"\u0054om Hanks (BlackRaptorAI)\","
  ],
  [
    "src/activity-log.ts",
    "* PAR-1039 ROTATION WITH A LINKED TRAIL (\u0054om, 2026-09-24; amends B-24): once the live file holds"
  ],
  [
    "src/activity-log.ts",
    "*  value prints one stderr line and keeps 5 (\u0054om's decision); it never stops logging. */"
  ],
  [
    "src/address-policy.ts",
    "/** PAR-851 (\u0054om's decision, docs/decisions.md) \u2014 a private/loopback/link-local/unique-local"
  ],
  [
    "src/cache.ts",
    "/** Gate decision (\u0054om, PAR-805/PAR-859, 2026-09-18, recorded as an amendment to \u0044-84 in"
  ],
  [
    "src/cache.ts",
    "* PRE-EXISTING UNSAFE ROOT, THE DEFAULT ROOT SPECIFICALLY \u2014 GATE DECISION, AMENDING \u0044-84 (\u0054om,"
  ],
  [
    "src/cache.ts",
    "// Gate decision, amending \u0044-84 (\u0054om, PAR-805/PAR-859, 2026-09-18) \u2014 see this function's"
  ],
  [
    "src/config.ts",
    "*  value prints one line and keeps 5 (\u0054om's decision), it must not make the file fail. */"
  ],
  [
    "src/fetcher.ts",
    "/** PAR-851 (\u0054om's decision, docs/decisions.md) \u2014 when true, a resolved address that is private,"
  ],
  [
    "src/fetcher.ts",
    "// PAR-851 (\u0054om's decision) \u2014 this entry's own opt-in covers its primary fetch and every"
  ],
  [
    "src/fetcher.ts",
    "// PAR-851 (\u0054om's decision) \u2014 a link followed from an opted-in entry's own document is"
  ],
  [
    "src/limits.ts",
    "/** PAR-1039 (\u0054om, 2026-09-24; amends B-24) \u2014 the live `activity.json` is renamed to a"
  ],
  [
    "src/link-policy.ts",
    "/** PAR-851 (\u0054om's decision, docs/decisions.md) \u2014 carried through from the owning entry's own"
  ],
  [
    "src/link-policy.ts",
    "* flag's now-widened scope (PAR-851, \u0054om's decision, docs/decisions.md \u0044-89a): this entry's own"
  ],
  [
    "src/registry.ts",
    "*  unique-local address without being refused for that reason alone (\u0054om's decision,"
  ],
  [
    "src/search.ts",
    "* before cache reads, resolution or network work (PAR-1042, decided by \u0054om)."
  ],
  [
    "test/activity-log-rotation.test.ts",
    "it(\"constants match \u0054om's decision: rotate at 4,000 entries, keep 5 archives, show 2,000\", () => {"
  ],
  [
    "test/authorship.test.ts",
    "expect(byline).toContain(\"\u0054om Hanks\");"
  ],
  [
    "test/authorship.test.ts",
    "it(\"README license summary names \u0054om Hanks and BlackRaptorAI\", () => {"
  ],
  [
    "test/authorship.test.ts",
    "expect(licenseSection.trimStart().split(\"\\n\")[0]).toBe(\"MIT \u00a9 2026 \u0054om Hanks / BlackRaptorAI\");"
  ],
  [
    "test/authorship.test.ts",
    "it(\"package author names \u0054om Hanks and BlackRaptorAI\", () => {"
  ],
  [
    "test/authorship.test.ts",
    "expect(pkg.author).toBe(\"\u0054om Hanks (BlackRaptorAI)\");"
  ],
  [
    "test/authorship.test.ts",
    "it(\"LICENSE copyright line names \u0054om Hanks and BlackRaptorAI\", () => {"
  ],
  [
    "test/authorship.test.ts",
    "expect(copyright).toBe(\"Copyright (c) 2026 \u0054om Hanks / BlackRaptorAI\");"
  ],
  [
    "test/authorship.test.ts",
    "expect(attribution).toBe(\"\u0054om Hanks / BlackRaptorAI\");"
  ],
  [
    "test/authorship.test.ts",
    "\"MIT \u00a9 2026 \u0054om Hanks / BlackRaptorAI. By contributing you agree your contribution is licensed\","
  ],
  [
    "test/c1-decision-record.test.ts",
    "it(\"records \u0054om's path-preserving privacy scope, not an ASSUMED decision\", () => {"
  ],
  [
    "test/c1-decision-record.test.ts",
    "expect(record).toContain(\"\u0044-96 \u2014 decided 2026-09-23 by \u0054om, PAR-990 / C1\");"
  ],
  [
    "test/cache-root.test.ts",
    "* Gate decision (\u0054om, PAR-805/PAR-859, 2026-09-18, amending \u0044-84) \u2014 recorded verbatim in"
  ],
  [
    "test/cache-root.test.ts",
    "describe(\"Gate decision (\u0054om, PAR-805/PAR-859, 2026-09-18) \u2014 the DEFAULT cache root is auto-tightened when found looser than 0700\", () => {"
  ],
  [
    "test/fetcher.test.ts",
    "describe(\"\u0054om's extension (docs/decisions.md): allowInternalHosts covers this entry's redirect hops and its own followed links\", () => {"
  ],
  [
    "test/par1036-public-record.test.ts",
    "expect(read(\"README.md\")).toContain(\"\u0054om's eight\");"
  ],
  [
    "test/par1036-public-record.test.ts",
    "expect(read(\".github/workflows/ci.yml\")).toContain(\"\u0054om's decision\");"
  ],
  [
    "test/release-prep.test.ts",
    "it(\"records \u0044-98 as \u0054om's trusted-launching-client decision, not an assumed transport control\", () => {"
  ],
  [
    "test/release-prep.test.ts",
    "expect(d98).toContain(\"decided 2026-09-24 by \u0054om\");"
  ],
  [
    "test/residual-register.test.ts",
    "expect(row(\"B-04\")).toContain(\"\u0054om accepted the remaining migration/cleanup boundary\");"
  ],
  [
    "test/residual-register.test.ts",
    "expect(row(\"B-25\")).toContain(\"\u0054om accepted the remaining migration/cleanup boundary\");"
  ],
  [
    "test/residual-register.test.ts",
    "expect(cells(\"B-04\")[3]).toBe(\"Descriptor-pinned reads and canonical-root checks close broader escapes; \u0054om accepted the remaining migration/cleanup boundary. \u0044-95 separately covers the configured-root race.\");"
  ],
  [
    "test/residual-register.test.ts",
    "\"\u0054om accepted the remaining migration/cleanup boundary; \u0044-95 separately covers the configured-root race.\","
  ],
  [
    "test/residual-register.test.ts",
    "expect(answered).toContain(\"decided by \u0054om\");"
  ],
  [
    "test/update-check-startup.test.ts",
    "* PAR-1008 opt-in update check, as amended by PAR-1040 (\u0044-97 amendment, \u0054om 2026-09-24/26):"
  ]
];
const decisionCreditRanges = (line: string): Array<readonly [number, number]> => {
  const subject = new RegExp(`\\b${creditName}(?:'s)?\\s+(?:decision\\b|own\\s+(?:instruction|ruling|framing)\\b|separate-project\\s+(?:decision|direction)\\b|(?:F[1-9]\\d*,\\s+)?option\\s+[a-z]\\b|(?:chose|chooses|accepted|accepts|retained|retains|decided)\\b)`, "gi");
  const attribution = new RegExp(`\\b(?:decided|confirmed|re-confirmed|chosen|accepted)(?:\\s+\\d{4}-\\d{2}-\\d{2})?\\s+by\\s+${creditName}\\b`, "gi");
  const datedRotation = new RegExp(`\\b${creditName},\\s+\\d{4}-\\d{2}-\\d{2}:\\s+rotation-only\\s+mutual\\s+exclusion\\b`, "gi");
  const timeoutException = new RegExp(`\\bR9\\s+exception\\s+\\(${creditName},\\s+2026-10-01,\\s+plan\\s+§6\\s+long-run\\s+question\\s+5\\)`, "gi");
  return [subject, attribution, datedRotation, timeoutException].flatMap((pattern) => [...line.matchAll(pattern)].map((match) => [match.index, match.index + match[0].length] as const));
};
const nonCreditMention = (path: string, line: string, nextLine = ""): boolean => {
  if (retainedCreditLines.some(([file, credit]) => file === path && credit === line.trim())) return false;
  const ranges = decisionCreditRanges(`${line}\n${nextLine}`);
  return [...line.matchAll(new RegExp(`\\b${creditName}\\b`, "g"))]
    .some((match) => !ranges.some(([start, end]) => match.index >= start && match.index + match[0].length <= end));
};

const inventory = (): string[] => {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  expect(files.length, "the guard must inspect a populated tracked tree").toBeGreaterThan(100);
  expect(files).toContain("README.md");
  expect(files).toContain("docs/decisions.md");
  return files;
};

describe("PAR-1036 public record guards", () => {
  it("PAR-1036: tracked docs and source comments reject internal process phrases", () => {
    const failures: string[] = [];
    for (const path of inventory()) {
      if (processPhrase(path)) failures.push(`${path}: internal process filename`);
      for (const [index, line] of readFileSync(new URL(`../${path}`, import.meta.url), "utf8").split(/\r?\n/).entries()) {
        if (processPhrase(line)) failures.push(`${path}:${index + 1}: internal process phrase`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("PAR-1036: tracked docs and source comments reject build attributions", () => {
    const failures: string[] = [];
    for (const path of inventory()) {
      const text = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
      const normalized = attributionText(text);
      const raw = attributionExpression().exec(text);
      const match = raw ?? attributionExpression().exec(normalized);
      if (match) failures.push(`${path}:${(raw ? text : normalized).slice(0, match.index).split("\n").length}: build attribution`);
    }
    expect(failures).toEqual([]);
  });

  it("PAR-1036: tracked filenames reject build attribution names", () => {
    const name = new RegExp(attributionNames.join("|"), "i");
    expect(inventory().filter((path) => name.test(path))).toEqual([]);
  });

  it("PAR-1036: tracked non-credit name mentions are refused without excluding decision credits", () => {
    const failures: string[] = [];
    for (const path of inventory()) {
      if (new RegExp(`\\b${creditName}\\b`).test(path)) failures.push(`${path}: non-credit filename`);
      const lines = readFileSync(new URL(`../${path}`, import.meta.url), "utf8").split(/\r?\n/);
      for (const [index, line] of lines.entries())
        if (nonCreditMention(path, line, lines[index + 1])) failures.push(`${path}:${index + 1}: non-credit mention`);
    }
    expect(failures).toEqual([]);
  });

  it("PAR-1036: credit exemptions reject unrelated prose and are scoped to exact files and lines", () => {
    expect(nonCreditMention("README.md", `${creditName} likes cryptography.`)).toBe(true);
    expect(nonCreditMention("README.md", `${creditName} likes decision records.`)).toBe(true);
    const author = `By ${creditName} Hanks / [BlackRaptorAI](https://github.com/BlackRaptorAI) · MIT`;
    expect(nonCreditMention("README.md", author)).toBe(false);
    expect(nonCreditMention("docs/examples/other.md", author)).toBe(true);
    expect(nonCreditMention("README.md", `${author} Additional unrelated prose.`)).toBe(true);
    for (const line of [`decided 2026-09-23 by ${creditName}`, `${creditName}'s decision`, `${creditName} chose`, "TomlKeyValue", "scanToml"])
      expect(nonCreditMention("docs/examples/new-decision.md", line), line).toBe(false);
  });

  it("PAR-1036: every name occurrence must independently credit a decision", () => {
    const credit = `${creditName} chose to preserve the cache.`;
    for (const line of [`${credit} ${creditName} likes cryptography.`, `${creditName} likes cryptography. ${credit}`, `${credit} ${creditName}'s hobbies are unrelated.`, `${credit} ${creditName} chose cache; ${creditName} likes prose.`])
      expect(nonCreditMention("README.md", line), line).toBe(true);
    for (const line of [`${credit} ${creditName}'s decision preserves old data.`, `decided 2026-10-01 by ${creditName}; ${creditName} accepted the boundary.`, `${credit} TomlKeyValue scanToml`])
      expect(nonCreditMention("docs/examples/new-decision.md", line), line).toBe(false);
  });

  it("PAR-1036: wrapped option credits and numbered decision credits remain allowed per occurrence", () => {
    expect(nonCreditMention("src/autowarm.ts", ` * PAR-1048 (${creditName}'s F11, option a; amends D-97)`)).toBe(false);
    expect(nonCreditMention("test/autowarm-scope.test.ts", ` * PAR-1048 (final audit L-20; ${creditName}'s F11, option a): scope`)).toBe(false);
    expect(nonCreditMention("docs/decisions.md", `Background scope. ${creditName}'s`, "option A (2026-09-24) with F11 option (a).")).toBe(false);
    expect(nonCreditMention("README.md", `${creditName}'s F11, option a. ${creditName} likes unrelated prose.`)).toBe(true);
    expect(nonCreditMention("README.md", `${creditName}'s`, "hobbies are unrelated.")).toBe(true);
  });

  it("PAR-1036: dated rotation decision credits remain scoped to their own name", () => {
    const credit = `${creditName}, 2026-10-01: rotation-only mutual exclusion`;
    expect(nonCreditMention("src/activity-log.ts", `/** Take the single-holder rotation marker (${credit};`)).toBe(false);
    expect(nonCreditMention("src/activity-log.ts", `${credit}; ${creditName} likes unrelated prose.`)).toBe(true);
    expect(nonCreditMention("README.md", `${creditName}, 2026-10-01: likes unrelated prose.`)).toBe(true);
  });

  it("PAR-1036: the single authorized R9 timeout credit remains scoped to its own name", () => {
    const credit = `R9 exception (${creditName}, 2026-10-01, plan §6 long-run question 5)`;
    expect(nonCreditMention("test/cache-read-toctou.test.ts", `// ${credit}, this test only: timeout raised`)).toBe(false);
    expect(nonCreditMention("test/cache-read-toctou.test.ts", `// ${credit}; ${creditName} likes unrelated prose.`)).toBe(true);
    expect(nonCreditMention("README.md", `R9 exception (${creditName}, 2026-10-01: unrelated hobbies)`)).toBe(true);
  });

  it("PAR-1036: rendered attribution formatting cannot hide build credit", () => {
    const name = attributionNames[0];
    for (const marker of ["**", "_", "`", "~~", '"', "'"])
      expect(attribution(`Generated with ${marker}${name}${marker}`), marker).toBe(true);
    expect(attribution(`Created by <strong>${name}</strong>`)).toBe(true);
    expect(attribution(`Co-Authored-By: <em>${name}</em>`)).toBe(true);
    expect(attribution(`Generated with\n**${name}**`)).toBe(true);
    expect(attribution("Ordinary supported documentation endpoint.")).toBe(false);
  });

  it("PAR-1036: author and decision credits remain allowed and whole-word matching excludes TomlKeyValue", () => {
    for (const text of ["decided 2026-09-23 by Tom", "Tom's decision", "Tom chose", "TomlKeyValue", "scanToml"])
      expect(processPhrase(text) || attribution(text), text).toBe(false);
    const decisions = readFileSync(new URL("../docs/decisions.md", import.meta.url), "utf8");
    expect(decisions).toContain("decided 2026-09-23 by Tom");
    expect(decisions).toContain("Tom's decision");
    expect(readFileSync(new URL("../docs/known-limitations.md", import.meta.url), "utf8")).toContain("Tom chose");
  });
});
