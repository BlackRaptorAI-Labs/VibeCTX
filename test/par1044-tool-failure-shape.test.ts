import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";
import { resetCacheRootState } from "../src/cache.js";
import type { Registry } from "../src/registry.js";

// PAR-1044 L-29: every tool fails the same way. A throw inside a tool becomes an `isError`
// result with a fixed message; the exception text (which may hold a local path) never
// reaches the model.
const LEAK = "/Users/me/PATHMARK-private/.vibectx";
let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "l29-")));
  vi.stubEnv("VIBECTX_CACHE_DIR", join(dir, "cache"));
  vi.stubEnv("VIBECTX_NO_LOG", "1");
  vi.stubEnv("VIBECTX_NO_AUTOWARM", "1");
  resetCacheRootState();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("unexpected fetch"); }));
});
afterEach(() => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetCacheRootState();
  fs.rmSync(dir, { recursive: true, force: true });
});

function throwingRegistry(): Registry {
  const fail = (): never => { throw new Error(`EACCES: permission denied, open '${LEAK}/resolved.json'`); };
  return { get entries(): Registry["entries"] { return fail(); }, get config(): never { return fail(); } } as unknown as Registry;
}

async function call(name: string, args: Record<string, unknown>) {
  const server = buildServer(throwingRegistry());
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "l29-failure-shape", version: "1" });
  try {
    await server.connect(a); await client.connect(b);
    return await client.callTool({ name, arguments: args });
  } finally { await client.close(); await server.close(); }
}

it.each([
  ["list_libraries", {}],
  ["search", { query: "hooks" }],
  ["get_docs", { library: "react", topic: "hooks" }],
  ["doctor", {}],
  ["warm_project", {}],
])("PAR-1044 L-29: %s turns a thrown error into an isError result without the exception text", async (name, args) => {
  const reply = await call(name, args);
  expect(reply.isError).toBe(true);
  const wire = JSON.stringify(reply);
  expect(wire).not.toContain("PATHMARK");
  expect(wire).not.toContain("EACCES");
  expect(wire).toMatch(new RegExp(`${name} could not complete`, "i"));
  expect(wire).toContain(`${name} failed in`);
});

it("PAR-1044 L-29: refresh keeps its partial-progress message and is marked isError", async () => {
  const reply = await call("refresh", {});
  expect(reply.isError).toBe(true);
  const wire = JSON.stringify(reply);
  expect(wire).toContain("Refresh stopped; earlier libraries may have updated.");
  expect(wire).not.toContain("PATHMARK");
  expect(wire).not.toContain("EACCES");
});
