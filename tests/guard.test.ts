import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGuard, isClaspPublish, resolveTargetDir } from '../src/guard.js';

const LIB_ID = 'LIB_SCRIPT_ID_0000000000000000000000000';
const SHEET_DEV = 'SHEET_DEV_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const SHEET_PROD = 'SHEET_PROD_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function master(): string {
  return JSON.stringify({
    version: 1,
    name: 'parc',
    apps: [
      {
        name: 'dash',
        projects: {
          dev: { script_id: 'DASH_DEV', clasp_path: 'apps/dash/dev' },
          prod: { script_id: 'DASH_PROD', clasp_path: 'apps/dash/prod' },
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

const CLEAN_PROD_CODE = `function open_() { return Config.get('mainSheet'); }`;
const LEAK_PROD_CODE = `function open_() { return SpreadsheetApp.openById('${SHEET_DEV}'); }`;

async function makeWorkspace(prodCode: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gaslens-guard-'));
  await writeFile(join(root, 'gaslens.workspace.json'), master(), 'utf8');
  for (const [env, code] of [['dev', CLEAN_PROD_CODE], ['prod', prodCode]] as const) {
    const dir = join(root, 'apps', 'dash', env);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'appsscript.json'), '{"runtimeVersion":"V8"}', 'utf8');
    await writeFile(join(dir, 'Code.gs'), code, 'utf8');
  }
  return root;
}

function payload(command: string, cwd: string): string {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd });
}

describe('guard — helpers', () => {
  it('isClaspPublish reconnaît push/deploy/create-deployment, pas clone/pull', () => {
    expect(isClaspPublish('clasp push')).toBe(true);
    expect(isClaspPublish('cd apps/dash/prod && clasp push --force')).toBe(true);
    expect(isClaspPublish('clasp deploy --deploymentId X')).toBe(true);
    expect(isClaspPublish('clasp clone 123')).toBe(false);
    expect(isClaspPublish('clasp pull')).toBe(false);
    expect(isClaspPublish('npm test')).toBe(false);
  });

  it('resolveTargetDir : -P, cd, sinon cwd', () => {
    expect(resolveTargetDir('clasp push -P apps/dash/prod', '/ws')).toContain('prod');
    expect(resolveTargetDir('cd apps/dash/dev && clasp push', '/ws')).toContain('dev');
    expect(resolveTargetDir('clasp push', '/ws/apps/dash/prod')).toContain('prod');
  });
});

describe('guard — décision (G3)', () => {
  it('BLOQUE un clasp push vers prod quand env validate est BREAK (fuite inter-env)', async () => {
    const root = await makeWorkspace(LEAK_PROD_CODE);
    try {
      const prodDir = join(root, 'apps', 'dash', 'prod');
      const out = await runGuard({ stdinJson: payload('clasp push --force', prodDir) });
      expect(out.kind).toBe('block');
      if (out.kind === 'block') {
        expect(out.reason).toContain('PROD');
        expect(out.reason).toContain('dash');
        expect(out.hookPayload).toContain('deny');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('LAISSE PASSER un clasp push vers prod quand env validate est CLEAN', async () => {
    const root = await makeWorkspace(CLEAN_PROD_CODE);
    try {
      const prodDir = join(root, 'apps', 'dash', 'prod');
      const out = await runGuard({ stdinJson: payload('clasp push', prodDir) });
      expect(out.kind).toBe('allow');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('LAISSE PASSER un push vers DEV même si prod aurait un BREAK', async () => {
    const root = await makeWorkspace(LEAK_PROD_CODE);
    try {
      const devDir = join(root, 'apps', 'dash', 'dev');
      const out = await runGuard({ stdinJson: payload('clasp push', devDir) });
      expect(out.kind).toBe('allow');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('résout la cible prod via `cd` dans la commande', async () => {
    const root = await makeWorkspace(LEAK_PROD_CODE);
    try {
      const out = await runGuard({
        stdinJson: payload('cd apps/dash/prod && clasp push --force', root),
      });
      expect(out.kind).toBe('block');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('neutre sur une commande non-clasp', async () => {
    const root = await makeWorkspace(LEAK_PROD_CODE);
    try {
      const out = await runGuard({ stdinJson: payload('npm test', join(root, 'apps', 'dash', 'prod')) });
      expect(out.kind).toBe('allow');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('neutre hors workspace gaslens', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gaslens-guard-bare-'));
    try {
      const out = await runGuard({ stdinJson: payload('clasp push', root) });
      expect(out.kind).toBe('allow');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('neutre sur stdin invalide', async () => {
    const out = await runGuard({ stdinJson: 'pas du json' });
    expect(out.kind).toBe('allow');
  });
});
