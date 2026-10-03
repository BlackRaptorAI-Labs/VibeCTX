import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCache, libDirName, urlSlug } from '../src/cache.js';
import { getDocsToolText } from '../src/get-docs.js';
import { entryForVersion, loadRegistry, type Registry } from '../src/registry.js';
import { readResolvedEntries, toResolvedEntry } from '../src/resolved-store.js';
import { versionReadmeCandidates } from '../src/resolve.js';
import { runSearch } from '../src/search.js';
import { runWarm } from '../src/warm.js';
import { resetSearchIndexMemo } from '../src/search-index.js';
import { resetResolutionWindow, resolveToolText } from '../src/resolve.js';
import { refreshToolText } from '../src/refresh.js';
import { stubPublicDns } from './helpers/public-dns.js';
let dir: string;
const latest = 'https://elysiajs.com/llms.txt';
const v1 = 'https://raw.githubusercontent.com/elysiajs/elysia/refs/tags/v1.2.3/README.md';
const v2 = 'https://raw.githubusercontent.com/elysiajs/elysia/refs/tags/v2.0.0/README.md';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'test-audit-1031-'));
  process.env.VIBECTX_CACHE_DIR = dir;
  resetSearchIndexMemo(); resetResolutionWindow(); stubPublicDns();
});
afterEach(() => {
  delete process.env.VIBECTX_CACHE_DIR;
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});
function fetchRoutes(extraPages: Record<string, unknown> = {}) {
  const meta = { homepage: 'https://elysiajs.com', repository: 'https://github.com/elysiajs/elysia' };
  const pages: Record<string, unknown> = {
    'https://registry.npmjs.org/elysia/latest': meta,
    'https://registry.npmjs.org/elysia/1.2.3': meta,
    'https://registry.npmjs.org/elysia/2.0.0': meta,
    [v1]: '# Elysia\n\n## Middleware\n\nFirst pinned middleware API.',
    [v2]: '# Elysia\n\n## Middleware\n\nSecond pinned middleware API.',
    ...extraPages,
  };
  const spy = vi.fn(async (url: unknown) => {
    const body = pages[String(url)];
    return body === undefined ? new Response('not found', { status: 404 }) : new Response(typeof body === 'string' ? body : JSON.stringify(body), { headers: { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json' } });
  });
  vi.stubGlobal('fetch', spy); return spy;
}
it('PAR-1031: an earlier exact pin remains usable in the live registry after another pin resolves', async () => {
  fetchRoutes();
  const reg: Registry = { entries: new Map() };
  await getDocsToolText(reg, { library: 'elysia', version: '1.2.3', topic: 'middleware' });
  await getDocsToolText(reg, { library: 'elysia', version: '2.0.0', topic: 'middleware' });
  writeCache('elysia', latest, '# Elysia\n\n## Middleware\n\nLatest middleware API.');
  expect(readResolvedEntries()[0].versionedDocuments).toHaveLength(2);
  const restarted = await getDocsToolText(loadRegistry(), { library: 'elysia', version: '1.2.3', topic: 'middleware', offline: true });
  expect(restarted).toContain('First pinned middleware API.');
  const current = await getDocsToolText(reg, { library: 'elysia', version: '1.2.3', topic: 'middleware', offline: true });
  expect(current).toContain('First pinned middleware API.');
});
it('PAR-1031: search keeps a cached latest document ahead of a fresh pinned fallback', () => {
  const entry = { name: 'elysia', urls: [latest], versionedDocuments: [{ version: '1.2.3', url: v1 }] };
  writeCache('elysia', latest, '# Elysia\n\n## Middleware\n\nLatest middleware API.');
  const path = join(dir, libDirName('elysia'), `${urlSlug(latest)}.meta.json`);
  const meta = JSON.parse(readFileSync(path, 'utf8'));
  meta.fetchedAt = '2000-01-01T00:00:00.000Z'; writeFileSync(path, JSON.stringify(meta));
  writeCache('elysia', v1, '# Elysia\n\n## Middleware\n\nPinned middleware API.');
  const out = runSearch({ entries: new Map([['elysia', entry]]) }, { query: 'middleware' });
  expect(out.groups[0]).toMatchObject({ url: latest, stale: true });
  expect(out.groups[0].version).toBeUndefined();
});
it('PAR-1031: restarted get_docs selects the requested pin from multiple cached versions', async () => {
  fetchRoutes();
  const reg: Registry = { entries: new Map() };
  await getDocsToolText(reg, { library: 'elysia', version: '1.2.3', topic: 'middleware' });
  await getDocsToolText(reg, { library: 'elysia', version: '2.0.0', topic: 'middleware' });
  const spy = vi.fn(() => { throw new Error('offline network'); }); vi.stubGlobal('fetch', spy);
  const restarted = loadRegistry();
  const current = await getDocsToolText(restarted, { library: 'elysia', version: '2.0.0', topic: 'middleware', offline: true });
  expect(current).toContain('Second pinned middleware API.');
  expect(current).not.toContain('First pinned middleware API.'); expect(spy).not.toHaveBeenCalled();
});
it('PAR-1031: search keeps the version label when reusing a stored index', () => {
  writeCache('elysia', v1, '# Elysia\n\n## Middleware\n\nPinned middleware API.');
  const reg = { entries: new Map([['elysia', { name: 'elysia', urls: [latest], versionedDocuments: [{ version: '1.2.3', url: v1 }] }]]) };
  runSearch(reg, { query: 'middleware' });
  const out = runSearch(reg, { query: 'middleware' });
  expect(out.fromIndex).toBe(1); expect(out.groups[0].version).toBe('1.2.3');
});
it('PAR-1031: offline warm retains its earlier project pin after another version resolves', async () => {
  fetchRoutes();
  const reg: Registry = { entries: new Map() };
  const project = join(dir, 'project'); mkdirSync(project);
  writeFileSync(join(project, 'package.json'), JSON.stringify({ dependencies: { elysia: '1.2.3' } }));
  const first = await runWarm(reg, { dir: project });
  expect(first.dependencies[0].url).toBe(v1);
  await getDocsToolText(reg, { library: 'elysia', version: '2.0.0', topic: 'middleware' });
  writeCache('elysia', latest, '# Elysia\n\n## Middleware\n\nLatest middleware API.');
  const spy = vi.fn(() => { throw new Error('offline network'); }); vi.stubGlobal('fetch', spy);
  const restarted = await runWarm(loadRegistry(), { dir: project, offline: true });
  expect(restarted.dependencies[0].url).toBe(v1);
  const current = await runWarm(reg, { dir: project, offline: true });
  expect(spy).not.toHaveBeenCalled();
  expect(current.dependencies[0]).toMatchObject({ status: 'already fresh', url: v1 });
  expect(current.dependencies[0].note).toBeUndefined();
});
it('PAR-1031: a missing exact-pin cache never silently serves latest', async () => {
  fetchRoutes();
  const reg: Registry = { entries: new Map() };
  await getDocsToolText(reg, { library: 'elysia', version: '1.2.3', topic: 'middleware' });
  writeCache('elysia', latest, '# Elysia\n\n## Middleware\n\nLatest middleware API.');
  rmSync(join(dir, libDirName('elysia'), `${urlSlug(v1)}.md`));
  const spy = vi.fn(() => { throw new Error('offline network'); }); vi.stubGlobal('fetch', spy);
  const out = await getDocsToolText(loadRegistry(), { library: 'elysia', version: '1.2.3', topic: 'middleware', offline: true });
  expect(out).not.toContain('Latest middleware API.');
  expect(out).toContain('Source: none · nothing cached');
  expect(out).toContain(v1); expect(spy).not.toHaveBeenCalled();
});

it('PAR-1031: changing the resolved ecosystem discards earlier pins in memory and on disk', async () => {
  const pythonLatest = 'https://raw.githubusercontent.com/fixture-org/python-elysia/HEAD/README.md';
  fetchRoutes({
    'https://pypi.org/pypi/elysia/json': { info: { project_urls: { Repository: 'https://github.com/fixture-org/python-elysia' } } },
    [pythonLatest]: '# Python Elysia\n\n## Middleware\n\nPython middleware API.',
  });
  const reg: Registry = { entries: new Map() };
  await getDocsToolText(reg, { library: 'elysia', version: '1.2.3', topic: 'middleware' });
  expect(reg.entries.get('elysia')?.versionedDocuments).toEqual([{ version: '1.2.3', url: v1 }]);
  await resolveToolText(reg, 'elysia', 'pypi');
  expect(reg.entries.get('elysia')?.resolved?.source).toBe('pypi');
  expect(reg.entries.get('elysia')?.versionedDocuments).toBeUndefined();
  const restarted = loadRegistry();
  expect(restarted.entries.get('elysia')?.resolved?.source).toBe('pypi');
  expect(restarted.entries.get('elysia')?.versionedDocuments).toBeUndefined();
  const spy = vi.fn(() => { throw new Error('offline network'); }); vi.stubGlobal('fetch', spy);
  const out = await getDocsToolText(restarted, { library: 'elysia', version: '1.2.3', topic: 'middleware', offline: true });
  expect(out).toContain('Python middleware API.');
  expect(out).not.toContain('First pinned middleware API.');
  expect(out).not.toContain('· version 1.2.3');
  expect(spy).not.toHaveBeenCalled();
});

it('PAR-1031: refreshing latest retains registered pinned documents for offline reads', async () => {
  fetchRoutes({ [latest]: '# Elysia\n\n## Middleware\n\nLatest middleware API.' });
  const reg: Registry = { entries: new Map() };
  await getDocsToolText(reg, { library: 'elysia', version: '1.2.3', topic: 'middleware' });
  expect(await refreshToolText(reg, 'elysia')).toContain('refreshed from');
  const spy = vi.fn(() => { throw new Error('offline network'); }); vi.stubGlobal('fetch', spy);
  const out = await getDocsToolText(loadRegistry(), { library: 'elysia', version: '1.2.3', topic: 'middleware', offline: true });
  expect(out).toContain('First pinned middleware API.');
  expect(out).toContain('· version 1.2.3');
  expect(spy).not.toHaveBeenCalled();
});

it.each([
  'https://unrelated.example/README.md',
  'https://raw.githubusercontent.com/elysiajs/elysia/HEAD/README.md',
  'https://raw.githubusercontent.com/elysiajs/elysia/refs/heads/1.2.3/README.md',
  'https://raw.githubusercontent.com/elysiajs/elysia/refs/tags/v9.9.9/README.md',
])('PAR-1031: rejects a stored or live exact-pin mapping to %s', (url) => {
  const entry = {
    name: 'elysia', urls: [latest], versionedDocuments: [{ version: '1.2.3', url }],
    resolved: { source: 'npm' as const, resolvedAt: '2026-09-01T00:00:00.000Z', metadataUrl: 'https://registry.npmjs.org/elysia/latest' },
  };
  expect(toResolvedEntry(entry)).toBeUndefined();
  expect(entryForVersion(entry, '1.2.3')).toBeUndefined();
});

it('PAR-1031: accepts every generated tag spelling and README variant for validated version shapes', () => {
  for (const version of ['1.2.3', 'v1.2.3', '1.2.3-beta+build', '1_2_3', '1.2.3.post1', 'A'.repeat(128)]) {
    for (const repo of [{ owner: 'elysiajs', repo: 'elysia' }, { owner: 'A-C_m.e', repo: 'pkg._-name' }]) {
      const candidates = versionReadmeCandidates(repo, version);
      expect(candidates).toHaveLength(8);
      for (const url of candidates) {
        const entry = {
          name: 'elysia', urls: [latest], versionedDocuments: [{ version, url }],
          resolved: { source: 'npm' as const, resolvedAt: '2026-09-01T00:00:00.000Z', metadataUrl: 'https://registry.npmjs.org/elysia/latest' },
        };
        expect(toResolvedEntry(entry)?.versionedDocuments, url).toEqual([{ version, url }]);
        expect(entryForVersion(entry, version)?.urls, url).toEqual([url]);
      }
    }
  }
});
