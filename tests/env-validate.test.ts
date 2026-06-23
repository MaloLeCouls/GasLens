import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runEnvValidate,
  checkUndeclaredResources,
  extractIdFromUrl,
} from '../src/env-validate.js';
import { parseWorkspaceManifest } from '../src/workspace-manifest.js';

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

  it('WARN env.hardcoded_resource pour un id NON déclaré via openById (E5)', async () => {
    const UNDECLARED = 'UNDECLARED_ID_ABCDEFGHIJKLMNOPQRSTUV';
    const root = await makeWorkspace(CLEAN_DEV, {
      lib: CLEAN_PROD.lib,
      code: `function open_() { return DriveApp.getFileById('${UNDECLARED}'); }`,
    });
    try {
      const r = await runEnvValidate({ root, env: 'prod' });
      const hc = r.findings.find(
        (f) => f.consumer_kind === 'env.hardcoded_resource' && f.reason.includes(UNDECLARED),
      );
      expect(hc).toBeDefined();
      expect(hc?.reason).toContain('NON déclaré');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('BREAK env.cross_env_leak quand prod ouvre une URL embarquant un id DEV (openByUrl, F5a)', async () => {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_DEV}/edit`;
    const root = await makeWorkspace(CLEAN_DEV, {
      lib: CLEAN_PROD.lib,
      code: `function open_() { return SpreadsheetApp.openByUrl('${url}'); }`,
    });
    try {
      const r = await runEnvValidate({ root, env: 'prod' });
      expect(r.verdict).toBe('BREAK');
      const leak = r.findings.filter((f) => f.consumer_kind === 'env.cross_env_leak');
      // Exactement une fuite : pas de double-comptage (substring vs openByUrl).
      expect(leak).toHaveLength(1);
      expect(leak[0]?.reason).toContain(SHEET_DEV);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('WARN env.hardcoded_resource pour un id NON déclaré dans une URL openByUrl (F5a)', async () => {
    const UNDECLARED = 'UNDECLARED_URL_ID_CDEFGHIJKLMNOPQRSTUV';
    const url = `https://docs.google.com/document/d/${UNDECLARED}/edit`;
    const root = await makeWorkspace(CLEAN_DEV, {
      lib: CLEAN_PROD.lib,
      code: `function open_() { return DocumentApp.openByUrl('${url}'); }`,
    });
    try {
      const r = await runEnvValidate({ root, env: 'prod' });
      const hc = r.findings.find(
        (f) => f.consumer_kind === 'env.hardcoded_resource' && f.reason.includes(UNDECLARED),
      );
      expect(hc).toBeDefined();
      expect(hc?.reason).toContain('openByUrl');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ne flague pas un littéral court / non id-shaped passé à openById', async () => {
    const root = await makeWorkspace(CLEAN_DEV, {
      lib: CLEAN_PROD.lib,
      code: `function open_() { return SpreadsheetApp.openById('short'); }`,
    });
    try {
      const r = await runEnvValidate({ root, env: 'prod' });
      expect(r.findings.some((f) => f.reason.includes('short'))).toBe(false);
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

describe('env validate — library_scope_missing cross-projet (G1)', () => {
  function masterWithProvider(): string {
    return JSON.stringify({
      version: 1,
      name: 'parc',
      apps: [
        {
          name: 'core',
          library_prefix: 'Core',
          projects: {
            dev: { script_id: 'CORE_DEV', clasp_path: 'apps/core/dev' },
            prod: { script_id: LIB_ID, clasp_path: 'apps/core/prod' },
          },
        },
        {
          name: 'dash',
          projects: {
            dev: { script_id: 'DASH_DEV', clasp_path: 'apps/dash/dev' },
            prod: { script_id: 'DASH_PROD', clasp_path: 'apps/dash/prod' },
          },
        },
      ],
      library: { user_symbol: 'Core', script_id: LIB_ID, prod_version: 12 },
      environments: { dev: { resources: {} }, prod: { resources: {} } },
    });
  }

  function consumerManifest(scopes: string[] | null): string {
    const m: Record<string, unknown> = {
      runtimeVersion: 'V8',
      dependencies: {
        libraries: [{ userSymbol: 'Core', libraryId: LIB_ID, version: '12', developmentMode: false }],
      },
    };
    if (scopes) m.oauthScopes = scopes;
    return JSON.stringify(m);
  }

  async function makeParc(consumerScopes: string[] | null): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'gaslens-g1-'));
    await writeFile(join(root, 'gaslens.workspace.json'), masterWithProvider(), 'utf8');
    // core/prod : la lib utilise GmailApp, sans oauthScopes explicite (auto-détection).
    const coreDir = join(root, 'apps', 'core', 'prod');
    await mkdir(coreDir, { recursive: true });
    await writeFile(join(coreDir, 'appsscript.json'), JSON.stringify({ runtimeVersion: 'V8' }), 'utf8');
    await writeFile(join(coreDir, 'Code.gs'), `function notify(to) { GmailApp.sendEmail(to, 'hi', 'body'); }`, 'utf8');
    // dash/prod : consomme Core, scopes explicites (selon le cas).
    const dashDir = join(root, 'apps', 'dash', 'prod');
    await mkdir(dashDir, { recursive: true });
    await writeFile(join(dashDir, 'appsscript.json'), consumerManifest(consumerScopes), 'utf8');
    await writeFile(join(dashDir, 'Code.gs'), `function go() { return Core.notify('a@b.c'); }`, 'utf8');
    return root;
  }

  it('WARN quand le consommateur (scopes explicites) manque le scope Gmail requis par la lib', async () => {
    const root = await makeParc(['https://www.googleapis.com/auth/spreadsheets']);
    try {
      const r = await runEnvValidate({ root, env: 'prod' });
      const f = r.findings.find((x) => x.consumer_kind === 'env.library_scope_missing');
      expect(f).toBeDefined();
      expect(f?.severity).toBe('warn');
      expect(f?.reason).toContain('mail.google.com');
      expect(f?.symbol).toContain('dash');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('CLEAN quand le consommateur déclare le scope Gmail', async () => {
    const root = await makeParc(['https://mail.google.com/']);
    try {
      const r = await runEnvValidate({ root, env: 'prod' });
      expect(r.findings.some((x) => x.consumer_kind === 'env.library_scope_missing')).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('silencieux si le consommateur est en auto-détection (pas d\'oauthScopes explicite)', async () => {
    const root = await makeParc(null);
    try {
      const r = await runEnvValidate({ root, env: 'prod' });
      expect(r.findings.some((x) => x.consumer_kind === 'env.library_scope_missing')).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('extractIdFromUrl (F5a)', () => {
  const ID = 'A'.repeat(30);
  it('extrait l\'id d\'une URL éditeur (/d/<ID>)', () => {
    expect(extractIdFromUrl(`https://docs.google.com/spreadsheets/d/${ID}/edit`)).toBe(ID);
    expect(extractIdFromUrl(`https://drive.google.com/file/d/${ID}/view`)).toBe(ID);
  });
  it('extrait l\'id d\'une URL de dossier Drive (/folders/<ID>)', () => {
    expect(extractIdFromUrl(`https://drive.google.com/drive/folders/${ID}`)).toBe(ID);
  });
  it('renvoie null quand l\'URL ne porte pas d\'id reconnaissable', () => {
    expect(extractIdFromUrl('https://example.com/page')).toBeNull();
    expect(extractIdFromUrl('https://docs.google.com/spreadsheets/d/short/edit')).toBeNull();
  });
});

describe('env validate — undeclared_resource (cohérence manifeste)', () => {
  const asymmetric = parseWorkspaceManifest({
    environments: {
      dev: { resources: { mainSheet: 'S_DEV', intakeForm: 'F_DEV' } },
      prod: { resources: { mainSheet: 'S_PROD' } }, // intakeForm manquant
    },
  }).manifest!;

  it('signale une ressource déclarée en dev mais absente de prod', () => {
    const findings = checkUndeclaredResources(asymmetric, ['prod']);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.consumer_kind).toBe('env.undeclared_resource');
    expect(findings[0]?.severity).toBe('warn');
    expect(findings[0]?.reason).toContain('intakeForm');
  });

  it('aucun finding quand les environnements sont symétriques', () => {
    const sym = parseWorkspaceManifest({
      environments: {
        dev: { resources: { mainSheet: 'S_DEV' } },
        prod: { resources: { mainSheet: 'S_PROD' } },
      },
    }).manifest!;
    expect(checkUndeclaredResources(sym, ['dev', 'prod'])).toEqual([]);
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
