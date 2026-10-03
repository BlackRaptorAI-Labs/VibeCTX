import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const guard = fileURLToPath(new URL("./network-guard.setup.ts", import.meta.url));
const cli = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function childProbe(connector: string, forbidden: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "vibectx-guard-socket-")); scratch.push(dir);
  const fixture = join(dir, "socket.test.ts");
  writeFileSync(fixture, connector === "redirect" ? `
    import http from 'node:http';
    import dns from 'node:dns';
    import { expect, it, vi } from 'vitest';
    it('PAR-1038 socket admission probe', async () => {
      const hits = [];
      const server = http.createServer((req, res) => {
        hits.push(req.url);
        if (req.url === '/start') res.writeHead(302, { location: 'http://socket-fixture.invalid:' + server.address().port + '/end' });
        res.end('local response');
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      vi.spyOn(dns, 'lookup').mockImplementation((host, opts, callback) => {
        if (host !== 'socket-fixture.invalid') throw new Error('Unexpected fixture lookup');
        callback(null, opts?.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4);
      });
      try {
        await expect(fetch('http://127.0.0.1:' + server.address().port + '/start')).rejects.toThrow();
        expect(hits).toEqual(['/start']);
      } finally {
        vi.restoreAllMocks(); server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    });
  ` : `
    import net, { connect as namedConnect, createConnection } from 'node:net';
    import http from 'node:http';
    import { expect, it } from 'vitest';
    it('PAR-1038 socket admission probe', async () => {
      let hits = 0;
      const server = net.createServer(socket => { hits++; socket.end('ok'); });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;
      const options = { host: ${JSON.stringify(forbidden ? "socket-fixture.invalid" : "127.0.0.1")}, port,
        autoSelectFamily: false, lookup: (_host, _options, callback) => callback(null, '127.0.0.1', 4) };
      let client;
      try {
        const connect = () => { client = ${connector}; return client; };
        ${forbidden ? `expect(connect).toThrow(/network guard blocked .*socket-fixture\\.invalid/);
        expect(hits).toBe(0);` : `connect();
        await new Promise((resolve, reject) => { client.once('end', resolve); client.once('error', reject); client.resume(); });
        expect(hits).toBe(1);`}
      } finally {
        client?.destroy();
        await new Promise(resolve => server.close(resolve));
      }
    });
  `);
  // The child owns its blocked-attempt counter, so the parent cannot swallow the guard's
  // mandatory afterAll failure. Resolve Vitest imports from the repository installation.
  const config = join(process.cwd(), `.socket-guard-${process.pid}-${scratch.length}.config.mjs`);
  try {
    writeFileSync(config, `export default { test: { include: [${JSON.stringify(fixture)}], setupFiles: [${JSON.stringify(guard)}], fileParallelism: false } };`);
    return spawnSync(process.execPath, [cli, "run", "--config", config, "--reporter=verbose"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 4000,
      env: { ...process.env, NO_COLOR: "1", VIBECTX_CACHE_DIR: dir },
    });
  } finally { rmSync(config, { force: true }); }
}

it.each([
  ["createConnection normalized arguments", "createConnection(options)"],
  ["named connect normalized arguments", "namedConnect(options)"],
  ["HTTP normalized arguments", "http.get({ ...options, path: '/' })"],
  ["fetch automatic redirect", "redirect"],
  ["net.connect with undefined path", "net.connect({ ...options, path: undefined })"],
  ["Socket.connect with undefined path", "new net.Socket().connect({ ...options, path: undefined })"],
])("PAR-1038: %s cannot bypass socket admission or its blocked-attempt counter", (_label, connector) => {
  const result = childProbe(connector, true);
  const output = `${result.stdout}${result.stderr}`;
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(output).toContain("PAR-1038 socket admission probe");
  expect(output).toMatch(/Tests\s+1 passed/);
  expect(output).toContain("network guard blocked attempt count:");
  expect(output).toContain("socket-fixture.invalid");
  expect(output).toMatch(/expected 1 to be \+?0/);
});
it("PAR-1038: normalized loopback socket arguments still reach a real listener", () => {
  const result = childProbe("createConnection(options)", false);
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  expect(result.stdout).toMatch(/Tests\s+1 passed/);
});
