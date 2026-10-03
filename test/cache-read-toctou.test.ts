import { afterEach, expect, test } from "vitest";
import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readCache, writeCache } from "../src/cache.js";
import { libDirName, urlSlug } from "../src/cache-meta.js";

let base: string | undefined;

afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  if (base) rmSync(base, { recursive: true, force: true });
  base = undefined;
});

/** AUDIT-20260920-01 — POSIX must pin the final content-file descriptor with O_NOFOLLOW.
 * A second process repeatedly swaps the final component between a regular cached document and a
 * symlink to a secret. The cache may miss while racing, but it must never serve the secret. */
test.skipIf(process.platform === "win32")("readCache never serves a symlink target swapped into its content-read race", async () => {
  base = mkdtempSync(join(tmpdir(), "vibectx-cache-read-race-"));
  process.env.VIBECTX_CACHE_DIR = join(base, "cache");
  const url = "https://docs.example.test/race";
  writeCache("victim", url, "normal documentation");
  const dir = join(process.env.VIBECTX_CACHE_DIR, libDirName("victim"));
  const content = join(dir, `${urlSlug(url)}.md`);
  const normal = join(base, "normal");
  const secret = join(base, "secret");
  writeFileSync(normal, "normal documentation");
  writeFileSync(secret, "TOP_SECRET_FROM_OUTSIDE_CACHE");
  // A configured shared cache remains allowed by D-84; model a second local writer racing its
  // final component, rather than rejecting the configured cache on permissions.
  chmodSync(process.env.VIBECTX_CACHE_DIR, 0o777);
  chmodSync(dir, 0o777);

  const racer = spawn(process.execPath, ["-e", `
    const fs = require('node:fs');
    const [content, normal, secret] = process.argv.slice(1);
    const staged = content + '.race';
    for (;;) {
      try { fs.unlinkSync(staged); } catch {}
      try { fs.symlinkSync(secret, staged); fs.renameSync(staged, content); } catch {}
      try { fs.unlinkSync(staged); } catch {}
      try { fs.linkSync(normal, staged); fs.renameSync(staged, content); } catch {}
    }
  `, content, normal, secret], { stdio: "ignore" });
  try {
    let leaked = false;
    for (let i = 0; i < 250_000 && !leaked; i++) {
      leaked = readCache("victim", url, 168)?.content === "TOP_SECRET_FROM_OUTSIDE_CACHE";
    }
    expect(leaked).toBe(false);
  } finally {
    racer.kill("SIGKILL");
    await new Promise<void>((resolve) => racer.once("exit", () => resolve()));
  }
  // R9 exception (Tom, 2026-10-01, plan §6 long-run question 5), this test only: timeout raised
  // from 30 s to about twice the slowest measured run; assertion and the 250,000 iterations are
  // unchanged. MEASURED 2026-10-01 on macOS, Node 26: alone 16.9-23.1 s over 10 runs; inside three
  // loaded full-suite runs 32.2-32.3 s (slowest 32,283 ms), which exceeded the old 30 s limit, as
  // did Node 20 CI runs 36846326404 and 36848203370.
}, 65_000);
