import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanProject } from '../src/scanner.js';
import { validateApi, renderApiValidationText } from '../src/validate-api.js';

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gaslens-api-'));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content, 'utf8');
  }
  return root;
}

const MANIFEST = JSON.stringify({ runtimeVersion: 'V8' });

describe('validate-api — détection de méthodes hallucinées', () => {
  it("BREAK sur Range.getValuesAll() (n'existe pas, proche: getValues)", async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': `function go() {
        return SpreadsheetApp.getActive().getActiveSheet().getRange('A1').getValuesAll();
      }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = validateApi(idx);
      expect(report.verdict).toBe('BREAK');
      expect(report.entries).toHaveLength(1);
      expect(report.entries[0]).toMatchObject({
        kind: 'api.unknown_method',
        on_type: 'Range',
        method: 'getValuesAll',
      });
      expect(report.entries[0]!.suggestions).toContain('getValues');
      expect(report.findings[0]?.consumer_kind).toBe('api.unknown_method');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("BREAK sur SpreadsheetApp.openByName (inexistant)", async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': `function go() { return SpreadsheetApp.openByName('foo'); }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = validateApi(idx);
      expect(report.verdict).toBe('BREAK');
      const e = report.entries[0]!;
      expect(e.on_type).toBe('SpreadsheetApp');
      expect(e.method).toBe('openByName');
      expect(e.suggestions.some((s) => s.startsWith('openBy'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("CLEAN sur une chaîne 100 % valide", async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': `function go() {
        return SpreadsheetApp.getActive().getSheetByName('x').getRange('A1').getValues();
      }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = validateApi(idx);
      expect(report.verdict).toBe('CLEAN');
      expect(report.entries).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('validate-api — honnêteté', () => {
  it("ignore les chaînes enracinées sur un nom inconnu du registre", async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': `function go() { return OAuth2.getService('x').hasAccess(); }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = validateApi(idx);
      // OAuth2 n'est pas dans le registre → on ne valide pas, donc CLEAN ici.
      // (Le manifest-analysis se chargera d'OAuth2 si non déclaré.)
      expect(report.verdict).toBe('CLEAN');
      expect(report.chains_skipped_unknown_root).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("arrête honnêtement la chaîne quand un type retourné est 'unknown' (pas de faux positif)", async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': `function go() {
        // getRangeList returns 'unknown' dans le registre → la suite n'est PAS validée.
        return SpreadsheetApp.getActive().getRangeList(['A1', 'B1']).hypotheticalMethod();
      }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = validateApi(idx);
      expect(report.verdict).toBe('CLEAN');
      expect(report.chains_stopped_unknown_type).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("arrête sur les types tableau (Sheet[]) sans inventer", async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': `function go() {
        // getSheets() returns 'Sheet[]' → on ne valide pas .toto() après.
        return SpreadsheetApp.getActive().getSheets().toto();
      }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = validateApi(idx);
      expect(report.verdict).toBe('CLEAN');
      expect(report.chains_stopped_unknown_type).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('validate-api — chaînes builder GAS (cas terrain)', () => {
  it('valide la chaîne ScriptApp.newTrigger().timeBased().everyWeeks().create()', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': `function go() {
        ScriptApp.newTrigger('fn').timeBased().everyWeeks(1).create();
      }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = validateApi(idx);
      expect(report.verdict).toBe('CLEAN');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("flag une méthode inexistante du builder (everyHours typo)", async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': `function go() {
        ScriptApp.newTrigger('fn').timeBased().everyHourz(1).create();
      }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = validateApi(idx);
      expect(report.verdict).toBe('BREAK');
      const e = report.entries[0]!;
      expect(e.on_type).toBe('ClockTriggerBuilder');
      expect(e.method).toBe('everyHourz');
      expect(e.suggestions).toContain('everyHours');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('validate-api — api.wrong_arity', () => {
  it('BREAK quand Properties.setProperty est appelée avec 1 arg (manque value)', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': `function go() { PropertiesService.getScriptProperties().setProperty('k'); }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = validateApi(idx);
      expect(report.verdict).toBe('BREAK');
      const e = report.entries[0]!;
      expect(e.kind).toBe('api.wrong_arity');
      expect(e.method).toBe('setProperty');
      expect(e.arity_observed).toBe(1);
      expect(e.arity_expected).toEqual({ min: 2, max: 2 });
      expect(report.findings[0]?.consumer_kind).toBe('api.wrong_arity');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('BREAK quand ScriptApp.newTrigger() est appelée sans argument', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': `function go() { ScriptApp.newTrigger().timeBased().everyHours(1).create(); }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = validateApi(idx);
      expect(report.verdict).toBe('BREAK');
      const e = report.entries[0]!;
      expect(e.method).toBe('newTrigger');
      expect(e.arity_observed).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('BREAK quand range.setValue() oublie sa valeur', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': `function go() {
        SpreadsheetApp.getActive().getActiveSheet().getRange('A1').setValue();
      }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = validateApi(idx);
      const e = report.entries.find((x) => x.kind === 'api.wrong_arity');
      expect(e?.method).toBe('setValue');
      expect(e?.on_type).toBe('Range');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('CLEAN quand l\'arity est correcte', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': `function go() {
        PropertiesService.getScriptProperties().setProperty('k', 'v');
        ScriptApp.newTrigger('runJob').timeBased().everyHours(1).create();
      }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = validateApi(idx);
      expect(report.verdict).toBe('CLEAN');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ne flag pas trop d'arguments (JS les ignore en silence)", async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': `function go() {
        Utilities.getUuid('extra-arg-ignored');
      }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = validateApi(idx);
      expect(report.entries.filter((e) => e.kind === 'api.wrong_arity')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ne flag pas les méthodes sans arity dans le registre (silencieux par honnêteté)", async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      // Sheet.getRange est overloadée (1-4 args), donc absente de GAS_API_ARITY.
      // L'appel à 5 args ne doit PAS lever — on s'abstient plutôt que d'inventer.
      'main.gs': `function go() { SpreadsheetApp.getActive().getActiveSheet().getRange(1, 1, 1, 1).getValue(); }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = validateApi(idx);
      expect(report.verdict).toBe('CLEAN');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('validate-api — rendu texte', () => {
  it("inclut project, verdict, méthode hallucinée et suggestion", async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': `function go() {
        return SpreadsheetApp.getActive().getSheetByName('x').getRange('A1').getValuesAll();
      }`,
    });
    try {
      const idx = await scanProject({ root });
      const txt = renderApiValidationText(validateApi(idx));
      expect(txt).toContain('BREAK');
      expect(txt).toContain('api.unknown_method');
      expect(txt).toContain('Range.getValuesAll');
      expect(txt).toContain('getValues');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
