/**
 * `gaslens doc lint` + `gaslens doc stub` (V4 §25).
 *
 * Principe directeur : **on n'auto-écrit jamais la prose d'intention** (elle est
 * par définition non-dérivable). Ce qui est automatisable, c'est *repérer les
 * manques et la dérive* :
 *
 *   - `doc.undocumented` : fonction sans ligne d'intention (le « highlight ») ;
 *   - `doc.param_drift`  : un tag `@param x` sans paramètre `x` réel
 *                          (renommé/supprimé) — la doc ment sur la signature.
 *
 * `doc stub <fn>` émet un squelette JSDoc (params détectés, intention laissée
 * vide à remplir) — il aide à rédiger sans rédiger à la place de l'agent.
 */

import type { Finding, Verdict } from './findings.js';
import { aggregateVerdict } from './findings.js';
import type { FunctionRecord, ProjectIndex } from './types.js';

export type DocCheck = 'undocumented' | 'drift';

export interface DocLintOptions {
  /** Sous-ensemble de checks à exécuter ; vide/absent = tous. */
  checks?: Set<DocCheck>;
  /** N'examiner que les fonctions publiques (ignore les `_` privées). */
  publicOnly?: boolean;
}

export interface DocLintReport {
  project: string;
  verdict: Verdict;
  summary: string;
  findings: Finding[];
}

export function lintDoc(index: ProjectIndex, opts: DocLintOptions = {}): DocLintReport {
  const run = (c: DocCheck): boolean => !opts.checks || opts.checks.size === 0 || opts.checks.has(c);
  const findings: Finding[] = [];

  for (const fn of index.functions) {
    if (opts.publicOnly && fn.definition.visibility === 'private') continue;
    if (run('undocumented')) {
      const f = checkUndocumented(fn, index.project);
      if (f) findings.push(f);
    }
    if (run('drift')) {
      findings.push(...checkParamDrift(fn, index.project));
    }
  }

  const breaks = findings.filter((f) => f.severity === 'break');
  const warns = findings.filter((f) => f.severity === 'warn');
  const verdict = aggregateVerdict(breaks, warns);
  return {
    project: index.project,
    verdict,
    summary: buildSummary(findings),
    findings,
  };
}

/** `doc.undocumented` — pas de bloc, ou bloc sans texte d'intention. */
function checkUndocumented(fn: FunctionRecord, project: string): Finding | null {
  const summary = fn.definition.doc?.summary ?? null;
  if (summary && summary.length > 0) return null;
  return {
    severity: 'info',
    symbol: `${project}::doc::${fn.name}`,
    consumer: { file: fn.definition.file, line: fn.definition.line },
    consumer_kind: 'doc.undocumented',
    reason:
      `la fonction '${fn.name}' n'a pas de ligne d'intention JSDoc — ` +
      `l'agent ne peut pas connaître le *pourquoi* / le sens métier (seule info non-dérivable)`,
    fix_hint:
      `ajouter une ligne décrivant l'intention (ex: \`gaslens doc stub ${fn.name}\` pour un squelette à compléter)`,
    confidence: 'high',
  };
}

/** `doc.param_drift` — tag `@param x` sans paramètre réel `x`. */
function checkParamDrift(fn: FunctionRecord, project: string): Finding[] {
  const doc = fn.definition.doc;
  if (!doc || doc.param_tags.length === 0) return [];
  const realParams = new Set(
    fn.definition.params.map((p) => p.name.replace(/^\.\.\./, '')),
  );
  const out: Finding[] = [];
  for (const tag of doc.param_tags) {
    if (realParams.has(tag)) continue;
    out.push({
      severity: 'warn',
      symbol: `${project}::doc::${fn.name}`,
      consumer: { file: fn.definition.file, line: fn.definition.line },
      consumer_kind: 'doc.param_drift',
      reason:
        `'${fn.name}' documente '@param ${tag}' mais aucun paramètre '${tag}' n'existe ` +
        `(renommé ou supprimé) — la doc a dérivé de la signature`,
      fix_hint:
        realParams.size > 0
          ? `corriger en '@param ${[...realParams].join('|')}' ou retirer le tag obsolète`
          : `retirer le tag '@param ${tag}' (la fonction ne prend aucun paramètre)`,
      confidence: 'high',
    });
  }
  return out;
}

function buildSummary(findings: Finding[]): string {
  if (findings.length === 0) return 'Documentation cohérente (intention présente, @param alignés).';
  const undoc = findings.filter((f) => f.consumer_kind === 'doc.undocumented').length;
  const drift = findings.filter((f) => f.consumer_kind === 'doc.param_drift').length;
  const parts: string[] = [];
  if (undoc > 0) parts.push(`${undoc} sans intention`);
  if (drift > 0) parts.push(`${drift} @param en dérive`);
  return `Doc : ${parts.join(', ')}.`;
}

export function renderDocLintText(report: DocLintReport): string {
  const lines: string[] = [`[${report.project}]  ${report.verdict}  ${report.summary}`];
  for (const f of report.findings) {
    lines.push(
      `  ${f.severity.toUpperCase()}  ${f.consumer_kind}  ${f.consumer.file}:${f.consumer.line}`,
    );
    lines.push(`        ${f.reason}`);
    if (f.fix_hint) lines.push(`        fix: ${f.fix_hint}`);
  }
  return lines.join('\n');
}

/**
 * Émet un squelette JSDoc pour `fnName` : `@param` détectés (type laissé en
 * placeholder), intention et `@returns` à compléter. Ne remplace jamais une
 * doc existante — c'est une aide à la rédaction.
 */
export function docStub(index: ProjectIndex, fnName: string): string | null {
  const fn = index.functions.find((f) => f.name === fnName);
  if (!fn) return null;
  const lines: string[] = ['/**'];
  lines.push(' * <intention : décris le *pourquoi* / le sens métier — à compléter>');
  for (const p of fn.definition.params) {
    const bare = p.name.replace(/^\.\.\./, '');
    const type = p.jsdoc_type ?? '*';
    lines.push(` * @param {${type}} ${bare}  <sens de l'argument — à compléter>`);
  }
  const returnsSomething =
    fn.return_analysis.serializable !== 'unknown' || fn.return_analysis.nullable;
  if (returnsSomething || fn.definition.returns) {
    lines.push(' * @returns <sens du retour (pas la shape exacte) — à compléter>');
  }
  lines.push(' */');
  return lines.join('\n');
}
