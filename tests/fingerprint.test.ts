import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { scanProject } from '../src/scanner.js';
import { diffIndexes } from '../src/diff.js';
import { bodyFingerprint } from '../src/extract/definitions.js';
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

describe('bodyFingerprint — normalisation', () => {
  it("le même corps avec whitespace différent → même fingerprint", () => {
    expect(bodyFingerprint('{ return 1; }')).toBe(
      bodyFingerprint('{\n  return 1;\n}'),
    );
  });

  it("renvoie une chaîne hex de 16 caractères", () => {
    expect(bodyFingerprint('{}')).toMatch(/^[0-9a-f]{16}$/);
  });

  it("change si un identifiant change", () => {
    expect(bodyFingerprint('{ return a; }')).not.toBe(
      bodyFingerprint('{ return b; }'),
    );
  });

  it("change si un littéral change", () => {
    expect(bodyFingerprint('{ return 1; }')).not.toBe(
      bodyFingerprint('{ return 2; }'),
    );
  });
});

describe('scan — body_fingerprint sur chaque fonction', () => {
  it("chaque définition porte un fingerprint", () => {
    for (const fn of baseline.functions) {
      expect(fn.definition.body_fingerprint).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it("deux fonctions différentes ont des fingerprints différents", () => {
    const fps = new Set(baseline.functions.map((f) => f.definition.body_fingerprint));
    expect(fps.size).toBeGreaterThan(1);
  });
});

describe('diff — détection de rename via body_fingerprint', () => {
  it("rename pur (juste le nom change) → function_renamed, pas add+remove", () => {
    // Simule : sendEmailReport renommée en dispatchReport.
    const current = clone(baseline);
    const send = current.functions.find((f) => f.name === 'sendEmailReport')!;
    send.name = 'dispatchReport';
    send.id = send.id.replace('sendEmailReport', 'dispatchReport');
    // body_fingerprint INCHANGÉ (le corps n'a pas bougé).
    // Les call sites en current pointent encore vers 'sendEmailReport' → unresolved.
    // On simule cet état :
    current.unresolved_calls.push({
      file: 'triggers.gs',
      line: 9,
      callee_text: 'sendEmailReport',
      reason: 'identifier non résolu',
    });
    current.unresolved_calls.push({
      file: 'dashboard.html',
      line: 23,
      callee_text: 'google.script.run.sendEmailReport',
      reason: 'introuvable',
    });

    const r = diffIndexes(baseline, current);
    expect(r.derived_change_set).toContainEqual(
      expect.objectContaining({
        delta: 'function_renamed',
        detail: expect.stringContaining("renommée en 'dispatchReport'"),
      }),
    );
    // Pas de function_added/removed pour ce rename
    expect(
      r.derived_change_set.some(
        (d) => d.delta === 'function_added' && d.detail.includes('dispatchReport'),
      ),
    ).toBe(false);
    expect(
      r.derived_change_set.some(
        (d) => d.delta === 'function_removed' && d.detail.includes('sendEmailReport'),
      ),
    ).toBe(false);
    expect(r.verdict).toBe('BREAK');
    // Les unresolved → BREAK
    expect(r.breaks.length).toBeGreaterThanOrEqual(2);
    expect(
      r.breaks.some((b) => b.consumer_kind === 'client_call.invocation'),
    ).toBe(true);
  });

  it("si le corps change AUSSI lors du rename → pas un rename (add + remove)", () => {
    const current = clone(baseline);
    const send = current.functions.find((f) => f.name === 'sendEmailReport')!;
    send.name = 'dispatchReport';
    send.id = send.id.replace('sendEmailReport', 'dispatchReport');
    send.definition.body_fingerprint = '00000000deadbeef'; // corps modifié
    const r = diffIndexes(baseline, current);
    expect(
      r.derived_change_set.some((d) => d.delta === 'function_renamed'),
    ).toBe(false);
    expect(
      r.derived_change_set.some((d) => d.delta === 'function_added'),
    ).toBe(true);
    expect(
      r.derived_change_set.some((d) => d.delta === 'function_removed'),
    ).toBe(true);
  });
});
