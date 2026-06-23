import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWorkspaceFiles, writeWorkspace } from '../src/workspace-init.js';
import { parseWorkspaceManifest } from '../src/workspace-manifest.js';

describe('workspace init — génération (pure)', () => {
  it('émet l’arborescence complète par défaut', () => {
    const files = buildWorkspaceFiles({ name: 'parc' });
    const paths = files.map((f) => f.path);
    expect(paths).toContain('CLAUDE.md');
    expect(paths).toContain('README.md');
    expect(paths).toContain('gaslens.workspace.json');
    expect(paths).toContain('.gitignore');
    expect(paths).toContain('.claude/settings.json');
    expect(paths).toContain('.mcp.json');
    expect(paths).toContain('apps/.gitkeep');
    expect(paths).toContain('backlog/inbox/.gitkeep');
    expect(paths).toContain('backlog/triaged/.gitkeep');
    expect(paths).toContain('backlog/archive/.gitkeep');
    // Setup complet (G6) : scripts/, CI template, docs chargées à la demande.
    expect(paths).toContain('scripts/push-dev.sh');
    expect(paths).toContain('scripts/deploy-prod.sh');
    expect(paths).toContain('scripts/run-tests.sh');
    expect(paths).toContain('.github/workflows/gas-ci.yml');
    expect(paths).toContain('docs/deploy.md');
    expect(paths).toContain('docs/scopes.md');
  });

  it('le manifeste maître généré est valide et nommé', () => {
    const files = buildWorkspaceFiles({ name: 'mon-parc' });
    const manifest = files.find((f) => f.path === 'gaslens.workspace.json')!;
    const res = parseWorkspaceManifest(JSON.parse(manifest.content));
    expect(res.errors).toEqual([]);
    expect(res.manifest?.name).toBe('mon-parc');
    expect(Object.keys(res.manifest!.environments)).toEqual(['dev', 'prod']);
  });

  it('le settings.json déclare la marketplace + le plugin', () => {
    const files = buildWorkspaceFiles({ name: 'x' });
    const settings = JSON.parse(
      files.find((f) => f.path === '.claude/settings.json')!.content,
    );
    expect(settings.enabledPlugins).toContain('gaslens@gaslens');
    expect(settings.extraKnownMarketplaces.gaslens.source).toBe('MaloLeCouls/GasLens');
  });

  it('--no-plugin omet .claude/settings.json ; --mcp none omet .mcp.json', () => {
    const files = buildWorkspaceFiles({ name: 'x', withPlugin: false, mcp: 'none' });
    const paths = files.map((f) => f.path);
    expect(paths).not.toContain('.claude/settings.json');
    expect(paths).not.toContain('.mcp.json');
  });
});

describe('workspace init — écriture', () => {
  it('écrit tous les fichiers sur un dossier neuf', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gaslens-init-'));
    try {
      const files = buildWorkspaceFiles({ name: 'parc' });
      const res = await writeWorkspace(root, files);
      expect(res.skipped).toEqual([]);
      expect(res.written.length).toBe(files.length);
      expect(existsSync(join(root, 'gaslens.workspace.json'))).toBe(true);
      expect(existsSync(join(root, 'backlog/inbox/.gitkeep'))).toBe(true);
      const claude = await readFile(join(root, 'CLAUDE.md'), 'utf8');
      expect(claude).toContain('parc');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ne réécrit pas un fichier existant sans --force', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gaslens-init-'));
    try {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'CLAUDE.md'), 'ORIGINAL', 'utf8');
      const files = buildWorkspaceFiles({ name: 'parc' });
      const res = await writeWorkspace(root, files);
      expect(res.skipped.some((s) => s.path === 'CLAUDE.md')).toBe(true);
      expect(await readFile(join(root, 'CLAUDE.md'), 'utf8')).toBe('ORIGINAL');

      const forced = await writeWorkspace(root, files, { force: true });
      expect(forced.written).toContain('CLAUDE.md');
      expect(await readFile(join(root, 'CLAUDE.md'), 'utf8')).not.toBe('ORIGINAL');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
