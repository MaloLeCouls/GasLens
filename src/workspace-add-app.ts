/**
 * `gaslens workspace add-app <nom>` (E4) — onboarder une app dans un workspace
 * existant sans tout faire à la main.
 *
 * Écrit l'entrée `apps[]` dans le manifeste maître (deux projets `dev`/`prod`),
 * crée l'arborescence `apps/<nom>/{dev,prod}` + un `CLAUDE.md` d'app, et renvoie
 * les prochaines étapes (clasp clone/create pour renseigner les scriptId). Le
 * scriptId est volontairement omis : il est connu après le clone.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  loadWorkspaceManifest,
  WORKSPACE_MANIFEST_FILENAME,
  type WorkspaceManifest,
  type App,
} from './workspace-manifest.js';
import { writeWorkspace, type ScaffoldFile, type WriteWorkspaceResult } from './workspace-init.js';

export interface AddAppOptions {
  name: string;
  /** Préfixe d'exposition si l'app est consommée comme librairie. */
  libraryPrefix?: string;
  force?: boolean;
}

export interface AddAppPlan {
  manifest: WorkspaceManifest;
  files: ScaffoldFile[];
}

/** Calcule (sans I/O) le manifeste mis à jour + les fichiers à créer. */
export function planAddApp(
  current: WorkspaceManifest,
  opts: AddAppOptions,
): AddAppPlan | { error: string } {
  if (current.apps.some((a) => a.name === opts.name)) {
    return { error: `l'app '${opts.name}' existe déjà dans le manifeste` };
  }
  const base = `apps/${opts.name}`;
  const app: App = {
    name: opts.name,
    ...(opts.libraryPrefix ? { library_prefix: opts.libraryPrefix } : {}),
    projects: {
      dev: { clasp_path: `${base}/dev` },
      prod: { clasp_path: `${base}/prod` },
    },
  };
  const manifest: WorkspaceManifest = { ...current, apps: [...current.apps, app] };
  const files: ScaffoldFile[] = [
    { path: `${base}/dev/.gitkeep`, content: '' },
    { path: `${base}/prod/.gitkeep`, content: '' },
    // .claspignore par projet (G6) : ne pousser QUE le code GAS au push clasp.
    { path: `${base}/dev/.claspignore`, content: claspignore() },
    { path: `${base}/prod/.claspignore`, content: claspignore() },
    { path: `${base}/CLAUDE.md`, content: appClaudeMd(opts.name, opts.libraryPrefix) },
  ];
  return { manifest, files };
}

export interface AddAppRunResult {
  ok: boolean;
  message: string;
  written?: string[];
  skipped?: WriteWorkspaceResult['skipped'];
  nextSteps?: string[];
}

export async function runAddApp(root: string, opts: AddAppOptions): Promise<AddAppRunResult> {
  const loaded = await loadWorkspaceManifest(root);
  if (!loaded.found) {
    return {
      ok: false,
      message: `pas de ${WORKSPACE_MANIFEST_FILENAME} ici — lance d'abord 'gaslens workspace init <nom>'`,
    };
  }
  if (!loaded.manifest) {
    return { ok: false, message: `manifeste invalide : ${loaded.errors.join(' ; ')}` };
  }
  const plan = planAddApp(loaded.manifest, opts);
  if ('error' in plan) {
    return { ok: false, message: plan.error };
  }
  // Le manifeste est réécrit intentionnellement (mise à jour), pas via le skip.
  await writeFile(
    join(root, WORKSPACE_MANIFEST_FILENAME),
    JSON.stringify(plan.manifest, null, 2) + '\n',
    'utf8',
  );
  const { written, skipped } = await writeWorkspace(root, plan.files, { force: opts.force });
  return {
    ok: true,
    message: `app '${opts.name}' ajoutée au manifeste (${written.length} fichier(s) créé(s)).`,
    written,
    skipped,
    nextSteps: [
      `clasp clone <scriptId-dev>  dans apps/${opts.name}/dev   (ou clasp create)`,
      `clasp clone <scriptId-prod> dans apps/${opts.name}/prod`,
      `renseigner les script_id dans ${WORKSPACE_MANIFEST_FILENAME}`,
      `gaslens scan apps/${opts.name}/dev -o apps/${opts.name}/dev/.gaslens/baseline.json`,
      `gaslens env validate apps/${opts.name}/prod   (doit être CLEAN)`,
    ],
  };
}

/** `.claspignore` (G6) : clasp ne pousse que le code GAS du projet. */
function claspignore(): string {
  return `# Ne pousser que le code GAS (appsscript.json + .gs/.html).
**/**
!appsscript.json
!*.gs
!*.html
!*.js
# Outillage local jamais poussé au projet GAS :
.gaslens/**
.clasp.json
.claspignore
node_modules/**
`;
}

function appClaudeMd(name: string, libraryPrefix?: string): string {
  const lib = libraryPrefix
    ? `\nPréfixe de librairie exposé : \`${libraryPrefix}\` — les appels \`${libraryPrefix}.fn()\`\ndepuis les autres projets sont résolus par gaslens (cross_project_edges).\n`
    : '';
  return `## App ${name} (GAS)
${lib}
Entry points web : \`doGet\` / \`doPost\` (cf. \`gaslens inspect doGet\`).
Fonctions privées : suffixe \`_\` (non appelables par \`google.script.run\`).

### Environnements (2 projets par webapp, isolation « hard »)

- \`dev\`  → \`apps/${name}/dev\`  : bibliothèque en HEAD, ressources de dev.
- \`prod\` → \`apps/${name}/prod\` : bibliothèque figée, ressources de prod, deployment ID stable.

Ressources (Sheets/Forms/dossiers) : **jamais en dur** dans le code — passer par
Config/Script Properties scopées à l'environnement. \`gaslens env validate\`
attrape \`env.cross_env_leak\` et \`env.hardcoded_resource\`.

### Façade

Le Google Site embarque le \`/exec\` PROD ; promouvoir = republier sur le même
deployment ID (le Site ne change pas).
`;
}
