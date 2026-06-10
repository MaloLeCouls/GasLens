import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { scanProject } from '../src/scanner.js';
import { diffIndexes, extractReturnFieldSet } from '../src/diff.js';
import { exitCodeFor } from '../src/check.js';
import type { ProjectIndex } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, 'fixtures/sample-project');

let baseline: ProjectIndex;

function clone(x: ProjectIndex): ProjectIndex {
  return JSON.parse(JSON.stringify(x)) as ProjectIndex;
}

beforeAll(async () => {
  baseline = await scanProject({ root: FIXTURE });
});

describe('extractReturnFieldSet — utilitaire', () => {
  it("parse `{a: T, b: T}` en ['a', 'b']", () => {
    expect(extractReturnFieldSet('{success: boolean, messageId: string}')).toEqual([
      'success',
      'messageId',
    ]);
  });

  it("gère les types imbriqués `{a: {x:T,y:T}, b:T}`", () => {
    expect(extractReturnFieldSet('{a: {x: T, y: T}, b: T}')).toEqual(['a', 'b']);
  });

  it("renvoie null si pas un objet", () => {
    expect(extractReturnFieldSet('string')).toBeNull();
    expect(extractReturnFieldSet(null)).toBeNull();
  });
});

describe('diff — no change', () => {
  it('diff(idx, idx) → CLEAN, derived_change_set vide', () => {
    const r = diffIndexes(baseline, baseline);
    expect(r.verdict).toBe('CLEAN');
    expect(r.breaks).toEqual([]);
    expect(r.derived_change_set).toEqual([]);
  });
});

describe('diff — return.field_removed (V2 §9 cas central)', () => {
  it("retirer 'messageId' du JSDoc → BREAK sur dashboard.html (handler le lit toujours)", () => {
    const current = clone(baseline);
    const send = current.functions.find((f) => f.name === 'sendEmailReport')!;
    send.definition.returns!.jsdoc_type = '{success: boolean}';

    const r = diffIndexes(baseline, current);
    expect(r.verdict).toBe('BREAK');
    expect(r.derived_change_set).toContainEqual(
      expect.objectContaining({
        delta: 'return.field_removed',
        detail: expect.stringContaining('messageId'),
      }),
    );
    expect(r.breaks).toHaveLength(1);
    const b = r.breaks[0]!;
    expect(b.consumer.file).toBe('dashboard.html');
    expect(b.consumer.line).toBe(17);
    expect(b.consumer_kind).toBe('client_call.success_handler');
    expect(b.reason).toContain('messageId');
  });

  it("retirer 'messageId' ET supprimer la lecture côté HTML → CLEAN (changement synchronisé)", () => {
    const current = clone(baseline);
    const send = current.functions.find((f) => f.name === 'sendEmailReport')!;
    send.definition.returns!.jsdoc_type = '{success: boolean}';
    // Simule que dashboard.html ne lit plus result.messageId.
    if (send.inferred_contract?.return_shape) {
      send.inferred_contract.return_shape.fields_read =
        send.inferred_contract.return_shape.fields_read.filter(
          (f) => f.field !== 'messageId',
        );
      send.inferred_contract.return_shape.field_names = ['success'];
    }
    const r = diffIndexes(baseline, current);
    expect(r.verdict).toBe('CLEAN');
    expect(r.breaks).toEqual([]);
    expect(r.derived_change_set).toContainEqual(
      expect.objectContaining({ delta: 'return.field_removed' }),
    );
  });

  it("ajouter un champ → derived seul, pas de break", () => {
    const current = clone(baseline);
    const send = current.functions.find((f) => f.name === 'sendEmailReport')!;
    send.definition.returns!.jsdoc_type = '{success: boolean, messageId: string, correlationId: string}';
    const r = diffIndexes(baseline, current);
    expect(r.derived_change_set).toContainEqual(
      expect.objectContaining({ delta: 'return.field_added' }),
    );
    expect(r.breaks).toEqual([]);
    expect(r.verdict).toBe('CLEAN');
  });
});

describe('diff — param.removed', () => {
  it("retirer 'recipients' → BREAK sur les sites qui passaient un 2e arg", () => {
    const current = clone(baseline);
    const send = current.functions.find((f) => f.name === 'sendEmailReport')!;
    send.definition.params = send.definition.params.filter(
      (p) => p.name !== 'recipients',
    );
    const r = diffIndexes(baseline, current);
    expect(r.derived_change_set).toContainEqual(
      expect.objectContaining({ delta: 'param.removed' }),
    );
    expect(r.breaks.length).toBeGreaterThanOrEqual(2);
    expect(r.verdict).toBe('BREAK');
  });
});

describe('diff — function_removed / function_added', () => {
  it('retirer une fonction → WARN + derived', () => {
    const current = clone(baseline);
    current.functions = current.functions.filter((f) => f.name !== 'formatReport');
    const r = diffIndexes(baseline, current);
    expect(r.derived_change_set).toContainEqual(
      expect.objectContaining({ delta: 'function_removed' }),
    );
    expect(r.verdict).toBe('WARN');
  });

  it('ajouter une fonction → safe (CLEAN par défaut)', () => {
    const current = clone(baseline);
    // ajoute un dupe fake avec un autre nom
    const fake = clone({ ...baseline } as ProjectIndex).functions[0]!;
    fake.name = 'brandNewFn';
    fake.id = 'sample-project::email.gs::brandNewFn';
    current.functions.push(fake);
    const r = diffIndexes(baseline, current);
    expect(r.derived_change_set).toContainEqual(
      expect.objectContaining({ delta: 'function_added' }),
    );
    expect(r.verdict).toBe('CLEAN');
  });
});

describe('diff — template binding field removed', () => {
  it("retirer 'userName' de tpl.data alors que dashboard.html le lit → BREAK", () => {
    const current = clone(baseline);
    const dogetFn = current.functions.find((f) => f.name === 'doGet')!;
    const tb = dogetFn.patterns.template_bindings[0]!;
    tb.data_fields_set = tb.data_fields_set.filter((f) => f !== 'userName');
    // unread/read_but_not_set sont recomputés au scan ; ici on les ajuste manuellement.
    tb.read_but_not_set = ['userName'];
    const r = diffIndexes(baseline, current);
    expect(r.derived_change_set).toContainEqual(
      expect.objectContaining({ delta: 'template.binding_field_removed' }),
    );
    expect(r.breaks).toContainEqual(
      expect.objectContaining({
        consumer_kind: 'template_scriptlet_reader',
        reason: expect.stringContaining('userName'),
      }),
    );
  });
});

describe('diff — property key passe en write_only', () => {
  it("supprimer la lecture de API_KEY → WARN write_only", () => {
    const current = clone(baseline);
    const apiKey = current.property_keys.find((k) => k.key === 'API_KEY')!;
    apiKey.reads = [];
    apiKey.status = 'write_only';
    const r = diffIndexes(baseline, current);
    expect(r.derived_change_set).toContainEqual(
      expect.objectContaining({ delta: 'property_key.write_only' }),
    );
    expect(
      r.warns.some((w) => w.consumer_kind === 'property_key_writer'),
    ).toBe(true);
  });
});

describe('check — exit codes (V2 §9.2)', () => {
  it('CLEAN → 0', () => {
    expect(exitCodeFor('CLEAN', 'break')).toBe(0);
  });
  it('BREAK avec fail-on=break → 3', () => {
    expect(exitCodeFor('BREAK', 'break')).toBe(3);
  });
  it('WARN avec fail-on=warn → 4', () => {
    expect(exitCodeFor('WARN', 'warn')).toBe(4);
  });
  it('WARN avec fail-on=break → 0 (sous le seuil)', () => {
    expect(exitCodeFor('WARN', 'break')).toBe(0);
  });
  it('fail-on=never → toujours 0', () => {
    expect(exitCodeFor('BREAK', 'never')).toBe(0);
  });
});
