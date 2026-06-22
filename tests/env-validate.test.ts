import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEnvValidate } from '../src/env-validate.js';

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
  const root = await mkdtemp(join(tmpdir(), 'gaslens-env-'));
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
  lib: { version: '12', developmentMode: true }, // dev → HEAD
  code: `function open_() { return Config.get('mainSheet'); }`,
};
const CLEAN_PROD: ProjectSpec = {
  lib: { version: '12', developmentMode: false }, // prod → figée 12
  code: `function open_() { return Config.get('mainSheet'); }`,
};

describe('env validate — axe RESSOURCES', () => {
  it('BREAK env.cross_env_leak quand prod embarque un id de ressource DEV', async () => {
    const root = await makeWorkspace(CLEAN_DEV, {
      lib: CLEAN_PROD.lib,
      code: `function open_() { return SpreadsheetApp.openById('${SHEET_DEV}'); }`,
    });
    try {
      const r = await runEnvValidate({ root });
      expect(r.verdict).toBe('BREAK');
      const leak = r.findings.find((f) => f.consumer_kind === 'env.cross_env_leak');
      expect(leak).toBeDefined();
      expect(leak?.consumer.file).toBe('Code.gs');
      expect(leak?.reason).toContain(SHEET_DEV);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('WARN env.hardcoded_resource quand prod embarque son PROPRE id (bon env)', async () => {
    const root = await makeWorkspace(CLEAN_DEV, {
      lib: CLEAN_PROD.lib,
      code: `function open_() { return SpreadsheetApp.openById('${SHEET_PROD}'); }`,
    });
    try {
      const r = await runEnvValidate({ root });
      expect(r.verdict).toBe('WARN');
      const hc = r.findings.find((f) => f.consumer_kind === 'env.hardcoded_resource');
      expect(hc).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('env validate — axe CODE', () => {
  it('BREAK env.library_version_mismatch quand prod consomme la lib en HEAD', async () => {
    const root = await makeWorkspace(CLEAN_DEV, {
      lib: { version: '12', developmentMode: true }, // prod en HEAD → faute
      code: CLEAN_PROD.code,
    });
    try {
      const r = await runEnvValidate({ root, env: 'prod' });
      expect(r.verdict).toBe('BREAK');
      const mm = r.findings.find((f) => f.consumer_kind === 'env.library_version_mismatch');
      expect(mm?.reason).toContain('HEAD');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('BREAK quand prod consomme une mauvaise version figée', async () => {
    const root = await makeWorkspace(CLEAN_DEV, {
      lib: { version: '9', developmentMode: false }, // attendu 12
      code: CLEAN_PROD.code,
    });
    try {
      const r = await runEnvValidate({ root, env: 'prod' });
      expect(r.verdict).toBe('BREAK');
      const mm = r.findings.find((f) => f.consumer_kind === 'env.library_version_mismatch');
      expect(mm?.reason).toMatch(/version 9/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('WARN quand dev consomme une version figée au lieu de HEAD', async () => {
    const root = await makeWorkspace(
      { lib: { version: '12', developmentMode: false }, code: CLEAN_DEV.code },
      CLEAN_PROD,
    );
    try {
      const r = await runEnvValidate({ root, env: 'dev' });
      expect(r.verdict).toBe('WARN');
      expect(
        r.findings.some((f) => f.consumer_kind === 'env.library_version_mismatch'),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('env validate — cas sains & no-op', () => {
  it('CLEAN sur un parc aligné', async () => {
    const root = await makeWorkspace(CLEAN_DEV, CLEAN_PROD);
    try {
      const r = await runEnvValidate({ root });
      expect(r.verdict).toBe('CLEAN');
      expect(r.findings).toEqual([]);
      expect(r.coverage.checked.length).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('no-op (CLEAN, manifest_present=false) sans gaslens.workspace.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gaslens-env-'));
    try {
      const r = await runEnvValidate({ root });
      expect(r.manifest_present).toBe(false);
      expect(r.verdict).toBe('CLEAN');
      expect(r.findings).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('cible un seul projet quand root pointe exactement un dossier projet (mode hook)', async () => {
    const root = await makeWorkspace(CLEAN_DEV, {
      lib: CLEAN_PROD.lib,
      code: `function open_() { return SpreadsheetApp.openById('${SHEET_DEV}'); }`,
    });
    try {
      const prodDir = join(root, 'apps', 'dashboard', 'prod');
      const r = await runEnvValidate({ root: prodDir });
      expect(r.coverage.checked).toEqual([
        { app: 'dashboard', env: 'prod', dir: prodDir },
      ]);
      expect(r.verdict).toBe('BREAK');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
