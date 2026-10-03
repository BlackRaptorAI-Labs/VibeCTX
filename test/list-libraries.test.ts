import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCache, urlSlug, libDirName, resetCacheRootState } from "../src/cache.js";
import { loadRegistry, loadRegistryFrom, type Registry } from "../src/registry.js";
import { listLibrariesText } from "../src/list-libraries.js";
import { saveDoctorVerdicts } from "../src/doctor-store.js";

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "vibectx-list-")));
  process.env.VIBECTX_CACHE_DIR = dir;
});

afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const registry: Registry = {
  entries: new Map([
    [
      "fastify",
      { name: "fastify", urls: ["https://fastify.dev/llms-full.txt", "https://fastify.dev/llms.txt"], description: "Fastify web framework reference" },
    ],
    ["react", { name: "react", urls: ["https://react.dev/llms-full.txt"], description: "React 19 documentation", ttlHours: 0 }],
    ["pgvector", { name: "pgvector", urls: ["https://raw.githubusercontent.com/pgvector/pgvector/master/README.md"] }],
  ]),
};

describe("listLibrariesText (PAR-707: kind bracket)", () => {
  it("PAR-861 red-first: refused cache root is explicit but its path is redacted for the model", () => {
    const target = join(dir, "actual");
    const refused = join(dir, "refused-root");
    mkdirSync(target);
    symlinkSync(target, refused);
    process.env.VIBECTX_CACHE_DIR = refused;
    resetCacheRootState();
    const text = listLibrariesText({ entries: new Map() });
    expect(text).toMatch(/Cache dir:.*refused.*symlink/i);
    expect(text).not.toContain(refused);
    expect(text).toContain("list_libraries failed in cache (CacheError");
    expect(text).toContain("vibectx report-bug");
  });
  it("adds a kind bracket after the cache-status bracket, classified from the cached document", () => {
    writeCache("fastify", "https://fastify.dev/llms.txt", "# Fastify\n- [A](/docs/A.md)\n- [B](/docs/B.md)\n- [C](/docs/C.md)");
    writeCache("react", "https://react.dev/llms-full.txt", "# React\n\nProse about hooks.\n\n## useEffect\n\nEffects.");
    const text = listLibrariesText(registry);
    expect(text.startsWith("Cache dir: [redacted]\n\n")).toBe(true);
    expect(text).toMatch(/- \*\*fastify\*\* — Fastify web framework reference \[cached \S+\] \[index-only\]/);
    expect(text).toMatch(/- \*\*react\*\* — React 19 documentation \[cached \S+ \(stale\)\] \[full-text\]/);
    expect(text).toMatch(/- \*\*pgvector\*\* —  \[not cached\] \[unknown\]/);
  });

  it("shows aliases briefly after the name, and nothing extra for entries without them (PAR-654)", () => {
    const withAliases: Registry = {
      entries: new Map([
        ["next.js", { name: "next.js", urls: ["https://nextjs.org/llms.txt"], description: "Next.js", aliases: ["next", "nextjs"] }],
        ["hono", { name: "hono", urls: ["https://hono.dev/llms.txt"], description: "Hono", aliases: [] }],
        ["zod", { name: "zod", urls: ["https://zod.dev/llms.txt"], description: "Zod" }],
      ]),
    };
    const text = listLibrariesText(withAliases);
    expect(text).toMatch(/- \*\*next\.js\*\* \(aka next, nextjs\) — Next\.js \[not cached\] \[unknown\]/);
    expect(text).toMatch(/- \*\*hono\*\* — Hono \[not cached\]/);
    expect(text).toMatch(/- \*\*zod\*\* — Zod \[not cached\]/);
    expect(text).not.toMatch(/hono\*\* \(aka/);
  });

  it("D-06: after a config claims a default alias as its name, that alias leaves the default's aka list", () => {
    const config = join(dir, "vibectx.config.json");
    writeFileSync(config, JSON.stringify({ libraries: [{ name: "next", urls: ["https://example.com/next.txt"] }] }), "utf8");
    const text = listLibrariesText(loadRegistry(config));
    expect(text).toMatch(/- \*\*next\.js\*\* \(aka nextjs\) — /);
    expect(text).not.toMatch(/aka next,/);
    expect(text).toMatch(/- \*\*next\*\* —  \[not cached\]/);
  });

  it("uses the first cached candidate URL for the classification", () => {
    writeCache("fastify", "https://fastify.dev/llms-full.txt", "# Fastify\n\nFull prose reference.\n\n## Server\n\nOptions.");
    writeCache("fastify", "https://fastify.dev/llms.txt", "# Fastify\n- [A](/docs/A.md)\n- [B](/docs/B.md)\n- [C](/docs/C.md)");
    expect(listLibrariesText(registry)).toMatch(/\*\*fastify\*\*.*\[full-text\]/);
  });

  it("marks resolved entries with [resolved] after the kind bracket (PAR-655)", () => {
    const withResolved: Registry = {
      entries: new Map([
        ["zod", { name: "zod", urls: ["https://zod.dev/llms.txt"], description: "Zod" }],
        [
          "elysia",
          {
            name: "elysia",
            urls: ["https://elysiajs.com/llms.txt"],
            description: "Ergonomic framework",
            resolved: { source: "npm", resolvedAt: "2026-09-06T00:00:00.000Z", metadataUrl: "https://registry.npmjs.org/elysia/latest" },
          },
        ],
      ]),
    };
    const text = listLibrariesText(withResolved);
    expect(text).toMatch(/- \*\*zod\*\* — Zod \[not cached\] \[unknown\]$/m);
    expect(text).toMatch(/- \*\*elysia\*\* — \(package-supplied\) Ergonomic framework \[not cached\] \[unknown\] \[resolved\]$/m);
  });
});

import { writeProjectRecord } from "../src/project-store.js";

describe("listLibrariesText (PAR-656: warming… marker and project line)", () => {
  it("appends warming… inside the status bracket for entries the startup autowarm has in flight", () => {
    writeCache("react", "https://react.dev/llms-full.txt", "# React\n\nProse.");
    const text = listLibrariesText(registry, { warming: new Set(["react", "pgvector"]), projectDir: dir });
    expect(text).toMatch(/- \*\*react\*\* — React 19 documentation \[cached \S+ \(stale\), warming…\] \[full-text\]/);
    expect(text).toMatch(/- \*\*pgvector\*\* —  \[not cached, warming…\] \[unknown\]/);
    expect(text).toMatch(/- \*\*fastify\*\* — Fastify web framework reference \[not cached\] \[unknown\]/);
  });

  it("ends with one project-deps line when a warm record exists for the working directory, and with nothing extra otherwise", () => {
    const without = listLibrariesText(registry, { projectDir: dir, warming: new Set() });
    expect(without).not.toContain("Project deps");
    writeProjectRecord({
      schemaVersion: 1,
      dir,
      manifests: ["package.json"],
      dependencies: [
        { name: "react", ecosystem: "npm", source: "package.json", library: "react", status: "cached", url: "https://react.dev/llms-full.txt" },
        { name: "zz", ecosystem: "npm", source: "package.json", status: "unresolved" },
        { name: "eslint", ecosystem: "npm", source: "package.json", status: "denied (noise list)" },
      ],
      warmedAt: "2026-09-06T06:00:00.000Z",
    });
    const text = listLibrariesText(registry, { projectDir: dir, warming: new Set() });
    const lines = text.split("\n");
    expect(lines[lines.length - 1]).toBe("Project deps ([redacted]): 1 cached, 1 unresolved, 1 denied — warmed 2026-09-06T06:00:00.000Z");
    expect(lines[lines.length - 2]).toBe("");
    expect(text.match(/Project deps/g)).toHaveLength(1);
  });

  it("defaults to process.cwd() for the project line and the live autowarm set for the marker", () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(dir);
    try {
      writeProjectRecord({ schemaVersion: 1, dir, manifests: ["package.json"], dependencies: [], warmedAt: "2026-09-06T06:00:00.000Z" });
      expect(listLibrariesText(registry)).toContain("Project deps ([redacted]): 0 cached, 0 unresolved, 0 denied");
    } finally {
      cwd.mockRestore();
    }
  });
});

describe("listLibrariesText: the config header (D-18, PAR-657)", () => {
  const oneLibrary = (name: string): string => {
    const path = join(dir, `${name}.json`);
    writeFileSync(path, JSON.stringify({ libraries: [{ name, urls: [`https://${name}.example.com/llms.txt`] }] }), "utf8");
    return path;
  };

  it("PAR-989: model-visible config header omits an absolute config path", () => {
    const path = oneLibrary("private-config");
    const reg = loadRegistryFrom({ files: [{ path, scope: "env", legacy: false }], notes: [] });
    const out = listLibrariesText(reg, { cwd: join(dir, "other-project"), home: join(dir, "other-home") });
    expect(out).toContain("VIBECTX_CONFIG=");
    expect(out).not.toContain(path);
  });

  it("PAR-989: model-visible config notes omit path-bearing diagnostics", () => {
    const path = oneLibrary("private-notes");
    const reg = loadRegistryFrom({ files: [{ path, scope: "env", legacy: false }], notes: [`could not read ${path}`] });
    const out = listLibrariesText(reg, { cwd: join(dir, "other-project"), home: join(dir, "other-home") });
    expect(out).toContain("config note: inspect terminal diagnostics");
    expect(out).not.toContain(path);
  });

  it("says `none (shipped defaults)` when no config was loaded, before the cache dir", () => {
    const text = listLibrariesText(loadRegistry(), { cwd: dir, home: dir });
    expect(text.split("\n").slice(0, 2)).toEqual(["config: none (shipped defaults)", "Cache dir: [redacted]"]);
  });

  it("names an explicit --config source without its personal path", () => {
    const path = oneLibrary("acme");
    const text = listLibrariesText(loadRegistry(path), { cwd: dir, home: dir });
    expect(text.split("\n")[0]).toBe("config: --config [redacted]");
    expect(text).toMatch(/- \*\*acme\*\*/);
  });

  it("names project and user config scopes, highest precedence first, without paths", () => {
    const project = oneLibrary("team");
    const user = oneLibrary("personal");
    const registry = loadRegistryFrom({
      files: [
        { path: user, scope: "user", legacy: false },
        { path: project, scope: "project", legacy: false },
      ],
      notes: ["./docs-cache.config.json is deprecated: rename it to vibectx.config.json"],
    });
    const lines = listLibrariesText(registry, { cwd: dir, home: dir }).split("\n");
    expect(lines[0]).toBe("config: [redacted] (project) · [redacted] (user)");
    expect(lines[1]).toBe("config note: inspect terminal diagnostics");
    expect(lines[2]).toBe("Cache dir: [redacted]");
  });

  it("names an env source", () => {
    const path = oneLibrary("env-team");
    const registry = loadRegistryFrom({ files: [{ path, scope: "env", legacy: false }], notes: [] });
    expect(listLibrariesText(registry, { cwd: dir, home: dir }).split("\n")[0]).toBe("config: VIBECTX_CONFIG=[redacted]");
  });

  it("S2: config-supplied name, aliases and description are cleaned before they are rendered", () => {
    // A committed config is a file the reader may not have written; a terminal escape or a
    // bidi override in it must not survive into the tool's answer.
    const path = join(dir, "nasty.json");
    writeFileSync(
      path,
      JSON.stringify({
        libraries: [
          {
            name: "acme\u001b[31m",
            aliases: ["acme\u200bjs"],
            urls: ["https://docs.acme.example.com/llms.txt"],
            description: "Acme\u001b[2J\u202e platform\u200b docs",
          },
        ],
      }),
      "utf8",
    );
    const text = listLibrariesText(loadRegistry(path), { cwd: dir, home: dir });
    // (newlines excepted: the output is a list)
    expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/);
    expect(text).toMatch(/- \*\*acme\[31m\*\* \(aka acmejs\) — Acme\[2J platform docs/);
  });

  it("S2: an over-long config-supplied name, alias or description is clipped, not printed whole", () => {
    // Cleaning alone leaves length: a config can carry a 5 KB `description`, and one entry
    // must not be able to bury the other twenty-nine rows of the answer.
    const path = join(dir, "long.json");
    writeFileSync(
      path,
      JSON.stringify({
        libraries: [
          {
            name: `n${"a".repeat(5300)}`,
            aliases: [`x${"b".repeat(5300)}`],
            urls: ["https://docs.acme.example.com/llms.txt"],
            description: `d${"c".repeat(5300)}`,
          },
        ],
      }),
      "utf8",
    );
    const line = listLibrariesText(loadRegistry(path), { cwd: dir, home: dir })
      .split("\n")
      .find((l) => l.startsWith("- **naa")); // not `next.js`, which the defaults also supply
    expect(line).toBeDefined();
    for (const field of [/^- \*\*([^*]+)\*\*/, /\(aka ([^)]+)\)/, /— ([^[]+) \[/]) {
      const shown = field.exec(line!)?.[1];
      expect(shown, String(field)).toBeDefined();
      expect(shown!.length, shown!.slice(0, 12)).toBeLessThanOrEqual(200);
      expect(shown!.endsWith("…"), shown!.slice(0, 12)).toBe(true); // clipped, and it says so
    }
  });

  it("omits the header for a hand-built registry (no config resolution to report)", () => {
    expect(listLibrariesText(registry).startsWith("Cache dir: [redacted]\n\n")).toBe(true);
  });
});

describe("A19/PAR-728: doctor's verdict surfaced in list_libraries", () => {
  it("PAR-704 shape: an entry doctor found unhealthy (index-only, probe failing) is marked, even though the cache shows it as cleanly cached", () => {
    writeCache("fastify", "https://fastify.dev/llms.txt", "# Fastify\n- [A](/docs/A.md)\n- [B](/docs/B.md)\n- [C](/docs/C.md)");
    saveDoctorVerdicts([
      {
        name: "fastify",
        kind: "index-only",
        healthy: false,
        reasons: ["index-only, no links followed (answered from the link list at best)"],
        checkedAt: "2026-09-17T00:00:00.000Z",
      },
    ]);
    const text = listLibrariesText(registry);
    expect(text).toMatch(
      /- \*\*fastify\*\* — Fastify web framework reference \[cached \S+\] \[index-only\] \[doctor: check failed \(index-only\), checked 2026-09-17T00:00:00\.000Z\]/,
    );
  });

  it("says nothing extra for a library doctor found healthy, or one doctor has never checked", () => {
    saveDoctorVerdicts([{ name: "react", kind: "full-text", healthy: true, reasons: [], checkedAt: "2026-09-17T00:00:00.000Z" }]);
    writeCache("react", "https://react.dev/llms-full.txt", "# React\n\nProse.");
    const text = listLibrariesText(registry);
    expect(text).toMatch(/- \*\*react\*\* — React 19 documentation \[cached \S+ \(stale\)\] \[full-text\]$/m);
    expect(text).toMatch(/- \*\*pgvector\*\* —  \[not cached\] \[unknown\]$/m); // no verdict at all: no note
    expect(text).not.toContain("[doctor:");
  });

  it("security-architect S-1: never renders doctor's free-text reasons, even a hostile one — only the closed kind enum and the check date", () => {
    // The persisted store is process-global; `reasons` can carry config-authored probeQuery
    // text or a raw error message from a DIFFERENT project's own doctor run. list_libraries
    // must never repeat that text, regardless of what it says.
    writeCache("fastify", "https://fastify.dev/llms.txt", "# Fastify\n- [A](/docs/A.md)");
    saveDoctorVerdicts([
      {
        name: "fastify",
        kind: "index-only",
        healthy: false,
        reasons: ["some other project's secret internal hostname: internal.example.corp"],
        checkedAt: "2026-09-17T00:00:00.000Z",
      },
    ]);
    const text = listLibrariesText(registry);
    expect(text).not.toContain("internal.example.corp");
    expect(text).not.toContain("some other project's");
    expect(text).toMatch(/\[doctor: check failed \(index-only\), checked 2026-09-17T00:00:00\.000Z\]/);
  });
});

describe("A4 (PAR-717) — a corrupt .meta.json no longer crashes list_libraries", () => {
  it("reports the entry not cached instead of throwing (audit finding 4.5: list-libraries.ts:37 was unguarded and untested)", () => {
    const url = "https://fastify.dev/llms.txt";
    writeCache("fastify", url, "# Fastify\n- [A](/docs/A.md)");
    const metaPath = join(dir, libDirName("fastify"), `${urlSlug(url)}.meta.json`);
    writeFileSync(metaPath, "{ not json", "utf8");
    let text = "";
    expect(() => {
      text = listLibrariesText(registry);
    }).not.toThrow();
    expect(text).toMatch(/- \*\*fastify\*\* — Fastify web framework reference \[not cached\] \[unknown\]/);
  });
});
