import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanProject, scanWorkspace } from '../src/scanner.js';
import { analyzeLiveLibraries } from '../src/resolve-live.js';
import { createDiskCachedFetcher } from '../src/fetchers/lib-cache.js';
import {
  enrichWorkspaceWithLibraries,
  renameProject,
} from '../src/enrich-workspace.js';
import type {
  LibraryFetcher,
  LibrarySource,
} from '../src/resolve-live.js';
import type { WorkspaceIndex } from '../src/types.js';

function oauthLikeFetcher(): LibraryFetcher {
  return {
    async fetch(scriptId): Promise<LibrarySource | null> {
      if (scriptId !== 'sid-oauth2') return null;
      return {
        files: [
          { name: 'appsscript', source: '{}', type: 'JSON' },
          {
            name: 'OAuth2',
            source: 'function createService(name){ return { setTokenUrl: function(){} }; }',
            type: 'SERVER_JS',
          },
        ],
        meta: { scriptId },
      };
    },
  };
}

async function makeConsumer(root: string): Promise<void> {
  await writeFile(
    join(root, 'appsscript.json'),
    JSON.stringify({
      dependencies: {
        libraries: [
          { userSymbol: 'OAuth2', libraryId: 'sid-oauth2', version: '43' },
        ],
      },
    }),
    'utf8',
  );
  await writeFile(
    join(root, 'main.gs'),
    `function go() { return OAuth2.createService('x'); }`,
    'utf8',
  );
}

describe('renameProject', () => {
  it('renomme project + FunctionRecord.project + préfixe id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gaslens-rename-'));
    try {
      await writeFile(
        join(root, 'main.gs'),
        'function f(){} function g(){ f(); }',
        'utf8',
      );
      const idx = await scanProject({ root });
      expect(idx.project).not.toBe('NewLib');
      const renamed = renameProject(idx, 'NewLib');
      expect(renamed.project).toBe('NewLib');
      for (const fn of renamed.functions) {
        expect(fn.project).toBe('NewLib');
        expect(fn.id.startsWith('NewLib::')).toBe(true);
      }
      // L'original est inchangé (clone profond).
      expect(idx.project).not.toBe('NewLib');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('enrichWorkspaceWithLibraries — projet seul → workspace enrichi', () => {
  it("matérialise la lib via cache, l'indexe et résout cross_project_edges", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'gaslens-enrich-'));
    const cacheDir = await mkdtemp(join(tmpdir(), 'gaslens-cache-'));
    try {
      await makeConsumer(projectRoot);
      const idx = await scanProject({ root: projectRoot });
      const fetcher = createDiskCachedFetcher(oauthLikeFetcher(), { cacheDir });
      const report = await analyzeLiveLibraries(idx, fetcher);
      expect(report.summary.external_resolved).toBe(1);
      expect(report.fetched_sources).toHaveLength(1);

      const enriched = await enrichWorkspaceWithLibraries(idx, {
        cacheDir,
        fetched_sources: report.fetched_sources!,
      });
      expect(enriched.kind).toBe('workspace');
      const projects = enriched.projects.map((p) => p.project).sort();
      expect(projects).toContain('OAuth2');
      // Une arête cross-project : go() @ projet consumer → createService @ OAuth2.
      const edges = enriched.cross_project_edges;
      const oauth = edges.find((e) => e.callee_project === 'OAuth2');
      expect(oauth).toBeDefined();
      expect(oauth?.callee_function).toBe('createService');
      // La fonction createService doit avoir un called_by cross-project.
      const oauthProj = enriched.projects.find((p) => p.project === 'OAuth2')!;
      const createService = oauthProj.functions.find(
        (f) => f.name === 'createService',
      )!;
      expect(createService.called_by.some((c) => c.caller_project)).toBe(true);
      // Et une exposure de type 'library'.
      expect(createService.exposures.some((e) => e.type === 'library')).toBe(true);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it('idempotent — enrichir un workspace déjà résolu donne le même résultat', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'gaslens-enrich-'));
    const cacheDir = await mkdtemp(join(tmpdir(), 'gaslens-cache-'));
    try {
      await makeConsumer(projectRoot);
      const idx = await scanProject({ root: projectRoot });
      const fetcher = createDiskCachedFetcher(oauthLikeFetcher(), { cacheDir });
      const report = await analyzeLiveLibraries(idx, fetcher);
      const e1 = await enrichWorkspaceWithLibraries(idx, {
        cacheDir,
        fetched_sources: report.fetched_sources!,
      });
      const e2 = await enrichWorkspaceWithLibraries(e1, {
        cacheDir,
        fetched_sources: report.fetched_sources!,
      });
      expect(e2.cross_project_edges.length).toBe(e1.cross_project_edges.length);
      // Pas de duplication des called_by ni des exposures library.
      const oauthFn1 = e1.projects
        .find((p) => p.project === 'OAuth2')!
        .functions.find((f) => f.name === 'createService')!;
      const oauthFn2 = e2.projects
        .find((p) => p.project === 'OAuth2')!
        .functions.find((f) => f.name === 'createService')!;
      const cb1 = oauthFn1.called_by.filter((c) => c.caller_project).length;
      const cb2 = oauthFn2.called_by.filter((c) => c.caller_project).length;
      expect(cb2).toBe(cb1);
      const lib1 = oauthFn1.exposures.filter((e) => e.type === 'library').length;
      const lib2 = oauthFn2.exposures.filter((e) => e.type === 'library').length;
      expect(lib2).toBe(lib1);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("ne re-scanne pas la lib si un projet 'local' du même user_symbol existe déjà", async () => {
    const root = await mkdtemp(join(tmpdir(), 'gaslens-enrich-mix-'));
    const cacheDir = await mkdtemp(join(tmpdir(), 'gaslens-cache-'));
    try {
      // Workspace avec un projet OAuth2 local.
      await mkdir(join(root, 'App'), { recursive: true });
      await makeConsumer(join(root, 'App'));
      await mkdir(join(root, 'OAuth2'), { recursive: true });
      await writeFile(join(root, 'OAuth2', 'appsscript.json'), '{}', 'utf8');
      await writeFile(
        join(root, 'OAuth2', 'lib.gs'),
        'function createService(){ return null; }',
        'utf8',
      );
      const ws = (await scanWorkspace({ root })) as WorkspaceIndex;
      const fetcher = createDiskCachedFetcher(oauthLikeFetcher(), { cacheDir });
      // Le rapport ne devrait PAS fetcher la lib (status local).
      const report = await analyzeLiveLibraries(ws, fetcher);
      expect(report.libraries[0]?.status).toBe('local');
      expect(report.fetched_sources ?? []).toHaveLength(0);
      // Enrichir avec une liste vide ne change rien.
      const enriched = await enrichWorkspaceWithLibraries(ws, {
        cacheDir,
        fetched_sources: [],
      });
      expect(enriched.projects.map((p) => p.project).sort()).toEqual([
        'App',
        'OAuth2',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});
