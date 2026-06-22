import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanWorkspace } from '../src/scanner.js';
import type { WorkspaceIndex } from '../src/types.js';

/**
 * Preuve de réalisation du LOT E (G1 + G2) sur un vrai parc multi-repo :
 * une bibliothèque mère `Core` (apps/core/{dev,prod}) consommée par `dash`
 * (apps/dash/{dev,prod}). Avant E1/E2 : noms collisionnés (`dev`/`prod`) et
 * `cross_project_edges: []`. Après : noms distincts + edges résolus via le
 * manifeste maître.
 */
async function makeMultiRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gaslens-mr-'));
  await writeFile(
    join(root, 'gaslens.workspace.json'),
    JSON.stringify({
      version: 1,
      name: 'parc',
      apps: [
        { name: 'core', library_prefix: 'Core', projects: {
          dev: { script_id: 'CORE_DEV', clasp_path: 'apps/core/dev' },
          prod: { script_id: 'CORE_PROD', clasp_path: 'apps/core/prod' } } },
        { name: 'dash', projects: {
          dev: { script_id: 'DASH_DEV', clasp_path: 'apps/dash/dev' },
          prod: { script_id: 'DASH_PROD', clasp_path: 'apps/dash/prod' } } },
      ],
      library: { user_symbol: 'Core', script_id: 'CORE_LIB', prod_version: 3 },
      environments: { dev: { resources: {} }, prod: { resources: {} } },
    }),
    'utf8',
  );
  for (const env of ['dev', 'prod']) {
    const core = join(root, 'apps', 'core', env);
    await mkdir(core, { recursive: true });
    await writeFile(join(core, 'appsscript.json'), '{"runtimeVersion":"V8"}', 'utf8');
    await writeFile(join(core, 'Code.gs'), `/** Formate une date. */\nfunction formatDate(d) { return String(d); }`, 'utf8');

    const dash = join(root, 'apps', 'dash', env);
    await mkdir(dash, { recursive: true });
    await writeFile(
      join(dash, 'appsscript.json'),
      JSON.stringify({ runtimeVersion: 'V8', dependencies: { libraries: [
        { userSymbol: 'Core', libraryId: 'CORE_LIB', version: '3', developmentMode: env === 'dev' },
      ] } }),
      'utf8',
    );
    await writeFile(
      join(dash, 'Code.gs'),
      `/** Entrée web. */\nfunction doGet() { return Core.formatDate(new Date()); }`,
      'utf8',
    );
  }
  return root;
}

describe('multi-repo — E1 (noms) + E2 (edges cross-repo)', () => {
  it('G1 : les projets ont des noms distincts (chemin relatif, pas basename)', async () => {
    const root = await makeMultiRepo();
    try {
      const idx = (await scanWorkspace({ root })) as WorkspaceIndex;
      expect(idx.kind).toBe('workspace');
      const names = idx.projects.map((p) => p.project).sort();
      expect(names).toEqual([
        'apps/core/dev', 'apps/core/prod', 'apps/dash/dev', 'apps/dash/prod',
      ]);
      // plus aucune collision : autant de noms distincts que de projets.
      expect(new Set(names).size).toBe(idx.projects.length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('G2 : l\'appel Core.formatDate depuis dash est résolu en cross_project_edge', async () => {
    const root = await makeMultiRepo();
    try {
      const idx = (await scanWorkspace({ root })) as WorkspaceIndex;
      expect(idx.cross_project_edges.length).toBeGreaterThan(0);
      const devEdge = idx.cross_project_edges.find(
        (e) => e.caller_project === 'apps/dash/dev',
      );
      expect(devEdge).toBeDefined();
      expect(devEdge?.callee_project).toBe('apps/core/dev'); // env-aware : dev→dev
      expect(devEdge?.callee_function).toBe('formatDate');
      expect(devEdge?.library_prefix).toBe('Core');

      // env-aware : le consommateur prod se lie au fournisseur prod.
      const prodEdge = idx.cross_project_edges.find(
        (e) => e.caller_project === 'apps/dash/prod',
      );
      expect(prodEdge?.callee_project).toBe('apps/core/prod');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('la fonction de lib voit son caller cross-repo (propagation de régression)', async () => {
    const root = await makeMultiRepo();
    try {
      const idx = (await scanWorkspace({ root })) as WorkspaceIndex;
      const coreDev = idx.projects.find((p) => p.project === 'apps/core/dev')!;
      const formatDate = coreDev.functions.find((f) => f.name === 'formatDate')!;
      // formatDate est désormais "appelée par" dash/dev → un changement de sa
      // signature serait propagé comme régression.
      expect(formatDate.called_by.some((c) => c.caller_project === 'apps/dash/dev')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
