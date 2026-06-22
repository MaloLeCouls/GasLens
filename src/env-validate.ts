/**
 * `gaslens env validate` (V4 §29) — les **deux axes d'environnement**.
 *
 * Croise le manifeste maître `gaslens.workspace.json` (source de vérité) avec
 * la réalité de chaque projet pour attraper le désalignement des deux axes :
 *
 *   - AXE CODE      → `env.library_version_mismatch` : un projet `prod` qui
 *                     consomme la bibliothèque en HEAD/dev (instable) au lieu de
 *                     la version figée, ou inversement un `dev` figé.
 *   - AXE RESSOURCES→ `env.cross_env_leak` (le finding-roi) : un projet d'un env
 *                     embarque en dur l'id d'une ressource appartenant à un AUTRE
 *                     env (prod pointant une Sheet dev, ou pire l'inverse) ;
 *                   → `env.hardcoded_resource` : id de ressource du BON env mais
 *                     codé en dur au lieu de passer par Config/Properties.
 *
 * 100 % statique et local : lit les `appsscript.json` et les sources `.gs`/`.html`
 * du parc. La détection de ressources ne nécessite pas d'extracteur dédié — on
 * cherche les **ids exacts déclarés** dans le manifeste maître par recherche de
 * sous-chaîne (fiable, sans AST).
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { readManifest } from './manifest.js';
import {
  loadWorkspaceManifest,
  resourceOwnerIndex,
  declaredLogicalNames,
  WORKSPACE_MANIFEST_FILENAME,
  type WorkspaceManifest,
  type Library,
  type ProjectRef,
} from './workspace-manifest.js';
import type { ProjectManifest } from './types.js';
import {
  aggregateVerdict,
  type Finding,
  type Verdict,
} from './findings.js';

export interface EnvValidateOptions {
  /** Racine de départ : workspace, ou un sous-projet (on remonte au manifeste). */
  root: string;
  /** Filtre sur un nom d'app. */
  project?: string;
  /** Filtre sur un nom d'environnement (`dev`/`prod`). */
  env?: string;
}

export interface ValidatedTarget {
  app: string;
  env: string;
  dir: string;
}

export interface EnvValidateReport {
  verdict: Verdict;
  summary: string;
  /** Le manifeste maître a-t-il été trouvé ? */
  manifest_present: boolean;
  /** Chemin du manifeste maître (ou tentative). */
  manifest_path: string;
  findings: Finding[];
  coverage: {
    checked: ValidatedTarget[];
    skipped: Array<{ app: string; env: string; reason: string }>;
  };
}

/** Remonte l'arborescence depuis `start` jusqu'à trouver le manifeste maître. */
export function findWorkspaceRoot(start: string): string | null {
  let dir = resolve(start);
  let safety = 0;
  while (safety++ < 100) {
    if (existsSync(join(dir, WORKSPACE_MANIFEST_FILENAME))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export async function runEnvValidate(
  opts: EnvValidateOptions,
): Promise<EnvValidateReport> {
  const wsRoot = findWorkspaceRoot(opts.root);
  if (!wsRoot) {
    return {
      verdict: 'CLEAN',
      summary: `Aucun ${WORKSPACE_MANIFEST_FILENAME} trouvé en remontant depuis ${opts.root} — validation d'environnement ignorée.`,
      manifest_present: false,
      manifest_path: join(opts.root, WORKSPACE_MANIFEST_FILENAME),
      findings: [],
      coverage: { checked: [], skipped: [] },
    };
  }

  const loaded = await loadWorkspaceManifest(wsRoot);
  if (!loaded.manifest) {
    return {
      verdict: 'BREAK',
      summary: `${WORKSPACE_MANIFEST_FILENAME} invalide : ${loaded.errors.join(' ; ')}`,
      manifest_present: true,
      manifest_path: loaded.path,
      findings: [],
      coverage: { checked: [], skipped: [] },
    };
  }
  const master = loaded.manifest;

  const targets = collectTargets(master, wsRoot, opts);
  const findings: Finding[] = [];
  const checked: ValidatedTarget[] = [];
  const skipped: EnvValidateReport['coverage']['skipped'] = [];

  const ownerIndex = resourceOwnerIndex(master);

  for (const t of targets) {
    if (!existsSync(t.dir)) {
      skipped.push({ app: t.app, env: t.env, reason: `dossier projet introuvable (${t.dir})` });
      continue;
    }
    const { manifest } = await readManifest(t.dir);
    findings.push(...checkLibraryVersion(manifest, master.library, t));
    findings.push(...(await checkResourceLeaks(t, ownerIndex)));
    checked.push(t);
  }

  findings.push(...checkUndeclaredResources(master, uniqueEnvs(checked)));

  const breaks = findings.filter((f) => f.severity === 'break');
  const warns = findings.filter((f) => f.severity === 'warn');
  const verdict = aggregateVerdict(breaks, warns);
  return {
    verdict,
    summary: buildSummary(checked, breaks.length, warns.length, skipped.length),
    manifest_present: true,
    manifest_path: loaded.path,
    findings,
    coverage: { checked, skipped },
  };
}

/**
 * Détermine les (app, env, dossier) à valider. Si `root` désigne précisément un
 * dossier de projet déclaré, on ne valide que celui-là (cas du hook) ; sinon on
 * itère tout le parc (filtres `project`/`env` optionnels).
 */
function collectTargets(
  master: WorkspaceManifest,
  wsRoot: string,
  opts: EnvValidateOptions,
): ValidatedTarget[] {
  const all: ValidatedTarget[] = [];
  for (const app of master.apps) {
    if (opts.project && app.name !== opts.project) continue;
    for (const [env, ref] of Object.entries(app.projects)) {
      if (opts.env && env !== opts.env) continue;
      const project = ref as ProjectRef | undefined;
      if (!project?.clasp_path) continue;
      all.push({ app: app.name, env, dir: resolve(join(wsRoot, project.clasp_path)) });
    }
  }
  // Cas hook : `root` est exactement l'un des dossiers projet → cibler lui seul.
  const rootResolved = resolve(opts.root);
  const exact = all.filter((t) => t.dir === rootResolved);
  return exact.length > 0 ? exact : all;
}

function uniqueEnvs(targets: ValidatedTarget[]): string[] {
  return [...new Set(targets.map((t) => t.env))];
}

/**
 * AXE RESSOURCES (cohérence du manifeste) — `env.undeclared_resource`. Une
 * ressource logique déclarée dans certains environnements mais ABSENTE d'un env
 * validé signale un parc sous-provisionné (ex: `mainSheet` ajoutée en dev,
 * oubliée en prod) — la promotion casserait à l'exécution.
 */
export function checkUndeclaredResources(
  master: WorkspaceManifest,
  envs: string[],
): Finding[] {
  const union = declaredLogicalNames(master);
  if (union.size === 0) return [];
  const out: Finding[] = [];
  for (const env of envs) {
    const declared = new Set(Object.keys(master.environments[env]?.resources ?? {}));
    for (const logical of union) {
      if (declared.has(logical)) continue;
      out.push({
        severity: 'warn',
        symbol: `env::${env}`,
        consumer: { file: WORKSPACE_MANIFEST_FILENAME, line: 1 },
        consumer_kind: 'env.undeclared_resource',
        reason:
          `la ressource logique '${logical}' est déclarée dans d'autres environnements ` +
          `mais absente de environments.${env}.resources — l'environnement '${env}' est sous-provisionné`,
        fix_hint: `ajouter '${logical}' à environments.${env}.resources dans ${WORKSPACE_MANIFEST_FILENAME}`,
        confidence: 'high',
      });
    }
  }
  return out;
}

/** AXE CODE — politique de version de la bibliothèque mère. */
export function checkLibraryVersion(
  manifest: ProjectManifest,
  lib: Library | undefined,
  target: ValidatedTarget,
): Finding[] {
  if (!lib) return [];
  const entry = manifest.libraries.find(
    (l) =>
      (lib.user_symbol && l.user_symbol === lib.user_symbol) ||
      (l.library_id !== '' && l.library_id === lib.script_id),
  );
  if (!entry) return []; // ce projet ne consomme pas la bibliothèque mère.

  const symbol = `${target.app}::env::${target.env}`;
  const consumer = { file: 'appsscript.json', line: 1 };
  const isHead =
    entry.development_mode === true ||
    entry.version === '' ||
    entry.version === '0' ||
    entry.version.toUpperCase() === 'HEAD';

  if (target.env === 'prod') {
    const expected = String(lib.prod_version);
    if (isHead) {
      return [
        {
          severity: 'break',
          symbol,
          consumer,
          consumer_kind: 'env.library_version_mismatch',
          reason:
            `le projet PROD '${target.app}' consomme la bibliothèque '${entry.user_symbol}' en mode HEAD/développement ` +
            `(developmentMode) alors que prod exige la version figée ${expected} — la prod tournerait sur du code instable`,
          fix_hint: `dans ${target.dir}/appsscript.json : dependencies.libraries['${entry.user_symbol}'].developmentMode=false et version='${expected}'`,
          confidence: 'high',
        },
      ];
    }
    if (entry.version !== expected) {
      return [
        {
          severity: 'break',
          symbol,
          consumer,
          consumer_kind: 'env.library_version_mismatch',
          reason:
            `le projet PROD '${target.app}' consomme la bibliothèque '${entry.user_symbol}' en version ${entry.version} ` +
            `alors que le manifeste maître fige la prod à la version ${expected}`,
          fix_hint: `aligner version='${expected}' dans ${target.dir}/appsscript.json, ou corriger prod_version dans ${WORKSPACE_MANIFEST_FILENAME}`,
          confidence: 'high',
        },
      ];
    }
    return [];
  }

  if (target.env === 'dev') {
    if (!isHead) {
      return [
        {
          severity: 'warn',
          symbol,
          consumer,
          consumer_kind: 'env.library_version_mismatch',
          reason:
            `le projet DEV '${target.app}' consomme la bibliothèque '${entry.user_symbol}' figée en version ${entry.version} ` +
            `alors que dev devrait suivre la HEAD pour tester le dernier code`,
          fix_hint: `dans ${target.dir}/appsscript.json : dependencies.libraries['${entry.user_symbol}'].developmentMode=true`,
          confidence: 'medium',
        },
      ];
    }
  }
  return [];
}

/** AXE RESSOURCES — ids de ressources en dur (fuite inter-env ou hardcode). */
export async function checkResourceLeaks(
  target: ValidatedTarget,
  ownerIndex: Map<string, Array<{ env: string; logical: string }>>,
): Promise<Finding[]> {
  if (ownerIndex.size === 0) return [];
  const findings: Finding[] = [];
  const sources = await listSourceFiles(target.dir);

  for (const file of sources) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (const [id, owners] of ownerIndex) {
      const envsOwning = new Set(owners.map((o) => o.env));
      const ownedByThisEnv = envsOwning.has(target.env);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (!line.includes(id)) continue;
        const rel = relative(target.dir, file).replace(/\\/g, '/');
        const consumer = { file: rel, line: i + 1 };
        const symbol = `${target.app}::env::${target.env}`;
        if (ownedByThisEnv) {
          findings.push({
            severity: 'warn',
            symbol,
            consumer,
            consumer_kind: 'env.hardcoded_resource',
            reason:
              `id de ressource '${id}' (${describeOwners(owners)}) codé en dur dans le projet '${target.app}' [${target.env}] — ` +
              `même si l'environnement est correct, l'id devrait passer par Config/Script Properties pour rester promouvable`,
            fix_hint: `remplacer le littéral par une lecture de propriété (ex: Config.get('${owners.find((o) => o.env === target.env)?.logical ?? 'maRessource'}'))`,
            confidence: 'medium',
          });
        } else {
          findings.push({
            severity: 'break',
            symbol,
            consumer,
            consumer_kind: 'env.cross_env_leak',
            reason:
              `FUITE INTER-ENV : le projet '${target.app}' [${target.env}] embarque en dur l'id de ressource '${id}' ` +
              `qui appartient à ${describeOwners(owners)} — ce projet lira/écrira les données du MAUVAIS environnement`,
            fix_hint: `retirer l'id en dur et lire la ressource via Config/Script Properties scopées à l'environnement '${target.env}'`,
            confidence: 'high',
          });
        }
      }
    }
  }
  return findings;
}

function describeOwners(owners: Array<{ env: string; logical: string }>): string {
  return owners.map((o) => `${o.env}.${o.logical}`).join(', ');
}

const SOURCE_EXTS = ['.gs', '.html', '.htm', '.js'];
const SKIP_DIRS = new Set(['node_modules', '.git', '.gaslens', 'dist']);

/** Liste récursive (peu profonde) des sources d'un projet. */
async function listSourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string, depth: number): Promise<void> {
    if (depth > 8) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(join(d, e.name), depth + 1);
      } else if (SOURCE_EXTS.some((ext) => e.name.endsWith(ext))) {
        out.push(join(d, e.name));
      }
    }
  }
  await walk(dir, 0);
  return out;
}

function buildSummary(
  checked: ValidatedTarget[],
  breaks: number,
  warns: number,
  skipped: number,
): string {
  if (checked.length === 0) {
    return `Aucun projet validable (clasp_path manquant ?). ${skipped} cible(s) ignorée(s).`;
  }
  if (breaks === 0 && warns === 0) {
    return `Environnements cohérents sur ${checked.length} projet(s) validé(s).`;
  }
  const parts: string[] = [];
  if (breaks > 0) parts.push(`${breaks} fuite(s)/désalignement(s) bloquant(s)`);
  if (warns > 0) parts.push(`${warns} avertissement(s)`);
  return `Validation d'environnement : ${parts.join(', ')} sur ${checked.length} projet(s).`;
}

export function renderEnvValidateText(report: EnvValidateReport): string {
  const lines: string[] = [];
  lines.push(`${report.verdict}  ${report.summary}`);
  for (const f of report.findings) {
    lines.push(
      `  ${f.severity.toUpperCase()}  ${f.consumer_kind}  ${f.consumer.file}:${f.consumer.line}`,
    );
    lines.push(`        ${f.reason}`);
    if (f.fix_hint) lines.push(`        fix: ${f.fix_hint}`);
  }
  for (const s of report.coverage.skipped) {
    lines.push(`  SKIP  ${s.app}[${s.env}] — ${s.reason}`);
  }
  return lines.join('\n');
}
