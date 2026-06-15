import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { scanProject, scanWorkspace } from '../src/scanner.js';
import { buildMap, renderMapText } from '../src/map.js';
import type { ProjectIndex, WorkspaceIndex } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(here, 'fixtures/sample-project');
const WORKSPACE = resolve(here, 'fixtures/sample-workspace');

describe('map — projection projet unique', () => {
  let project: ProjectIndex;
  beforeAll(async () => {
    project = await scanProject({ root: PROJECT });
  });

  it("renvoie kind=project_map quand l'index est un projet", () => {
    const report = buildMap(project);
    expect(report.kind).toBe('project_map');
    expect(report.projects).toHaveLength(1);
    expect(report.workspace_root).toBeUndefined();
    expect(report.cross_project_edges_count).toBeUndefined();
  });

  it('expose les deux entry points web (doGet / doPost)', () => {
    const report = buildMap(project);
    const ep = report.projects[0]!.entry_points;
    const names = ep.map((e) => e.function).sort();
    expect(names).toEqual(['doGet', 'doPost']);
    for (const e of ep) {
      expect(e.file).toBe('triggers.gs');
      expect(e.line).toBeGreaterThan(0);
    }
  });

  it('liste runWeeklyReport en trigger installable avec son détail', () => {
    const report = buildMap(project);
    const triggers = report.projects[0]!.triggers;
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatchObject({
      function: 'runWeeklyReport',
      kind: 'installable_trigger',
    });
    expect(triggers[0]!.detail).toContain('ScriptApp.newTrigger');
  });

  it('inscrit sendEmailReport dans exposed_to_client avec un call_site', () => {
    const report = buildMap(project);
    const client = report.projects[0]!.exposed_to_client;
    expect(client.map((c) => c.function)).toEqual(['sendEmailReport']);
    expect(client[0]!.call_sites).toBe(1);
    expect(client[0]!.file).toBe('email.gs');
  });

  it("expose le template dashboard.html lié à la fonction qui l'attache", () => {
    const report = buildMap(project);
    const tpl = report.projects[0]!.scriptlet_templates;
    expect(tpl).toHaveLength(1);
    expect(tpl[0]).toMatchObject({
      template_file: 'dashboard.html',
      bound_by: ['doGet'],
    });
    expect(tpl[0]!.fields_set).toBeGreaterThan(0);
  });

  it('reporte les totaux files/functions et la coverage projet', () => {
    const report = buildMap(project);
    const t = report.projects[0]!.totals;
    expect(t.files).toBe(project.files.length);
    expect(t.functions).toBe(project.functions.length);
    expect(t.public_functions + t.private_functions).toBe(t.functions);
    const cov = report.projects[0]!.coverage;
    expect(cov.resolved_pct).toBe(project.coverage_summary.resolved_pct);
    expect(cov.confidence).toBe(project.coverage_summary.confidence);
  });

  it('libraries_consumed est vide pour ce projet (aucun préfixe utilisé)', () => {
    const report = buildMap(project);
    expect(report.projects[0]!.libraries_consumed).toEqual([]);
    expect(report.projects[0]!.libraries_exposed).toBeUndefined();
  });

  it('JSON sérialisable sans cycle', () => {
    const report = buildMap(project);
    expect(() => JSON.stringify(report)).not.toThrow();
  });
});

describe('map — projection workspace multi-projets', () => {
  let ws: WorkspaceIndex;
  beforeAll(async () => {
    const idx = await scanWorkspace({ root: WORKSPACE });
    if (idx.kind !== 'workspace') throw new Error('expected workspace');
    ws = idx;
  });

  it('renvoie kind=workspace_map et inclut le compte d\'edges cross-project', () => {
    const report = buildMap(ws);
    expect(report.kind).toBe('workspace_map');
    expect(report.cross_project_edges_count).toBe(ws.cross_project_edges.length);
    expect(report.projects.map((p) => p.project).sort()).toEqual(['AppA', 'CommonUtils']);
  });

  it("AppA déclare consommer CommonUtils, résolu vers le projet du workspace", () => {
    const report = buildMap(ws);
    const appA = report.projects.find((p) => p.project === 'AppA')!;
    expect(appA.libraries_consumed).toHaveLength(1);
    expect(appA.libraries_consumed[0]).toMatchObject({
      prefix: 'CommonUtils',
      resolved_in_workspace: true,
      resolved_callee_project: 'CommonUtils',
    });
    expect(appA.libraries_consumed[0]!.call_sites).toBeGreaterThan(0);
  });

  it('CommonUtils est exposé comme librairie consommée par AppA', () => {
    const report = buildMap(ws);
    const common = report.projects.find((p) => p.project === 'CommonUtils')!;
    expect(common.libraries_exposed).toBeDefined();
    expect(common.libraries_exposed).toEqual([
      { consumed_by_project: 'AppA', call_sites: ws.cross_project_edges.length },
    ]);
  });

  it("AppA n'a pas de libraries_exposed (personne ne le consomme)", () => {
    const report = buildMap(ws);
    const appA = report.projects.find((p) => p.project === 'AppA')!;
    expect(appA.libraries_exposed).toBeUndefined();
  });
});

describe('map — format texte', () => {
  it('produit une vue ligne-par-ligne avec en-tête workspace + sections projet', async () => {
    const idx = await scanWorkspace({ root: WORKSPACE });
    const txt = renderMapText(buildMap(idx));
    expect(txt.split('\n')[0]).toMatch(/^workspace\b/);
    expect(txt).toMatch(/\[AppA\]/);
    expect(txt).toMatch(/\[CommonUtils\]/);
    expect(txt).toContain('entry: doGet');
    expect(txt).toContain('consumes: CommonUtils');
    expect(txt).toContain('exposes: AppA');
  });

  it('le format texte reste compact (~bornes ROI V3 §21.5)', async () => {
    const project = await scanProject({ root: PROJECT });
    const txt = renderMapText(buildMap(project));
    // bornes très lâches : si on dépasse 2000 caractères pour ce fixture, c'est qu'on a perdu la promesse de compacité.
    expect(txt.length).toBeLessThan(2000);
    expect(txt.length).toBeGreaterThan(0);
  });
});
