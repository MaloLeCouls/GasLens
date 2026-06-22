import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planAddApp, runAddApp } from '../src/workspace-add-app.js';
import {
  parseWorkspaceManifest,
  loadWorkspaceManifest,
  emptyWorkspaceManifest,
} from '../src/workspace-manifest.js';
import { buildWorkspaceFiles, writeWorkspace } from '../src/workspace-init.js';

describe('workspace add-app — plan (pur)', () => {
  it('ajoute une app avec ses deux projets dev/prod', () => {
    const plan = planAddApp(emptyWorkspaceManifest('parc'), { name: 'dash' });
    expect('error' in plan).toBe(false);
    if ('error' in plan) return;
    const app = plan.manifest.apps.find((a) => a.name === 'dash')!;
    expect(app.projects.dev?.clasp_path).toBe('apps/dash/dev');
    expect(app.projects.prod?.clasp_path).toBe('apps/dash/prod');
    expect(app.projects.dev?.script_id).toBeUndefined(); // renseigné après clone
    expect(plan.files.map((f) => f.path)).toContain('apps/dash/CLAUDE.md');
  });

  it('porte le library_prefix quand fourni', () => {
    const plan = planAddApp(emptyWorkspaceManifest('parc'), { name: 'core', libraryPrefix: 'Core' });
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.manifest.apps[0]?.library_prefix).toBe('Core');
    const claudeMd = plan.files.find((f) => f.path === 'apps/core/CLAUDE.md')!;
    expect(claudeMd.content).toContain('Core');
  });

  it('le manifeste résultant reste valide (script_id optionnel)', () => {
    const plan = planAddApp(emptyWorkspaceManifest('parc'), { name: 'dash' });
    if ('error' in plan) throw new Error(plan.error);
    const res = parseWorkspaceManifest(JSON.parse(JSON.stringify(plan.manifest)));
    expect(res.errors).toEqual([]);
  });

  it('refuse un doublon', () => {
    const m = planAddApp(emptyWorkspaceManifest('parc'), { name: 'dash' });
    if ('error' in m) throw new Error(m.error);
    const dup = planAddApp(m.manifest, { name: 'dash' });
    expect('error' in dup).toBe(true);
  });
});

describe('workspace add-app — exécution', () => {
  it('met à jour le manifeste et crée l’arborescence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gaslens-addapp-'));
    try {
      await writeWorkspace(root, buildWorkspaceFiles({ name: 'parc' }));
      const res = await runAddApp(root, { name: 'dash', libraryPrefix: 'Core' });
      expect(res.ok).toBe(true);
      expect(existsSync(join(root, 'apps/dash/dev/.gitkeep'))).toBe(true);
      expect(existsSync(join(root, 'apps/dash/CLAUDE.md'))).toBe(true);
      expect(res.nextSteps?.some((s) => s.includes('clasp clone'))).toBe(true);

      const loaded = await loadWorkspaceManifest(root);
      expect(loaded.manifest?.apps.some((a) => a.name === 'dash')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('échoue proprement hors d’un workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gaslens-addapp-'));
    try {
      const res = await runAddApp(root, { name: 'dash' });
      expect(res.ok).toBe(false);
      expect(res.message).toContain('workspace init');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
