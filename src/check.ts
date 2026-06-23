import { resolve, join } from 'node:path';
import { scanProject } from './scanner.js';
import { diffIndexes, type DiffOptions } from './diff.js';
import { analyzeManifest } from './manifest-analysis.js';
import { validateApi } from './validate-api.js';
import { lintRuntime } from './lint-runtime.js';
import { lintWebapp } from './lint-webapp.js';
import { runEnvValidate, findWorkspaceRoot } from './env-validate.js';
import { loadWorkspaceManifest, type ProjectRef } from './workspace-manifest.js';
import { lintDoc } from './doc-lint.js';
import {
  aggregateVerdict,
  summarize,
  type DiffReport,
  type Finding,
  type Verdict,
} from './findings.js';
import type { ProjectIndex } from './types.js';

export interface CheckOptions {
  /** Index baseline déjà chargé. */
  baseline: ProjectIndex;
  /** Racine du projet courant à re-scanner. */
  currentRoot: string;
  /** Étiquettes affichées dans le rapport. */
  baselineLabel?: string;
  currentLabel?: string;
  severity_threshold?: 'info' | 'warn' | 'break';
  /** Seuil au-dessus duquel l'exit code passe en BREAK (4 pour WARN, 3 pour BREAK). */
  fail_on?: 'break' | 'warn' | 'never';
}

export interface CheckResult {
  report: DiffReport;
  exit_code: number;
}

/**
 * `gaslens check` (V2 §9.2) : scan le projet courant, compare à `baseline`,
 * renvoie le rapport + un exit code exploitable par un hook.
 *
 *   exit 0 — verdict CLEAN (rien à signaler ; passe fail_on)
 *   exit 3 — verdict BREAK
 *   exit 4 — verdict WARN (uniquement si fail_on=warn)
 *   exit 2 — réservé aux erreurs d'outillage (géré par le CLI)
 */
export async function runCheck(opts: CheckOptions): Promise<CheckResult> {
  const current = await scanProject({ root: opts.currentRoot });
  const diffOpts: DiffOptions = {
    baselineLabel: opts.baselineLabel ?? 'baseline',
    currentLabel: opts.currentLabel ?? 'working-tree',
    severity_threshold: opts.severity_threshold ?? 'warn',
  };
  const report = diffIndexes(opts.baseline, current, diffOpts);
  const threshold = opts.severity_threshold ?? 'warn';
  const enriched = await applyEnrichments(report, current, opts.currentRoot, threshold);
  const fail_on = opts.fail_on ?? 'break';
  const exit_code = exitCodeFor(enriched.verdict, fail_on);
  return { report: enriched, exit_code };
}

/**
 * Cœur partagé d'enrichissement (factorisé — LOT F10). Fusionne une liste de
 * findings candidats dans le rapport : filtre par seuil de sévérité, range
 * chaque finding dans `breaks`/`warns`/`safe`, et recalcule verdict + summary.
 *
 * Les six `enrichWith*Findings` ci-dessous n'en sont plus que de fines façades
 * (source des candidats + nom stable pour les importeurs). No-op rapide quand il
 * n'y a aucun candidat à retenir — préserve l'identité du rapport d'entrée.
 */
function mergeFindings(
  report: DiffReport,
  candidates: Finding[],
  threshold: 'info' | 'warn' | 'break',
): DiffReport {
  if (candidates.length === 0) return report;
  const extra = candidates.filter((f) => keepBySeverity(f, threshold));
  if (extra.length === 0) return report;
  const breaks: Finding[] = [...report.breaks, ...extra.filter((f) => f.severity === 'break')];
  const warns: Finding[] = [...report.warns, ...extra.filter((f) => f.severity === 'warn')];
  const safe: Finding[] = [
    ...report.safe,
    ...extra.filter((f) => f.severity === 'safe' || f.severity === 'info'),
  ];
  const verdict = aggregateVerdict(breaks, warns);
  return {
    ...report,
    breaks,
    warns,
    safe,
    verdict,
    summary: summarize(breaks, warns, report.coverage.resolved_pct),
  };
}

function keepBySeverity(
  f: Finding,
  threshold: 'info' | 'warn' | 'break',
): boolean {
  if (threshold === 'break') return f.severity === 'break';
  if (threshold === 'warn') return f.severity === 'break' || f.severity === 'warn';
  return true;
}

export function enrichWithManifestFindings(
  report: DiffReport,
  current: ProjectIndex,
  threshold: 'info' | 'warn' | 'break',
): DiffReport {
  return mergeFindings(report, analyzeManifest(current).findings, threshold);
}

export function enrichWithApiFindings(
  report: DiffReport,
  current: ProjectIndex,
  threshold: 'info' | 'warn' | 'break',
): DiffReport {
  return mergeFindings(report, validateApi(current).findings, threshold);
}

export function enrichWithLintRuntimeFindings(
  report: DiffReport,
  current: ProjectIndex,
  threshold: 'info' | 'warn' | 'break',
): DiffReport {
  return mergeFindings(report, lintRuntime(current).findings, threshold);
}

export function enrichWithLintWebappFindings(
  report: DiffReport,
  current: ProjectIndex,
  threshold: 'info' | 'warn' | 'break',
  embeddedInSite = false,
): DiffReport {
  return mergeFindings(report, lintWebapp(current, { embeddedInSite }).findings, threshold);
}

/**
 * Le projet enraciné en `root` est-il déclaré **embarqué dans un Google Site**
 * (`site_embeds` non vide pour son app dans le manifeste maître) ? Quand oui, on
 * SAIT que l'absence d'`ALLOWALL` casse l'embed → `webapp.xframe_missing` passe
 * de info à warn (G2 ↔ G4). No-op rapide hors workspace.
 */
export async function resolveEmbeddedInSite(root: string): Promise<boolean> {
  const wsRoot = findWorkspaceRoot(root);
  if (!wsRoot) return false;
  const loaded = await loadWorkspaceManifest(wsRoot);
  if (!loaded.manifest) return false;
  const target = resolve(root);
  for (const app of loaded.manifest.apps) {
    if (!app.site_embeds || app.site_embeds.length === 0) continue;
    for (const ref of Object.values(app.projects)) {
      const p = ref as ProjectRef | undefined;
      if (!p?.clasp_path) continue;
      if (resolve(join(wsRoot, p.clasp_path)) === target) return true;
    }
  }
  return false;
}

/**
 * Enrichit le rapport avec les findings de documentation (V4 §25). Branché en
 * L1 : avec un seuil `warn`, `doc.param_drift`/`doc.return_drift` (dérive de
 * signature/shape) remontent ; `doc.undocumented` (info, le « highlight ») et
 * `doc.stale_ref` (info) restent consultables via `gaslens doc lint` sans
 * bloquer l'édition.
 */
export function enrichWithDocFindings(
  report: DiffReport,
  current: ProjectIndex,
  threshold: 'info' | 'warn' | 'break',
): DiffReport {
  return mergeFindings(report, lintDoc(current).findings, threshold);
}

/**
 * Chaîne complète d'enrichissement (V2 §9.2 + V4 §25/§29) partagée par
 * `runCheck` ET le hook L1 : diff structurel → manifest → API → lint runtime →
 * lint webapp → doc → env. C'est ce qui fait que le hook gate *chaque* édition
 * sur les mêmes findings que `gaslens check`.
 */
export async function applyEnrichments(
  report: DiffReport,
  current: ProjectIndex,
  root: string,
  threshold: 'info' | 'warn' | 'break',
): Promise<DiffReport> {
  let r = enrichWithManifestFindings(report, current, threshold);
  r = enrichWithApiFindings(r, current, threshold);
  r = enrichWithLintRuntimeFindings(r, current, threshold);
  const embeddedInSite = await resolveEmbeddedInSite(root);
  r = enrichWithLintWebappFindings(r, current, threshold, embeddedInSite);
  r = enrichWithDocFindings(r, current, threshold);
  r = await enrichWithEnvFindings(r, root, threshold);
  return r;
}

/**
 * Enrichit le rapport avec les findings d'environnement (V4 §29). No-op rapide
 * si aucun `gaslens.workspace.json` n'est trouvé en remontant depuis `root` —
 * la grande majorité des projets mono-repo restent ainsi non impactés.
 */
export async function enrichWithEnvFindings(
  report: DiffReport,
  root: string,
  threshold: 'info' | 'warn' | 'break',
): Promise<DiffReport> {
  const env = await runEnvValidate({ root });
  return mergeFindings(report, env.findings, threshold);
}

export function exitCodeFor(verdict: Verdict, fail_on: 'break' | 'warn' | 'never'): number {
  if (fail_on === 'never') return 0;
  if (verdict === 'BREAK') return 3;
  if (verdict === 'WARN' && fail_on === 'warn') return 4;
  return 0;
}
