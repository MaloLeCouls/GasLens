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

describe('emit-contract-tests — runner gas-fakes (V3 §23)', () => {
  let gasFakesHarness: string;
  beforeAll(() => {
    gasFakesHarness = emitContractTests(idx, {
      include_all_public: false,
      runner: 'gas-fakes',
    });
  });

  it("le header annonce explicitement le runner gas-fakes", () => {
    expect(gasFakesHarness).toContain('runner : gas-fakes');
    expect(gasFakesHarness).toContain('gas-fakes');
    expect(gasFakesHarness).toContain('npm install gas-fakes');
  });

  it("inclut le bootstrap import 'gas-fakes' avant le code", () => {
    expect(gasFakesHarness).toMatch(/import 'gas-fakes';/);
    // L'import doit précéder la définition du helper.
    const importIdx = gasFakesHarness.indexOf("import 'gas-fakes';");
    const helperIdx = gasFakesHarness.indexOf('function _gaslensAssertShape_(');
    expect(importIdx).toBeGreaterThan(-1);
    expect(importIdx).toBeLessThan(helperIdx);
  });

  it("contient le footer auto-exécuté avec process.exit pour CI", () => {
    expect(gasFakesHarness).toContain('runGaslensContractTests();');
    expect(gasFakesHarness).toContain('process.exit(0)');
    expect(gasFakesHarness).toContain('process.exit(1)');
    expect(gasFakesHarness).toContain('process.stderr.write');
  });

  it("ne contient PAS l'avertissement SANDBOX du runner clasp (cible différente)", () => {
    expect(gasFakesHarness).not.toContain('À DÉPLOYER DANS UN PROJET GAS DE SANDBOX');
    expect(gasFakesHarness).not.toContain('clasp run runGaslensContractTests');
  });

  it("le runner clasp (défaut) reste inchangé en termes d'avertissement", () => {
    expect(harness).toContain('SANDBOX');
    expect(harness).toContain('clasp run runGaslensContractTests');
    expect(harness).not.toContain("import 'gas-fakes';");
    expect(harness).not.toContain('process.exit(');
  });

  it("le code généré reste syntaxiquement valide JavaScript", () => {
    // Le harnais gas-fakes utilise des imports ESM — on parse via vm/module
    // équivalent en plaçant l'import dans un wrapper async function.
    const body = gasFakesHarness.replace(/^import 'gas-fakes';$/m, '// import stub');
    expect(() => new Function(body)).not.toThrow();
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
