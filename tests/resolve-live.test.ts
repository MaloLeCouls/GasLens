import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanProject, scanWorkspace } from '../src/scanner.js';
import {
  analyzeLiveLibraries,
  renderResolveLiveText,
  NoopFetcher,
  type LibraryFetcher,
  type LibrarySource,
} from '../src/resolve-live.js';

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gaslens-rl-'));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content, 'utf8');
  }
  return root;
}

describe('resolve-live — projet seul', () => {
  it("classe une lib déclarée + jamais appelée en 'declared_unused'", async () => {
    const root = await makeProject({
      'appsscript.json': JSON.stringify({
        dependencies: {
          libraries: [
            { userSymbol: 'Lodash', libraryId: 'lib-id-lodash', version: '1' },
          ],
        },
      }),
      'main.gs': `function go() { return 42; }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = await analyzeLiveLibraries(idx);
      expect(report.scope).toBe('project');
      expect(report.summary.total).toBe(1);
      expect(report.summary.declared_unused).toBe(1);
      expect(report.libraries[0]).toMatchObject({
        user_symbol: 'Lodash',
        library_id: 'lib-id-lodash',
        version: '1',
        status: 'declared_unused',
        calls_count: 0,
      });
      expect(report.advice.some((a) => a.includes('Lodash'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classe une lib externe utilisée mais sans fetcher en 'external_unfetched'", async () => {
    const root = await makeProject({
      'appsscript.json': JSON.stringify({
        dependencies: {
          libraries: [
            { userSymbol: 'OAuth2', libraryId: 'sid-oauth2', version: '43' },
          ],
        },
      }),
      'main.gs': `function go() { return OAuth2.createService('x').setTokenUrl('y'); }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = await analyzeLiveLibraries(idx); // NoopFetcher implicite
      expect(report.summary.external_unfetched).toBe(1);
      const lib = report.libraries[0]!;
      expect(lib.status).toBe('external_unfetched');
      expect(lib.calls_count).toBeGreaterThanOrEqual(1);
      expect(lib.call_sites.map((s) => s.method)).toContain('createService');
      expect(report.advice.some((a) => a.includes('OAuth2'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("aucune librairie déclarée → rapport vide, summary à zéro", async () => {
    const root = await makeProject({
      'appsscript.json': '{}',
      'main.gs': `function go() { return 1; }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = await analyzeLiveLibraries(idx);
      expect(report.summary.total).toBe(0);
      expect(report.libraries).toEqual([]);
      expect(renderResolveLiveText(report)).toContain('aucune librairie');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('resolve-live — workspace multi-projets', () => {
  it("classe une lib avec un projet de même userSymbol en 'local'", async () => {
    const root = await mkdtemp(join(tmpdir(), 'gaslens-rl-ws-'));
    try {
      // Projet consommateur App qui dépend de la lib CommonUtils.
      await mkdir(join(root, 'App'), { recursive: true });
      await writeFile(
        join(root, 'App', 'appsscript.json'),
        JSON.stringify({
          dependencies: {
            libraries: [
              { userSymbol: 'CommonUtils', libraryId: 'sid-cu', version: '3' },
            ],
          },
        }),
        'utf8',
      );
      await writeFile(
        join(root, 'App', 'main.gs'),
        `function go() { return CommonUtils.log('x'); }`,
        'utf8',
      );
      // Projet librairie local.
      await mkdir(join(root, 'CommonUtils'), { recursive: true });
      await writeFile(
        join(root, 'CommonUtils', 'appsscript.json'),
        '{}',
        'utf8',
      );
      await writeFile(
        join(root, 'CommonUtils', 'lib.gs'),
        `function log(s) { return s; }`,
        'utf8',
      );
      const ws = await scanWorkspace({ root });
      const report = await analyzeLiveLibraries(ws);
      expect(report.scope).toBe('workspace');
      expect(report.summary.local).toBe(1);
      expect(report.summary.external_unfetched).toBe(0);
      const lib = report.libraries.find((l) => l.user_symbol === 'CommonUtils')!;
      expect(lib.status).toBe('local');
      expect(lib.calls_count).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('resolve-live — fetcher pluggable', () => {
  it('un fetcher qui réussit fait passer une lib externe en external_resolved', async () => {
    const root = await makeProject({
      'appsscript.json': JSON.stringify({
        dependencies: {
          libraries: [
            { userSymbol: 'OAuth2', libraryId: 'sid-oauth2', version: '43' },
          ],
        },
      }),
      'main.gs': `function go() { return OAuth2.createService('x'); }`,
    });
    try {
      const idx = await scanProject({ root });
      const okFetcher: LibraryFetcher = {
        async fetch(scriptId): Promise<LibrarySource | null> {
          expect(scriptId).toBe('sid-oauth2');
          return {
            files: [
              { name: 'appsscript.json', source: '{}', type: 'JSON' },
              { name: 'OAuth2', source: 'function createService(){}', type: 'SERVER_JS' },
            ],
          };
        },
      };
      const report = await analyzeLiveLibraries(idx, okFetcher);
      expect(report.summary.external_resolved).toBe(1);
      expect(report.libraries[0]?.status).toBe('external_resolved');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('un fetcher qui throw range la lib en external_unresolvable avec fetch_error', async () => {
    const root = await makeProject({
      'appsscript.json': JSON.stringify({
        dependencies: {
          libraries: [
            { userSymbol: 'PrivateLib', libraryId: 'sid-priv', version: '1' },
          ],
        },
      }),
      'main.gs': `function go() { return PrivateLib.api(); }`,
    });
    try {
      const idx = await scanProject({ root });
      const failingFetcher: LibraryFetcher = {
        async fetch(): Promise<LibrarySource | null> {
          throw new Error('container-bound script — not retrievable');
        },
      };
      const report = await analyzeLiveLibraries(idx, failingFetcher);
      expect(report.summary.external_unresolvable).toBe(1);
      const lib = report.libraries[0]!;
      expect(lib.status).toBe('external_unresolvable');
      expect(lib.fetch_error).toContain('container-bound');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('NoopFetcher renvoie toujours null (sentinel du default path)', async () => {
    const result = await NoopFetcher.fetch('any', null);
    expect(result).toBeNull();
  });
});
