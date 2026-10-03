import { describe, it, expect, vi } from "vitest";

/**
 * PAR-1048 (F12) — a filesystem root is never a project, even with a manifest in it. No test can
 * write a manifest at `/`, so discovery is mocked to report one everywhere: only the root rule
 * can then refuse it.
 */
vi.mock("../src/project-deps.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/project-deps.js")>();
  return { ...actual, discoverProjectDependencies: (dir: string) => ({ dir, manifests: ["package.json"], dependencies: [], notes: [] }) };
});

const { autowarmProjectDir } = await import("../src/autowarm.js");

describe("PAR-1048 (F12): filesystem root", () => {
  it("PAR-1048 (F12): a filesystem root with a manifest is still not a project", () => {
    expect(autowarmProjectDir("/srv/app", "/elsewhere")).toBe("/srv/app"); // the mock really reports a manifest
    expect(autowarmProjectDir("/", "/elsewhere")).toBeUndefined();
  });
});
