/**
 * `gaslens workspace init <nom>` (V5 §33) — le scaffolder unique de setup.
 *
 * Génère le **workspace** (pas le plugin : lui s'installe à part, une fois).
 * Émet le manifeste maître squelette, le `.claude/settings.json` qui *déclare*
 * la marketplace + le plugin (→ install auto-proposée à l'ouverture), le
 * `.mcp.json` Chrome, l'arborescence `apps/ backlog/ docs/`, et un `README.md`
 * qui double `gaslens doctor` en clair.
 *
 * La génération est **pure** (`buildWorkspaceFiles`) ; l'écriture
 * (`writeWorkspace`) ne touche jamais un fichier existant sans `force`.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { emptyWorkspaceManifest } from './workspace-manifest.js';

const pexec = promisify(execFile);

export interface WorkspaceInitOptions {
  name: string;
  /** Écrire `.claude/settings.json` déclarant la marketplace + le plugin. */
  withPlugin?: boolean;
  /** `chrome` → `.mcp.json` chrome-devtools ; `none` → pas de MCP local. */
  mcp?: 'chrome' | 'none';
}

export interface ScaffoldFile {
  /** Chemin relatif à la racine du workspace. */
  path: string;
  content: string;
}

const MARKETPLACE_SOURCE = 'MaloLeCouls/GasLens';

export function buildWorkspaceFiles(opts: WorkspaceInitOptions): ScaffoldFile[] {
  const { name } = opts;
  const withPlugin = opts.withPlugin ?? true;
  const mcp = opts.mcp ?? 'chrome';
  const files: ScaffoldFile[] = [];

  files.push({ path: 'CLAUDE.md', content: rootClaudeMd(name) });
  files.push({ path: 'README.md', content: readme(name) });
  files.push({
    path: 'gaslens.workspace.json',
    content: JSON.stringify(emptyWorkspaceManifest(name), null, 2) + '\n',
  });
  files.push({ path: '.gitignore', content: gitignore() });

  if (withPlugin) {
    files.push({ path: '.claude/settings.json', content: claudeSettings() });
  }
  if (mcp === 'chrome') {
    files.push({ path: '.mcp.json', content: mcpJson() });
  }

  // Arborescence (placeholders : git ne suit pas les dossiers vides).
  for (const dir of ['apps', 'backlog/inbox', 'backlog/triaged', 'backlog/archive', 'docs']) {
    files.push({ path: `${dir}/.gitkeep`, content: '' });
  }

  return files;
}

export interface WriteWorkspaceResult {
  written: string[];
  skipped: Array<{ path: string; reason: string }>;
}

export async function writeWorkspace(
  root: string,
  files: ScaffoldFile[],
  opts: { force?: boolean } = {},
): Promise<WriteWorkspaceResult> {
  const written: string[] = [];
  const skipped: WriteWorkspaceResult['skipped'] = [];
  for (const f of files) {
    const full = join(root, f.path);
    if (existsSync(full) && !opts.force) {
      skipped.push({ path: f.path, reason: 'existe déjà (utiliser --force pour écraser)' });
      continue;
    }
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, f.content, 'utf8');
    written.push(f.path);
  }
  return { written, skipped };
}

/**
 * `git init` + premier commit (la baseline du 1er check, V5 §33). Best-effort :
 * renvoie un message exploitable sans jamais jeter (git absent = on continue).
 */
export async function gitInitAndCommit(root: string): Promise<{ ok: boolean; message: string }> {
  if (existsSync(join(root, '.git'))) {
    return { ok: false, message: 'dépôt git déjà présent — init ignoré' };
  }
  try {
    await pexec('git', ['init'], { cwd: root });
    await pexec('git', ['add', '-A'], { cwd: root });
    await pexec(
      'git',
      ['commit', '-m', 'chore: scaffold gaslens workspace', '--no-gpg-sign'],
      { cwd: root },
    );
    return { ok: true, message: 'git init + premier commit (baseline)' };
  } catch (err) {
    return { ok: false, message: `git indisponible ou échec : ${(err as Error).message}` };
  }
}

function rootClaudeMd(name: string): string {
  return `# Workspace ${name} (Google Apps Script, piloté par agent)

Ce workspace est analysé par **gaslens** (le *cerveau* : vérité statique, zéro
effet de bord). Le casting (V4 §26) : gaslens = cerveau, clasp = mains
(push/deploy), Chrome DevTools MCP = yeux (exécution réelle). La source de
vérité du parc est \`gaslens.workspace.json\` (apps, bibliothèque, environnements,
ressources) — *lue* par gaslens, *écrite* par les skills d'onboarding.

## Contrat de confiance (ce sur quoi tu peux t'appuyer)

À chaque édition de \`.gs\`/\`.html\`, le hook PostToolUse lance le pipeline
\`gaslens check\` complet (diff structurel + manifest + API + lint + **doc** +
**env**). Si une modif casse un consommateur — ou fait fuiter une ressource d'un
environnement vers l'autre (\`env.cross_env_leak\`) — le verdict BREAK est
ré-injecté dans ta boucle. Tu n'as pas à re-vérifier ces points à la main.

Deux environnements : \`dev\` (bibliothèque en HEAD, ressources de dev) et
\`prod\` (bibliothèque figée, ressources de prod). \`gaslens env validate\` garantit
leur alignement.

## Démarrer

1. \`gaslens doctor\` — règle les prérequis listés (clasp, Node, Chrome).
2. \`/gaslens-onboard-app\` — interview + scaffolding de la 1re app.
3. Code : inner loop gratuite (hook), outer loop par feature (clasp + MCP).

## Mémoire vivante

<!-- Notes durables sur ce parc : décisions, pièges, conventions locales. -->
`;
}

function readme(name: string): string {
  return `# ${name}

Workspace Google Apps Script généré par \`gaslens workspace init\`.

## Prérequis (vérifiés par \`gaslens doctor\`)

Au lancement de Claude Code, le hook SessionStart lance \`gaslens doctor\` et te
liste ce qui manque. À régler une fois pour toutes :

- [ ] **Node ≥ 22** (requis par chrome-devtools-mcp) — \`nvm install 22\`
- [ ] **gaslens** sur le PATH — \`npm i -g @malolecouls/gaslens\`
- [ ] **clasp** installé + connecté — \`npm i -g @google/clasp && clasp login\`
- [ ] **API Apps Script** activée — https://script.google.com/home/usersettings
- [ ] **Chrome** lançable en remote-debugging (si MCP \`--autoConnect\`) —
      \`--remote-debugging-port=9222\`
- [ ] **plugin gaslens** activé — proposé à l'ouverture via \`.claude/settings.json\`

## Flux jour-1

\`\`\`
1. npm i -g @malolecouls/gaslens          # le moteur
2. gaslens workspace init ${name}         # (déjà fait : ce dossier)
3. cd ${name} && claude                   # ouvre Claude Code ici
4. [dialogue de confiance] → installer la marketplace + le plugin gaslens
5. [SessionStart] gaslens doctor          # règle les 2-3 prérequis listés
6. /gaslens-onboard-app                   # 1re app + clasp clone
\`\`\`

## Structure

- \`gaslens.workspace.json\` — manifeste maître (apps, lib, environnements, ressources).
- \`apps/\` — une app par sous-dossier (\`dev\`/\`prod\` par webapp).
- \`backlog/{inbox,triaged,archive}/\` — intake des demandes.
- \`docs/\` — documentation du parc.
`;
}

function gitignore(): string {
  return `.gaslens/
.clasprc.json
node_modules/
*.log
.DS_Store
backlog/inbox/
backlog/archive/
`;
}

function claudeSettings(): string {
  return (
    JSON.stringify(
      {
        extraKnownMarketplaces: { gaslens: { source: MARKETPLACE_SOURCE } },
        enabledPlugins: ['gaslens@gaslens'],
      },
      null,
      2,
    ) + '\n'
  );
}

function mcpJson(): string {
  return (
    JSON.stringify(
      {
        mcpServers: {
          'chrome-devtools': {
            command: 'npx',
            // Version épinglée (V5 §37.8) : stabilise l'installation dans le temps.
            args: ['-y', 'chrome-devtools-mcp@1.3.0', '--autoConnect'],
          },
        },
      },
      null,
      2,
    ) + '\n'
  );
}
