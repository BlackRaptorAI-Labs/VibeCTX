import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * PAR-856: `docs/decisions.md`'s D-80 went stale for two days (2026-09-18 to
 * 2026-09-20) by naming a `vite` version one bump behind the entry's own later, correct text.
 * The lesson generalizes: any hand-typed number that a later change can silently outrun needs
 * either a re-derivation instruction (D-80's own fix) or a test that fails when the two drift
 * apart. README.md carries two such numbers this test guards:
 *
 *   1. The "On pinning" blockquote's `git checkout v<version>` example — it names
 *      `v<package.json version>` (PAR-1037, final audit L-17: comparing it only with the last
 *      tag made the release commit fail once tagged unless the README moved in that same
 *      commit, and it could not move before the tag existed). On a tagged commit it must
 *      equal that tag, and it never names a version older than the last reachable tag.
 *   2. The Install section's literal `engines.node` range string — it must match
 *      `package.json`'s own `engines.node` exactly, so a future bump (like the one D-80
 *      documents) cannot leave the README quoting an outdated range.
 *
 * CI fetches full Git history and tags (`fetch-depth: 0` in `.github/workflows/ci.yml`), so a
 * missing reachable tag there is a failure. A local shallow clone may still skip with a stated
 * reason. The engines.node check does not depend on tags and always runs.
 */

function repoRoot(): string {
  return fileURLToPath(new URL("..", import.meta.url));
}

function readRepoFile(name: string): string {
  return readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
}

function latestTagReachableFromHead(): string | null {
  try {
    const out = execFileSync("git", ["describe", "--tags", "--abbrev=0", "HEAD"], {
      cwd: repoRoot(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const tag = out.trim();
    return tag.length > 0 ? tag : null;
  } catch {
    // No tag reachable from HEAD — either a genuinely untagged history, or (far more likely
    // in practice) a shallow clone that never fetched tags at all. Either way, this test has
    // nothing trustworthy to compare README against, so it must not pretend otherwise.
    return null;
  }
}

/** The `git checkout v<version>` pin in a README's "On pinning" blockquote. */
function pinIn(readme: string): string | undefined {
  return readme.match(/> \*\*On pinning:\*\*[\s\S]*?(?=\n## )/)?.[0].match(/`git checkout (v[0-9][^`]*)`/)?.[1];
}

/** The L-17 tagged-commit check: a `vX.Y.Z` tag on HEAD that the README pin does not name. */
function pinMismatchAtHead(dir: string): { pin: string | undefined; tag: string } | undefined {
  // Read-only: lists the tags on HEAD of the repository at `dir`; never creates or moves one.
  const tags = execFileSync("git", ["tag", "--points-at", "HEAD"], { cwd: dir, encoding: "utf8", env: dir === repoRoot() ? process.env : isolatedGitEnv(dir) })
    .split("\n").map((t) => t.trim()).filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
  const pin = pinIn(readFileSync(join(dir, "README.md"), "utf8"));
  return tags.map((tag) => ({ pin, tag })).find((m) => m.pin !== m.tag);
}

/** Git for a throwaway fixture: no user or system config, no hooks, no signing, no network. */
function isolatedGitEnv(dir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", HOME: dir,
    GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"]) delete env[key];
  return env;
}

/** The real repository's tags, for the "untouched" check (read-only). */
function realTagRefs(): string {
  return execFileSync("git", ["for-each-ref", "refs/tags"], { cwd: repoRoot(), encoding: "utf8" });
}

/** Compare `vX.Y.Z` tags numerically: negative, zero or positive. */
function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10));
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

describe("README's release-pinning instructions stay consistent with the repo", () => {
  const tag = latestTagReachableFromHead();

  const pinnedTag = (): string => {
    const readme = readRepoFile("README.md");
    const pinningBlock = readme.match(/> \*\*On pinning:\*\*[\s\S]*?(?=\n## )/);
    expect(pinningBlock, "README must contain an 'On pinning' blockquote").not.toBeNull();
    const tagMatch = pinningBlock![0].match(/`git checkout (v[0-9][^`]*)`/);
    expect(tagMatch, "the 'On pinning' blockquote must contain a `git checkout v<version>` example").not.toBeNull();
    return tagMatch![1]!;
  };

  it("PAR-1037 (L-17): names v<package.json version> in the 'On pinning' blockquote", () => {
    const pkg = JSON.parse(readRepoFile("package.json")) as { version: string };
    expect(pinnedTag()).toBe(`v${pkg.version}`);
  });

  it("PAR-1037 (L-17): on a tagged commit, the blockquote names that tag", () => {
    expect(pinMismatchAtHead(repoRoot())).toBeUndefined();
  });

  it("PAR-1037 (L-17, decision 19): the tagged-commit check fails on a wrong pin and passes on the right one, in a throwaway tagged repository", () => {
    const realTagsBefore = realTagRefs();
    const dir = mkdtempSync(join(tmpdir(), "vibectx-tagged-fixture-"));
    try {
      const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: isolatedGitEnv(dir), stdio: ["ignore", "pipe", "pipe"] });
      const writePin = (tag: string) => writeFileSync(join(dir, "README.md"), `# Fixture\n\n> **On pinning:** \`git checkout ${tag}\` pins your clone to this release.\n\n## Next\n`);
      git("init", "-q", "-b", "main");
      writePin("v0.2.0");
      git("add", "README.md"); git("commit", "-q", "-m", "wrong pin");
      git("tag", "v0.3.0");
      expect(pinMismatchAtHead(dir)).toEqual({ pin: "v0.2.0", tag: "v0.3.0" });
      writePin("v0.3.0");
      git("commit", "-q", "-am", "right pin");
      git("tag", "-f", "v0.3.0");
      expect(pinMismatchAtHead(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(realTagRefs()).toBe(realTagsBefore);
  });

  it("never names a version older than the last tag `git describe` resolves from HEAD", (ctx) => {
    if (tag === null) {
      if (process.env.CI) {
        throw new Error("CI checkout has no reachable tag; fetch full history and tags before running this check");
      }
      ctx.skip(
        "no git tag reachable from HEAD (git describe --tags failed) — possible in a local shallow " +
          "clone with no tags fetched; nothing to compare README's pinning example against",
      );
      return;
    }
    expect(compareVersions(pinnedTag(), tag), `README names ${pinnedTag()}, older than the last tag ${tag}`).toBeGreaterThanOrEqual(0);
  });

  it("states the same engines.node range in the Install section as package.json declares", () => {
    const pkg = JSON.parse(readRepoFile("package.json")) as { engines?: { node?: string } };
    const enginesNode = pkg.engines?.node;
    expect(enginesNode, "package.json must declare engines.node").toBeTruthy();
    const readme = readRepoFile("README.md");
    // Scoped to the Install section specifically (round-3 review: an earlier version of this
    // test scanned the whole README while its own failure message claimed to check only the
    // Install section) — everything between the "## Install" and "## Quickstart" headings.
    const installSection = readme.match(/^## Install\n[\s\S]*?(?=\n## Quickstart)/m);
    expect(installSection, "README must have an '## Install' section followed by '## Quickstart'").not.toBeNull();
    // The Install section states the range in bold backticks, e.g. **`^20.19.0 || ^22.12.0 ||
    // >=24.0.0`**. Escape the range for literal matching (it contains regex metacharacters:
    // `^`, `|`, `.`).
    const escaped = enginesNode!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp("`" + escaped + "`");
    expect(
      pattern.test(installSection![0]),
      `README's Install section must state the literal range "${enginesNode}" verbatim ` +
        `(found in package.json's engines.node) — it must be updated whenever engines.node changes`,
    ).toBe(true);
  });
});
