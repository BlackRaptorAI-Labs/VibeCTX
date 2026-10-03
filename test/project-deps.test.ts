import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import {
  DEPENDENCY_DENYLIST,
  isDeniedDependency,
  parsePackageJsonDeps,
  parsePackageJsonVersions,
  parsePyprojectDeps,
  parsePyprojectVersions,
  parseRequirementsTxt,
  parsePackageLockDeps,
  parsePnpmLockDeps,
  requirementName,
  requirementVersion,
  requirementVersionRejection,
  discoverProjectDependencies,
  MANIFEST_MAX_BYTES,
  cleanText,
} from "../src/project-deps.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibectx-deps-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): void {
  writeFileSync(join(dir, name), content, "utf8");
}

describe("DEPENDENCY_DENYLIST / isDeniedDependency (PAR-656)", () => {
  it("is an exported, documented constant with an npm and a pypi list", () => {
    expect(Object.keys(DEPENDENCY_DENYLIST).sort()).toEqual(["npm", "pypi"]);
    expect(DEPENDENCY_DENYLIST.npm).toContain("@types/*");
    expect(DEPENDENCY_DENYLIST.pypi).toContain("pip");
  });

  it.each([
    ["@types/node", "npm"],
    ["@types/react", "npm"],
    ["eslint", "npm"],
    ["eslint-config-next", "npm"],
    ["@eslint/eslintrc", "npm"],
    ["prettier", "npm"],
    ["prettier-plugin-tailwindcss", "npm"],
    ["@typescript-eslint/parser", "npm"],
    ["tslib", "npm"],
    ["@babel/core", "npm"],
    ["postcss", "npm"],
    ["autoprefixer", "npm"],
    ["husky", "npm"],
    ["lint-staged", "npm"],
    ["setuptools", "pypi"],
    ["setuptools-scm", "pypi"],
    ["wheel", "pypi"],
    ["pip", "pypi"],
    ["build", "pypi"],
    ["twine", "pypi"],
    ["black", "pypi"],
  ] as const)("denies %s (%s)", (name, eco) => {
    expect(isDeniedDependency(name, eco)).toBe(true);
  });

  it.each([
    ["typescript", "npm"],
    ["pytest", "pypi"],
    ["pytest-asyncio", "pypi"],
    ["ruff", "pypi"],
    ["next", "npm"],
    ["build", "npm"], // `build` is denied on PyPI only
    ["postcss-nesting", "npm"], // only the bare `postcss` is denied
    ["types", "npm"], // `@types/*` is a scope rule, not a substring rule
  ] as const)("keeps %s (%s)", (name, eco) => {
    expect(isDeniedDependency(name, eco)).toBe(false);
  });

  it("a trailing `*` is a prefix rule (eslint* covers eslint-plugin-x); a bare name is exact", () => {
    expect(isDeniedDependency("eslint-plugin-react", "npm")).toBe(true);
    expect(isDeniedDependency("husky-hooks", "npm")).toBe(false);
  });

  it("matches PyPI names in their PEP 503 form", () => {
    expect(isDeniedDependency("Setuptools_SCM", "pypi")).toBe(true);
    expect(isDeniedDependency("BLACK", "pypi")).toBe(true);
  });
});

describe("parsePackageJsonDeps", () => {
  it("reads dependencies then devDependencies in file order; peer / optional / bundled are not read", () => {
    const names = parsePackageJsonDeps(
      JSON.stringify({
        name: "app",
        dependencies: { next: "15.0.0", react: "^19", "@supabase/supabase-js": "^2" },
        devDependencies: { typescript: "^5", vitest: "^3" },
        peerDependencies: { "peer-only": "*" },
        optionalDependencies: { "optional-only": "*" },
      }),
    );
    expect(names).toEqual(["next", "react", "@supabase/supabase-js", "typescript", "vitest"]);
  });

  it("unwraps npm: alias specs to the real package and skips file:/link:/workspace:/portal: specs", () => {
    expect(
      parsePackageJsonDeps(
        JSON.stringify({
          dependencies: {
            "my-react": "npm:react@^19",
            "my-scoped": "npm:@tanstack/react-query@5",
            local: "file:../local",
            linked: "link:../linked",
            sibling: "workspace:*",
            portal: "portal:../p",
            git: "github:honojs/hono",
          },
        }),
      ),
    ).toEqual(["react", "@tanstack/react-query", "git"]);
  });

  it("de-duplicates and tolerates a malformed or dependency-less manifest", () => {
    expect(parsePackageJsonDeps(JSON.stringify({ dependencies: { a: "1" }, devDependencies: { a: "1" } }))).toEqual(["a"]);
    expect(parsePackageJsonDeps("{}")).toEqual([]);
    expect(parsePackageJsonDeps(JSON.stringify({ dependencies: ["not", "an", "object"] }))).toEqual([]);
    expect(() => parsePackageJsonDeps("{ not json")).toThrow();
  });
});

describe("parsePackageJsonVersions (A11/PAR-724): an exact pin, never a range's lower bound", () => {
  it("captures a bare semver as an exact pin", () => {
    const versions = parsePackageJsonVersions(JSON.stringify({ dependencies: { next: "15.0.0" } }));
    expect(versions.get("next")).toBe("15.0.0");
  });

  it("does NOT capture a range — a range names no single version to match docs against", () => {
    const versions = parsePackageJsonVersions(
      JSON.stringify({ dependencies: { react: "^19.0.0", tilde: "~1.2.3", star: "*", xrange: "1.2.x", or: "^1 || ^2" } }),
    );
    expect(versions.size).toBe(0);
  });

  it("excludes npm: aliases and local (file:/link:/workspace:/portal:) specs — neither is a version of the name", () => {
    const versions = parsePackageJsonVersions(
      JSON.stringify({ dependencies: { "my-react": "npm:react@19.0.0", local: "file:../local", sibling: "workspace:*" } }),
    );
    expect(versions.size).toBe(0);
  });

  it("dependencies then devDependencies, first occurrence wins", () => {
    const versions = parsePackageJsonVersions(JSON.stringify({ dependencies: { a: "1.0.0" }, devDependencies: { a: "2.0.0" } }));
    expect(versions.get("a")).toBe("1.0.0");
  });

  it("a pre-release / build-metadata exact pin is still exact", () => {
    const versions = parsePackageJsonVersions(JSON.stringify({ dependencies: { a: "1.0.0-beta.1", b: "1.0.0+build.5" } }));
    expect(versions.get("a")).toBe("1.0.0-beta.1");
    expect(versions.get("b")).toBe("1.0.0+build.5");
  });
});

describe("requirementName (PEP 508 → project name)", () => {
  it.each([
    ["requests", "requests"],
    ["requests>=2.31,<3", "requests"],
    ["Django==5.0", "django"],
    ["httpx[http2]>=0.27", "httpx"],
    ['uvicorn[standard] ; python_version >= "3.10"', "uvicorn"],
    ["typing_extensions", "typing-extensions"],
    ["Typing.Extensions~=4.0", "typing-extensions"],
    ["pytest (>=7.0)", "pytest"],
    ["pydantic @ https://example.com/pydantic.whl", "pydantic"],
    ["  numpy  # trailing comment", "numpy"],
  ])("%s → %s", (spec, name) => {
    expect(requirementName(spec)).toBe(name);
  });

  it.each(["", "   ", "# comment only", "-r other.txt", "-e .", "-e git+https://x/y.git#egg=z", "./local/path", "../up", "/abs/path", "https://example.com/x.whl", "git+https://github.com/o/r.git", "--index-url https://x", "-c constraints.txt"])(
    "skips %j",
    (spec) => {
      expect(requirementName(spec)).toBeUndefined();
    },
  );
});

describe("requirementVersion (A11/PAR-724): an == pin, never a range's lower bound", () => {
  it.each([
    ["Django==5.0", "5.0"],
    ["httpx[http2]==0.27.0", "0.27.0"],
    ['uvicorn==0.30.0 ; python_version >= "3.10"', "0.30.0"],
    ["  numpy==1.26.4  # trailing comment", "1.26.4"],
  ])("%s → %s", (spec, version) => {
    expect(requirementVersion(spec)).toBe(version);
  });

  it.each([
    "requests>=2.31,<3", // a range, not a pin
    "Typing.Extensions~=4.0", // ~= is a range
    "requests", // no version at all
    "pytest!=7.0.0", // != names an exclusion, not a pin
    'httpx==0.27.0,!=0.27.1 ; python_version >= "3.10"', // a second, comma-separated constraint
  ])("skips %j (not a single exact pin)", (spec) => {
    expect(requirementVersion(spec)).toBeUndefined();
  });

  it("undefined for anything requirementName itself would skip (not a plain requirement)", () => {
    expect(requirementVersion("-r other.txt")).toBeUndefined();
    expect(requirementVersion("./local/path")).toBeUndefined();
  });

  it("PAR-824 (item 3): a pip-compile-style hash-pinned line, already continuation-joined, still captures the version — the trailing --hash options are not part of it", () => {
    // `parseRequirementsTxt` joins the `\` continuation before this function ever sees the
    // line; this is that joined, single-logical-line shape.
    expect(requirementVersion('django==4.2.3 --hash=sha256:abc123 --hash=sha256:def456')).toBe("4.2.3");
    expect(requirementVersion('django==4.2.3     --hash=sha256:abc123')).toBe("4.2.3"); // extra join whitespace
  });

  it("PAR-824 (item 4): a PEP 440 epoch pin is excluded from capture (VERSION_SHAPE does not accept `!`) rather than captured and then mis-flagged invalid downstream", () => {
    // Before this fix: captured as "1!2.0" (the old ad-hoc shape allowed a bare `!`), then
    // rejected at `resolvePackage`'s VERSION_SHAPE gate with a confusing "not a valid
    // version/ref" verdict on a name that IS valid PEP 440. Now: not captured at all — `warm`
    // proceeds as if unpinned, the same honest outcome an unparseable range already produces.
    expect(requirementVersion("pkg==1!2.0")).toBeUndefined();
  });

  it("code-reviewer round 2, S4: requirementVersionRejection distinguishes 'no pin' from 'pinned, unsupported shape'", () => {
    expect(requirementVersionRejection("pkg==1!2.0")).toBe("1!2.0"); // a pin exists, but requirementVersion can't capture it
    expect(requirementVersionRejection("pkg>=1.0")).toBeUndefined(); // no == pin at all — nothing to reject
    expect(requirementVersionRejection("pkg")).toBeUndefined(); // unpinned name
    expect(requirementVersionRejection("django==4.2.3")).toBeUndefined(); // a normal, VALID pin — requirementVersion already captures it
  });
});

describe("parseRequirementsTxt", () => {
  it("strips versions, extras, markers, comments and continuation lines; reports -r includes", () => {
    const { names, includes } = parseRequirementsTxt(
      [
        "# web",
        "fastapi>=0.110  # api",
        "uvicorn[standard]; sys_platform != 'win32'",
        "SQLAlchemy \\",
        "  >=2.0",
        "",
        "-r requirements-base.txt",
        "--requirement requirements-extra.txt",
        "-c constraints.txt",
        "-e .",
        "--index-url https://pypi.example",
        "typing_extensions",
        "fastapi==0.111  # duplicate",
      ].join("\n"),
    );
    expect(names).toEqual(["fastapi", "uvicorn", "sqlalchemy", "typing-extensions"]);
    expect(includes).toEqual(["requirements-base.txt", "requirements-extra.txt"]);
  });

  it("A11/PAR-724: captures an == pin per name, first occurrence wins; a range or unpinned name is absent from the map", () => {
    const { versions } = parseRequirementsTxt(["django==4.2.3", "fastapi>=0.110", "uvicorn", "django==9.9.9  # ignored, first wins"].join("\n"));
    expect(versions.get("django")).toBe("4.2.3");
    expect(versions.has("fastapi")).toBe(false);
    expect(versions.has("uvicorn")).toBe(false);
  });

  it("PAR-824 (item 3): a real pip-compile-style hash-pinned continuation line still captures the version", () => {
    // The exact shape `pip-compile` emits: the requirement, a `\` continuation, then one or
    // more indented `--hash=sha256:...` lines.
    const text = ["django==4.2.3 \\", "    --hash=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \\", "    --hash=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"].join(
      "\n",
    );
    const { names, versions } = parseRequirementsTxt(text);
    expect(names).toEqual(["django"]);
    expect(versions.get("django")).toBe("4.2.3");
  });
});

describe("parsePyprojectDeps (minimal TOML reader)", () => {
  it("reads [project].dependencies, optional-dependencies, dependency-groups and poetry tables", () => {
    const names = parsePyprojectDeps(`
[build-system]
requires = ["setuptools>=68", "wheel"]  # NOT a dependency table

[project]
name = "svc"
dependencies = [
  "fastapi>=0.110",   # api
  "httpx[http2]",
  'pydantic>=2',
]
readme = "README.md"

[project.optional-dependencies]
dev = ["pytest>=8", "ruff"]
docs = [
  "mkdocs",
]

[dependency-groups]
test = ["pytest-cov", { include-group = "dev" }]

[tool.poetry]
name = "svc"

[tool.poetry.dependencies]
python = "^3.11"
requests = "^2.31"
"Typing_Extensions" = { version = "*", optional = true }
boto3 = { version = "1.0", extras = ["s3"] }

[tool.poetry.group.dev.dependencies]
mypy = "*"

[tool.poetry.dev-dependencies]
black = "*"

[tool.ruff]
line-length = 120
`);
    expect(names).toEqual([
      "fastapi",
      "httpx",
      "pydantic",
      "pytest",
      "ruff",
      "mkdocs",
      "pytest-cov",
      "requests",
      "typing-extensions",
      "boto3",
      "mypy",
      "black",
    ]);
  });

  it("ignores strings that merely contain '#' or brackets, and arrays in unrelated tables", () => {
    const names = parsePyprojectDeps(`
[project]
description = "uses [brackets] and # hashes"
dependencies = ["a # not a comment inside a string", "b"]
[tool.other]
dependencies = ["nope"]
`);
    expect(names).toEqual(["a", "b"]);
  });

  it("returns [] for a file with none of the tables", () => {
    expect(parsePyprojectDeps('[tool.black]\nline-length = 88\n')).toEqual([]);
  });
});

describe("parsePyprojectVersions (A11/PAR-724): PEP 508 == pins and Poetry exact strings", () => {
  it("PEP 508 == pins from [project].dependencies / optional-dependencies / dependency-groups", () => {
    const versions = parsePyprojectVersions(`
[project]
dependencies = ["fastapi==0.110.0", "httpx[http2]>=0.27"]

[project.optional-dependencies]
dev = ["pytest==8.0.0"]

[dependency-groups]
test = ["pytest-cov==5.0.0"]
`);
    expect(versions.get("fastapi")).toBe("0.110.0");
    expect(versions.has("httpx")).toBe(false); // >= is a range, not a pin
    expect(versions.get("pytest")).toBe("8.0.0");
    expect(versions.get("pytest-cov")).toBe("5.0.0");
  });

  it("a PEP 440 epoch pin in pyproject is reported as not checked", () => {
    write("pyproject.toml", '[project]\ndependencies = ["pkg==1!2.0"]\n');
    const out = discoverProjectDependencies(dir);
    expect(out.dependencies).toEqual([{ name: "pkg", ecosystem: "pypi", source: "pyproject.toml" }]);
    expect(out.notes).toContain("pyproject.toml: pkg==1!2.0 pin not checked (unsupported version shape); warm proceeds as if unpinned");
  });

  it("Poetry: a plain quoted string with no range character is an exact pin; ^/~/*/inline-table are not", () => {
    const versions = parsePyprojectVersions(`
[tool.poetry.dependencies]
python = "^3.11"
requests = "^2.31"
django = "4.2.3"
"Typing_Extensions" = "4.9.0"
star = { version = "*", optional = true }
boto3 = { version = "1.0.0", extras = ["s3"] }
`);
    expect(versions.has("python")).toBe(false); // excluded the same way parsePyprojectDeps excludes it from names
    expect(versions.has("requests")).toBe(false); // ^2.31 is a range
    expect(versions.get("django")).toBe("4.2.3");
    expect(versions.get("typing-extensions")).toBe("4.9.0"); // PEP 503 folded, matching requirementName
    expect(versions.has("star")).toBe(false); // an inline table, not a plain string
    expect(versions.has("boto3")).toBe(false); // ditto — inline table wins even though its version field looks exact
  });

  it("skips a path/git/url Poetry source, same as parsePyprojectDeps does for names (R2)", () => {
    const versions = parsePyprojectVersions(`
[tool.poetry.dependencies]
local-lib = { path = "../local-lib", develop = true }
`);
    expect(versions.size).toBe(0);
  });

  it("returns an empty map for a file with none of the tables", () => {
    expect(parsePyprojectVersions("[tool.black]\nline-length = 88\n").size).toBe(0);
  });

  it("(security-architect, A11/PAR-724 round 1 S-2 / round 2 T-1) rejects a path-traversal or slash-bearing Poetry version string — this is the manifest path that bypasses the MCP schema entirely, so the shape gate must hold here on its own", () => {
    const versions = parsePyprojectVersions(`
[tool.poetry.dependencies]
evil = "../../../../evil/repo/HEAD"
alsoevil = "1.2/3"
backslash = "1.2\\\\3"
`);
    expect(versions.size).toBe(0);
  });
});

describe("lockfile fallbacks (names only, used when the manifest is absent)", () => {
  it("package-lock v2/v3: root package's dependencies + devDependencies; v1 has no root list → []", () => {
    const v3 = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { next: "15", react: "19" }, devDependencies: { typescript: "5" } },
        "node_modules/next": { version: "15.0.0" },
        "node_modules/transitive": { version: "1.0.0" },
      },
    });
    expect(parsePackageLockDeps(v3)).toEqual(["next", "react", "typescript"]);
    const v1 = JSON.stringify({ lockfileVersion: 1, dependencies: { next: { version: "15" }, transitive: { version: "1" } } });
    expect(parsePackageLockDeps(v1)).toEqual([]);
  });

  it("pnpm-lock: importers['.'] (v6+/v9) or the top-level dependencies blocks (v5); keys may be quoted", () => {
    const v9 = `lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
importers:
  .:
    dependencies:
      next:
        specifier: 15.0.0
        version: 15.0.0
      '@supabase/supabase-js':
        specifier: ^2
        version: 2.45.0
    devDependencies:
      typescript:
        specifier: ^5
        version: 5.6.0
  packages/other:
    dependencies:
      lodash:
        specifier: ^4
        version: 4.17.21
packages:
  next@15.0.0:
    resolution: {integrity: sha512-x}
`;
    expect(parsePnpmLockDeps(v9)).toEqual(["next", "@supabase/supabase-js", "typescript"]);
    const v5 = `lockfileVersion: 5.4
specifiers:
  react: ^18
dependencies:
  react: 18.3.1
devDependencies:
  vitest: 1.0.0
packages:
  /react/18.3.1:
    resolution: {integrity: x}
`;
    expect(parsePnpmLockDeps(v5)).toEqual(["react", "vitest"]);
  });
});

describe("discoverProjectDependencies", () => {
  it("reads every manifest present, in a fixed order, de-duplicated per ecosystem, with the source file per name", () => {
    write("package.json", JSON.stringify({ dependencies: { next: "15", stripe: "^16" }, devDependencies: { typescript: "5", "@types/node": "22" } }));
    write("pyproject.toml", '[project]\ndependencies = ["httpx", "Typing_Extensions"]\n');
    write("requirements.txt", "httpx==0.27\nfastapi\n-r requirements-dev.txt\n");
    write("requirements-dev.txt", "pytest\ntyping-extensions\n");
    write("package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { "from-lock": "1" } } } })); // ignored: manifest present
    const out = discoverProjectDependencies(dir);
    expect(out.dir).toBe(dir);
    expect(out.manifests).toEqual(["package.json", "pyproject.toml", "requirements.txt", "requirements-dev.txt"]);
    expect(out.dependencies).toEqual([
      { name: "next", ecosystem: "npm", source: "package.json" },
      { name: "stripe", ecosystem: "npm", source: "package.json" },
      { name: "typescript", ecosystem: "npm", source: "package.json" },
      { name: "@types/node", ecosystem: "npm", source: "package.json" }, // discovery keeps it; warm marks it denied
      { name: "httpx", ecosystem: "pypi", source: "pyproject.toml" },
      { name: "typing-extensions", ecosystem: "pypi", source: "pyproject.toml" },
      { name: "fastapi", ecosystem: "pypi", source: "requirements.txt" },
      { name: "pytest", ecosystem: "pypi", source: "requirements-dev.txt" },
    ]);
    expect(out.notes).toEqual([]);
  });

  it("A11/PAR-724: an exact pin from each manifest format threads through to ProjectDependency.version; a range does not", () => {
    write("package.json", JSON.stringify({ dependencies: { next: "15.0.0", react: "^19.0.0" } }));
    write("pyproject.toml", '[project]\ndependencies = ["fastapi==0.110.0", "httpx>=0.27"]\n');
    write("requirements.txt", "django==4.2.3\nuvicorn\n");
    const out = discoverProjectDependencies(dir);
    expect(out.dependencies).toEqual([
      { name: "next", ecosystem: "npm", source: "package.json", version: "15.0.0" },
      { name: "react", ecosystem: "npm", source: "package.json" }, // range: no version claimed
      { name: "fastapi", ecosystem: "pypi", source: "pyproject.toml", version: "0.110.0" },
      { name: "httpx", ecosystem: "pypi", source: "pyproject.toml" },
      { name: "django", ecosystem: "pypi", source: "requirements.txt", version: "4.2.3" },
      { name: "uvicorn", ecosystem: "pypi", source: "requirements.txt" },
    ]);
  });

  it("code-reviewer round 2, S4: an epoch-pinned dependency (unsupported version shape) is disclosed in `notes`, not silently dropped", () => {
    write("requirements.txt", "pkg==1!2.0\ndjango==4.2.3\n");
    const out = discoverProjectDependencies(dir);
    // The name is still discovered, just without a `version` — the SAME outcome an unparseable
    // range already produces (never silently invents or drops the dependency itself).
    expect(out.dependencies).toContainEqual({ name: "pkg", ecosystem: "pypi", source: "requirements.txt" });
    expect(out.dependencies).toContainEqual({ name: "django", ecosystem: "pypi", source: "requirements.txt", version: "4.2.3" });
    expect(out.notes.some((n) => n.includes("pkg==1!2.0 pin not checked"))).toBe(true);
  });

  it("-r includes are followed one level only, relative to the including file, and never outside the project directory", () => {
    mkdirSync(join(dir, "reqs"));
    write("requirements.txt", "-r reqs/base.txt\n-r ../outside.txt\n-r missing.txt\n");
    writeFileSync(join(dir, "reqs", "base.txt"), "a\n-r deeper.txt\n", "utf8");
    writeFileSync(join(dir, "reqs", "deeper.txt"), "too-deep\n", "utf8");
    const out = discoverProjectDependencies(dir);
    expect(out.manifests).toEqual(["requirements.txt", "reqs/base.txt"]);
    expect(out.dependencies.map((d) => d.name)).toEqual(["a"]);
    expect(out.notes).toEqual([
      "reqs/base.txt: -r deeper.txt is nested more than one level; skipped", // emitted while reading the first include
      "requirements.txt: -r ../outside.txt is outside the project directory; skipped",
      "requirements.txt: -r missing.txt not found; skipped",
    ]);
  });

  it("falls back to lockfiles only when the matching manifest is absent, and says which lockfiles it will not read", () => {
    write("package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { hono: "4" } } } }));
    write("pnpm-lock.yaml", "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      hono:\n        specifier: 4\n        version: 4.0.0\n      zod:\n        specifier: 3\n        version: 3.0.0\n");
    write("yarn.lock", '# yarn lockfile v1\n"hono@^4":\n  version "4.0.0"\n');
    write("uv.lock", "version = 1\n");
    write("poetry.lock", "[[package]]\nname = \"httpx\"\n");
    const out = discoverProjectDependencies(dir);
    expect(out.manifests).toEqual(["package-lock.json", "pnpm-lock.yaml"]);
    expect(out.dependencies).toEqual([
      { name: "hono", ecosystem: "npm", source: "package-lock.json" },
      { name: "zod", ecosystem: "npm", source: "pnpm-lock.yaml" },
    ]);
    expect(out.notes).toEqual([
      "yarn.lock: not read (it lists every package with no root marker); add a package.json",
      "uv.lock, poetry.lock: not read (Python lockfiles list every package); add a pyproject.toml or requirements.txt",
    ]);
  });

  it("a package-lock v1 beside no package.json is reported, not silently empty", () => {
    write("package-lock.json", JSON.stringify({ lockfileVersion: 1, dependencies: { next: { version: "15" } } }));
    const out = discoverProjectDependencies(dir);
    expect(out.manifests).toEqual([]);
    expect(out.dependencies).toEqual([]);
    expect(out.notes).toEqual(["package-lock.json: lockfileVersion 1 has no root dependency list; skipped"]);
  });

  it("an unparseable manifest is a note, not a crash; the other manifests still count", () => {
    write("package.json", "{ not json");
    write("requirements.txt", "flask\n");
    const out = discoverProjectDependencies(dir);
    expect(out.manifests).toEqual(["requirements.txt"]);
    expect(out.dependencies).toEqual([{ name: "flask", ecosystem: "pypi", source: "requirements.txt" }]);
    expect(out.notes).toHaveLength(1);
    expect(out.notes[0]).toMatch(/^package\.json: could not parse/);
  });

  it("no manifest at all → empty manifests and dependencies, no notes", () => {
    expect(discoverProjectDependencies(dir)).toEqual({ dir, manifests: [], dependencies: [], notes: [] });
  });

  it("throws when the directory does not exist or is a file", () => {
    expect(() => discoverProjectDependencies(join(dir, "nope"))).toThrow(/not a directory/);
    write("f.txt", "x");
    expect(() => discoverProjectDependencies(join(dir, "f.txt"))).toThrow(/not a directory/);
  });
});

describe("discoverProjectDependencies — hostile or oversized input", () => {
  it("drops names that are not valid package names (counted in a note, never echoed) so nothing from a manifest reaches the terminal unvalidated", () => {
    write("package.json", JSON.stringify({ dependencies: { next: "15", "[31mEVIL[0m": "1", "Not Valid": "1", "": "1" } }));
    write("requirements.txt", "flask\n]0;pwnedbad name\n");
    const out = discoverProjectDependencies(dir);
    expect(out.dependencies.map((d) => d.name)).toEqual(["next", "flask"]);
    // requirements lines that do not parse as a PEP 508 name never become names at all (no note);
    // package.json keys are free-form, so those are validated and counted.
    expect(out.notes).toEqual(["package.json: skipped 2 names that are not valid npm package names"]);
    expect(JSON.stringify(out)).not.toContain("EVIL");
    expect(JSON.stringify(out)).not.toContain("");
  });

  it("a manifest over MANIFEST_MAX_BYTES is not read; a note says so", () => {
    write("package.json", JSON.stringify({ dependencies: { next: "15" } }));
    write("requirements.txt", `flask\n${"#".repeat(MANIFEST_MAX_BYTES)}\n`);
    const out = discoverProjectDependencies(dir);
    expect(out.manifests).toEqual(["package.json"]);
    expect(out.notes).toEqual([`requirements.txt: larger than ${MANIFEST_MAX_BYTES / (1024 * 1024)} MiB; not read`]);
  });
});

describe("N-1 / N-3 — a BOM does not break a manifest, and every parser is guarded", () => {
  const BOM = "﻿";
  it("a BOM-prefixed package.json, package-lock.json, requirements.txt and pyproject.toml all parse", () => {
    expect(parsePackageJsonDeps(BOM + JSON.stringify({ dependencies: { next: "15" } }))).toEqual(["next"]);
    expect(parsePackageLockDeps(BOM + JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { hono: "4" } } } }))).toEqual(["hono"]);
    expect(parseRequirementsTxt(`${BOM}flask\n`).names).toEqual(["flask"]);
    expect(parsePyprojectDeps(`${BOM}[project]\ndependencies = ["httpx"]\n`)).toEqual(["httpx"]);
    expect(parsePnpmLockDeps(`${BOM}dependencies:\n  hono: 4\n`)).toEqual(["hono"]);
  });

  it("discovery reads a BOM-prefixed package.json instead of noting a parse failure", () => {
    write("package.json", BOM + JSON.stringify({ dependencies: { next: "15" } }));
    const out = discoverProjectDependencies(dir);
    expect(out.manifests).toEqual(["package.json"]);
    expect(out.dependencies.map((d) => d.name)).toEqual(["next"]);
    expect(out.notes).toEqual([]);
  });
});

describe("S1 — no super-linear parsing: 1 MiB pathological lines finish inside the budget", () => {
  const MiB = 1024 * 1024;
  /** Q-4: a wall-clock budget on a shared CI box is a flake generator, so it is set well above
   *  any linear scan of a megabyte (measured: single-digit ms here) and far below the
   *  super-linear behaviour it exists to catch (measured before the fix: 11.3 s at 3000 spaces
   *  for the TOML header, 31.8 s at 4000 for the pnpm key). Anything between the two is a
   *  regression this catches; nothing in between is a plausible healthy time. */
  const BUDGET_MS = 5000;
  const took = (fn: () => unknown) => {
    const t = performance.now();
    fn();
    return performance.now() - t;
  };
  it("TOML table header `[` + spaces + `x` (was 11.3 s at 3000 spaces)", () => {
    expect(took(() => parsePyprojectDeps("[" + " ".repeat(MiB) + "x"))).toBeLessThan(BUDGET_MS);
    expect(took(() => parsePyprojectDeps("[[" + " ".repeat(MiB) + "]"))).toBeLessThan(BUDGET_MS);
  });
  it("pnpm key: indentation + `x` without a colon (was 31.8 s at 4000 spaces)", () => {
    expect(took(() => parsePnpmLockDeps("importers:\n  .:\n    dependencies:\n" + " ".repeat(MiB) + "x"))).toBeLessThan(BUDGET_MS);
    expect(took(() => parsePnpmLockDeps("importers:\n  .:\n    dependencies:\n      '" + "a".repeat(MiB)))).toBeLessThan(BUDGET_MS);
    expect(took(() => parsePnpmLockDeps(" ".repeat(MiB) + "dependencies :"))).toBeLessThan(BUDGET_MS);
  });
  it("requirements: long names, long runs of spaces, long -r lines, long markers and extras", () => {
    expect(took(() => parseRequirementsTxt("a" + " ".repeat(MiB) + "="))).toBeLessThan(BUDGET_MS);
    expect(took(() => parseRequirementsTxt("a".repeat(MiB) + "!"))).toBeLessThan(BUDGET_MS);
    expect(took(() => parseRequirementsTxt("-r" + " ".repeat(MiB)))).toBeLessThan(BUDGET_MS);
    expect(took(() => parseRequirementsTxt("--requirement=" + "x".repeat(MiB)))).toBeLessThan(BUDGET_MS);
    expect(took(() => parseRequirementsTxt("x[" + "e,".repeat(MiB / 2) + "]; " + "python_version > '3' and ".repeat(MiB / 25)))).toBeLessThan(BUDGET_MS);
    expect(took(() => parseRequirementsTxt("a\\\n" + " ".repeat(MiB) + "\\\nb"))).toBeLessThan(BUDGET_MS);
    expect(took(() => parseRequirementsTxt("git+" + "a".repeat(MiB) + "://x"))).toBeLessThan(BUDGET_MS);
  });
  it("pyproject: long array values, long inline tables, long keys", () => {
    expect(took(() => parsePyprojectDeps('[project]\ndependencies = ["' + "a".repeat(MiB) + '"]'))).toBeLessThan(BUDGET_MS);
    expect(took(() => parsePyprojectDeps("[project]\ndependencies = [" + '"a",'.repeat(MiB / 4) + "]"))).toBeLessThan(BUDGET_MS);
    expect(took(() => parsePyprojectDeps("[tool.poetry.dependencies]\n" + "k".repeat(MiB) + " = { version = '*' }"))).toBeLessThan(BUDGET_MS);
    expect(took(() => parsePyprojectDeps("[tool.poetry.dependencies]\nx = {" + " ".repeat(MiB) + "path = 'a' }"))).toBeLessThan(BUDGET_MS);
  });
  it("package.json: a long npm: alias spec", () => {
    expect(took(() => parsePackageJsonDeps(JSON.stringify({ dependencies: { x: "npm:" + "a".repeat(MiB), y: "npm:@" + "a".repeat(MiB) } })))).toBeLessThan(BUDGET_MS);
  });
  it("tripwire: the module's remaining regex literals are exactly the allow-listed linear ones", () => {
    // A8 / PAR-721 (Move 3): cleanText, and its control/bidi character class, moved to
    // src/text.ts — it is no longer in this file's regex inventory. The equivalent tripwire
    // over text.ts (the same expected literal) lives in test/text.test.ts; this row is
    // removed here, not weakened, because the pattern it guarded is no longer here to guard.
    const src = readFileSync(new URL("../src/project-deps.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
      .replace(/\/\/.*$/gm, ""); // line comments
    const literals = [...src.matchAll(/(?:^|[=(,:\s])\/((?:\\.|\[(?:\\.|[^\]\n])*\]|[^/\n\\[])+)\/[gimsuy]*/g)].map((m) => m[1]);
    expect(new Set(literals)).toEqual(
      new Set([
        "\\r\\n?", // fixed width
        "\\\\\\n\\s*", // anchored on a literal backslash-newline
        // A11/PAR-724: two more, both a single character class (no nested quantifier, no
        // alternation) applied linearly, the same class this tripwire already accepts —
        // POETRY_RANGE_CHARS was removed (security-architect S-2): the Poetry version branch
        // now shares VERSION_SHAPE (imported from package-names.ts, so no new literal here).
        "^\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?$", // EXACT_SEMVER — anchored, one optional group
        // PAR-824 (item 4): `requirementVersion`'s own ad-hoc exact-version-token shape
        // (`^[A-Za-z0-9][A-Za-z0-9.+!_-]*$`) is gone — it now shares `VERSION_SHAPE` too, for
        // the same reason the Poetry branch already does (one definition, D-48), which also
        // closes its missing length cap and its stray, non-PEP-440 bare `!` acceptance. `\s+`
        // (PAR-824 item 3) trims a trailing `--hash=sha256:…` (and further `--hash=…` options)
        // off a `pip-compile`-joined continuation line before the version shape check runs — a
        // single bounded quantifier on one character class, the same linear shape every other
        // literal here already is.
        "\\s+",
      ]),
    );
  });
});

describe("R2 — poetry inline tables with path / git / url are local or VCS sources, skipped", () => {
  it("skips them and keeps version-only inline tables", () => {
    expect(
      parsePyprojectDeps(`
[tool.poetry.dependencies]
python = "^3.11"
requests = "^2.31"
local-lib = { path = "../local-lib", develop = true }
from-git = { git = "https://github.com/o/r.git", branch = "main" }
from-url = { url = "https://example.com/x.whl" }
pinned = { version = "1.0", extras = ["s3"] }
`),
    ).toEqual(["requests", "pinned"]);
  });
});

describe("S2 / D-09 — symlinks are refused, and nothing outside the project is ever read", () => {
  const CANARY = "zz-canary-outside-project";
  let outside: string;
  beforeEach(() => {
    outside = mkdtempSync(join(tmpdir(), "vibectx-outside-"));
    writeFileSync(join(outside, "requirements.txt"), `${CANARY}\n`, "utf8");
  });
  afterEach(() => {
    rmSync(outside, { recursive: true, force: true });
  });

  it("a symlinked requirements-x.txt pointing outside is refused, the target never read", () => {
    symlinkSync(join(outside, "requirements.txt"), join(dir, "requirements-x.txt"));
    write("requirements.txt", "flask\n");
    const out = discoverProjectDependencies(dir);
    expect(out.manifests).toEqual(["requirements.txt"]);
    expect(out.dependencies.map((d) => d.name)).toEqual(["flask"]);
    expect(out.notes).toEqual(["requirements-x.txt: is outside the project directory; skipped"]);
    expect(JSON.stringify(out)).not.toContain(CANARY);
  });

  it("a symlinked package.json / pyproject.toml pointing outside is refused", () => {
    writeFileSync(join(outside, "package.json"), JSON.stringify({ dependencies: { [CANARY]: "1" } }), "utf8");
    symlinkSync(join(outside, "package.json"), join(dir, "package.json"));
    symlinkSync(join(outside, "requirements.txt"), join(dir, "pyproject.toml"));
    const out = discoverProjectDependencies(dir);
    expect(out.manifests).toEqual([]);
    expect(out.notes).toEqual(["package.json: is outside the project directory; skipped", "pyproject.toml: is outside the project directory; skipped"]);
    expect(JSON.stringify(out)).not.toContain(CANARY);
  });

  it("a symlinked lockfile pointing outside is refused too", () => {
    writeFileSync(join(outside, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { [CANARY]: "1" } } } }), "utf8");
    symlinkSync(join(outside, "package-lock.json"), join(dir, "package-lock.json"));
    const out = discoverProjectDependencies(dir);
    expect(out.notes).toEqual(["package-lock.json: is outside the project directory; skipped"]);
    expect(JSON.stringify(out)).not.toContain(CANARY);
  });

  it("-r to a symlinked file, or through a symlinked directory, is refused", () => {
    symlinkSync(join(outside, "requirements.txt"), join(dir, "linked.txt"));
    symlinkSync(outside, join(dir, "linkdir"));
    mkdirSync(join(dir, "real"));
    writeFileSync(join(dir, "real", "base.txt"), "httpx\n", "utf8");
    write("requirements.txt", "-r linked.txt\n-r linkdir/requirements.txt\n-r real/base.txt\n");
    const out = discoverProjectDependencies(dir);
    expect(out.manifests).toEqual(["requirements.txt", "real/base.txt"]);
    expect(out.dependencies.map((d) => d.name)).toEqual(["httpx"]);
    expect(out.notes).toEqual([
      "requirements.txt: -r linked.txt is outside the project directory; skipped",
      "requirements.txt: -r linkdir/requirements.txt is outside the project directory; skipped",
    ]);
    expect(JSON.stringify(out)).not.toContain(CANARY);
  });

  it("an absolute -r path, and a relative one that escapes, are outside the project directory and skipped", () => {
    write("requirements.txt", `-r ${join(outside, "requirements.txt")}\n-r ../${basename(outside)}/requirements.txt\n`);
    const out = discoverProjectDependencies(dir);
    expect(out.dependencies).toEqual([]);
    expect(out.notes).toHaveLength(2);
    for (const n of out.notes) expect(n).toMatch(/is outside the project directory; skipped$/);
    expect(JSON.stringify(out)).not.toContain(CANARY);
  });

  it("Q-1: a -r include that lands OUTSIDE the project is reported as outside, not merely as a symlink — the realpath-containment branch decides", () => {
    // Lexically `linked.txt` and `linkdir/requirements.txt` are inside the project; their real
    // paths are not. Neuter the containment branch in checkPath (`return "ok"`) and these two
    // notes become "skipped (symlink)", so this assertion goes red.
    symlinkSync(join(outside, "requirements.txt"), join(dir, "linked.txt"));
    symlinkSync(outside, join(dir, "linkdir"));
    write("requirements.txt", "-r linked.txt\n-r linkdir/requirements.txt\n");
    const out = discoverProjectDependencies(dir);
    expect(out.notes).toEqual([
      "requirements.txt: -r linked.txt is outside the project directory; skipped",
      "requirements.txt: -r linkdir/requirements.txt is outside the project directory; skipped",
    ]);
    expect(out.dependencies).toEqual([]);
    expect(JSON.stringify(out)).not.toContain(CANARY);
  });

  it("Q-1: a symlink that stays INSIDE the project is still refused, and still says so — D-09 is unchanged for in-project links", () => {
    mkdirSync(join(dir, "real"));
    writeFileSync(join(dir, "real", "base.txt"), "httpx\n", "utf8");
    symlinkSync(join(dir, "real", "base.txt"), join(dir, "inside-link.txt"));
    symlinkSync(join(dir, "real"), join(dir, "insidedir"));
    write("requirements.txt", "-r inside-link.txt\n-r insidedir/base.txt\n-r real/base.txt\n");
    const out = discoverProjectDependencies(dir);
    expect(out.notes).toEqual([
      "requirements.txt: -r inside-link.txt skipped (symlink)",
      "requirements.txt: -r insidedir/base.txt skipped (symlink)",
    ]);
    expect(out.manifests).toEqual(["requirements.txt", "real/base.txt"]);
    expect(out.dependencies.map((d) => d.name)).toEqual(["httpx"]);
  });

  it("a dangling symlink is still reported as a symlink, not as a missing file", () => {
    symlinkSync(join(dir, "gone.txt"), join(dir, "requirements-dangling.txt"));
    write("requirements.txt", "flask\n");
    const out = discoverProjectDependencies(dir);
    expect(out.notes).toEqual(["requirements-dangling.txt: skipped (symlink)"]);
  });

  it("the project directory itself may sit behind a symlink (realpath containment compares real paths on both sides)", () => {
    const link = join(outside, "proj-link");
    symlinkSync(dir, link);
    write("requirements.txt", "-r sub/base.txt\n");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "base.txt"), "httpx\n", "utf8");
    const out = discoverProjectDependencies(link);
    expect(out.dependencies.map((d) => d.name)).toEqual(["httpx"]);
    expect(out.notes).toEqual([]);
  });
});

describe("S3 — control, bidi and zero-width characters never reach a note or a manifest name", () => {
  const ESC = "\u001b";
  const BEL = "\u0007";
  it("an escape sequence in a file name and an OSC-8 sequence in an include are stripped from the notes", () => {
    writeFileSync(join(dir, `requirements-${ESC}[31mred${ESC}[0m.txt`), "flask\n", "utf8");
    write("requirements.txt", `-r ${ESC}]8;;https://evil.example${BEL}missing${ESC}]8;;${BEL}.txt\n-r \u202eevil\u200b.txt\n`);
    const out = discoverProjectDependencies(dir);
    const all = JSON.stringify(out);
    expect(all).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/);
    expect(out.manifests).toEqual(["requirements.txt", "requirements-[31mred[0m.txt"]);
    expect(out.notes).toEqual([
      "requirements.txt: -r ]8;;https://evil.examplemissing]8;;.txt not found; skipped",
      "requirements.txt: -r evil.txt not found; skipped",
    ]);
  });

  it("cleanText is exported for the renderers: strips C0/C1, bidi and zero-width; leaves other text intact", () => {
    expect(cleanText(`a${ESC}b\u0000c\u009fd\u200be\u202ef\u2066g\ufeffh`)).toBe("abcdefgh");
    expect(cleanText("plain — ünïcode ✓ ok")).toBe("plain — ünïcode ✓ ok");
  });
});
