import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWorkspaceFiles, writeWorkspace } from '../src/workspace-init.js';
import { runDoctor } from '../src/doctor.js';
import { runEnvValidate } from '../src/env-validate.js';
import { scanProject } from '../src/scanner.js';
import { lintDoc } from '../src/doc-lint.js';
import { loadWorkspaceManifest } from '../src/workspace-manifest.js';

/**
 * Éval d'installation « jour-1 à blanc » (V5 §35/§37.7) — le pendant des évals
 * d'analyse. Déroule le flux complet sur un dossier vierge : scaffold → doctor
 * → onboarding d'une app → env validate → scan + doc lint. Si une étape casse,
 * c'est une régression d'installation.
 */
describe('install flow — jour 1 de bout en bout', () => {
  it('scaffold → doctor → onboard → env validate → scan tiennent ensemble', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gaslens-home-'));
    const root = await mkdtemp(join(tmpdir(), 'gaslens-ws-'));
    try {
      await writeFile(join(home, '.clasprc.json'), '{}', 'utf8'); // clasp « connecté »

      // 1) gaslens workspace init <nom>
      const files = buildWorkspaceFiles({ name: 'parc' });
      const { written, skipped } = await writeWorkspace(root, files);
      expect(skipped).toEqual([]);
      expect(written).toContain('gaslens.workspace.json');
      expect(written).toContain('.claude/settings.json');

      // Le settings.json déclare la marketplace + le plugin (install auto-proposée).
      const settings = JSON.parse(
        await (await import('node:fs/promises')).readFile(
          join(root, '.claude/settings.json'),
          'utf8',
        ),
      );
      expect(settings.enabledPlugins).toContain('gaslens@gaslens');

      // Le manifeste squelette est valide.
      const loaded = await loadWorkspaceManifest(root);
      expect(loaded.manifest).not.toBeNull();

      // 2) SessionStart → gaslens doctor (env injecté, FS réel sur le scaffold)
      const doc = await runDoctor({
        cwd: root,
        nodeVersion: '22.0.0',
        which: () => true,
        home,
      });
      expect(doc.checks.find((c) => c.id === 'workspace-manifest')?.status).toBe('ok');
      expect(doc.checks.find((c) => c.id === 'plugin-enabled')?.status).toBe('ok');
      expect(doc.checks.find((c) => c.id === 'index')?.status).toBe('info'); // pas encore scanné
      expect(doc.exit_code).toBe(0);

      // 3) Onboard d'une app : on remplit le manifeste maître + les 2 projets.
      await writeFile(
        join(root, 'gaslens.workspace.json'),
        JSON.stringify({
          version: 1,
          name: 'parc',
          apps: [
            {
              name: 'dashboard',
              library_prefix: 'Core',
              projects: {
                dev: { script_id: 'DEV', clasp_path: 'apps/dashboard/dev' },
                prod: { script_id: 'PROD', clasp_path: 'apps/dashboard/prod' },
              },
            },
          ],
          library: { user_symbol: 'Core', script_id: 'LIB', prod_version: 12 },
          environments: {
            dev: { resources: { mainSheet: 'S_DEV' } },
            prod: { resources: { mainSheet: 'S_PROD' } },
          },
        }),
        'utf8',
      );
      for (const [env, dev] of [['dev', true], ['prod', false]] as const) {
        const dir = join(root, 'apps', 'dashboard', env);
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, 'appsscript.json'),
          JSON.stringify({
            runtimeVersion: 'V8',
            dependencies: {
              libraries: [
                { userSymbol: 'Core', libraryId: 'LIB', version: '12', developmentMode: dev },
              ],
            },
          }),
          'utf8',
        );
        await writeFile(
          join(dir, 'Code.gs'),
          `/**\n * Ouvre la feuille principale de l'app.\n */\nfunction open_() { return Config.get('mainSheet'); }`,
          'utf8',
        );
      }

      // 4) env validate → CLEAN (prod figée, dev HEAD, pas d'id en dur, symétrie)
      const env = await runEnvValidate({ root });
      expect(env.verdict).toBe('CLEAN');
      expect(env.coverage.checked.length).toBe(2);

      // 5) scan + doc lint de bout en bout sur l'app
      const idx = await scanProject({ root: join(root, 'apps', 'dashboard', 'dev') });
      expect(idx.functions.some((f) => f.name === 'open_')).toBe(true);
      const docLint = lintDoc(idx);
      expect(docLint.verdict).toBe('CLEAN'); // open_ a une intention → pas undocumented
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it('un parc fraîchement scaffoldé sans app : env validate est un no-op CLEAN', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gaslens-ws-'));
    try {
      await writeWorkspace(root, buildWorkspaceFiles({ name: 'vide' }));
      const env = await runEnvValidate({ root });
      expect(env.manifest_present).toBe(true);
      expect(env.verdict).toBe('CLEAN');
      expect(env.findings).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
