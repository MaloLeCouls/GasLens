import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildParcOverview,
  renderParcOverviewText,
  renderRegistryText,
} from '../src/parc-overview.js';

const LIB_ID = 'LIB_SCRIPT_ID_0000000000000000000000000';
const SHEET_DEV = 'SHEET_DEV_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const SHEET_PROD = 'SHEET_PROD_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function masterManifest(): string {
  return JSON.stringify({
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
    library: { user_symbol: 'Core', script_id: LIB_ID, prod_version: 12 },
    environments: {
      dev: { resources: { mainSheet: SHEET_DEV } },
      prod: { resources: { mainSheet: SHEET_PROD } },
    },
  });
}

function libDep(opts: { version: string; developmentMode: boolean }): string {
  return JSON.stringify({
    runtimeVersion: 'V8',
    dependencies: {
      libraries: [
        {
          userSymbol: 'Core',
          libraryId: LIB_ID,
          version: opts.version,
          developmentMode: opts.developmentMode,
        },
      ],
    },
  });
}

interface ProjectSpec {
  lib: { version: string; developmentMode: boolean };
  code: string;
}

async function makeWorkspace(dev: ProjectSpec, prod: ProjectSpec): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gaslens-parc-'));
  await writeFile(join(root, 'gaslens.workspace.json'), masterManifest(), 'utf8');
  for (const [env, spec] of [['dev', dev], ['prod', prod]] as const) {
    const dir = join(root, 'apps', 'dashboard', env);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'appsscript.json'), libDep(spec.lib), 'utf8');
    await writeFile(join(dir, 'Code.gs'), spec.code, 'utf8');
  }
  return root;
}

const CLEAN_DEV: ProjectSpec = {
  lib: { version: '12', developmentMode: true },
  code: `/**\n * Ouvre la ressource.\n */\nfunction open() { return Config.get('mainSheet'); }`,
};
const CLEAN_PROD: ProjectSpec = {
  lib: { version: '12', developmentMode: false },
  code: `function open() { return Config.get('mainSheet'); }`,
};

describe('workspace overview (F6)', () => {
  it('synthétise apps × dev/prod, version lib, verdict env, couverture doc', async () => {
    const root = await makeWorkspace(CLEAN_DEV, CLEAN_PROD);
    try {
      const r = await buildParcOverview({ root });
      expect(r.manifest_present).toBe(true);
      expect(r.library?.prod_version).toBe(12);
      expect(r.apps).toHaveLength(1);
      const app = r.apps[0]!;
      expect(app.name).toBe('dashboard');
      const dev = app.envs.find((e) => e.env === 'dev')!;
      const prod = app.envs.find((e) => e.env === 'prod')!;
      expect(dev.lib_mode).toBe('HEAD');
      expect(prod.lib_mode).toBe('pinned');
      expect(prod.lib_version).toBe('12');
      // dev : 1 fonction publique documentée → 100 % ; prod : 0/1 → 0 %.
      expect(dev.doc_coverage_pct).toBe(100);
      expect(prod.doc_coverage_pct).toBe(0);
      expect(dev.functions).toBe(1);
      expect(r.env_verdict).toBe('CLEAN');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('remonte le verdict env validate par app/env (BREAK sur fuite inter-env)', async () => {
    const root = await makeWorkspace(CLEAN_DEV, {
      lib: CLEAN_PROD.lib,
      code: `function open() { return SpreadsheetApp.openById('${SHEET_DEV}'); }`,
    });
    try {
      const r = await buildParcOverview({ root });
      expect(r.env_verdict).toBe('BREAK');
      const prod = r.apps[0]!.envs.find((e) => e.env === 'prod')!;
      expect(prod.env_verdict).toBe('BREAK');
      const dev = r.apps[0]!.envs.find((e) => e.env === 'dev')!;
      expect(dev.env_verdict).toBe('CLEAN');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('--no-scan : pas de couverture doc ni de compte de fonctions', async () => {
    const root = await makeWorkspace(CLEAN_DEV, CLEAN_PROD);
    try {
      const r = await buildParcOverview({ root, noScan: true });
      const dev = r.apps[0]!.envs.find((e) => e.env === 'dev')!;
      expect(dev.functions).toBeNull();
      expect(dev.doc_coverage_pct).toBeNull();
      // La version de lib est lue depuis appsscript.json (pas besoin de scan).
      expect(dev.lib_mode).toBe('HEAD');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('marque un projet déclaré mais non cloné (dossier absent)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gaslens-parc-'));
    await writeFile(join(root, 'gaslens.workspace.json'), masterManifest(), 'utf8');
    try {
      const r = await buildParcOverview({ root });
      const dev = r.apps[0]!.envs.find((e) => e.env === 'dev')!;
      expect(dev.present).toBe(false);
      expect(dev.functions).toBeNull();
      expect(renderParcOverviewText(r)).toContain('non cloné');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('registre (G4) : expose le plan de masse enrichi', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gaslens-parc-'));
    const enriched = JSON.stringify({
      version: 1,
      name: 'parc',
      apps: [
        {
          name: 'dashboard',
          description: 'Tableau de bord commercial',
          library_prefix: 'Core',
          site_embeds: ['https://sites.google.com/view/x/accueil'],
          projects: {
            prod: {
              script_id: 'DASH_PROD',
              clasp_path: 'apps/dashboard/prod',
              gcp_project_id: 'gcp-dash-123',
              exec_url: 'https://script.google.com/.../exec',
              container_id: 'DRIVE_FILE_ID_XYZ',
            },
          },
        },
      ],
      library: { user_symbol: 'Core', script_id: LIB_ID, prod_version: 12 },
      environments: { dev: { resources: {} }, prod: { resources: {} } },
    });
    await writeFile(join(root, 'gaslens.workspace.json'), enriched, 'utf8');
    try {
      const r = await buildParcOverview({ root, noScan: true });
      const app = r.apps[0]!;
      expect(app.description).toBe('Tableau de bord commercial');
      expect(app.site_embeds).toEqual(['https://sites.google.com/view/x/accueil']);
      const prod = app.envs.find((e) => e.env === 'prod')!;
      expect(prod.gcp_project_id).toBe('gcp-dash-123');
      expect(prod.exec_url).toContain('/exec');
      expect(prod.container_id).toBe('DRIVE_FILE_ID_XYZ');
      const reg = renderRegistryText(r);
      expect(reg).toContain('Plan de masse');
      expect(reg).toContain('gcp-dash-123');
      expect(reg).toContain('Tableau de bord commercial');
      expect(reg).toContain('embarquée dans Site');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('no-op honnête sans manifeste maître', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gaslens-parc-'));
    try {
      const r = await buildParcOverview({ root });
      expect(r.manifest_present).toBe(false);
      expect(r.apps).toEqual([]);
      expect(renderParcOverviewText(r)).toContain('parc:');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
