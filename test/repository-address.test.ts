import { describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { checkForUpdate } from "../src/update-check.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("PAR-1050: one repository address", () => {
  it("PAR-1050: tracked files reject the old repository address outside the constant and historical logs", () => {
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("package.json");
    expect(files).toContain("src/update-check.ts");
    const historical = new Set(["docs/decisions.md", "CHANGELOG.md"]);
    // Assemble the rejected value so this guard does not plant its own forbidden address.
    const oldAddress = ["BlackRaptorAI", "VibeCTX"].join("/");
    const offenders = files.filter((file) => {
      if (historical.has(file)) return false;
      const content = readFileSync(join(ROOT, file)).toString();
      const checked = file === "src/repository.js"
        ? content.replace(/^export const REPO_SLUG = "[^"\n]*";$/m, "") : content;
      return checked.includes(oldAddress);
    });
    expect(offenders, "all live repository addresses must use the Labs organization").toEqual([]);
  });

  it("PAR-1050: the update check calls the Labs releases API and links its release", async () => {
    const request = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ tag_name: "v0.3.0" })));
    const notes: string[] = [];
    await checkForUpdate({ enabled: true, currentVersion: "0.2.0", request, notify: (line) => notes.push(line) });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe("https://api.github.com/repos/BlackRaptorAI-Labs/VibeCTX/releases/latest");
    expect(notes).toEqual(["update available: v0.2.0 → v0.3.0 — https://github.com/BlackRaptorAI-Labs/VibeCTX/releases/tag/v0.3.0\n"]);
  });

  it("PAR-1050: explicit metadata maintenance derives static links from the one slug and preserves attribution", () => {
    const dir = mkdtempSync(join(tmpdir(), "vibectx-address-"));
    try {
      mkdirSync(join(dir, "src"));
      mkdirSync(join(dir, "scripts"));
      const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
      writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
      const previous = manifest.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");
      const byline = readFileSync(join(ROOT, "README.md"), "utf8").split(/\r?\n/).find((line) => line.startsWith("By "));
      expect(byline).toContain("https://github.com/BlackRaptorAI");
      for (const name of ["README.md", "CONTRIBUTING.md"]) {
        writeFileSync(join(dir, name), `${byline}\ngit clone ${previous}.git\n${previous}/issues\n`);
      }
      copyFileSync(join(ROOT, "scripts/sync-repository.mjs"), join(dir, "scripts/sync-repository.mjs"));
      // Change only the copied canonical slug, then run the actual generator.
      writeFileSync(join(dir, "src/repository.js"), readFileSync(join(ROOT, "src/repository.js"), "utf8")
        .replace(/export const REPO_SLUG = .*;/, 'export const REPO_SLUG = "fixture-org/fixture-repo";'));
      execFileSync(process.execPath, [join(dir, "scripts/sync-repository.mjs"), "--write"]);
      const updated = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      expect(updated).toEqual({ ...manifest, repository: { ...manifest.repository, url: "git+https://github.com/fixture-org/fixture-repo.git" } });
      for (const name of ["README.md", "CONTRIBUTING.md"]) {
        expect(readFileSync(join(dir, name), "utf8")).toBe(`${byline}\ngit clone https://github.com/fixture-org/fixture-repo.git\nhttps://github.com/fixture-org/fixture-repo/issues\n`);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("PAR-1050: the actual metrics script requests the shared repository with its derived User-Agent", () => {
    const dir = mkdtempSync(join(tmpdir(), "vibectx-metrics-address-"));
    try {
      const capture = join(dir, "request.json");
      const preload = join(dir, "stub.mjs");
      writeFileSync(preload, `import { writeFileSync } from "node:fs";
globalThis.fetch = async (url, init) => {
  writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ url, headers: init.headers }));
  return new Response(JSON.stringify({ open_issues_count: 3, stargazers_count: 5, forks_count: 7 }));
};\n`);
      const output = execFileSync(process.execPath, ["--import", preload, join(ROOT, "scripts/metrics.mjs")], { encoding: "utf8" });
      expect(JSON.parse(readFileSync(capture, "utf8"))).toEqual({
        url: "https://api.github.com/repos/BlackRaptorAI-Labs/VibeCTX",
        headers: { "user-agent": "vibectx-metrics (+https://github.com/BlackRaptorAI-Labs/VibeCTX)", accept: "application/json" },
      });
      expect(output).toContain("All 3 figures were retrieved live just now.");
      expect(output).toMatch(/open issues\s+3/);
      expect(output).toMatch(/stars\s+5/);
      expect(output).toMatch(/forks\s+7/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("PAR-1050: the default repository check rejects drift without writing any file", () => {
    const dir = mkdtempSync(join(tmpdir(), "vibectx-address-check-"));
    try {
      mkdirSync(join(dir, "src"));
      mkdirSync(join(dir, "scripts"));
      copyFileSync(join(ROOT, "package.json"), join(dir, "package.json"));
      for (const name of ["README.md", "CONTRIBUTING.md"]) copyFileSync(join(ROOT, name), join(dir, name));
      copyFileSync(join(ROOT, "scripts/sync-repository.mjs"), join(dir, "scripts/sync-repository.mjs"));
      writeFileSync(join(dir, "src/repository.js"), readFileSync(join(ROOT, "src/repository.js"), "utf8")
        .replace(/export const REPO_SLUG = .*;/, 'export const REPO_SLUG = "fixture-org/fixture-repo";'));
      const files = ["package.json", "README.md", "CONTRIBUTING.md", "src/repository.js"];
      const before = files.map((file) => readFileSync(join(dir, file)));
      const checked = spawnSync(process.execPath, [join(dir, "scripts/sync-repository.mjs")], { encoding: "utf8" });
      expect(checked.status).toBe(1);
      for (const [index, file] of files.entries()) expect(readFileSync(join(dir, file))).toEqual(before[index]);
      execFileSync(process.execPath, [join(dir, "scripts/sync-repository.mjs"), "--write"]);
      const generated = files.map((file) => readFileSync(join(dir, file)));
      expect(spawnSync(process.execPath, [join(dir, "scripts/sync-repository.mjs"), "--check"]).status).toBe(0);
      for (const [index, file] of files.entries()) expect(readFileSync(join(dir, file))).toEqual(generated[index]);
      // A stale document must fail even when package metadata is already canonical.
      const readmePath = join(dir, "README.md");
      const drifted = readFileSync(readmePath, "utf8").replaceAll("https://github.com/fixture-org/fixture-repo", "https://github.com/stale-org/fixture-repo");
      writeFileSync(readmePath, drifted);
      expect(spawnSync(process.execPath, [join(dir, "scripts/sync-repository.mjs"), "--check"]).status).toBe(1);
      expect(readFileSync(readmePath, "utf8")).toBe(drifted);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
