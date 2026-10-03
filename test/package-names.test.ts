import { describe, it, expect } from "vitest";
import {
  npmNameError,
  pypiNameError,
  normalisePyPiName,
  packageNameError,
  versionShapeError,
  VERSION_SHAPE,
  MAX_VERSION_LENGTH,
  MAX_NAME_LENGTH,
} from "../src/package-names.js";

describe("npmNameError (npm naming rules; undefined = valid)", () => {
  it.each(["hono", "httpx", "stripe", "@tanstack/react-query", "@scope/pkg.js", "a", "lodash-es", "some_pkg", "pkg~1", "@types/node"])(
    "accepts %s",
    (name) => expect(npmNameError(name)).toBeUndefined(),
  );

  it.each([
    ["an empty string", ""],
    ["whitespace", "   "],
    ["uppercase", "Hono"],
    ["a leading dot", ".hidden"],
    ["a leading underscore", "_private"],
    ["a scope with a leading dot", "@.scope/pkg"],
    ["a missing scope name", "@/pkg"],
    ["a missing package after the scope", "@scope/"],
    ["two slashes", "@scope/a/b"],
    ["a slash without a scope", "a/b"],
    ["a space", "my pkg"],
    ["a URL", "https://registry.npmjs.org/hono"],
    ["path traversal", "../etc/passwd"],
    ["a query string", "hono?x=1"],
    ["a percent sign", "ho%6eo"],
    ["a colon", "hono:latest"],
    ["a newline", "hono\n"],
    ["215 characters", "a".repeat(215)],
    ["unicode", "héllo"],
  ])("rejects %s", (_label, name) => {
    expect(npmNameError(name)).toMatch(/npm/);
  });

  it("accepts exactly 214 characters", () => {
    expect(npmNameError("a".repeat(214))).toBeUndefined();
  });
});

// PAR-822 (security-audit #1-ranked finding): `MAX_NAME_LENGTH` is exported so `resolve.ts`
// and `registry.ts` can bound and clip a caller-supplied `library`/`name` argument with the
// SAME constant this file already uses to validate a real package name's length — not a
// second, independently-set number that could drift from it.
describe("MAX_NAME_LENGTH (PAR-822)", () => {
  it("is exported, and is exactly npmNameError's own length boundary", () => {
    expect(MAX_NAME_LENGTH).toBe(214);
    expect(npmNameError("a".repeat(MAX_NAME_LENGTH))).toBeUndefined();
    expect(npmNameError("a".repeat(MAX_NAME_LENGTH + 1))).toMatch(/npm/);
  });
});

describe("normalisePyPiName / pypiNameError (PEP 503)", () => {
  it("folds runs of -, _ and . to a single hyphen and lowercases", () => {
    expect(normalisePyPiName("Django_REST.framework")).toBe("django-rest-framework");
    expect(normalisePyPiName("httpx")).toBe("httpx");
    expect(normalisePyPiName("a--b__c..d")).toBe("a-b-c-d");
  });

  it.each(["httpx", "Django", "typing_extensions", "zope.interface", "a", "A1", "py-3"])("accepts %s", (name) => {
    expect(pypiNameError(name)).toBeUndefined();
  });

  it.each([
    ["an empty string", ""],
    ["a leading hyphen", "-httpx"],
    ["a trailing dot", "httpx."],
    ["a slash", "encode/httpx"],
    ["a space", "http x"],
    ["an @", "@httpx"],
    ["a URL", "https://pypi.org/project/httpx"],
    ["unicode", "httpx™"],
    ["a newline", "httpx\n"],
    ["215 characters", "a".repeat(215)],
  ])("rejects %s", (_label, name) => {
    expect(pypiNameError(name)).toMatch(/PyPI/);
  });
});

describe("packageNameError (either ecosystem)", () => {
  it("is undefined when at least one ecosystem accepts the name, else names both rules", () => {
    expect(packageNameError("hono")).toBeUndefined();
    expect(packageNameError("@tanstack/react-query")).toBeUndefined(); // npm-only shape
    expect(packageNameError("zope.interface")).toBeUndefined(); // valid in both
    expect(packageNameError("Django")).toBeUndefined(); // PyPI accepts mixed case; npm does not
    expect(packageNameError("https://evil.example/x")).toMatch(/not a valid npm or PyPI package name/);
    expect(packageNameError("../x")).toMatch(/not a valid npm or PyPI package name/);
    expect(packageNameError("")).toMatch(/not a valid npm or PyPI package name/);
  });
});

describe("VERSION_SHAPE / versionShapeError (A11/PAR-724, security-architect S-1/S-2)", () => {
  it.each(["1.2.3", "v1.2.3", "1.2.3-beta.1", "1.2.3+build.5", "2024.1.0", "a", "9".repeat(MAX_VERSION_LENGTH)])(
    "accepts %s",
    (version) => expect(versionShapeError(version)).toBeUndefined(),
  );

  it.each([
    ["a path segment", "../../../../evil/repo/HEAD"],
    ["a bare slash", "1.2/3"],
    ["a backslash", "1.2\\3"],
    ["a newline", "1.0.0\nSource: forged"],
    ["a NUL byte", "1.0.0\x00evil"],
    ["a leading dot", ".1.2.3"],
    ["a leading dash", "-1.2.3"],
    ["empty", ""],
    ["over the length cap", "9".repeat(MAX_VERSION_LENGTH + 1)],
    ["a space", "1.2.3 evil"],
    ["a query-string character", "1.2.3?x=1"],
    ["a fragment character", "1.2.3#x"],
  ])("rejects %s", (_label, version) => {
    expect(versionShapeError(version)).toMatch(/not a valid version\/ref/);
    expect(VERSION_SHAPE.test(version)).toBe(false);
  });

  it("the regex and the error function agree on every case above (no drift between the gate and its reporter)", () => {
    for (const v of ["1.2.3", "../evil", "", "1.0.0\n"]) {
      expect(VERSION_SHAPE.test(v)).toBe(versionShapeError(v) === undefined);
    }
  });
});
