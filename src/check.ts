import { scanProject } from './scanner.js';
import { diffIndexes, type DiffOptions } from './diff.js';
import type { DiffReport, Verdict } from './findings.js';
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
  const fail_on = opts.fail_on ?? 'break';
  const exit_code = exitCodeFor(report.verdict, fail_on);
  return { report, exit_code };
}

export function exitCodeFor(verdict: Verdict, fail_on: 'break' | 'warn' | 'never'): number {
  if (fail_on === 'never') return 0;
  if (verdict === 'BREAK') return 3;
  if (verdict === 'WARN' && fail_on === 'warn') return 4;
  return 0;
}
