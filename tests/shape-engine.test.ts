import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { scanProject } from '../src/scanner.js';
import { diffIndexes } from '../src/diff.js';
import type { FunctionRecord, ProjectIndex } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, 'fixtures/sample-project');

let idx: ProjectIndex;
const byName = new Map<string, FunctionRecord>();

function clone(x: ProjectIndex): ProjectIndex {
  return JSON.parse(JSON.stringify(x)) as ProjectIndex;
}

beforeAll(async () => {
  idx = await scanProject({ root: FIXTURE });
  for (const fn of idx.functions) byName.set(fn.name, fn);
});

describe('return_analysis — nullabilité', () => {
  it('détecte un `return null` dans lookupUser_', () => {
    const r = byName.get('lookupUser_')!.return_analysis;
    expect(r.nullable).toBe(true);
    expect(r.null_paths).toHaveLength(1);
    expect(r.null_paths[0]!.file).toBe('dispatch.gs');
  });

  it("ne flag PAS comme nullable une fonction qui ne renvoie jamais null", () => {
    const r = byName.get('sendEmailReport')!.return_analysis;
    expect(r.nullable).toBe(false);
    expect(r.null_paths).toEqual([]);
  });
});

describe('return_analysis — sérialisabilité', () => {
  it('flag `return new MyClass()` comme non-sérialisable (V2 §11.5)', () => {
    const r = byName.get('buildEntity')!.return_analysis;
    expect(r.serializable).toBe(false);
    expect(r.non_serializable_reasons[0]!.reason).toContain('new MyClass()');
  });

  it("ne flag PAS `new Date()` (Date est sérialisable via google.script.run)", () => {
    // Aucune fonction du fixture ne renvoie new Date() directement, mais on
    // peut vérifier que les fonctions normales restent sérialisables.
    const r = byName.get('sendEmailReport')!.return_analysis;
    expect(r.serializable).toBe(true);
  });

  it("ne flag PAS comme non-sérialisable un retour qui CONTIENT un appel à .map(fn)", () => {
    // listItems fait `rows.map(function(row){...})` — la function passée à map
    // n'est PAS une partie de la shape de retour (qui est un array d'objets).
    const r = byName.get('listItems')!.return_analysis;
    expect(r.serializable).toBe(true);
    expect(r.non_serializable_reasons).toEqual([]);
  });
});

describe('return_analysis — open object (clé calculée)', () => {
  it('flag has_open_object pour `return { [k]: v }`', () => {
    const r = byName.get('buildDynamicMap')!.return_analysis;
    expect(r.has_open_object).toBe(true);
  });

  it('ajoute une note coverage pour expliquer la limite à l\'agent', () => {
    const cov = byName.get('buildDynamicMap')!.coverage;
    expect(
      cov.unresolved.some((u) => u.what.includes('clé')),
    ).toBe(true);
  });
});

describe('coverage — dispatch dynamique (V2 §10.4)', () => {
  it('détecte handlers[name]() comme source d\'incertitude', () => {
    const cov = byName.get('dispatchAction')!.coverage;
    const hit = cov.unresolved.find((u) => u.what.includes('dispatch dynamique'));
    expect(hit).toBeDefined();
    expect(hit!.where).toContain('dispatch.gs');
    expect(hit!.suggestion).toBeDefined();
  });
});

describe('coverage_summary — synthèse projet (V1 §1.5)', () => {
  it("expose total_unresolved et unresolved_by_kind", () => {
    const s = idx.coverage_summary;
    expect(s.total_unresolved).toBeGreaterThan(0);
    expect(s.unresolved_by_kind.dynamic_dispatch).toBeGreaterThanOrEqual(1);
    expect(s.unresolved_by_kind.computed_key_in_return).toBeGreaterThanOrEqual(1);
  });

  it("liste les fonctions à risque (sérialisabilité, dispatch, open returns)", () => {
    const s = idx.coverage_summary;
    expect(s.functions_with_non_serializable_returns).toContain('buildEntity');
    expect(s.functions_with_dynamic_dispatch).toContain('dispatchAction');
    expect(s.functions_with_open_returns).toContain('buildDynamicMap');
  });
});

describe('diff — serializable.broke (V2 §11.5)', () => {
  it("BREAK quand un client_call a son retour devenu non-sérialisable", () => {
    const current = clone(idx);
    const send = current.functions.find((f) => f.name === 'sendEmailReport')!;
    // Simule : le retour devient new SomeClass()
    send.return_analysis.serializable = false;
    send.return_analysis.non_serializable_reasons = [
      { file: 'email.gs', line: 13, reason: 'retour est `new BigPayload()`' },
    ];

    const r = diffIndexes(idx, current);
    expect(r.derived_change_set).toContainEqual(
      expect.objectContaining({ delta: 'serializable.broke' }),
    );
    expect(r.verdict).toBe('BREAK');
    expect(
      r.breaks.some(
        (b) =>
          b.consumer_kind === 'client_call.invocation' &&
          b.reason.includes('non transmissible'),
      ),
    ).toBe(true);
  });

  it("pas de BREAK si la fonction n'est pas exposée via google.script.run", () => {
    const current = clone(idx);
    const fr = current.functions.find((f) => f.name === 'formatReport')!;
    fr.return_analysis.serializable = false;
    fr.return_analysis.non_serializable_reasons = [
      { file: 'email.gs', line: 17, reason: 'fake' },
    ];
    const r = diffIndexes(idx, current);
    // delta émis mais aucun BREAK consommateur (formatReport pas client_call)
    expect(r.derived_change_set).toContainEqual(
      expect.objectContaining({ delta: 'serializable.broke' }),
    );
    expect(r.breaks.filter((b) => b.consumer_kind === 'client_call.invocation')).toEqual([]);
  });
});

describe('diff — return.nullability_changed', () => {
  it("WARN avec confidence=medium quand un handler lit un champ sans garde", () => {
    const current = clone(idx);
    const send = current.functions.find((f) => f.name === 'sendEmailReport')!;
    send.return_analysis.nullable = true;
    send.return_analysis.null_paths = [
      { file: 'email.gs', line: 12 },
    ];
    const r = diffIndexes(idx, current);
    expect(r.derived_change_set).toContainEqual(
      expect.objectContaining({ delta: 'return.nullability_changed' }),
    );
    const w = r.warns.find(
      (w) => w.consumer_kind === 'client_call.success_handler',
    );
    expect(w).toBeDefined();
    expect(w!.confidence).toBe('medium');
  });
});
