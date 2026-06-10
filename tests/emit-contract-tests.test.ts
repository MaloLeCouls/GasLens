import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { scanProject } from '../src/scanner.js';
import { emitContractTests } from '../src/emit-contract-tests.js';
import type { ProjectIndex } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, 'fixtures/sample-project');

let idx: ProjectIndex;
let harness: string;

beforeAll(async () => {
  idx = await scanProject({ root: FIXTURE });
  harness = emitContractTests(idx);
});

describe('emit-contract-tests — structure générée', () => {
  it("entête identifie le projet et avertit du déploiement sandbox", () => {
    expect(harness).toContain('sample-project');
    expect(harness).toContain('SANDBOX');
    expect(harness).toContain('JAMAIS');
  });

  it("contient le helper _gaslensAssertShape_", () => {
    expect(harness).toContain('function _gaslensAssertShape_(');
    expect(harness).toContain('champs manquants');
    expect(harness).toContain('typeof result');
  });

  it("contient le runner runGaslensContractTests qui agrège", () => {
    expect(harness).toContain('function runGaslensContractTests()');
    expect(harness).toContain('passes++');
    expect(harness).toContain('failures.push');
  });

  it("le code généré est du JavaScript syntaxiquement valide", () => {
    expect(() => new Function(harness)).not.toThrow();
  });
});

describe('emit-contract-tests — sélection des fonctions', () => {
  it("génère un test pour sendEmailReport (a un inferred_contract.return_shape)", () => {
    expect(harness).toContain('function _test_sendEmailReport_()');
    expect(harness).toContain("_gaslensAssertShape_('sendEmailReport',");
    expect(harness).toMatch(/\['success', 'messageId'\]/);
  });

  it("référence le handler consommateur dans le test (traçabilité)", () => {
    expect(harness).toMatch(/handlers: \['onSendOk'\]/);
  });

  it("n'inclut PAS les fonctions privées (suffixe _)", () => {
    expect(harness).not.toMatch(/function _test_generateId__\(/);
    expect(harness).not.toMatch(/function _test_getUserName__\(/);
  });

  it("n'inclut PAS les fonctions publiques sans contrat connu (par défaut)", () => {
    // doGet, doPost, listItems n'ont pas d'inferred_contract.return_shape
    expect(harness).not.toContain('function _test_doGet_()');
    expect(harness).not.toContain('function _test_listItems_()');
  });

  it("inclut TOUTES les fonctions publiques avec --include-all", () => {
    const all = emitContractTests(idx, { include_all_public: true });
    expect(all).toContain('function _test_doGet_()');
    expect(all).toContain('function _test_listItems_()');
    expect(all).toContain('function _test_sendEmailReport_()');
    // toujours pas les privées
    expect(all).not.toMatch(/_test_generateId__/);
  });

  it("marque les arguments en TODO avec leur type JSDoc", () => {
    expect(harness).toContain('/* reportData: Object */ null');
    expect(harness).toContain('/* recipients: string[] */ null');
  });
});

describe('emit-contract-tests — cas vide', () => {
  it("explique quoi faire si aucune fonction n'a de contrat connu", () => {
    const stub: ProjectIndex = {
      kind: 'project',
      project: 'empty',
      root: '/tmp',
      scanned_at: '2026-06-10T00:00:00Z',
      files: [],
      functions: [],
      property_keys: [],
      pending_library_calls: [],
      coverage_summary: {
        resolved_pct: 100,
        confidence: 'high',
        total_unresolved: 0,
        unresolved_by_kind: {},
        functions_with_open_returns: [],
        functions_with_dynamic_dispatch: [],
        functions_with_non_serializable_returns: [],
      },
      unresolved_calls: [],
    };
    const out = emitContractTests(stub);
    expect(out).toContain("Aucune fonction n'a de shape de retour connue");
    expect(out).toContain('--include-all');
    expect(() => new Function(out)).not.toThrow();
  });
});
