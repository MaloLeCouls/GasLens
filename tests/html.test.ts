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

describe('HTML pass — google.script.run + scriptlets', () => {
  it('inclut dashboard.html dans files', () => {
    expect(idx.files).toContain('dashboard.html');
  });

  it('attache un client_call à sendEmailReport (cible de google.script.run)', () => {
    const rec = byName.get('sendEmailReport')!;
    const clientCalls = rec.exposures.filter((e) => e.type === 'client_call');
    expect(clientCalls).toHaveLength(1);
    const c = clientCalls[0]!;
    expect(c.file).toBe('dashboard.html');
    expect(c.detail).toBe('google.script.run.sendEmailReport(...)');
  });

  it('capture le successHandler et failureHandler par nom et position', () => {
    const c = byName
      .get('sendEmailReport')!
      .exposures.find((e) => e.type === 'client_call')!;
    expect(c.success_handler).toEqual({
      name: 'onSendOk',
      inline: false,
      line: 24,
      col: 30,
    });
    expect(c.failure_handler).toEqual({
      name: 'onSendErr',
      inline: false,
      line: 25,
      col: 30,
    });
  });

  it('renseigne arguments_text du client_call', () => {
    const c = byName
      .get('sendEmailReport')!
      .exposures.find((e) => e.type === 'client_call')!;
    expect(c.arguments_text).toEqual(["{ foo: 1 }", "['user@example.com']"]);
  });

  it('user_object est null quand withUserObject n\'est pas utilisé', () => {
    const c = byName
      .get('sendEmailReport')!
      .exposures.find((e) => e.type === 'client_call')!;
    expect(c.user_object).toBeNull();
  });

  it('attache une exposure scriptlet à include via <?!= include(...) ?>', () => {
    const rec = byName.get('include')!;
    const scriptlets = rec.exposures.filter((e) => e.type === 'scriptlet');
    expect(scriptlets).toHaveLength(1);
    const s = scriptlets[0]!;
    expect(s.scriptlet_kind).toBe('<?!=');
    expect(s.file).toBe('dashboard.html');
    expect(s.arguments_text).toEqual(["'styles'"]);
  });

  it("n'attache PAS de scriptlet sur des member_expressions (<?= data.userName ?>)", () => {
    // 'data' et 'userName' ne sont pas des fonctions du projet — pas de faux exposure.
    for (const fn of idx.functions) {
      for (const e of fn.exposures.filter((x) => x.type === 'scriptlet')) {
        // Le seul scriptlet attendu est 'include'.
        expect(fn.name).toBe('include');
      }
    }
  });

  it("n'expose pas de client_call vers une fonction privée (suffixe _)", () => {
    // getUserName_ existe mais n'est pas appelée par google.script.run dans la fixture.
    const rec = byName.get('getUserName_')!;
    expect(rec.exposures.filter((e) => e.type === 'client_call')).toHaveLength(0);
  });

  it("traduit correctement les positions HTML (1-based, ligne fichier)", () => {
    const c = byName
      .get('sendEmailReport')!
      .exposures.find((e) => e.type === 'client_call')!;
    // Le call_expression extérieur démarre sur la ligne `google.script.run` (23).
    expect(c.line).toBe(23);
  });

  it('aucun appel non résolu introduit par la passe HTML sur ce fixture', () => {
    expect(idx.unresolved_calls).toEqual([]);
  });
});
