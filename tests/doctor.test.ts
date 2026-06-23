import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor, renderDoctorText } from '../src/doctor.js';

const VALID_MASTER = JSON.stringify({
  version: 1,
  name: 'parc',
  environments: { dev: { resources: {} }, prod: { resources: {} } },
});

const PLUGIN_SETTINGS = JSON.stringify({
  extraKnownMarketplaces: { gaslens: { source: 'MaloLeCouls/GasLens' } },
  enabledPlugins: ['gaslens@gaslens'],
});

async function tempWith(manifest: string | null): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gaslens-doctor-'));
  if (manifest !== null) {
    await writeFile(join(root, 'gaslens.workspace.json'), manifest, 'utf8');
  }
  // Le check plugin lit réellement .claude/settings.json (déclaration du plugin).
  await mkdir(join(root, '.claude'), { recursive: true });
  await writeFile(join(root, '.claude', 'settings.json'), PLUGIN_SETTINGS, 'utf8');
  return root;
}

describe('doctor', () => {
  it('tout prêt → ok=true, exit 0, aucun error/warn', async () => {
    const root = await tempWith(VALID_MASTER);
    try {
      const r = await runDoctor({
        cwd: root,
        nodeVersion: '22.5.0',
        which: () => true,
        fileExists: () => true,
        home: root,
      });
      expect(r.exit_code).toBe(0);
      expect(r.ok).toBe(true);
      expect(r.checks.some((c) => c.status === 'error' || c.status === 'warn')).toBe(false);
      expect(r.checks.find((c) => c.id === 'node-version')?.status).toBe('ok');
      expect(r.checks.find((c) => c.id === 'workspace-manifest')?.status).toBe('ok');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('Node trop ancien → error + exit 1', async () => {
    const root = await tempWith(VALID_MASTER);
    try {
      const r = await runDoctor({
        cwd: root,
        nodeVersion: '20.10.0',
        which: () => true,
        fileExists: () => true,
        home: root,
      });
      expect(r.exit_code).toBe(1);
      expect(r.ok).toBe(false);
      const node = r.checks.find((c) => c.id === 'node-version');
      expect(node?.status).toBe('error');
      expect(node?.fix_hint).toContain('nvm');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('clasp non connecté → warn (ok=false) mais exit 0', async () => {
    const root = await tempWith(VALID_MASTER);
    try {
      const r = await runDoctor({
        cwd: root,
        nodeVersion: '22.0.0',
        which: () => true,
        fileExists: (p) => !p.endsWith('.clasprc.json'),
        home: root,
      });
      expect(r.exit_code).toBe(0);
      expect(r.ok).toBe(false);
      expect(r.checks.find((c) => c.id === 'clasp-login')?.status).toBe('warn');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('manifeste maître invalide → error', async () => {
    const root = await tempWith('{ pas du json');
    try {
      const r = await runDoctor({
        cwd: root,
        nodeVersion: '22.0.0',
        which: () => true,
        fileExists: () => true,
        home: root,
      });
      expect(r.checks.find((c) => c.id === 'workspace-manifest')?.status).toBe('error');
      expect(r.exit_code).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('API Apps Script + Chrome restent "manual" (jamais OK ni cassé)', async () => {
    const root = await tempWith(VALID_MASTER);
    try {
      const r = await runDoctor({
        cwd: root,
        nodeVersion: '22.0.0',
        which: () => true,
        fileExists: () => true,
        home: root,
      });
      expect(r.checks.find((c) => c.id === 'apps-script-api')?.status).toBe('manual');
      expect(r.checks.find((c) => c.id === 'chrome-remote-debug')?.status).toBe('manual');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('renderDoctorText --quiet-when-ok est vide quand tout est prêt', async () => {
    const root = await tempWith(VALID_MASTER);
    try {
      const r = await runDoctor({
        cwd: root,
        nodeVersion: '22.0.0',
        which: () => true,
        fileExists: () => true,
        home: root,
      });
      expect(renderDoctorText(r, true)).toBe('');
      expect(renderDoctorText(r, false).length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('doctor — E3 (durcissement multi-repo)', () => {
  const MASTER_WITH_APP = JSON.stringify({
    version: 1,
    name: 'parc',
    apps: [
      { name: 'dash', projects: {
        dev: { script_id: 'DASH_DEV', clasp_path: 'apps/dash/dev' },
        prod: { script_id: 'DASH_PROD', clasp_path: 'apps/dash/prod' } } },
    ],
    environments: { dev: { resources: {} }, prod: { resources: {} } },
  });

  it('clasp-config WARN quand le scriptId de .clasp.json diverge du manifeste', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gaslens-doctor-'));
    try {
      await writeFile(join(root, 'gaslens.workspace.json'), MASTER_WITH_APP, 'utf8');
      await mkdir(join(root, '.claude'), { recursive: true });
      await writeFile(join(root, '.claude', 'settings.json'), PLUGIN_SETTINGS, 'utf8');
      await writeFile(join(root, '.clasprc.json'), '{}', 'utf8'); // clasp « connecté » (home=root)
      for (const [env, sid] of [['dev', 'DASH_DEV'], ['prod', 'WRONG_ID']] as const) {
        const dir = join(root, 'apps', 'dash', env);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'appsscript.json'), '{}', 'utf8');
        await writeFile(join(dir, '.clasp.json'), JSON.stringify({ scriptId: sid }), 'utf8');
      }
      const r = await runDoctor({ cwd: root, nodeVersion: '22.0.0', which: () => true, home: root });
      const clasp = r.checks.find((c) => c.id === 'clasp-config');
      expect(clasp?.status).toBe('warn');
      expect(clasp?.detail).toContain('dash/prod');
      expect(r.ok).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('baselines INFO quand un projet cloné n’a pas de baseline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gaslens-doctor-'));
    try {
      await writeFile(join(root, 'gaslens.workspace.json'), MASTER_WITH_APP, 'utf8');
      await mkdir(join(root, '.claude'), { recursive: true });
      await writeFile(join(root, '.claude', 'settings.json'), PLUGIN_SETTINGS, 'utf8');
      const dir = join(root, 'apps', 'dash', 'dev'); // cloné mais pas de .gaslens
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'appsscript.json'), '{}', 'utf8');
      await writeFile(join(dir, '.clasp.json'), JSON.stringify({ scriptId: 'DASH_DEV' }), 'utf8');
      const r = await runDoctor({ cwd: root, nodeVersion: '22.0.0', which: () => true, home: root });
      const bl = r.checks.find((c) => c.id === 'baselines');
      expect(bl?.status).toBe('info');
      expect(bl?.detail).toContain('dash/dev');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('plugin-enabled WARN quand settings.json existe mais ne déclare pas le plugin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gaslens-doctor-'));
    try {
      await writeFile(join(root, 'gaslens.workspace.json'), VALID_MASTER, 'utf8');
      await mkdir(join(root, '.claude'), { recursive: true });
      await writeFile(join(root, '.claude', 'settings.json'), '{}', 'utf8'); // pas d'enabledPlugins
      const r = await runDoctor({ cwd: root, nodeVersion: '22.0.0', which: () => true, home: root });
      expect(r.checks.find((c) => c.id === 'plugin-enabled')?.status).toBe('warn');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('library WARN quand une app expose un library_prefix mais le manifeste ne déclare pas library', async () => {
    const masterProviderNoLib = JSON.stringify({
      version: 1,
      name: 'parc',
      apps: [
        {
          name: 'core',
          library_prefix: 'Core',
          projects: {
            dev: { script_id: 'CORE_DEV', clasp_path: 'apps/core/dev' },
            prod: { script_id: 'CORE_PROD', clasp_path: 'apps/core/prod' },
          },
        },
      ],
      environments: { dev: { resources: {} }, prod: { resources: {} } },
    });
    const root = await mkdtemp(join(tmpdir(), 'gaslens-doctor-'));
    try {
      await writeFile(join(root, 'gaslens.workspace.json'), masterProviderNoLib, 'utf8');
      await mkdir(join(root, '.claude'), { recursive: true });
      await writeFile(join(root, '.claude', 'settings.json'), PLUGIN_SETTINGS, 'utf8');
      const r = await runDoctor({ cwd: root, nodeVersion: '22.0.0', which: () => true, fileExists: () => true, home: root });
      const lib = r.checks.find((c) => c.id === 'library');
      expect(lib?.status).toBe('warn');
      expect(lib?.detail).toContain('DORMANT');
      expect(lib?.fix_hint).toContain('prod_version');
      expect(r.ok).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('library OK quand library est déclarée ; INFO quand aucun provider', async () => {
    const withLib = JSON.stringify({
      version: 1,
      name: 'parc',
      apps: [{ name: 'core', library_prefix: 'Core', projects: {} }],
      library: { user_symbol: 'Core', script_id: 'LIB_'.padEnd(40, 'X'), prod_version: 12 },
      environments: { dev: { resources: {} }, prod: { resources: {} } },
    });
    const noProvider = JSON.stringify({
      version: 1,
      name: 'parc',
      apps: [{ name: 'standalone', projects: {} }],
      environments: { dev: { resources: {} }, prod: { resources: {} } },
    });
    for (const [manifest, expected] of [[withLib, 'ok'], [noProvider, 'info']] as const) {
      const root = await mkdtemp(join(tmpdir(), 'gaslens-doctor-'));
      try {
        await writeFile(join(root, 'gaslens.workspace.json'), manifest, 'utf8');
        await mkdir(join(root, '.claude'), { recursive: true });
        await writeFile(join(root, '.claude', 'settings.json'), PLUGIN_SETTINGS, 'utf8');
        const r = await runDoctor({ cwd: root, nodeVersion: '22.0.0', which: () => true, fileExists: () => true, home: root });
        expect(r.checks.find((c) => c.id === 'library')?.status).toBe(expected);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it('ADC INFO quand aucune credential par défaut n’est présente', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gaslens-doctor-'));
    try {
      await writeFile(join(root, 'gaslens.workspace.json'), VALID_MASTER, 'utf8');
      await mkdir(join(root, '.claude'), { recursive: true });
      await writeFile(join(root, '.claude', 'settings.json'), PLUGIN_SETTINGS, 'utf8');
      // home=root (pas d'ADC), env sans GOOGLE_APPLICATION_CREDENTIALS.
      const r = await runDoctor({ cwd: root, nodeVersion: '22.0.0', which: () => true, home: root, env: {} });
      expect(r.checks.find((c) => c.id === 'adc')?.status).toBe('info');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
