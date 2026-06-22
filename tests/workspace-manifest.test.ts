import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseWorkspaceManifest,
  loadWorkspaceManifest,
  resourceOwnerIndex,
  declaredLogicalNames,
  environmentNames,
  emptyWorkspaceManifest,
  WORKSPACE_MANIFEST_FILENAME,
} from '../src/workspace-manifest.js';

const VALID = {
  version: 1,
  name: 'parc-demo',
  apps: [
    {
      name: 'dashboard',
      library_prefix: 'Core',
      projects: {
        dev: { script_id: 'DEV_SCRIPT_ID', clasp_path: 'apps/dashboard/dev' },
        prod: { script_id: 'PROD_SCRIPT_ID', deployment_id: 'AKfycb...' },
      },
    },
  ],
  library: { user_symbol: 'Core', script_id: 'LIB_SCRIPT_ID', prod_version: 12 },
  environments: {
    dev: { resources: { mainSheet: 'SHEET_DEV', intakeForm: 'FORM_DEV' } },
    prod: { resources: { mainSheet: 'SHEET_PROD', intakeForm: 'FORM_PROD' } },
  },
};

describe('workspace-manifest — parsing & validation', () => {
  it('valide un manifeste complet et conserve les valeurs', () => {
    const res = parseWorkspaceManifest(VALID);
    expect(res.errors).toEqual([]);
    expect(res.manifest).not.toBeNull();
    const m = res.manifest!;
    expect(m.apps[0]?.projects.dev?.script_id).toBe('DEV_SCRIPT_ID');
    expect(m.library?.prod_version).toBe(12);
    expect(m.library?.dev_version).toBe('HEAD'); // défaut appliqué
  });

  it('applique les défauts (version, environments, projects)', () => {
    const res = parseWorkspaceManifest({ name: 'mini' });
    expect(res.manifest).not.toBeNull();
    expect(res.manifest!.version).toBe(1);
    expect(res.manifest!.apps).toEqual([]);
    expect(res.manifest!.environments).toEqual({});
  });

  it('rejette un script_id vide avec une erreur localisée', () => {
    const bad = {
      apps: [{ name: 'x', projects: { dev: { script_id: '' } } }],
    };
    const res = parseWorkspaceManifest(bad);
    expect(res.manifest).toBeNull();
    expect(res.errors.join('\n')).toMatch(/apps\.0\.projects\.dev\.script_id/);
  });

  it('rejette une prod_version non entière positive', () => {
    const bad = {
      library: { script_id: 'L', prod_version: 0 },
    };
    const res = parseWorkspaceManifest(bad);
    expect(res.manifest).toBeNull();
    expect(res.errors.join('\n')).toMatch(/library\.prod_version/);
  });
});

describe('workspace-manifest — helpers', () => {
  it('resourceOwnerIndex inverse id → (env, logical)', () => {
    const m = parseWorkspaceManifest(VALID).manifest!;
    const idx = resourceOwnerIndex(m);
    expect(idx.get('SHEET_DEV')).toEqual([{ env: 'dev', logical: 'mainSheet' }]);
    expect(idx.get('FORM_PROD')).toEqual([{ env: 'prod', logical: 'intakeForm' }]);
  });

  it('declaredLogicalNames fait l’union des noms à travers les envs', () => {
    const m = parseWorkspaceManifest(VALID).manifest!;
    expect([...declaredLogicalNames(m)].sort()).toEqual(['intakeForm', 'mainSheet']);
  });

  it('environmentNames conserve les clés déclarées', () => {
    const m = parseWorkspaceManifest(VALID).manifest!;
    expect(environmentNames(m)).toEqual(['dev', 'prod']);
  });

  it('emptyWorkspaceManifest émet un squelette dev/prod', () => {
    const sk = emptyWorkspaceManifest('nouveau');
    expect(sk.name).toBe('nouveau');
    expect(Object.keys(sk.environments)).toEqual(['dev', 'prod']);
    expect(sk.apps).toEqual([]);
  });
});

describe('workspace-manifest — chargement disque', () => {
  it('found=false quand le fichier est absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gaslens-wsm-'));
    try {
      const res = await loadWorkspaceManifest(root);
      expect(res.found).toBe(false);
      expect(res.manifest).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('charge et valide un manifeste présent sur disque', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gaslens-wsm-'));
    try {
      await writeFile(
        join(root, WORKSPACE_MANIFEST_FILENAME),
        JSON.stringify(VALID),
        'utf8',
      );
      const res = await loadWorkspaceManifest(root);
      expect(res.found).toBe(true);
      expect(res.errors).toEqual([]);
      expect(res.manifest?.library?.prod_version).toBe(12);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('found=true + errors sur JSON cassé', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gaslens-wsm-'));
    try {
      await writeFile(join(root, WORKSPACE_MANIFEST_FILENAME), '{ not json', 'utf8');
      const res = await loadWorkspaceManifest(root);
      expect(res.found).toBe(true);
      expect(res.manifest).toBeNull();
      expect(res.errors[0]).toMatch(/JSON invalide/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
