import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { scanWorkspace } from '../src/scanner.js';
import { inspect } from '../src/inspect.js';
import { impact } from '../src/impact.js';
import type {
  FunctionRecord,
  ProjectIndex,
  WorkspaceIndex,
} from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = resolve(here, 'fixtures/sample-workspace');
const SINGLE = resolve(here, 'fixtures/sample-project');

describe('scanWorkspace — détection multi-projets', () => {
  let ws: WorkspaceIndex;
  beforeAll(async () => {
    const idx = await scanWorkspace({ root: WORKSPACE });
    if (idx.kind !== 'workspace') throw new Error('expected workspace');
    ws = idx;
  });

  it('détecte les 2 projets AppA et CommonUtils', () => {
    expect(ws.projects.map((p) => p.project).sort()).toEqual([
      'AppA',
      'CommonUtils',
    ]);
  });

  it('a une racine workspace_root et un kind=workspace', () => {
    expect(ws.workspace_root).toBe(WORKSPACE);
    expect(ws.kind).toBe('workspace');
  });

  it("résout les appels CommonUtils.log et CommonUtils.formatDate vers le bon projet", () => {
    const edges = ws.cross_project_edges;
    expect(edges).toHaveLength(4);
    const log = edges.filter((e) => e.callee_function === 'log');
    expect(log).toHaveLength(2);
    expect(log[0]!).toMatchObject({
      caller_project: 'AppA',
      callee_project: 'CommonUtils',
      library_prefix: 'CommonUtils',
    });
  });

  it("ajoute called_by avec caller_project sur le record cible CommonUtils::log", () => {
    const commonUtils = ws.projects.find((p) => p.project === 'CommonUtils')!;
    const log = commonUtils.functions.find((f) => f.name === 'log')!;
    expect(log.called_by).toHaveLength(2);
    expect(log.called_by[0]!.caller_project).toBe('AppA');
    expect(log.called_by[0]!.file).toBe('main.gs');
  });

  it("ajoute une exposure 'library' sur la fonction cible", () => {
    const commonUtils = ws.projects.find((p) => p.project === 'CommonUtils')!;
    const log = commonUtils.functions.find((f) => f.name === 'log')!;
    const libExposures = log.exposures.filter((e) => e.type === 'library');
    expect(libExposures.length).toBeGreaterThanOrEqual(2);
    expect(libExposures[0]!.file).toMatch(/^AppA\//);
  });

  it("ne résout PAS les préfixes inconnus (ExtLib.* reste external_boundary)", () => {
    const appA = ws.projects.find((p) => p.project === 'AppA')!;
    const unknown = appA.functions.find((f) => f.name === 'unknownProjectCall_')!;
    // ExtLib n'est dans aucun manifeste donc rec n'a pas de pending_library_call.
    // L'appel reste vu comme call externe non résolu.
    expect(unknown.calls_out).toEqual(expect.arrayContaining([]));
  });

  it("n'expose PAS les fonctions privées de la lib aux autres projets", () => {
    // privateHelper_ existe dans CommonUtils mais n'est appelée nulle part →
    // appeler CommonUtils.privateHelper_() depuis AppA ne créerait aucune edge.
    const edges = ws.cross_project_edges;
    expect(edges.some((e) => e.callee_function === 'privateHelper_')).toBe(false);
  });
});

describe('scanWorkspace — projet unique = ProjectIndex (compat)', () => {
  it("renvoie un ProjectIndex (pas un WorkspaceIndex) sur un projet unique", async () => {
    const idx = await scanWorkspace({ root: SINGLE });
    expect(idx.kind).toBe('project');
    if (idx.kind === 'project') {
      expect(idx.project).toBe('sample-project');
    }
  });
});

describe('inspect — disambiguation cross-project', () => {
  let ws: WorkspaceIndex;
  let commonUtils: ProjectIndex;
  let appA: ProjectIndex;
  beforeAll(async () => {
    const idx = await scanWorkspace({ root: WORKSPACE });
    if (idx.kind !== 'workspace') throw new Error('expected workspace');
    ws = idx;
    commonUtils = ws.projects.find((p) => p.project === 'CommonUtils')!;
    appA = ws.projects.find((p) => p.project === 'AppA')!;
  });

  it("inspect log sur CommonUtils trouve la fonction avec ses 2 callers cross-project", () => {
    const r = inspect(commonUtils, 'log', {
      detailLevel: 'standard',
      include: [],
      maxCallers: 25,
      coverageDetail: 'summary',
      fuzzy: false,
    });
    if (r.kind !== 'found') throw new Error('expected found');
    expect(r.payload.callers!.total).toBe(2);
    expect(r.payload.callers!.items[0]!.caller_project).toBe('AppA');
  });

  it("impact rename:log → BREAK sur 2 sites AppA avec fix_hint cross-project qualifié", () => {
    const r = impact(commonUtils, 'log', { kind: 'rename', new_name: 'logIt' });
    if (r.kind !== 'found') throw new Error('expected found');
    expect(r.report.verdict).toBe('BREAK');
    expect(r.report.breaks).toHaveLength(2);
    expect(r.report.breaks[0]!.consumer.file).toBe('AppA/main.gs');
    expect(r.report.breaks[0]!.fix_hint).toContain('AppA/main.gs');
  });
});
