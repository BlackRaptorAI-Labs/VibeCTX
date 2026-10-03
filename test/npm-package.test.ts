import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Decision 23: 0.3.0 ships on npm as well as from source. The published tarball holds only what
// the server needs to run: package.json, README, LICENSE, the compiled JavaScript, and the
// audited runtime dependency tree bundled byte-exact (bundleDependencies, 0.1.1).
const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name: string; private?: boolean; files?: string[]; bin?: Record<string, string>;
  dependencies?: Record<string, string>; bundleDependencies?: string[];
};
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as {
  packages: Record<string, { dev?: boolean; optional?: boolean }>;
};

it("decision 23: package.json is publishable as @blackraptorai/vibectx with a compiled-JavaScript whitelist", () => {
  expect(pkg.name).toBe("@blackraptorai/vibectx");
  expect(pkg.private).toBeUndefined();
  expect(pkg.files).toEqual(["dist/**/*.js"]);
  expect(pkg.bin).toEqual({ vibectx: "dist/index.js" });
  expect([...(pkg.bundleDependencies ?? [])].sort()).toEqual(Object.keys(pkg.dependencies ?? {}).sort());
});

// Listed once while the file loads, outside the timed test: under full-suite load `npm pack`
// can take longer than a test's default budget. The subprocess keeps its own 60 s limit. It runs
// the real prepack (the repository-link check), as publish does.
const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 60_000, stdio: ["ignore", "pipe", "pipe"],
})) as { name: string; files: { path: string }[] }[];

it("decision 23: npm pack lists only package metadata, docs, compiled JavaScript and the bundled runtime tree", () => {
  expect(packed).toHaveLength(1);
  expect(packed[0]!.name).toBe("@blackraptorai/vibectx");
  const paths = packed[0]!.files.map((file) => file.path);

  // Runtime packages only: lockfile entries that are neither dev nor dev-optional.
  const runtime = new Set(Object.entries(lock.packages)
    .filter(([path, entry]) => path.startsWith("node_modules/") && entry.dev !== true)
    .map(([path]) => path));
  const owner = (path: string) => {
    const parts = path.split("/");
    let found: string | undefined;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] !== "node_modules") continue;
      const scoped = parts[i + 1]?.startsWith("@");
      const end = i + (scoped ? 3 : 2);
      found = parts.slice(0, end).join("/");
    }
    return found;
  };

  const unexpected = paths.filter((path) => {
    if (path === "package.json" || path === "README.md" || path === "LICENSE") return false;
    if (/^dist\/[^/]+\.js$/.test(path)) return false;
    if (path.startsWith("node_modules/")) return !runtime.has(owner(path) ?? "");
    return true;
  });
  expect(unexpected, "every packed path must be intended").toEqual([]);
  for (const forbidden of [/^test\//, /^src\//, /^docs\//, /^scripts\//, /^verification\//, /\.map$/, /\.d\.ts$/, /\.tgz$/, /(^|\/)\.env/, /AUDIT/i, /^\.vibectx/]) {
    expect(paths.filter((path) => !path.startsWith("node_modules/") && forbidden.test(path)), String(forbidden)).toEqual([]);
  }
  for (const required of ["package.json", "README.md", "LICENSE", "node_modules/@modelcontextprotocol/sdk/package.json", "node_modules/zod/package.json"]) {
    expect(paths, required).toContain(required);
  }
  // dist/ is a build output; when it exists, the entry point must be in the tarball.
  if (existsSync(join(root, "dist/index.js"))) expect(paths).toContain("dist/index.js");
});

it("decision 23: the published package declares no install-time scripts (npm would warn about them on every install)", () => {
  const scripts = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
  expect(Object.keys(scripts).filter((name) => ["preinstall", "install", "postinstall", "prepare"].includes(name))).toEqual([]);
  // The repository-link check still runs before every build, pack and publish (PAR-1050).
  for (const hook of ["prebuild", "prepack"]) expect(scripts[hook], hook).toBe("npm run repository:check");
  expect(scripts.prepublishOnly).toContain("npm run repository:check");
});

// Decision 24: the bundled dependency tree ships exactly as upstream published it, including any
// test files those packages publish. VibeCTX's own entries (everything outside node_modules/) must
// contain no tests, fixtures, notes or local data. The exemption is node_modules/ only.
it("decision 24: VibeCTX's own pack entries (outside node_modules/) contain no tests, fixtures, notes or local data", () => {
  const own = packed[0]!.files.map((file) => file.path).filter((path) => !path.startsWith("node_modules/"));
  expect(own.length).toBeGreaterThan(3);
  const disallowed = [
    /(^|\/)(tests?|__tests__|fixtures?|spec|__mocks__|coverage)(\/|$)/i, // test and fixture folders
    /\.(test|spec)\.[^/]+$/i, // test files
    /(^|\/)(docs|verification|notes?)(\/|$)|(^|\/)\.[^/]+\//i, // notes folders and any hidden folder
    /(^|\/)[^/]*(notes?|audit|report|draft|todo)[^/]*\.(md|txt)$/i, // note-like documents
    /(^|\/)(\.vibectx|\.docs-cache-mcp)(\/|$)|(^|\/)(activity(-\d+)?|consent|resolved)\.json$|\.(log|tgz|sqlite|db)$|(^|\/)\.(env|npmrc)/i, // local data and secrets
  ];
  expect(own.filter((path) => disallowed.some((pattern) => pattern.test(path)))).toEqual([]);
});
