import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { scanProject } from '../src/scanner.js';
import type { FunctionRecord, ProjectIndex } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, 'fixtures/sample-project');

let idx: ProjectIndex;
const byName = new Map<string, FunctionRecord>();

beforeAll(async () => {
  idx = await scanProject({ root: FIXTURE });
  for (const fn of idx.functions) byName.set(fn.name, fn);
});

describe('scanner v0 — sample-project', () => {
  it('détecte tous les .gs + .html du projet (l\'HTML rejoint l\'index)', () => {
    expect(idx.files.sort()).toEqual([
      'config.gs',
      'dashboard.html',
      'dispatch.gs',
      'email.gs',
      'triggers.gs',
      'users.gs',
      'utils.gs',
    ]);
  });

  it('lit le nom du projet depuis le manifeste / dossier racine', () => {
    expect(idx.project).toBe('sample-project');
  });

  it('détecte toutes les fonctions top-level (déclarations + arrow assignée)', () => {
    const names = [...byName.keys()].sort();
    expect(names).toEqual([
      'MyClass',
      'buildDynamicMap',
      'buildEntity',
      'cacheLookup_',
      'dispatchAction',
      'doGet',
      'doPost',
      'formatReport',
      'generateId_',
      'getApiKey_',
      'getCurrentUser_',
      'getUserName_',
      'include',
      'installWeeklyTrigger_',
      'listItems',
      'logCurrentUser',
      'lookupUser_',
      'readUserPref_',
      'runWeeklyReport',
      'sendEmailReport',
      'setApiKey_',
      'setupConfig',
      'summarizeRow_',
    ]);
  });

  it('marque comme private les fonctions à suffixe _', () => {
    expect(byName.get('generateId_')!.definition.visibility).toBe('private');
    expect(byName.get('getUserName_')!.definition.visibility).toBe('private');
    expect(byName.get('installWeeklyTrigger_')!.definition.visibility).toBe(
      'private',
    );
  });

  it('marque comme public les fonctions sans suffixe _', () => {
    expect(byName.get('sendEmailReport')!.definition.visibility).toBe('public');
    expect(byName.get('doGet')!.definition.visibility).toBe('public');
    expect(byName.get('include')!.definition.visibility).toBe('public');
  });

  it('expose doGet et doPost comme entry_point_web', () => {
    expect(byName.get('doGet')!.exposures.map((e) => e.type)).toContain(
      'entry_point_web',
    );
    expect(byName.get('doPost')!.exposures.map((e) => e.type)).toContain(
      'entry_point_web',
    );
  });

  it('expose runWeeklyReport comme installable_trigger via ScriptApp.newTrigger', () => {
    const rec = byName.get('runWeeklyReport')!;
    const trig = rec.exposures.find((e) => e.type === 'installable_trigger');
    expect(trig).toBeDefined();
    expect(trig!.file).toBe('triggers.gs');
  });

  it('résout les call sites internes inter-fichiers (namespace projet partagé)', () => {
    // sendEmailReport (email.gs) est appelée depuis triggers.gs:doPost et triggers.gs:runWeeklyReport.
    const callers = byName.get('sendEmailReport')!.called_by;
    const callerNames = callers.map((c) => c.caller).sort();
    expect(callerNames).toEqual(['doPost', 'runWeeklyReport']);
    // listItems est appelée depuis doGet et runWeeklyReport.
    const listCallers = byName
      .get('listItems')!
      .called_by.map((c) => c.caller)
      .sort();
    expect(listCallers).toEqual(['doGet', 'runWeeklyReport']);
  });

  it('renseigne arguments_text et return_used_as sur called_by', () => {
    const formatCaller = byName.get('formatReport')!.called_by[0]!;
    expect(formatCaller.arguments_text).toEqual(['reportData']);
    expect(formatCaller.return_used_as).toBe('assigned:body');
  });

  it('liste les appels externes GAS comme calls_out qualifiés (Service.method)', () => {
    const send = byName.get('sendEmailReport')!;
    expect(send.calls_out).toContain('GmailApp.sendEmail');
    expect(send.calls_out).toContain('formatReport');
    expect(send.calls_out).toContain('generateId_');
  });

  it("parse JSDoc avec accolades imbriquées (@returns {{...}})", () => {
    const send = byName.get('sendEmailReport')!;
    expect(send.definition.returns).not.toBeNull();
    expect(send.definition.returns!.jsdoc_type).toBe(
      '{success: boolean, messageId: string}',
    );
  });

  it('extrait params + types JSDoc + descriptions', () => {
    const params = byName.get('sendEmailReport')!.definition.params;
    expect(params).toEqual([
      {
        name: 'reportData',
        jsdoc_type: 'Object',
        desc: 'données du rapport',
      },
      {
        name: 'recipients',
        jsdoc_type: 'string[]',
        desc: 'destinataires',
      },
    ]);
  });

  it('renseigne des positions 1-based correctes', () => {
    const send = byName.get('sendEmailReport')!.definition;
    expect(send.file).toBe('email.gs');
    expect(send.line).toBe(7);
    expect(send.col).toBe(0);
  });

  it('détecte une fonction définie comme arrow assignée à const (include)', () => {
    const inc = byName.get('include');
    expect(inc).toBeDefined();
    expect(inc!.definition.file).toBe('utils.gs');
  });

  it("n'a aucun appel non résolu sur les fixtures (corpus propre)", () => {
    expect(idx.unresolved_calls).toEqual([]);
  });

  it("attache l'IDs Project::file::fn de manière stable", () => {
    expect(byName.get('sendEmailReport')!.id).toBe(
      'sample-project::email.gs::sendEmailReport',
    );
  });

  it("note les frontières externes vers les librairies non indexées", () => {
    // Aucune fonction du sample ne fait CommonUtils.foo(), donc external_boundaries
    // doit rester vide. (Couverture d'un cas "négatif" pour éviter les faux positifs.)
    for (const fn of idx.functions) {
      expect(fn.coverage.external_boundaries).toEqual([]);
    }
  });
});
