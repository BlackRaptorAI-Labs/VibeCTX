import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// PAR-1037: the release checklist's commands are the control, so the ones the final audit found
// missing or too narrow are pinned here (M-6, L-18, X-2, M-8).
const releasing = (): string => readFileSync(new URL("../RELEASING.md", import.meta.url), "utf8");
const section = (heading: string): string => {
  const text = releasing();
  const start = text.indexOf(heading);
  expect(start, `RELEASING.md must have "${heading}"`).toBeGreaterThanOrEqual(0);
  const next = text.slice(start + heading.length).search(/\n#{2,3} /);
  return next === -1 ? text.slice(start) : text.slice(start, start + heading.length + next);
};

it("PAR-1037 (L-18): the stalled-branch detector checks every remote branch except main, not only par-*", () => {
  const step = section("### 2a. Find stalled branches");
  expect(step).toContain("git branch -r --format='%(refname:lstrip=3)' | grep -v -x -e HEAD -e main");
  expect(step).toContain("gh pr list --state all --limit 1000 --json headRefName");
  expect(step).not.toMatch(/--list 'origin\/par-\*'/);
});

it("PAR-1037 (M-6): a GitHub Release is created from the existing tag and /releases/latest is checked", () => {
  const step = section("## 7. Publish the GitHub Release");
  expect(step).toContain("gh release create v<version> --verify-tag");
  expect(step).toContain("gh api repos/<owner>/<repo>/releases/latest --jq .tag_name");
});

it("PAR-1037 (X-2, M-8): the public repository is built from the tag, committed as a noreply identity, and its file list checked", () => {
  const step = section("## 8. Build the public repository from the tag");
  expect(step).toContain("git -C <source> archive --format=tar v<version> | tar -x -C <fresh>");
  expect(step).toContain('user.email="<id>+<github-login>@users.noreply.github.com"');
  expect(step).toContain("diff <(git -C <fresh> ls-files | sort) <(git -C <source> ls-tree -r --name-only v<version> | sort)");
  expect(step).toContain("gh api repos/<owner>/<old-repo>/forks");
});
