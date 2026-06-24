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

import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

/**
 * Allowlist par défaut des commandes gaslens **read-only** (V5 §33 — A2).
 *
 * Auto-approuve dans Claude Code les sous-commandes qui n'ont aucun effet de
 * bord distant : pas de push/deploy, jamais l'API Apps Script. Le casting reste
 * intact (gaslens = cerveau / clasp = mains) : tout ce qui mute Google reste
 * sous gate humain via `clasp push`/`clasp deploy`, **volontairement absents**
 * de cette liste.
 */
export const DEFAULT_GASLENS_ALLOW: readonly string[] = [
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
  for (const dir of ['apps', 'backlog/inbox', 'backlog/triaged', 'backlog/archive']) {
    files.push({ path: `${dir}/.gitkeep`, content: '' });
  }

  // Setup complet (G6) : wrappers, CI template, docs chargées à la demande.
  files.push({ path: 'scripts/push-dev.sh', content: pushDevScript() });
  files.push({ path: 'scripts/deploy-prod.sh', content: deployProdScript() });
  files.push({ path: 'scripts/run-tests.sh', content: runTestsScript() });
  files.push({ path: '.github/workflows/gas-ci.yml', content: gasCiTemplate() });
  files.push({ path: 'docs/deploy.md', content: deployDoc() });
  files.push({ path: 'docs/scopes.md', content: scopesDoc() });

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
    // `.claude/settings.json` est un cas particulier (A2) : si un settings
    // existe déjà, on fusionne **en dédupliquant** la liste `permissions.allow`
    // au lieu d'écraser (préserve les réglages utilisateur) ou de simplement
    // skip (sinon l'allowlist gaslens ne s'applique jamais sur les workspaces
    // déjà initialisés).
    if (f.path === '.claude/settings.json' && existsSync(full)) {
      const merged = await mergeClaudeSettings(full, f.content);
      if (merged.changed) {
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, merged.content, 'utf8');
        written.push(f.path);
      } else {
        skipped.push({ path: f.path, reason: 'déjà à jour (fusion sans changement)' });
      }
      continue;
    }
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
 * Fusionne un `.claude/settings.json` existant avec celui qu'on s'apprête à
 * écrire (A2). Préserve toutes les clés utilisateur, complète
 * `permissions.allow` en dédupliquant, et n'écrase une valeur scalaire que si
 * elle est absente côté existant. Renvoie `changed: false` quand la fusion ne
 * produit aucune modification (évite un write inutile + un faux « written »).
 */
async function mergeClaudeSettings(
  fullPath: string,
  generatedContent: string,
): Promise<{ content: string; changed: boolean }> {
  const generated = JSON.parse(generatedContent) as Record<string, unknown>;
  let existingRaw: string;
  try {
    existingRaw = await readFile(fullPath, 'utf8');
  } catch {
    return { content: generatedContent, changed: true };
  }
  let existing: Record<string, unknown>;
  try {
    existing = JSON.parse(existingRaw) as Record<string, unknown>;
  } catch {
    // JSON invalide existant : on n'écrase pas silencieusement.
    return { content: existingRaw, changed: false };
  }

  const merged: Record<string, unknown> = { ...existing };

  // Compléter les clés top-level absentes (extraKnownMarketplaces,
  // enabledPlugins) sans toucher à ce que l'utilisateur a déjà mis.
  for (const [k, v] of Object.entries(generated)) {
    if (k === 'permissions') continue;
    if (!(k in merged)) merged[k] = v;
  }

  // Fusion permissions.allow avec dédup (préserve l'ordre : existant d'abord,
  // puis nouvelles entrées générées).
  const genPerms = (generated.permissions ?? {}) as { allow?: unknown };
  const existingPerms = (existing.permissions ?? {}) as Record<string, unknown> & {
    allow?: unknown;
  };
  const genAllow = Array.isArray(genPerms.allow) ? (genPerms.allow as unknown[]) : [];
  const existingAllow = Array.isArray(existingPerms.allow)
    ? (existingPerms.allow as unknown[])
    : [];
  const dedup: unknown[] = [...existingAllow];
  for (const entry of genAllow) {
    if (!dedup.includes(entry)) dedup.push(entry);
  }
  merged.permissions = { ...existingPerms, allow: dedup };

  const out = JSON.stringify(merged, null, 2) + '\n';
  return { content: out, changed: out !== existingRaw };
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

## Sources de vérité du parc

Deux fichiers font foi avant toute action :

- \`gaslens.workspace.json\` à la racine du workspace — le manifeste maître
  (topologie multi-app dev/prod, bibliothèque, environnements, ressources).
- \`REGISTRY.md\` à la racine du workspace — la cartographie scriptId / URLs
  \`/dev\` et \`/exec\` / embeds Sites par app et par environnement, générée par
  \`gaslens workspace overview --format registry --write REGISTRY.md\`. À
  régénérer après chaque changement de déploiement ou d'embed.

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
        permissions: { allow: [...DEFAULT_GASLENS_ALLOW] },
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

// ── Setup complet (G6) — wrappers d'API claire (fonctions de forçage §7.1) ──

function pushDevScript(): string {
  return `#!/usr/bin/env bash
# push vers le projet DEV d'une app (jamais prod). Source de vérité = ce repo.
# Usage : scripts/push-dev.sh <app>
set -euo pipefail
app="\${1:?usage: push-dev.sh <app>}"
dir="apps/\${app}/dev"
[ -f "\${dir}/.clasp.json" ] || { echo "pas de \${dir}/.clasp.json — 'clasp clone' d'abord"; exit 1; }
( cd "\${dir}" && clasp status && clasp push )
`;
}

function deployProdScript(): string {
  return `#!/usr/bin/env bash
# Promotion PROD (sous gate humain) : valide → push → version → redeploy SUR LE
# MÊME deploymentId (URL /exec inchangée → le Google Site reste intact, cf.
# docs/deploy.md). NE crée JAMAIS un "New deployment".
# Usage : scripts/deploy-prod.sh <app> <deploymentId> [note]
set -euo pipefail
app="\${1:?usage: deploy-prod.sh <app> <deploymentId> [note]}"
deploymentId="\${2:?deploymentId stable requis (Manage deployments)}"
note="\${3:-promotion}"
dir="apps/\${app}/prod"
gaslens env validate "\${dir}" --format text || { echo "env validate non CLEAN — corrige avant prod"; exit 1; }
( cd "\${dir}" && clasp push )
ver="$( cd "\${dir}" && clasp version "\${note}" | grep -oE '[0-9]+' | tail -1 )"
( cd "\${dir}" && clasp deploy --deploymentId "\${deploymentId}" --versionNumber "\${ver}" )
echo "→ déployé version \${ver} sur \${deploymentId} (URL /exec inchangée)."
echo "→ pense à bumper library.prod_version si c'est la lib mère."
`;
}

function runTestsScript(): string {
  return `#!/usr/bin/env bash
# Lance les tests de contrat de l'API publique de la lib (le filet n°1, §6.2).
# Émets le harnais avec : gaslens emit-contract-tests --runner gas-fakes
# (exécutable LOCALEMENT, sans déploiement). Puis pointe ce script dessus.
set -euo pipefail
echo "adapter : node <harnais gas-fakes émis par gaslens emit-contract-tests>"
`;
}

function gasCiTemplate(): string {
  return `# CI du parc GAS (gabarit G6 — à compléter avec tes secrets clasp).
# Bloque le merge si les tests de contrat distants échouent (état de l'art §6.3).
# Secrets requis : CLASPRC_JSON (~/.clasprc.json), CLASP_JSON_DEV (.clasp.json dev).
name: gas-ci

on:
  pull_request:
  workflow_dispatch:

jobs:
  contract-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npm i -g @malolecouls/gaslens @google/clasp
      # Analyse statique anti-régression (rapide, sans réseau).
      - run: gaslens scan . && gaslens env validate --format text
      # --- À DÉCOMMENTER une fois les secrets configurés ---
      # - run: echo "\${{ secrets.CLASPRC_JSON }}" > ~/.clasprc.json
      # - run: echo "\${{ secrets.CLASP_JSON_DEV }}" > apps/<app>/dev/.clasp.json
      # - run: ( cd apps/<app>/dev && clasp push --force )
      # - run: node scripts/remote-run-tests.mjs   # scripts.run → exit ≠ 0 si échec
`;
}

function deployDoc(): string {
  return `# Déploiement & stabilité d'URL (chargé à la demande)

> Pointeur depuis le CLAUDE.md — pas d'@-import (coûte des tokens à chaque run).

## Version ≠ Déploiement (à ne jamais confondre)

- **Version** = snapshot immuable du code (point de sauvegarde). Une fois créée,
  ne change plus.
- **Déploiement** = une release qui rend une version servie, avec son URL/ID.
- **Éditer/\`clasp push\` ne change RIEN pour les utilisateurs du \`/exec\`** : il faut
  créer une nouvelle version ET re-pointer le déploiement existant dessus.

## \`/dev\` vs \`/exec\`

- \`/dev\` = toujours le dernier code sauvegardé (HEAD), éditeurs seulement → test.
- \`/exec\` = la version DÉPLOYÉE → ce que le Google Site embarque, ce que voient les
  visiteurs.
- ⚠️ Remplacer \`/dev\` par \`/exec\` à la main dans une URL **ne marche pas** (ids
  différents) — source classique d'iframe cassée.

## Préserver l'URL (sinon le Site casse)

« New deployment » crée un NOUVEL id/URL. Pour garder l'URL :
**Manage deployments → éditer le déploiement existant → pointer la nouvelle
version** (CLI : \`clasp deploy --deploymentId <id existant>\`). C'est ce que fait
\`scripts/deploy-prod.sh\`. Casser l'URL = casser toutes les pages qui l'embarquent.
`;
}

function scopesDoc(): string {
  return `# Scopes OAuth & propagation par la bibliothèque (chargé à la demande)

## Auto-détection vs oauthScopes explicite

- Par défaut, Apps Script **détecte automatiquement** les scopes en scannant le
  code — y compris ceux requis par la **bibliothèque** consommée.
- Dès qu'une webapp déclare un \`oauthScopes\` **explicite** dans son manifeste,
  l'auto-détection est **désactivée**. Si un scope utilisé par la lib manque,
  **la lib casse chez ce consommateur**.
- Retirer \`oauthScopes\` rétablit l'auto-détection.

## Implication cross-projet (l'angle mort)

Toute modif de l'API de la lib qui introduit un **nouveau service Google** (ex: la
lib se met à appeler Gmail) peut exiger d'ajouter le scope correspondant dans
**chaque** webapp à \`oauthScopes\` explicite. Invisible à la lecture d'un seul
projet → **\`gaslens env validate\` le détecte** (\`env.library_scope_missing\`).
`;
}
