import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanProject } from '../src/scanner.js';
import { analyzeManifest, renderManifestText } from '../src/manifest-analysis.js';

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gaslens-manifest-'));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content, 'utf8');
  }
  return root;
}

const MANIFEST_NO_DEPS = JSON.stringify(
  { runtimeVersion: 'V8', timeZone: 'Europe/Paris' },
  null,
  2,
);

describe('manifest — library detection', () => {
  it("BREAK library.undeclared sur un appel 'OAuth2.x' sans déclaration", async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST_NO_DEPS,
      'main.gs': `function go() { OAuth2.getService('me'); }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = analyzeManifest(idx);
      expect(report.verdict).toBe('BREAK');
      const undeclared = report.entries.find((e) => e.kind === 'library.undeclared');
      expect(undeclared?.symbol).toBe('OAuth2');
      expect(undeclared?.call_sites[0]).toMatchObject({
        file: 'main.gs',
        function: 'go',
        method: 'getService',
      });
      // Le finding doit porter le bon consumer_kind pour que check le route.
      expect(report.findings[0]?.consumer_kind).toBe('manifest.library');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('CLEAN quand la librairie est déclarée (userSymbol matche le receiver)', async () => {
    const root = await makeProject({
      'appsscript.json': JSON.stringify({
        runtimeVersion: 'V8',
        dependencies: {
          libraries: [{ userSymbol: 'OAuth2', libraryId: 'xxx', version: '1' }],
        },
      }),
      'main.gs': `function go() { OAuth2.getService('me'); }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = analyzeManifest(idx);
      expect(report.verdict).toBe('CLEAN');
      expect(report.entries.filter((e) => e.kind === 'library.undeclared')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("INFO library.unused quand le manifeste déclare une lib jamais appelée", async () => {
    const root = await makeProject({
      'appsscript.json': JSON.stringify({
        dependencies: {
          libraries: [{ userSymbol: 'Lodash', libraryId: 'xxx', version: '1' }],
        },
      }),
      'main.gs': `function go() { return 1; }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = analyzeManifest(idx);
      const unused = report.entries.find((e) => e.kind === 'library.unused');
      expect(unused?.symbol).toBe('Lodash');
      expect(unused?.severity).toBe('info');
      expect(report.verdict).toBe('CLEAN');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('manifest — advanced services', () => {
  it("BREAK advanced_service.missing pour 'Drive.Files.list()' sans déclaration", async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST_NO_DEPS,
      'main.gs': `function go() { Drive.Files.list({ q: 'mimeType="application/vnd.google-apps.folder"' }); }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = analyzeManifest(idx);
      expect(report.verdict).toBe('BREAK');
      const missing = report.entries.find((e) => e.kind === 'advanced_service.missing');
      expect(missing?.symbol).toBe('Drive');
      expect(report.findings[0]?.consumer_kind).toBe('manifest.advanced_service');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('CLEAN quand le service avancé est dans enabledAdvancedServices', async () => {
    const root = await makeProject({
      'appsscript.json': JSON.stringify({
        dependencies: {
          enabledAdvancedServices: [
            { userSymbol: 'Drive', serviceId: 'drive', version: 'v2' },
          ],
        },
      }),
      'main.gs': `function go() { Drive.Files.list({}); }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = analyzeManifest(idx);
      expect(report.verdict).toBe('CLEAN');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("INFO advanced_service.unused pour service activé jamais utilisé", async () => {
    const root = await makeProject({
      'appsscript.json': JSON.stringify({
        dependencies: {
          enabledAdvancedServices: [
            { userSymbol: 'Tasks', serviceId: 'tasks', version: 'v1' },
          ],
        },
      }),
      'main.gs': `function go() { return 1; }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = analyzeManifest(idx);
      const unused = report.entries.find((e) => e.kind === 'advanced_service.unused');
      expect(unused?.symbol).toBe('Tasks');
      expect(unused?.severity).toBe('info');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('manifest — bruit attendu (false positives évités)', () => {
  it("n'émet AUCUN finding pour les services natifs (SpreadsheetApp, GmailApp, …)", async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST_NO_DEPS,
      'main.gs': `function go() {
        SpreadsheetApp.getActive().getSheetByName('x').getRange('A1').getValue();
        GmailApp.sendEmail('a@b.c', 's', 'b');
        UrlFetchApp.fetch('https://example.com');
        Utilities.getUuid();
      }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = analyzeManifest(idx);
      expect(report.entries.filter((e) => e.severity === 'break')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignore les constructeurs JS natifs (JSON.stringify, Date.now, Math.abs)", async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST_NO_DEPS,
      'main.gs': `function go() {
        return { iso: new Date().toISOString(), abs: Math.abs(-5), s: JSON.stringify({}) };
      }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = analyzeManifest(idx);
      expect(report.entries).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ne capture pas le texte des expressions chaînées comme un nouveau receiver", async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST_NO_DEPS,
      'main.gs': `function go() {
        return SpreadsheetApp.getActive().getSheets()[0].getDataRange().getValues();
      }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = analyzeManifest(idx);
      // seuls SpreadsheetApp doit apparaître ; pas de "getActive()" ou autre chaînon.
      const undeclared = report.entries.filter((e) => e.kind === 'library.undeclared');
      expect(undeclared).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('manifest — manifeste absent', () => {
  it("signale gracieusement l'absence d'appsscript.json sans émettre de findings", async () => {
    const root = await makeProject({
      'main.gs': `function go() { GmailApp.sendEmail('a', 'b', 'c'); }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = analyzeManifest(idx);
      expect(report.manifest_present).toBe(false);
      expect(report.findings).toEqual([]);
      expect(report.summary).toContain('Aucun appsscript.json');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('manifest — rendu texte', () => {
  it('inclut le project, verdict, et au moins une ligne par entrée', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST_NO_DEPS,
      'main.gs': `function go() { ExtLib.something(); }`,
    });
    try {
      const idx = await scanProject({ root });
      const txt = renderManifestText(analyzeManifest(idx));
      expect(txt).toContain('BREAK');
      expect(txt).toContain('library.undeclared');
      expect(txt).toContain('ExtLib');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('manifest — phase 2 : oauthScopes', () => {
  it("silencieux quand oauthScopes est absent (auto-détection Google)", async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST_NO_DEPS,
      'main.gs': `function go() { GmailApp.sendEmail('a','b','c'); }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = analyzeManifest(idx);
      const scopes = report.entries.filter((e) => e.kind === 'scope.missing');
      expect(scopes).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("WARN scope.missing quand oauthScopes explicite n'inclut pas Gmail", async () => {
    const root = await makeProject({
      'appsscript.json': JSON.stringify({
        oauthScopes: ['https://www.googleapis.com/auth/spreadsheets'],
      }),
      'main.gs': `function go() { GmailApp.sendEmail('a','b','c'); }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = analyzeManifest(idx);
      const e = report.entries.find((x) => x.kind === 'scope.missing');
      expect(e?.symbol).toBe('GmailApp');
      expect(e?.severity).toBe('warn');
      expect(report.verdict).toBe('WARN');
      expect(report.findings[0]?.consumer_kind).toBe('manifest.scope');
      expect(report.findings[0]?.confidence).toBe('medium');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("CLEAN quand un scope acceptable (alternative) suffit", async () => {
    const root = await makeProject({
      'appsscript.json': JSON.stringify({
        oauthScopes: ['https://www.googleapis.com/auth/gmail.send'],
      }),
      'main.gs': `function go() { GmailApp.sendEmail('a','b','c'); }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = analyzeManifest(idx);
      expect(report.entries.filter((e) => e.kind === 'scope.missing')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("INFO scope.unused quand un scope déclaré ne sert à aucun service utilisé", async () => {
    const root = await makeProject({
      'appsscript.json': JSON.stringify({
        oauthScopes: [
          'https://www.googleapis.com/auth/spreadsheets',
          'https://mail.google.com/',
        ],
      }),
      'main.gs': `function go() { SpreadsheetApp.getActive().getRange('A1').getValue(); }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = analyzeManifest(idx);
      const unused = report.entries.find((e) => e.kind === 'scope.unused');
      expect(unused?.symbol).toBe('https://mail.google.com/');
      expect(unused?.severity).toBe('info');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('manifest — phase 2 : urlFetchWhitelist', () => {
  it("silencieux quand urlFetchWhitelist est absent", async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST_NO_DEPS,
      'main.gs': `function go() { UrlFetchApp.fetch('https://example.com/x'); }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = analyzeManifest(idx);
      expect(report.entries.filter((e) => e.kind === 'urlfetch.not_whitelisted')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("WARN sur fetch vers URL non listée", async () => {
    const root = await makeProject({
      'appsscript.json': JSON.stringify({
        urlFetchWhitelist: ['https://allowed.example.com/'],
      }),
      'main.gs': `function go() { UrlFetchApp.fetch('https://forbidden.example.com/api'); }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = analyzeManifest(idx);
      expect(report.verdict).toBe('WARN');
      const e = report.entries.find((x) => x.kind === 'urlfetch.not_whitelisted');
      expect(e?.symbol).toBe('https://forbidden.example.com/api');
      expect(report.findings[0]?.consumer_kind).toBe('manifest.urlfetch_whitelist');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("CLEAN sur fetch vers URL listée (match par préfixe)", async () => {
    const root = await makeProject({
      'appsscript.json': JSON.stringify({
        urlFetchWhitelist: ['https://allowed.example.com/'],
      }),
      'main.gs': `function go() { UrlFetchApp.fetch('https://allowed.example.com/api/v1'); }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = analyzeManifest(idx);
      expect(report.entries.filter((e) => e.kind === 'urlfetch.not_whitelisted')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignore les URLs dynamiques (variables / interpolation) sans faux positif", async () => {
    const root = await makeProject({
      'appsscript.json': JSON.stringify({
        urlFetchWhitelist: ['https://allowed.example.com/'],
      }),
      'main.gs': `function go(u) { UrlFetchApp.fetch(u); UrlFetchApp.fetch(\`https://x.com/\${id}\`); }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = analyzeManifest(idx);
      expect(report.entries.filter((e) => e.kind === 'urlfetch.not_whitelisted')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
