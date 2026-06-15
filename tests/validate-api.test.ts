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
