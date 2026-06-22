import { describe, it, expect } from 'vitest';
import { pickManifestTargets } from '../src/cli.js';
import type { ProjectIndex, WorkspaceIndex } from '../src/types.js';

function proj(name: string): ProjectIndex {
  return { kind: 'project', project: name } as unknown as ProjectIndex;
}
function ws(...names: string[]): WorkspaceIndex {
  return { kind: 'workspace', projects: names.map(proj) } as unknown as WorkspaceIndex;
}

describe('pickManifestTargets — sélection --project (ergonomie E1)', () => {
  const workspace = ws('apps/core/dev', 'apps/core/prod', 'apps/dash/dev', 'apps/dash/prod');

  it('sans filtre → tous les projets', () => {
    expect(pickManifestTargets(workspace, undefined).length).toBe(4);
  });

  it('chemin exact', () => {
    const r = pickManifestTargets(workspace, 'apps/dash/dev');
    expect(r.map((p) => p.project)).toEqual(['apps/dash/dev']);
  });

  it('suffixe multi-segment (dash/dev) → unique', () => {
    const r = pickManifestTargets(workspace, 'dash/dev');
    expect(r.map((p) => p.project)).toEqual(['apps/dash/dev']);
  });

  it('suffixe simple ambigu (dev) → tous les candidats', () => {
    const r = pickManifestTargets(workspace, 'dev');
    expect(r.map((p) => p.project).sort()).toEqual(['apps/core/dev', 'apps/dash/dev']);
  });

  it('inconnu → vide', () => {
    expect(pickManifestTargets(workspace, 'nope')).toEqual([]);
  });

  it('projet unique (non workspace) : exact ou suffixe', () => {
    const single = proj('apps/dash/dev');
    expect(pickManifestTargets(single, 'apps/dash/dev').length).toBe(1);
    expect(pickManifestTargets(single, 'dash/dev').length).toBe(1);
    expect(pickManifestTargets(single, undefined).length).toBe(1);
    expect(pickManifestTargets(single, 'other').length).toBe(0);
  });
});
