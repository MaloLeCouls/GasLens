/**
 * `gaslens workspace overview` (LOT F6) — la **vue parc d'un coup**.
 *
 * Un agent qui arrive sur un parc multi-app a besoin de s'orienter en UN appel :
 * quelles apps existent, leurs deux projets dev/prod, la version de la
 * bibliothèque mère que chacun consomme, le verdict `env validate` par app/env,
 * et la couverture de documentation. Cette commande synthétise tout ça à partir
 * du **manifeste maître** + d'un scan de chaque projet.
 *
 * 100 % statique et local (lit le manifeste + les sources). Hors hook chaud :
 * c'est une commande d'orientation, pas de gating. Réutilise `runEnvValidate`
 * (zéro duplication de la logique des deux axes).
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scanProject } from './scanner.js';
import { readManifest } from './manifest.js';
import { runEnvValidate, findWorkspaceRoot } from './env-validate.js';
import {
  loadWorkspaceManifest,
  WORKSPACE_MANIFEST_FILENAME,
  type Library,
} from './workspace-manifest.js';
import { aggregateVerdict, type Finding, type Verdict } from './findings.js';
import type { ProjectManifest } from './types.js';

export interface ParcEnvRow {
  env: string;
  clasp_path: string | null;
  script_id: string | null;
  /** Le dossier projet existe-t-il sur le disque ? */
  present: boolean;
  /** Version de la bibliothèque mère consommée (`HEAD`, un numéro, ou null). */
  lib_version: string | null;
  lib_mode: 'HEAD' | 'pinned' | 'none';
  /** Nombre de fonctions (null si non scanné). */
  functions: number | null;
  /** % de fonctions publiques avec une ligne d'intention (null si aucune publique). */
  doc_coverage_pct: number | null;
  /** Verdict `env validate` restreint à cette app/env. */
  env_verdict: Verdict;
}

export interface ParcAppRow {
  name: string;
  library_prefix: string | null;
  envs: ParcEnvRow[];
}

export interface ParcOverviewReport {
  kind: 'parc_overview';
  workspace_root: string;
  manifest_present: boolean;
  library: { script_id: string; prod_version: number; user_symbol: string | null } | null;
  apps: ParcAppRow[];
  /** Verdict global `env validate` sur tout le parc. */
  env_verdict: Verdict;
  /** Cohérence du manifeste (findings non rattachés à un projet, ex: undeclared_resource). */
  manifest_consistency_verdict: Verdict;
  summary: string;
}

export interface ParcOverviewOptions {
  root: string;
  /** Sauter le scan (couverture doc / compte de fonctions) — sortie plus rapide. */
  noScan?: boolean;
}

export async function buildParcOverview(
  opts: ParcOverviewOptions,
): Promise<ParcOverviewReport> {
  const wsRoot = findWorkspaceRoot(opts.root);
  if (!wsRoot) {
    return emptyReport(opts.root, `Aucun ${WORKSPACE_MANIFEST_FILENAME} trouvé en remontant depuis ${opts.root}.`);
  }
  const loaded = await loadWorkspaceManifest(wsRoot);
  if (!loaded.manifest) {
    return {
      ...emptyReport(wsRoot, `${WORKSPACE_MANIFEST_FILENAME} invalide : ${loaded.errors.join(' ; ')}`),
      manifest_present: true,
    };
  }
  const master = loaded.manifest;

  // Un seul passage `env validate` pour tout le parc → on attribue ensuite les
  // findings par app/env via leur `symbol`.
  const env = await runEnvValidate({ root: wsRoot });
  const findingsByAppEnv = indexFindingsByAppEnv(env.findings);
  const manifestLevelFindings = env.findings.filter((f) => attributionOf(f.symbol) === null);

  const apps: ParcAppRow[] = [];
  for (const app of master.apps) {
    const envs: ParcEnvRow[] = [];
    for (const [envName, ref] of Object.entries(app.projects)) {
      const claspPath = ref?.clasp_path ?? null;
      const dir = claspPath ? resolve(join(wsRoot, claspPath)) : null;
      const present = dir !== null && existsSync(dir);

      let libVersion: string | null = null;
      let libMode: ParcEnvRow['lib_mode'] = 'none';
      let functions: number | null = null;
      let docPct: number | null = null;

      if (present && dir) {
        const { manifest } = await readManifest(dir);
        const lib = libConsumption(manifest, master.library);
        libVersion = lib.version;
        libMode = lib.mode;
        if (!opts.noScan) {
          const idx = await scanProject({ root: dir });
          functions = idx.functions.length;
          docPct = docCoverage(idx.functions);
        }
      }

      const localFindings = findingsByAppEnv.get(`${app.name}::${envName}`) ?? [];
      envs.push({
        env: envName,
        clasp_path: claspPath,
        script_id: ref?.script_id ?? null,
        present,
        lib_version: libVersion,
        lib_mode: libMode,
        functions,
        doc_coverage_pct: docPct,
        env_verdict: verdictOf(localFindings),
      });
    }
    apps.push({ name: app.name, library_prefix: app.library_prefix ?? null, envs });
  }

  const report: ParcOverviewReport = {
    kind: 'parc_overview',
    workspace_root: wsRoot,
    manifest_present: true,
    library: master.library
      ? {
          script_id: master.library.script_id,
          prod_version: master.library.prod_version,
          user_symbol: master.library.user_symbol ?? null,
        }
      : null,
    apps,
    env_verdict: env.verdict,
    manifest_consistency_verdict: verdictOf(manifestLevelFindings),
    summary: '',
  };
  report.summary = buildSummary(report);
  return report;
}

function emptyReport(root: string, summary: string): ParcOverviewReport {
  return {
    kind: 'parc_overview',
    workspace_root: root,
    manifest_present: false,
    library: null,
    apps: [],
    env_verdict: 'CLEAN',
    manifest_consistency_verdict: 'CLEAN',
    summary,
  };
}

/** `${app}::env::${env}` → { app, env } ; sinon null (finding niveau manifeste). */
function attributionOf(symbol: string): { app: string; env: string } | null {
  const parts = symbol.split('::');
  if (parts.length === 3 && parts[1] === 'env' && parts[0] && parts[2]) {
    return { app: parts[0], env: parts[2] };
  }
  return null;
}

function indexFindingsByAppEnv(findings: Finding[]): Map<string, Finding[]> {
  const map = new Map<string, Finding[]>();
  for (const f of findings) {
    const at = attributionOf(f.symbol);
    if (!at) continue;
    const key = `${at.app}::${at.env}`;
    const slot = map.get(key) ?? [];
    slot.push(f);
    map.set(key, slot);
  }
  return map;
}

function verdictOf(findings: Finding[]): Verdict {
  return aggregateVerdict(
    findings.filter((f) => f.severity === 'break'),
    findings.filter((f) => f.severity === 'warn'),
  );
}

function libConsumption(
  manifest: ProjectManifest,
  lib: Library | undefined,
): { version: string | null; mode: ParcEnvRow['lib_mode'] } {
  if (!lib) return { version: null, mode: 'none' };
  const entry = manifest.libraries.find(
    (l) =>
      (lib.user_symbol && l.user_symbol === lib.user_symbol) ||
      (l.library_id !== '' && l.library_id === lib.script_id),
  );
  if (!entry) return { version: null, mode: 'none' };
  const isHead =
    entry.development_mode === true ||
    entry.version === '' ||
    entry.version === '0' ||
    entry.version.toUpperCase() === 'HEAD';
  return { version: isHead ? 'HEAD' : entry.version, mode: isHead ? 'HEAD' : 'pinned' };
}

function docCoverage(functions: ProjectScanFns): number | null {
  const pub = functions.filter((f) => f.definition.visibility === 'public');
  if (pub.length === 0) return null;
  const documented = pub.filter((f) => (f.definition.doc?.summary ?? '').length > 0).length;
  return Math.round((documented / pub.length) * 100);
}

type ProjectScanFns = Awaited<ReturnType<typeof scanProject>>['functions'];

function buildSummary(report: ParcOverviewReport): string {
  const appCount = report.apps.length;
  const envCount = report.apps.reduce((n, a) => n + a.envs.length, 0);
  const presentCount = report.apps.reduce(
    (n, a) => n + a.envs.filter((e) => e.present).length,
    0,
  );
  const head = `${appCount} app(s), ${envCount} projet(s) déclaré(s) (${presentCount} présent(s)).`;
  const verdictPart =
    report.env_verdict === 'CLEAN' && report.manifest_consistency_verdict === 'CLEAN'
      ? 'Environnements cohérents.'
      : `env validate: ${report.env_verdict}` +
        (report.manifest_consistency_verdict !== 'CLEAN'
          ? `, cohérence manifeste: ${report.manifest_consistency_verdict}`
          : '');
  return `${head} ${verdictPart}`;
}

/** Vue texte dense — pensée pour l'amorçage de session d'un agent. */
export function renderParcOverviewText(report: ParcOverviewReport): string {
  const lines: string[] = [];
  if (!report.manifest_present) {
    return `parc: ${report.summary}`;
  }
  lines.push(`parc @ ${report.workspace_root}`);
  lines.push(`  ${report.summary}`);
  if (report.library) {
    lines.push(
      `  lib mère: ${report.library.user_symbol ?? report.library.script_id} (prod figée v${report.library.prod_version})`,
    );
  }
  for (const app of report.apps) {
    lines.push('');
    lines.push(`[${app.name}]${app.library_prefix ? ` (prefix ${app.library_prefix})` : ''}`);
    for (const e of app.envs) {
      if (!e.present) {
        lines.push(`  ${e.env.padEnd(4)} — (non cloné : ${e.clasp_path ?? 'clasp_path manquant'})`);
        continue;
      }
      const lib = e.lib_mode === 'none' ? 'no-lib' : `lib=${e.lib_version}`;
      const doc = e.doc_coverage_pct === null ? 'doc=n/a' : `doc=${e.doc_coverage_pct}%`;
      const fns = e.functions === null ? '' : ` fns=${e.functions}`;
      lines.push(`  ${e.env.padEnd(4)} — ${e.env_verdict.padEnd(5)} ${lib} ${doc}${fns}`);
    }
  }
  return lines.join('\n');
}
