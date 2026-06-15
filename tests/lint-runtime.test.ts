import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanProject } from '../src/scanner.js';
import { lintRuntime, renderLintRuntimeText } from '../src/lint-runtime.js';

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gaslens-lint-'));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content, 'utf8');
  }
  return root;
}

const MANIFEST = JSON.stringify({ runtimeVersion: 'V8' });

describe('lint-runtime — quota.value_in_loop', () => {
  it('WARN sur setValue() dans une boucle for', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': `function go() {
        const sheet = SpreadsheetApp.getActive().getActiveSheet();
        for (let i = 0; i < 100; i++) {
          sheet.getRange(i + 1, 1).setValue(i);
        }
      }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = lintRuntime(idx);
      expect(report.verdict).toBe('WARN');
      const e = report.entries.find((x) => x.kind === 'quota.value_in_loop');
      expect(e?.function).toBe('go');
      expect(e?.fix_hint).toContain('setValues');
      expect(report.findings[0]?.consumer_kind).toBe('lint.quota_in_loop');
      expect(report.findings[0]?.confidence).toBe('medium');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("WARN sur appendRow() dans un .forEach() (boucle 'logique')", async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': `function go() {
        const sheet = SpreadsheetApp.getActive().getActiveSheet();
        [1,2,3].forEach(function(n) { sheet.appendRow([n]); });
      }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = lintRuntime(idx);
      const e = report.entries.find((x) => x.kind === 'quota.value_in_loop');
      expect(e?.fix_hint).toContain('setValues');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("n'attribue pas un appel d'une boucle imbriquée à la boucle externe (pas de double comptage)", async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': `function go() {
        for (let i = 0; i < 10; i++) {
          for (let j = 0; j < 10; j++) {
            SpreadsheetApp.getActive().getRange(i, j).setValue(1);
          }
        }
      }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = lintRuntime(idx);
      // 1 seul finding (la boucle la plus interne), pas 2.
      const e = report.entries.filter((x) => x.kind === 'quota.value_in_loop');
      expect(e).toHaveLength(1);
      expect(e[0]!.line).toBeGreaterThan(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("CLEAN sur une utilisation batch correcte (setValues hors boucle)", async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': `function go() {
        const sheet = SpreadsheetApp.getActive().getActiveSheet();
        const rows = [[1],[2],[3]];
        sheet.getRange(1, 1, rows.length, 1).setValues(rows);
      }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = lintRuntime(idx);
      expect(report.entries.filter((e) => e.severity === 'warn')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('lint-runtime — urlfetch.in_loop', () => {
  it('WARN sur UrlFetchApp.fetch dans une boucle for', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': `function go(urls) {
        const out = [];
        for (const u of urls) {
          out.push(UrlFetchApp.fetch(u));
        }
        return out;
      }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = lintRuntime(idx);
      const e = report.entries.find((x) => x.kind === 'urlfetch.in_loop');
      expect(e?.function).toBe('go');
      expect(e?.fix_hint).toContain('fetchAll');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('CLEAN sur fetchAll hors boucle', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': `function go(reqs) { return UrlFetchApp.fetchAll(reqs); }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = lintRuntime(idx);
      expect(report.entries.filter((e) => e.kind === 'urlfetch.in_loop')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('lint-runtime — lock.no_finally', () => {
  it('WARN quand waitLock() est appelé sans releaseLock() dans un finally', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': `function go() {
        const lock = LockService.getScriptLock();
        lock.waitLock(5000);
        doStuff();
        lock.releaseLock();
      }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = lintRuntime(idx);
      const e = report.entries.find((x) => x.kind === 'lock.no_finally');
      expect(e?.function).toBe('go');
      expect(report.findings[0]?.consumer_kind).toBe('lint.lock_no_finally');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("CLEAN quand releaseLock() est bien dans un finally", async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': `function go() {
        const lock = LockService.getScriptLock();
        try {
          lock.waitLock(5000);
          doStuff();
        } finally {
          lock.releaseLock();
        }
      }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = lintRuntime(idx);
      expect(report.entries.filter((e) => e.kind === 'lock.no_finally')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("WARN aussi sur tryLock() sans finally", async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': `function go() {
        const lock = LockService.getUserLock();
        if (lock.tryLock(0)) {
          doStuff();
          lock.releaseLock();
        }
      }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = lintRuntime(idx);
      const e = report.entries.find((x) => x.kind === 'lock.no_finally');
      expect(e?.function).toBe('go');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('lint-runtime — trigger.orphan', () => {
  it("INFO quand newTrigger().create() existe mais aucun deleteTrigger dans le projet", async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': `function install() {
        ScriptApp.newTrigger('runJob').timeBased().everyHours(1).create();
      }
      function runJob() {}`,
    });
    try {
      const idx = await scanProject({ root });
      const report = lintRuntime(idx);
      const e = report.entries.find((x) => x.kind === 'trigger.orphan');
      expect(e?.severity).toBe('info');
      expect(e?.confidence).toBe('low');
      expect(e?.reason).toContain('runJob');
      // INFO ne fait pas passer en WARN.
      expect(report.verdict).toBe('CLEAN');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("silencieux si le projet appelle deleteTrigger quelque part", async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': `function install() {
        ScriptApp.newTrigger('runJob').timeBased().everyHours(1).create();
      }
      function cleanup() {
        ScriptApp.getProjectTriggers().forEach(function(t) { ScriptApp.deleteTrigger(t); });
      }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = lintRuntime(idx);
      expect(report.entries.filter((e) => e.kind === 'trigger.orphan')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('lint-runtime — rendu texte', () => {
  it('inclut project, verdict, et une ligne par finding avec sa confidence', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': `function go() {
        const sheet = SpreadsheetApp.getActive().getActiveSheet();
        for (let i = 0; i < 5; i++) sheet.getRange(i+1, 1).setValue(i);
      }`,
    });
    try {
      const idx = await scanProject({ root });
      const txt = renderLintRuntimeText(lintRuntime(idx));
      expect(txt).toContain('WARN');
      expect(txt).toContain('quota.value_in_loop');
      expect(txt).toContain('confidence: medium');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
