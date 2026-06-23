import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanProject } from '../src/scanner.js';
import { lintDoc, docStub } from '../src/doc-lint.js';

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gaslens-doc-'));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content, 'utf8');
  }
  return root;
}

describe('doc lint — undocumented', () => {
  it('signale une fonction publique sans intention (info)', async () => {
    const root = await makeProject({
      'a.gs': `function doStuff(x) { return x + 1; }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = lintDoc(idx);
      const f = report.findings.find((f) => f.consumer_kind === 'doc.undocumented');
      expect(f).toBeDefined();
      expect(f?.severity).toBe('info');
      expect(f?.consumer.file).toBe('a.gs');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ne signale pas une fonction avec une ligne d’intention', async () => {
    const root = await makeProject({
      'a.gs': `/**\n * Incrémente la valeur passée.\n */\nfunction inc(x) { return x + 1; }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = lintDoc(idx);
      expect(report.findings.some((f) => f.consumer_kind === 'doc.undocumented')).toBe(false);
      expect(report.verdict).toBe('CLEAN');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('un bloc JSDoc sans intention (que des tags) reste undocumented', async () => {
    const root = await makeProject({
      'a.gs': `/**\n * @param {number} x\n */\nfunction inc(x) { return x + 1; }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = lintDoc(idx);
      expect(report.findings.some((f) => f.consumer_kind === 'doc.undocumented')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('--public-only ignore les fonctions privées', async () => {
    const root = await makeProject({
      'a.gs': `function helper_(x) { return x; }`,
    });
    try {
      const idx = await scanProject({ root });
      const all = lintDoc(idx);
      const pub = lintDoc(idx, { publicOnly: true });
      expect(all.findings.length).toBe(1);
      expect(pub.findings.length).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('doc lint — param_drift', () => {
  it('signale un @param sans paramètre réel (WARN)', async () => {
    const root = await makeProject({
      'a.gs': `/**\n * Envoie le rapport.\n * @param {string[]} recipientList  emails\n */\nfunction send(recipients) { return recipients.length; }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = lintDoc(idx);
      const drift = report.findings.find((f) => f.consumer_kind === 'doc.param_drift');
      expect(drift).toBeDefined();
      expect(drift?.severity).toBe('warn');
      expect(drift?.reason).toContain('recipientList');
      expect(report.verdict).toBe('WARN');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('aucun drift quand les @param matchent la signature', async () => {
    const root = await makeProject({
      'a.gs': `/**\n * Envoie le rapport.\n * @param {string[]} recipients  emails\n */\nfunction send(recipients) { return recipients.length; }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = lintDoc(idx);
      expect(report.findings.some((f) => f.consumer_kind === 'doc.param_drift')).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('les checks sont filtrables (drift seul)', async () => {
    const root = await makeProject({
      'a.gs': `/**\n * @param {string} ghost\n */\nfunction f(real) { return real; }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = lintDoc(idx, { checks: new Set(['drift']) });
      expect(report.findings.every((f) => f.consumer_kind === 'doc.param_drift')).toBe(true);
      expect(report.findings.some((f) => f.consumer_kind === 'doc.undocumented')).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('doc lint — return_drift (F4)', () => {
  it('signale un @returns citant un champ que la shape ne produit plus (WARN)', async () => {
    const root = await makeProject({
      'a.gs': [
        '/**',
        " * Construit l'utilisateur.",
        " * @returns {Object} l'objet avec `id` et `oldField`",
        ' */',
        "function getUser() { return { id: 1, name: 'a' }; }",
      ].join('\n'),
    });
    try {
      const idx = await scanProject({ root });
      const report = lintDoc(idx, { checks: new Set(['return_drift']) });
      const drift = report.findings.find((f) => f.consumer_kind === 'doc.return_drift');
      expect(drift).toBeDefined();
      expect(drift?.severity).toBe('warn');
      expect(drift?.reason).toContain('oldField');
      // 'id' est réellement produit → pas de finding pour lui.
      expect(report.findings.filter((f) => f.consumer_kind === 'doc.return_drift')).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('aucun return_drift quand les champs cités correspondent à la shape', async () => {
    const root = await makeProject({
      'a.gs': [
        '/**',
        " * Construit l'utilisateur.",
        ' * @returns {Object} avec `id` et `name`',
        ' */',
        "function getUser() { return { id: 1, name: 'a' }; }",
      ].join('\n'),
    });
    try {
      const idx = await scanProject({ root });
      const report = lintDoc(idx, { checks: new Set(['return_drift']) });
      expect(report.findings.some((f) => f.consumer_kind === 'doc.return_drift')).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("s'abstient quand la shape de retour n'est pas autoritaire (retour opaque)", async () => {
    const root = await makeProject({
      'a.gs': [
        '/**',
        ' * Relaie au helper.',
        ' * @returns {Object} avec `ghost`',
        ' */',
        'function getUser() { return helper_(); }',
        'function helper_() { return { id: 1 }; }',
      ].join('\n'),
    });
    try {
      const idx = await scanProject({ root });
      const report = lintDoc(idx, { checks: new Set(['return_drift']) });
      expect(report.findings.some((f) => f.consumer_kind === 'doc.return_drift')).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('doc lint — stale_ref (F4)', () => {
  it('signale une référence {@link} vers un symbole inexistant (info)', async () => {
    const root = await makeProject({
      'a.gs': [
        '/**',
        ' * Voir {@link disparu} pour le détail.',
        ' */',
        'function main() { return 1; }',
      ].join('\n'),
    });
    try {
      const idx = await scanProject({ root });
      const report = lintDoc(idx, { checks: new Set(['stale_ref']) });
      const stale = report.findings.find((f) => f.consumer_kind === 'doc.stale_ref');
      expect(stale).toBeDefined();
      expect(stale?.severity).toBe('info');
      expect(stale?.reason).toContain('disparu');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ne flague ni une fonction existante ni un service GAS natif', async () => {
    const root = await makeProject({
      'a.gs': [
        '/**',
        ' * Voir {@link helperX} et {@link SpreadsheetApp}.',
        ' */',
        'function main() { return helperX(); }',
        'function helperX() { return 1; }',
      ].join('\n'),
    });
    try {
      const idx = await scanProject({ root });
      const report = lintDoc(idx, { checks: new Set(['stale_ref']) });
      expect(report.findings.some((f) => f.consumer_kind === 'doc.stale_ref')).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('doc stub', () => {
  it('émet un squelette avec les params détectés', async () => {
    const root = await makeProject({
      'a.gs': `function send(recipients, subject) { return true; }`,
    });
    try {
      const idx = await scanProject({ root });
      const stub = docStub(idx, 'send');
      expect(stub).not.toBeNull();
      expect(stub).toContain('@param');
      expect(stub).toContain('recipients');
      expect(stub).toContain('subject');
      expect(stub).toContain('intention');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('renvoie null pour une fonction inconnue', async () => {
    const root = await makeProject({ 'a.gs': `function a() {}` });
    try {
      const idx = await scanProject({ root });
      expect(docStub(idx, 'nope')).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
