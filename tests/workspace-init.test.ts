import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildWorkspaceFiles,
  writeWorkspace,
  DEFAULT_GASLENS_ALLOW,
} from '../src/workspace-init.js';
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

  it('le settings.json déclare une allowlist read-only de gaslens (A2)', () => {
    const files = buildWorkspaceFiles({ name: 'x' });
    const settings = JSON.parse(
      files.find((f) => f.path === '.claude/settings.json')!.content,
    );
    const allow = settings.permissions?.allow as string[];
    expect(Array.isArray(allow)).toBe(true);
    // Les 12 entrées attendues (V5 §33 A2) — toutes read-only.
    const expected = [
      'Bash(gaslens scan:*)',
      'Bash(gaslens map:*)',
      'Bash(gaslens inspect:*)',
      'Bash(gaslens impact:*)',
      'Bash(gaslens diff:*)',
      'Bash(gaslens check:*)',
      'Bash(gaslens env validate:*)',
      'Bash(gaslens doc lint:*)',
      'Bash(gaslens manifest:*)',
      'Bash(gaslens validate-api:*)',
      'Bash(gaslens workspace overview:*)',
      'Bash(gaslens doctor:*)',
    ];
    for (const entry of expected) expect(allow).toContain(entry);
    expect(allow).toHaveLength(expected.length);
    // L'allowlist exportée et celle écrite doivent coïncider (single source of truth).
    expect([...DEFAULT_GASLENS_ALLOW]).toEqual(expected);
  });

  it('l’allowlist ne contient JAMAIS de commandes mutantes (clasp push / deploy / API Apps Script)', () => {
    const files = buildWorkspaceFiles({ name: 'x' });
    const raw = files.find((f) => f.path === '.claude/settings.json')!.content;
    // Vérif texte brut (insensible à l'imbrication JSON) : aucune mention interdite.
    expect(raw).not.toContain('clasp push');
    expect(raw).not.toContain('clasp deploy');
    expect(raw).not.toContain('--use-apps-script-api');
    // Et au niveau de la liste sémantique :
    const settings = JSON.parse(raw);
    const allow = (settings.permissions?.allow as string[]) ?? [];
    for (const entry of allow) {
      expect(entry).not.toContain('clasp push');
      expect(entry).not.toContain('clasp deploy');
      expect(entry).not.toContain('--use-apps-script-api');
    }
  });

  it('--no-plugin omet .claude/settings.json ; --mcp none omet .mcp.json', () => {
    const files = buildWorkspaceFiles({ name: 'x', withPlugin: false, mcp: 'none' });
    const paths = files.map((f) => f.path);
    expect(paths).not.toContain('.claude/settings.json');
    expect(paths).not.toContain('.mcp.json');
  });

  it('le CLAUDE.md racine référence REGISTRY.md et gaslens.workspace.json comme sources de vérité', () => {
    const files = buildWorkspaceFiles({ name: 'parc' });
    const claude = files.find((f) => f.path === 'CLAUDE.md')!.content;
    expect(claude).toContain('Sources de vérité du parc');
    expect(claude).toContain('gaslens.workspace.json');
    expect(claude).toContain('REGISTRY.md');
    expect(claude).toContain('gaslens workspace overview --format registry --write REGISTRY.md');
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

  it('fusionne `.claude/settings.json` existant en dédupliquant permissions.allow (A2)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gaslens-init-'));
    try {
      await mkdir(join(root, '.claude'), { recursive: true });
      const userSettings = {
        // Clés utilisateur arbitraires à préserver.
        env: { FOO: 'bar' },
        permissions: {
          allow: [
            'Bash(ls:*)',
            // Doublon volontaire avec la liste générée — doit rester unique.
            'Bash(gaslens scan:*)',
          ],
          deny: ['Bash(rm:*)'],
        },
      };
      await writeFile(
        join(root, '.claude/settings.json'),
        JSON.stringify(userSettings, null, 2),
        'utf8',
      );
      const files = buildWorkspaceFiles({ name: 'parc' });
      const res = await writeWorkspace(root, files);
      // settings.json doit avoir été *réécrit* (fusion), pas skippé.
      expect(res.written).toContain('.claude/settings.json');

      const merged = JSON.parse(
        await readFile(join(root, '.claude/settings.json'), 'utf8'),
      );
      // Préservation des clés utilisateur.
      expect(merged.env).toEqual({ FOO: 'bar' });
      expect(merged.permissions.deny).toEqual(['Bash(rm:*)']);
      // Dédup : 'Bash(gaslens scan:*)' une seule fois.
      const occurrences = merged.permissions.allow.filter(
        (e: string) => e === 'Bash(gaslens scan:*)',
      );
      expect(occurrences).toHaveLength(1);
      // L'allowlist gaslens complète est présente.
      for (const entry of DEFAULT_GASLENS_ALLOW) {
        expect(merged.permissions.allow).toContain(entry);
      }
      // L'entrée utilisateur préexistante non-gaslens reste.
      expect(merged.permissions.allow).toContain('Bash(ls:*)');
      // Aucune commande mutante n'est apparue par fusion.
      const raw = await readFile(join(root, '.claude/settings.json'), 'utf8');
      expect(raw).not.toContain('clasp push');
      expect(raw).not.toContain('--use-apps-script-api');
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
