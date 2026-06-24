import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor } from '../src/doctor.js';

/**
 * Tests B2 — deux trous comblés dans `gaslens doctor` :
 *  (A) check hot-path-staticity (toujours actif) : détecte ultracode / xhigh
 *      dans les hooks PreToolUse / PostToolUse / Stop / SubagentStop du
 *      `.claude/settings.json`.
 *  (B) check secrets (--secrets-scan opt-in) : repère .clasprc.json / .env*
 *      en racine + 1-2 niveaux, et grep best-effort 3 patterns secret.
 *
 * Tous les tests sont hors-réseau et auto-isolés (mkdtemp + rm).
 */

const VALID_MASTER = JSON.stringify({
  version: 1,
  name: 'parc',
  environments: { dev: { resources: {} }, prod: { resources: {} } },
});

async function tempWorkspace(settings: object | null, extra?: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gaslens-doctor-b2-'));
  await writeFile(join(root, 'gaslens.workspace.json'), VALID_MASTER, 'utf8');
  if (settings) {
    await mkdir(join(root, '.claude'), { recursive: true });
    await writeFile(join(root, '.claude', 'settings.json'), JSON.stringify(settings), 'utf8');
  }
  if (extra) {
    for (const [relPath, content] of Object.entries(extra)) {
      const full = join(root, relPath);
      await mkdir(join(full, '..'), { recursive: true });
      await writeFile(full, content, 'utf8');
    }
  }
  return root;
}

describe('doctor — check A: hot-path-staticity (invariant L1)', () => {
  it('hooks propres → status ok', async () => {
    const root = await tempWorkspace({
      enabledPlugins: ['gaslens@gaslens'],
      hooks: {
        PostToolUse: [
          {
            matcher: 'Write|Edit|MultiEdit',
            hooks: [{ type: 'command', command: 'gaslens hook --event post-tool-use' }],
          },
        ],
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'gaslens guard --event pre-tool-use' }],
          },
        ],
      },
    });
    try {
      const r = await runDoctor({
        cwd: root,
        nodeVersion: '22.0.0',
        which: () => true,
        fileExists: () => true,
        home: root,
      });
      const c = r.checks.find((x) => x.id === 'hot-path-staticity');
      expect(c).toBeDefined();
      expect(c?.status).toBe('ok');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('hook PostToolUse avec --effort ultracode → warn', async () => {
    const root = await tempWorkspace({
      enabledPlugins: ['gaslens@gaslens'],
      hooks: {
        PostToolUse: [
          {
            matcher: 'Write|Edit',
            hooks: [
              { type: 'command', command: 'claude --effort ultracode run something' },
            ],
          },
        ],
      },
    });
    try {
      const r = await runDoctor({
        cwd: root,
        nodeVersion: '22.0.0',
        which: () => true,
        fileExists: () => true,
        home: root,
      });
      const c = r.checks.find((x) => x.id === 'hot-path-staticity');
      expect(c).toBeDefined();
      expect(c?.status).toBe('warn');
      expect(c?.detail).toMatch(/ultracode/);
      expect(c?.detail).toMatch(/PostToolUse/);
      expect(c?.detail).toMatch(/invariant L1/i);
      // Ne doit PAS contenir la commande complète (risque de fuite).
      expect(c?.detail).not.toMatch(/claude --effort/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('hook SubagentStop avec xhigh → warn', async () => {
    const root = await tempWorkspace({
      enabledPlugins: ['gaslens@gaslens'],
      hooks: {
        SubagentStop: [
          {
            hooks: [
              { type: 'command', command: 'some-tool --mode XHigh --token secrettoken' },
            ],
          },
        ],
      },
    });
    try {
      const r = await runDoctor({
        cwd: root,
        nodeVersion: '22.0.0',
        which: () => true,
        fileExists: () => true,
        home: root,
      });
      const c = r.checks.find((x) => x.id === 'hot-path-staticity');
      expect(c).toBeDefined();
      expect(c?.status).toBe('warn');
      expect(c?.detail).toMatch(/xhigh/i);
      expect(c?.detail).toMatch(/SubagentStop/);
      // Pas de fuite de la chaîne complète (qui contient `secrettoken`).
      expect(c?.detail).not.toMatch(/secrettoken/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('doctor — check B: --secrets-scan', () => {
  it('--secrets-scan désactivé → aucun check secrets dans le rapport', async () => {
    const root = await tempWorkspace({ enabledPlugins: ['gaslens@gaslens'] });
    try {
      const r = await runDoctor({
        cwd: root,
        nodeVersion: '22.0.0',
        which: () => true,
        fileExists: () => true,
        home: root,
      });
      const any = r.checks.find((x) => x.id.startsWith('secrets-'));
      expect(any).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('workspace propre + --secrets-scan → status ok unique', async () => {
    const root = await tempWorkspace({ enabledPlugins: ['gaslens@gaslens'] });
    try {
      const r = await runDoctor({
        cwd: root,
        nodeVersion: '22.0.0',
        which: () => true,
        // Ne ment pas sur l'existence : on délègue au vrai fs (pas de .env créé).
        home: root,
        secretsScan: true,
      });
      const summary = r.checks.find((x) => x.id === 'secrets-scan');
      expect(summary).toBeDefined();
      expect(summary?.status).toBe('ok');
      const fileWarn = r.checks.find((x) => x.id.startsWith('secrets-file:'));
      expect(fileWarn).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('.env présent → warning par fichier', async () => {
    const root = await tempWorkspace(
      { enabledPlugins: ['gaslens@gaslens'] },
      { '.env': 'SECRET=do-not-print\n' },
    );
    try {
      const r = await runDoctor({
        cwd: root,
        nodeVersion: '22.0.0',
        which: () => true,
        home: root,
        secretsScan: true,
      });
      const envWarn = r.checks.find((x) => x.id === 'secrets-file:.env');
      expect(envWarn).toBeDefined();
      expect(envWarn?.status).toBe('warn');
      expect(envWarn?.detail).toMatch(/secret-bearing file/i);
      expect(envWarn?.detail).toMatch(/gitignored/);
      // Ne doit PAS contenir la valeur du secret.
      expect(envWarn?.detail).not.toMatch(/do-not-print/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('.clasprc.json présent en subdir → warning détecté', async () => {
    const root = await tempWorkspace(
      { enabledPlugins: ['gaslens@gaslens'] },
      { 'apps/AppA/.clasprc.json': '{"token":{"access_token":"redact"}}' },
    );
    try {
      const r = await runDoctor({
        cwd: root,
        nodeVersion: '22.0.0',
        which: () => true,
        home: root,
        secretsScan: true,
      });
      const warn = r.checks.find(
        (x) => x.id === 'secrets-file:apps/AppA/.clasprc.json',
      );
      expect(warn).toBeDefined();
      expect(warn?.status).toBe('warn');
      expect(warn?.detail).not.toMatch(/redact/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('pattern Google API key dans un fichier texte → warning file:line PATTERN sans valeur', async () => {
    const root = await tempWorkspace(
      { enabledPlugins: ['gaslens@gaslens'] },
      {
        'src/config.ts':
          '// config\nexport const KEY = "AIzaSyA1234567890abcdefghijklmnopqrstuvwx";\n',
      },
    );
    try {
      const r = await runDoctor({
        cwd: root,
        nodeVersion: '22.0.0',
        which: () => true,
        home: root,
        secretsScan: true,
      });
      const hit = r.checks.find(
        (x) => x.id.startsWith('secrets-pattern:src/config.ts:'),
      );
      expect(hit).toBeDefined();
      expect(hit?.status).toBe('warn');
      expect(hit?.detail).toMatch(/GOOGLE_API_KEY/);
      // CRITIQUE : la valeur du secret ne doit JAMAIS apparaître.
      expect(hit?.detail).not.toMatch(/AIzaSy/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
