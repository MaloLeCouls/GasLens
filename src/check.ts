import { scanProject } from './scanner.js';
import { diffIndexes, type DiffOptions } from './diff.js';
import { analyzeManifest } from './manifest-analysis.js';
import { validateApi } from './validate-api.js';
import { lintRuntime } from './lint-runtime.js';
import { lintWebapp } from './lint-webapp.js';
import { runEnvValidate } from './env-validate.js';
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

export function enrichWithManifestFindings(
  report: DiffReport,
  current: ProjectIndex,
  threshold: 'info' | 'warn' | 'break',
): DiffReport {
  const manifest = analyzeManifest(current);
  if (manifest.findings.length === 0) return report;
  const extra = manifest.findings.filter((f) =>
    keepBySeverity(f, threshold),
  );
  if (extra.length === 0) return report;
  const breaks: Finding[] = [...report.breaks, ...extra.filter((f) => f.severity === 'break')];
  const warns: Finding[] = [...report.warns, ...extra.filter((f) => f.severity === 'warn')];
  const safe: Finding[] = [...report.safe, ...extra.filter((f) => f.severity === 'safe' || f.severity === 'info')];
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

export function enrichWithApiFindings(
  report: DiffReport,
  current: ProjectIndex,
  threshold: 'info' | 'warn' | 'break',
): DiffReport {
  const api = validateApi(current);
  if (api.findings.length === 0) return report;
  const extra = api.findings.filter((f) => keepBySeverity(f, threshold));
  if (extra.length === 0) return report;
  const breaks: Finding[] = [...report.breaks, ...extra.filter((f) => f.severity === 'break')];
  const warns: Finding[] = [...report.warns, ...extra.filter((f) => f.severity === 'warn')];
  const safe: Finding[] = [...report.safe, ...extra.filter((f) => f.severity === 'safe' || f.severity === 'info')];
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

export function enrichWithLintRuntimeFindings(
  report: DiffReport,
  current: ProjectIndex,
  threshold: 'info' | 'warn' | 'break',
): DiffReport {
  const lint = lintRuntime(current);
  if (lint.findings.length === 0) return report;
  const extra = lint.findings.filter((f) => keepBySeverity(f, threshold));
  if (extra.length === 0) return report;
  const breaks: Finding[] = [...report.breaks, ...extra.filter((f) => f.severity === 'break')];
  const warns: Finding[] = [...report.warns, ...extra.filter((f) => f.severity === 'warn')];
  const safe: Finding[] = [...report.safe, ...extra.filter((f) => f.severity === 'safe' || f.severity === 'info')];
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

export function enrichWithLintWebappFindings(
  report: DiffReport,
  current: ProjectIndex,
  threshold: 'info' | 'warn' | 'break',
): DiffReport {
  const lint = lintWebapp(current);
  if (lint.findings.length === 0) return report;
  const extra = lint.findings.filter((f) => keepBySeverity(f, threshold));
  if (extra.length === 0) return report;
  const breaks: Finding[] = [...report.breaks, ...extra.filter((f) => f.severity === 'break')];
  const warns: Finding[] = [...report.warns, ...extra.filter((f) => f.severity === 'warn')];
  const safe: Finding[] = [...report.safe, ...extra.filter((f) => f.severity === 'safe' || f.severity === 'info')];
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

/**
 * Enrichit le rapport avec les findings de documentation (V4 §25). Branché en
 * L1 : avec un seuil `warn`, seul `doc.param_drift` (dérive de signature)
 * remonte ; `doc.undocumented` (info, le « highlight ») reste consultable via
 * `gaslens doc lint` sans bloquer l'édition.
 */
export function enrichWithDocFindings(
  report: DiffReport,
  current: ProjectIndex,
  threshold: 'info' | 'warn' | 'break',
): DiffReport {
  const doc = lintDoc(current);
  if (doc.findings.length === 0) return report;
  const extra = doc.findings.filter((f) => keepBySeverity(f, threshold));
  if (extra.length === 0) return report;
  const breaks: Finding[] = [...report.breaks, ...extra.filter((f) => f.severity === 'break')];
  const warns: Finding[] = [...report.warns, ...extra.filter((f) => f.severity === 'warn')];
  const safe: Finding[] = [...report.safe, ...extra.filter((f) => f.severity === 'safe' || f.severity === 'info')];
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
  r = enrichWithLintWebappFindings(r, current, threshold);
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
  if (env.findings.length === 0) return report;
  const extra = env.findings.filter((f) => keepBySeverity(f, threshold));
  if (extra.length === 0) return report;
  const breaks: Finding[] = [...report.breaks, ...extra.filter((f) => f.severity === 'break')];
  const warns: Finding[] = [...report.warns, ...extra.filter((f) => f.severity === 'warn')];
  const safe: Finding[] = [...report.safe, ...extra.filter((f) => f.severity === 'safe' || f.severity === 'info')];
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

export function exitCodeFor(verdict: Verdict, fail_on: 'break' | 'warn' | 'never'): number {
  if (fail_on === 'never') return 0;
  if (verdict === 'BREAK') return 3;
  if (verdict === 'WARN' && fail_on === 'warn') return 4;
  return 0;
}
