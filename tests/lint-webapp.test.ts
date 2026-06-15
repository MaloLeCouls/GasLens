import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanProject } from '../src/scanner.js';
import { lintWebapp, renderLintWebappText } from '../src/lint-webapp.js';

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gaslens-webapp-'));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content, 'utf8');
  }
  return root;
}

const MANIFEST = JSON.stringify({ runtimeVersion: 'V8', webapp: { access: 'ANYONE', executeAs: 'USER_DEPLOYING' } });
const SERVER_GS = `function doGet() { return HtmlService.createTemplateFromFile('index').evaluate(); }`;

describe('lint-webapp — mixed_content', () => {
  it('WARN sur <script src="http://...">', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': SERVER_GS,
      'index.html': `<!DOCTYPE html><html><head><script src="http://cdn.example.com/lib.js"></script></head><body></body></html>`,
    });
    try {
      const idx = await scanProject({ root });
      const report = lintWebapp(idx);
      expect(report.verdict).toBe('WARN');
      const e = report.entries.find((x) => x.kind === 'webapp.mixed_content');
      expect(e?.file).toBe('index.html');
      expect(e?.confidence).toBe('high');
      expect(report.findings[0]?.consumer_kind).toBe('webapp.mixed_content');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('WARN sur fetch("http://...") dans un <script>', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': SERVER_GS,
      'index.html': `<html><body><script>fetch('http://api.example.com/data')</script></body></html>`,
    });
    try {
      const idx = await scanProject({ root });
      const report = lintWebapp(idx);
      const e = report.entries.find((x) => x.kind === 'webapp.mixed_content');
      expect(e?.reason).toContain('http://api.example.com');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('CLEAN sur https://...', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': SERVER_GS,
      'index.html': `<html><head><script src="https://cdn.example.com/lib.js"></script></head></html>`,
    });
    try {
      const idx = await scanProject({ root });
      const report = lintWebapp(idx);
      expect(report.entries.filter((e) => e.kind === 'webapp.mixed_content')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('lint-webapp — link_target', () => {
  it("WARN sur <a href=\"...\"> sans target ni <base target=\"_top\">", async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': SERVER_GS,
      'index.html': `<html><body><a href="https://example.com">cliquer</a></body></html>`,
    });
    try {
      const idx = await scanProject({ root });
      const report = lintWebapp(idx);
      const e = report.entries.find((x) => x.kind === 'webapp.link_target');
      expect(e?.reason).toContain('https://example.com');
      expect(report.verdict).toBe('WARN');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('CLEAN si <base target="_top"> est présent dans le head', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': SERVER_GS,
      'index.html': `<html><head><base target="_top"></head><body><a href="https://example.com">x</a></body></html>`,
    });
    try {
      const idx = await scanProject({ root });
      const report = lintWebapp(idx);
      expect(report.entries.filter((e) => e.kind === 'webapp.link_target')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("CLEAN si chaque <a> a target=\"_top\" ou target=\"_blank\"", async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': SERVER_GS,
      'index.html': `<html><body><a href="https://x.com" target="_blank">x</a><a href="https://y.com" target="_top">y</a></body></html>`,
    });
    try {
      const idx = await scanProject({ root });
      const report = lintWebapp(idx);
      expect(report.entries.filter((e) => e.kind === 'webapp.link_target')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ignore les ancres locales (#foo), javascript: et mailto:', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': SERVER_GS,
      'index.html': `<html><body><a href="#top">x</a><a href="javascript:void(0)">y</a><a href="mailto:a@b.c">z</a></body></html>`,
    });
    try {
      const idx = await scanProject({ root });
      const report = lintWebapp(idx);
      expect(report.entries.filter((e) => e.kind === 'webapp.link_target')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('lint-webapp — form_submit', () => {
  it('WARN sur <form> avec bouton submit sans onsubmit/preventDefault', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': SERVER_GS,
      'index.html': `<html><body><form><input type="text"/><button type="submit">go</button></form></body></html>`,
    });
    try {
      const idx = await scanProject({ root });
      const report = lintWebapp(idx);
      const e = report.entries.find((x) => x.kind === 'webapp.form_submit');
      expect(e?.line).toBeGreaterThan(0);
      expect(report.verdict).toBe('WARN');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('CLEAN si onsubmit appelle preventDefault', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': SERVER_GS,
      'index.html': `<html><body><form onsubmit="event.preventDefault(); return false;"><button type="submit">go</button></form></body></html>`,
    });
    try {
      const idx = await scanProject({ root });
      const report = lintWebapp(idx);
      expect(report.entries.filter((e) => e.kind === 'webapp.form_submit')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("CLEAN si le <form> n'a pas de bouton submit", async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': SERVER_GS,
      'index.html': `<html><body><form><input type="text"/><button type="button" onclick="go()">go</button></form></body></html>`,
    });
    try {
      const idx = await scanProject({ root });
      const report = lintWebapp(idx);
      expect(report.entries.filter((e) => e.kind === 'webapp.form_submit')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('lint-webapp — rendu texte', () => {
  it('inclut project, verdict, kind, confidence, et fix_hint', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': SERVER_GS,
      'index.html': `<html><body><script src="http://x.com/lib.js"></script><a href="https://y.com">go</a></body></html>`,
    });
    try {
      const idx = await scanProject({ root });
      const txt = renderLintWebappText(lintWebapp(idx));
      expect(txt).toContain('WARN');
      expect(txt).toContain('webapp.mixed_content');
      expect(txt).toContain('webapp.link_target');
      expect(txt).toContain('confidence: high');
      expect(txt).toContain('fix:');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('lint-webapp — projet sans HTML', () => {
  it('CLEAN quand le projet ne sert aucun HTML', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': `function go() { return 1; }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = lintWebapp(idx);
      expect(report.verdict).toBe('CLEAN');
      expect(report.entries).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
