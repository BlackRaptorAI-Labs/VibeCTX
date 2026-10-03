import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const tracked = (): string[] => execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0").filter(Boolean);
const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const citedPaths = (paths: string[]): string[] => paths.filter((path) =>
  /^(src\/|test\/|docs\/|scripts\/|\.github\/|README\.md$|CONTRIBUTING\.md$|RELEASING\.md$)/.test(path));

function proseLines(markdown: string): string[] {
  let fence: { marker: string; size: number } | undefined;
  return markdown.split(/\r?\n/).map((line) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = { marker: marker[1][0], size: marker[1].length };
      else if (marker[1][0] === fence.marker && marker[1].length >= fence.size) fence = undefined;
      return "";
    }
    return fence ? "" : line;
  });
}

function anchorIds(markdown: string): Set<string> {
  const ids = new Set<string>();
  for (const line of proseLines(markdown)) {
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (!heading) continue;
    const slug = heading[1].toLowerCase().replace(/<[^>]*>/g, "")
      .replace(/[`*_~]/g, "").replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim().replace(/\s/g, "-");
    ids.add(slug);
  }
  return ids;
}

describe("public documentation references", () => {
  it("resolves every relative Markdown link outside fenced code to a tracked file", () => {
    const paths = tracked();
    const files = new Set(paths);
    const missing: string[] = [];
    for (const path of paths.filter((name) => name.endsWith(".md"))) {
      for (const [index, line] of proseLines(read(path)).entries()) {
        for (const match of line.matchAll(/\]\(([^)]+)\)/g)) {
          const raw = match[1].trim();
          const destination = raw.startsWith("<") ? raw.slice(1, raw.indexOf(">")) : raw.split(/\s+"/)[0];
          if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(destination)) continue;
          const target = decodeURIComponent(destination.split("#")[0]);
          const resolved = posix.normalize(posix.join(posix.dirname(path), target));
          if (!files.has(resolved)) missing.push(`${path}:${index + 1} -> ${destination}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("resolves anchors into the two public decision and limitation documents", () => {
    const targets = ["docs/decisions.md", "docs/known-limitations.md"];
    const ids = new Map(targets.map((path) => [path, anchorIds(read(path))]));
    const missing: string[] = [];
    for (const path of tracked().filter((name) => name.endsWith(".md"))) {
      for (const [index, line] of proseLines(read(path)).entries()) {
        for (const match of line.matchAll(/\]\(([^)]+)\)/g)) {
          const destination = match[1].trim().replace(/^<|>$/g, "").split(/\s+"/)[0];
          const [file, fragment] = destination.split("#");
          if (!fragment) continue;
          const resolved = posix.normalize(posix.join(posix.dirname(path), file));
          if (ids.has(resolved) && !ids.get(resolved)!.has(decodeURIComponent(fragment))) {
            missing.push(`${path}:${index + 1} -> ${destination}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("resolves every decision citation to a decision heading or bold lead", () => {
    const entries = new Set([...read("docs/decisions.md").matchAll(/(?:^## D-|\*\*D-)(\d{2,}[a-z]?)/gm)]
      .map((match) => `D-${match[1]}`));
    const missing = new Set<string>();
    for (const path of citedPaths(tracked())) {
      for (const line of read(path).split(/\r?\n/)) {
        // This exact header declares the next unused number; it is not a citation.
        if (path === "docs/decisions.md" && /^Numbering continues at D-\d{2,}\.$/.test(line)) continue;
        for (const match of line.matchAll(/\bD-\d{2,}[a-z]?\b/g)) {
          if (!entries.has(match[0])) missing.add(match[0]);
        }
      }
    }
    expect([...missing].sort()).toEqual([]);
  });

  it("does not cite an unpublished decision stub from source or tests", () => {
    const stubs = new Set<string>();
    let heading: string | undefined;
    for (const line of read("docs/decisions.md").split(/\r?\n/)) {
      heading = line.match(/^## (D-\d{2,}[a-z]?)\b/)?.[1] ?? heading;
      const row = line.match(/^\| \*\*(D-\d{2,}[a-z]?)\*\* \|/);
      const lead = line.match(/^- \*\*(D-\d{2,}[a-z]?)\*\*/);
      const stub = "Internal development-process decision; not published.";
      if ((row || lead) ? line.includes(stub) : line.trim() === stub) {
        const id = row?.[1] ?? lead?.[1] ?? heading;
        if (id) stubs.add(id);
      }
    }
    const citations: string[] = [];
    for (const path of tracked().filter((name) => /^(src|test|scripts)\//.test(name))) {
      for (const [index, line] of read(path).split(/\r?\n/).entries()) {
        for (const match of line.matchAll(/\bD-\d{2,}[a-z]?\b/g)) {
          if (stubs.has(match[0])) citations.push(`${path}:${index + 1} -> ${match[0]}`);
        }
      }
    }
    expect(citations).toEqual([]);
  });

  it("resolves every two-digit limitation citation to a register row", () => {
    const entries = new Set([...read("docs/known-limitations.md").matchAll(/^\| (B-\d{2}) \|/gm)]
      .map((match) => match[1]));
    const missing = new Set<string>();
    for (const path of citedPaths(tracked())) {
      for (const match of read(path).matchAll(/\bB-\d{2}\b/g)) {
        if (!entries.has(match[0])) missing.add(match[0]);
      }
    }
    expect([...missing].sort()).toEqual([]);
  });
});
