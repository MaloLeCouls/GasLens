import { GAS_API, GAS_API_SERVICE_ROOTS, getMethodArity } from './gas-api.js';
import type { Finding, Verdict } from './findings.js';
import { aggregateVerdict } from './findings.js';
import type { ApiCallChainRecord, ProjectIndex } from './types.js';

export interface ApiValidationEntry {
  kind: 'api.unknown_method' | 'api.wrong_arity';
  severity: 'break';
  /** Type registre où la méthode est introuvable (ex: 'Sheet', 'Range'). */
  on_type: string;
  /** Méthode hallucinée ou mal appelée. */
  method: string;
  /** Préfixe résolu de la chaîne avant l'erreur (texte) — ex: 'SpreadsheetApp.getActive()'. */
  resolved_prefix: string;
  /** Suggestions de noms proches dans le type (uniquement pour unknown_method). */
  suggestions: string[];
  /** Renseigné pour api.wrong_arity uniquement : ce que l'appel a passé vs ce qui est attendu. */
  arity_observed?: number;
  arity_expected?: { min: number; max: number };
  call_site: { file: string; line: number; function: string };
}

export interface ApiValidationReport {
  project: string;
  verdict: Verdict;
  summary: string;
  /** Nombre de chaînes analysées (utile pour la couverture). */
  chains_analyzed: number;
  /** Nombre de chaînes tronquées (préfixe non résoluble : indexation, etc.). */
  chains_truncated: number;
  /** Nombre de chaînes ignorées car la racine n'est pas un service connu. */
  chains_skipped_unknown_root: number;
  /** Nombre de chaînes interrompues honnêtement sur un type `unknown`. */
  chains_stopped_unknown_type: number;
  entries: ApiValidationEntry[];
  findings: Finding[];
}

/**
 * Valide les appels API GAS contre le registre (V3 §21.2).
 * Émet UNIQUEMENT `api.unknown_method` pour cette V1 — arity & deprecated
 * arriveront avec une couche de plus dans le registre.
 */
export function validateApi(index: ProjectIndex): ApiValidationReport {
  const entries: ApiValidationEntry[] = [];
  const findings: Finding[] = [];
  let chains_truncated = 0;
  let chains_skipped_unknown_root = 0;
  let chains_stopped_unknown_type = 0;

  for (const chain of index.api_call_chains) {
    if (chain.truncated_at_root) {
      chains_truncated += 1;
      continue;
    }
    if (!GAS_API_SERVICE_ROOTS.has(chain.root)) {
      chains_skipped_unknown_root += 1;
      continue;
    }
    let currentType: string = chain.root;
    let resolvedPrefix: string = chain.root;
    for (const m of chain.methods) {
      if (currentType === 'unknown' || currentType.endsWith('[]')) {
        chains_stopped_unknown_type += 1;
        break;
      }
      const sigs = GAS_API[currentType];
      if (!sigs) {
        // Le registre ne connaît pas ce type intermédiaire → on stoppe
        // honnêtement (coverage), pas de faux positif.
        chains_stopped_unknown_type += 1;
        break;
      }
      const sig = sigs[m.name];
      if (!sig) {
        const entry: ApiValidationEntry = {
          kind: 'api.unknown_method',
          severity: 'break',
          on_type: currentType,
          method: m.name,
          resolved_prefix: resolvedPrefix,
          suggestions: suggestMethods(currentType, m.name),
          call_site: {
            file: chain.file,
            line: m.line,
            function: chain.function,
          },
        };
        entries.push(entry);
        findings.push(toFinding(entry, index.project));
        break;
      }
      // Arity check (V3 §21.2, phase 2) — uniquement si l'arity est connue
      // ET seulement « trop peu d'args » (forgot arg). On ne flag pas
      // « trop d'args » : JS les ignore en silence, et GAS aussi.
      const expectedArity = getMethodArity(currentType, m.name);
      if (expectedArity !== null && m.arity < expectedArity.min) {
        const entry: ApiValidationEntry = {
          kind: 'api.wrong_arity',
          severity: 'break',
          on_type: currentType,
          method: m.name,
          resolved_prefix: resolvedPrefix,
          suggestions: [],
          arity_observed: m.arity,
          arity_expected: expectedArity,
          call_site: {
            file: chain.file,
            line: m.line,
            function: chain.function,
          },
        };
        entries.push(entry);
        findings.push(toFinding(entry, index.project));
        break;
      }
      resolvedPrefix = `${resolvedPrefix}.${m.name}()`;
      currentType = sig.returns;
    }
  }

  const verdict = aggregateVerdict(
    findings.filter((f) => f.severity === 'break'),
    findings.filter((f) => f.severity === 'warn'),
  );
  return {
    project: index.project,
    verdict,
    summary: buildSummary(entries, index.api_call_chains.length),
    chains_analyzed: index.api_call_chains.length,
    chains_truncated,
    chains_skipped_unknown_root,
    chains_stopped_unknown_type,
    entries,
    findings,
  };
}

function toFinding(entry: ApiValidationEntry, project: string): Finding {
  if (entry.kind === 'api.wrong_arity') {
    const obs = entry.arity_observed ?? 0;
    const exp = entry.arity_expected ?? { min: 0, max: 0 };
    const expectedText =
      exp.min === exp.max ? `${exp.min}` : `${exp.min}-${exp.max}`;
    return {
      severity: 'break',
      symbol: `${project}::api::${entry.on_type}.${entry.method}`,
      consumer: { file: entry.call_site.file, line: entry.call_site.line },
      consumer_kind: 'api.wrong_arity',
      reason:
        `'${entry.on_type}.${entry.method}' appelée avec ${obs} argument${obs > 1 ? 's' : ''}, ` +
        `attendu ${expectedText} (appel '${entry.resolved_prefix}.${entry.method}' depuis '${entry.call_site.function}')`,
      fix_hint:
        `consulter la signature de '${entry.on_type}.${entry.method}' — il manque ` +
        `${exp.min - obs} argument(s)`,
      confidence: 'high',
    };
  }
  const suggestionTail = entry.suggestions.length
    ? ` — proche(s) : ${entry.suggestions.map((s) => `'${s}'`).join(', ')}`
    : '';
  return {
    severity: 'break',
    symbol: `${project}::api::${entry.on_type}.${entry.method}`,
    consumer: { file: entry.call_site.file, line: entry.call_site.line },
    consumer_kind: 'api.unknown_method',
    reason:
      `méthode '${entry.method}' inexistante sur le type '${entry.on_type}' ` +
      `(appel '${entry.resolved_prefix}.${entry.method}' depuis '${entry.call_site.function}')` +
      suggestionTail,
    fix_hint: entry.suggestions.length
      ? `vérifier l'orthographe — méthodes proches : ${entry.suggestions.join(', ')}`
      : `consulter la doc Apps Script pour la surface de '${entry.on_type}'`,
    confidence: 'high',
  };
}

function suggestMethods(type: string, target: string, k: number = 3): string[] {
  const sigs = GAS_API[type];
  if (!sigs) return [];
  const t = target.toLowerCase();
  const distThreshold = Math.max(3, Math.floor(target.length / 2));
  const prefixLen = Math.min(4, Math.floor(target.length / 2));
  const tPrefix = t.slice(0, prefixLen);
  const ranked = Object.keys(sigs)
    .map((name) => ({
      name,
      d: editDistance(t, name.toLowerCase()),
    }))
    .filter(
      (x) =>
        x.d <= distThreshold ||
        x.name.toLowerCase().includes(t) ||
        (prefixLen > 0 && x.name.toLowerCase().startsWith(tPrefix)),
    )
    .sort((a, b) => a.d - b.d)
    .slice(0, k)
    .map((x) => x.name);
  return ranked;
}

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]!;
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + cost);
      prev = tmp;
    }
  }
  return dp[n]!;
}

function buildSummary(entries: ApiValidationEntry[], total: number): string {
  if (entries.length === 0) {
    return `API GAS validée sur ${total} chaîne(s) — aucune méthode hallucinée détectée.`;
  }
  return `${entries.length} méthode(s) API hallucinée(s) détectée(s) sur ${total} chaîne(s) analysée(s).`;
}

export function renderApiValidationText(report: ApiValidationReport): string {
  const lines: string[] = [];
  lines.push(
    `[${report.project}]  ${report.verdict}  ${report.summary} ` +
      `(skipped: ${report.chains_skipped_unknown_root} unknown-root, ` +
      `${report.chains_truncated} truncated, ${report.chains_stopped_unknown_type} stopped-on-unknown-type)`,
  );
  for (const e of report.entries) {
    const sites = `${e.call_site.file}:${e.call_site.line}`;
    if (e.kind === 'api.wrong_arity') {
      const exp = e.arity_expected ?? { min: 0, max: 0 };
      const expectedText = exp.min === exp.max ? `${exp.min}` : `${exp.min}-${exp.max}`;
      lines.push(
        `  BREAK  api.wrong_arity     ${e.on_type}.${e.method}  @ ${sites}  ` +
          `(observed=${e.arity_observed} expected=${expectedText})`,
      );
      lines.push(`        prefix: ${e.resolved_prefix}.${e.method}`);
      continue;
    }
    const suggest = e.suggestions.length ? `  → ${e.suggestions.join(', ')}` : '';
    lines.push(
      `  BREAK  api.unknown_method  ${e.on_type}.${e.method}  @ ${sites}${suggest}`,
    );
    lines.push(`        prefix: ${e.resolved_prefix}.${e.method}`);
  }
  return lines.join('\n');
}
