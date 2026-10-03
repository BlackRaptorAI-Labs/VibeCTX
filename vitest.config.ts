import { defineConfig } from "vitest/config";

/**
 * Product regressions live under `test/`. Keep locally ignored audit evidence and agent
 * worktrees out of the shipped suite: those files can intentionally assert the vulnerable
 * pre-fix behavior and must never change `npm test`'s result.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/network-guard.setup.ts"],
  },
});
