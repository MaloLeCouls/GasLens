import type { Finding, Verdict } from './findings.js';
import { aggregateVerdict } from './findings.js';
import type { ProjectIndex } from './types.js';

export type LintRuleKind =
  | 'quota.value_in_loop'
  | 'urlfetch.in_loop'
  | 'lock.no_finally'
  | 'trigger.orphan';

export interface LintRuntimeEntry {
  kind: LintRuleKind;
  severity: 'warn' | 'info';
  confidence: 'medium' | 'low';
  function: string;
  file: string;
  line: number;
  reason: string;
  fix_hint: string;
}

export interface LintRuntimeReport {
  project: string;
  verdict: Verdict;
  summary: string;
  entries: LintRuntimeEntry[];
  findings: Finding[];
}

/**
 * Lint heuristique (V3 §21.3). Toutes les règles sortent en WARN/INFO,
 * jamais BREAK — `break` reste réservé aux régressions structurelles.
 */
export function lintRuntime(index: ProjectIndex): LintRuntimeReport {
  const entries: LintRuntimeEntry[] = [];

  for (const v of index.runtime_signals.value_calls_in_loops) {
    entries.push({
      kind: 'quota.value_in_loop',
      severity: 'warn',
      confidence: 'medium',
      function: v.function,
      file: v.file,
      line: v.line,
      reason:
        `appel '${v.method}()' dans une boucle ${v.loop_kind} (depuis '${v.function}') ` +
        `— chaque itération coûte un round-trip au service GAS, quota-é par appel`,
      fix_hint: batchHintFor(v.method),
    });
  }

  for (const f of index.runtime_signals.fetches_in_loops) {
    entries.push({
      kind: 'urlfetch.in_loop',
      severity: 'warn',
      confidence: 'medium',
      function: f.function,
      file: f.file,
      line: f.line,
      reason:
        `UrlFetchApp.fetch dans une boucle ${f.loop_kind} (depuis '${f.function}') ` +
        `— appels séquentiels lents et coûteux en quota`,
      fix_hint:
        `préférer UrlFetchApp.fetchAll(requests) qui parallélise les appels et compte ` +
        `comme une seule unité de quota côté Apps Script`,
    });
  }

  for (const lk of index.runtime_signals.lock_acquisitions) {
    if (lk.has_release_in_finally) continue;
    entries.push({
      kind: 'lock.no_finally',
      severity: 'warn',
      confidence: 'medium',
      function: lk.function,
      file: lk.file,
      line: lk.line,
      reason:
        `acquisition de verrou '${lk.method}()' sans releaseLock() dans un bloc finally ` +
        `(scope '${lk.function}') — risque de verrou orphelin sur exception`,
      fix_hint:
        `entourer la section critique par try { ... } finally { lock.releaseLock(); } ` +
        `pour garantir la libération même en cas d'erreur`,
    });
  }

  // trigger.orphan — heuristique niveau projet : si on crée des triggers mais
  // que personne dans le projet n'appelle deleteTrigger, INFO (low confidence).
  const projectHasDelete = index.runtime_signals.has_any_delete_trigger;
  if (!projectHasDelete) {
    for (const t of index.runtime_signals.trigger_creates) {
      entries.push({
        kind: 'trigger.orphan',
        severity: 'info',
        confidence: 'low',
        function: t.function,
        file: t.file,
        line: t.line,
        reason:
          `ScriptApp.newTrigger(${t.handler_name ? `'${t.handler_name}'` : '...'}).create() détecté ` +
          `mais aucun appel à ScriptApp.deleteTrigger n'a été trouvé dans le projet ` +
          `— risque d'accumulation silencieuse de triggers, voire de récursion infinie`,
        fix_hint:
          `prévoir une fonction de nettoyage qui itère ScriptApp.getProjectTriggers() ` +
          `et appelle ScriptApp.deleteTrigger(trigger) — typiquement avant la création d'un nouveau`,
      });
    }
  }

  const findings = entries
    .filter((e) => e.severity !== 'info')
    .map((e) => toFinding(e, index.project));
  const verdict = aggregateVerdict(
    findings.filter((f) => f.severity === 'break'),
    findings.filter((f) => f.severity === 'warn'),
  );

  return {
    project: index.project,
    verdict,
    summary: buildSummary(entries),
    entries,
    findings,
  };
}

function batchHintFor(method: string): string {
  switch (method) {
    case 'getValue':
      return `extraire l'opération hors de la boucle ou utiliser getValues() sur la plage entière, puis itérer le tableau JS local`;
    case 'setValue':
      return `accumuler dans un tableau JS et écrire en bloc avec setValues(matrix)`;
    case 'appendRow':
      return `accumuler les lignes en tableau et écrire avec sheet.getRange(...).setValues(rows)`;
    case 'setFormula':
      return `accumuler et utiliser setFormulas(matrix)`;
    default:
      return `regrouper les appels et utiliser la variante batch équivalente (getValues/setValues/…)`;
  }
}

function toFinding(entry: LintRuntimeEntry, project: string): Finding {
  return {
    severity: entry.severity,
    symbol: `${project}::lint::${entry.kind}::${entry.function}`,
    consumer: { file: entry.file, line: entry.line },
    consumer_kind: consumerKindFor(entry.kind),
    reason: entry.reason,
    fix_hint: entry.fix_hint,
    confidence: entry.confidence,
  };
}

function consumerKindFor(
  kind: LintRuleKind,
):
  | 'lint.quota_in_loop'
  | 'lint.urlfetch_in_loop'
  | 'lint.lock_no_finally'
  | 'lint.trigger_orphan' {
  switch (kind) {
    case 'quota.value_in_loop':
      return 'lint.quota_in_loop';
    case 'urlfetch.in_loop':
      return 'lint.urlfetch_in_loop';
    case 'lock.no_finally':
      return 'lint.lock_no_finally';
    case 'trigger.orphan':
      return 'lint.trigger_orphan';
  }
}

function buildSummary(entries: LintRuntimeEntry[]): string {
  if (entries.length === 0) {
    return 'Aucun pattern runtime/quota suspect détecté.';
  }
  const by_kind = new Map<LintRuleKind, number>();
  for (const e of entries) by_kind.set(e.kind, (by_kind.get(e.kind) ?? 0) + 1);
  const parts = [...by_kind.entries()].map(([k, n]) => `${k}=${n}`);
  return `Lint runtime : ${parts.join(', ')}.`;
}

export function renderLintRuntimeText(report: LintRuntimeReport): string {
  const lines: string[] = [];
  lines.push(`[${report.project}]  ${report.verdict}  ${report.summary}`);
  for (const e of report.entries) {
    const sev = e.severity.toUpperCase();
    lines.push(
      `  ${sev}  ${e.kind}  @ ${e.file}:${e.line}  in ${e.function}  (confidence: ${e.confidence})`,
    );
    lines.push(`        reason: ${e.reason}`);
    lines.push(`        fix:    ${e.fix_hint}`);
  }
  return lines.join('\n');
}

