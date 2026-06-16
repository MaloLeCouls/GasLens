import type { ProjectIndex, WorkspaceIndex } from './types.js';

/**
 * Métriques agrégées d'une fonction GAS, telles que renvoyées par
 * `projects.getMetrics` (Apps Script API). Tous les champs sont nullables :
 * un provider peut connaître les exécutions mais pas le taux d'erreur, etc.
 * V3 §22.2 — strictement consultatif, jamais bloquant.
 */
export interface FunctionMetrics {
  function_name: string;
  /** Exécutions totales sur la fenêtre (`window_days`). */
  executions_count: number | null;
  /** Utilisateurs distincts ayant déclenché la fonction. */
  unique_users: number | null;
  /** Exécutions terminées en erreur sur la fenêtre. */
  error_count: number | null;
  /** Ratio `error_count / executions_count` ∈ [0,1]. */
  error_rate: number | null;
  /** ISO date de la dernière exécution observée. */
  last_execution_at: string | null;
  /** Largeur de la fenêtre d'agrégation. */
  window_days: number | null;
}

/**
 * Pont vers la vérité d'exécution (V3 §22.2). Strictement optionnel, hors
 * hook chaud. Le default `NoopMetricsProvider` renvoie `[]` — toute fonction
 * est alors classée `unknown` (cohérent avec la doctrine d'honnêteté : on
 * n'invente pas de données).
 *
 * La vraie impl Apps Script API (`projects.getMetrics` + `processes.list`)
 * arrivera dans une phase ultérieure, après `resolve-live` phase 2.
 */
export interface MetricsProvider {
  getMetrics(opts: {
    /** scriptId du projet ; null si inconnu de l'index. */
    scriptId: string | null;
    project: string;
    function_names: string[];
    window_days?: number;
  }): Promise<FunctionMetrics[]>;
}

export const NoopMetricsProvider: MetricsProvider = {
  async getMetrics() {
    return [];
  },
};

/**
 * Heat = fréquence d'exécution agrégée, indépendante du statique.
 *  - `hot`  : ≥ 1 exec/jour en moyenne ;
 *  - `warm` : > 0 mais < 1 exec/jour ;
 *  - `cold` : 0 exec sur la fenêtre ;
 *  - `unknown` : pas de données pour cette fonction.
 */
export type HeatLevel = 'hot' | 'warm' | 'cold' | 'unknown';

/**
 * Statut croisé statique × prod. C'est la vraie valeur ajoutée de §22.2 :
 *  - `confirmed_dead` : pas d'expositions statiques + pas d'exécutions →
 *    candidate sûre à la suppression.
 *  - `dispatched_dynamic` : pas d'expositions statiques mais des exécutions →
 *    appelée par un chemin que le statique ne voit pas (trigger UI, lookup
 *    dynamique, callback externe). **Ne PAS supprimer.**
 *  - `live` : expositions + exécutions cohérentes.
 *  - `cold_exposed` : expositions statiques mais 0 exécution → exposé mais
 *    inutilisé, candidat au tri (à valider).
 *  - `errored` : taux d'erreur > seuil (fonction fragile en prod).
 *  - `unknown` : pas de données prod (default provider).
 */
export type CrossStatus =
  | 'confirmed_dead'
  | 'dispatched_dynamic'
  | 'live'
  | 'cold_exposed'
  | 'errored'
  | 'unknown';

export interface ProdTruthEntry {
  project: string;
  function_name: string;
  /** Récap statique léger pour la lecture. */
  static_exposures_count: number;
  static_called_by_count: number;
  metrics: FunctionMetrics | null;
  heat: HeatLevel;
  cross_status: CrossStatus;
  /** Description courte ciblée à l'agent. */
  note: string;
}

export interface ProdTruthReport {
  scanned_at: string;
  scope: 'project' | 'workspace';
  window_days: number;
  summary: {
    total: number;
    confirmed_dead: number;
    dispatched_dynamic: number;
    cold_exposed: number;
    errored: number;
    live: number;
    unknown: number;
  };
  entries: ProdTruthEntry[];
  advice: string[];
}

export interface AnalyzeProdTruthOpts {
  /** Fenêtre d'agrégation demandée au provider (jours). Défaut 30. */
  window_days?: number;
  /** Seuil au-dessus duquel `errored` est levé. Défaut 0.05 (5 %). */
  error_rate_threshold?: number;
}

export async function analyzeProdTruth(
  idx: ProjectIndex | WorkspaceIndex,
  provider: MetricsProvider = NoopMetricsProvider,
  opts: AnalyzeProdTruthOpts = {},
): Promise<ProdTruthReport> {
  const window_days = opts.window_days ?? 30;
  const error_threshold = opts.error_rate_threshold ?? 0.05;
  const projects: ProjectIndex[] =
    idx.kind === 'workspace' ? idx.projects : [idx];

  const entries: ProdTruthEntry[] = [];
  for (const p of projects) {
    const names = p.functions.map((f) => f.name);
    if (names.length === 0) continue;
    const raw = await safeGetMetrics(provider, {
      scriptId: null,
      project: p.project,
      function_names: names,
      window_days,
    });
    const byName = new Map<string, FunctionMetrics>();
    for (const m of raw) byName.set(m.function_name, m);

    for (const fn of p.functions) {
      const m = byName.get(fn.name) ?? null;
      const heat = classifyHeat(m, window_days);
      const cross = classifyCross(
        fn.exposures.length,
        fn.called_by.length,
        m,
        heat,
        error_threshold,
      );
      entries.push({
        project: p.project,
        function_name: fn.name,
        static_exposures_count: fn.exposures.length,
        static_called_by_count: fn.called_by.length,
        metrics: m,
        heat,
        cross_status: cross,
        note: buildNote(cross, heat, m, error_threshold),
      });
    }
  }

  const summary = countByStatus(entries);
  return {
    scanned_at: new Date().toISOString(),
    scope: idx.kind === 'workspace' ? 'workspace' : 'project',
    window_days,
    summary,
    entries,
    advice: buildAdvice(entries, summary),
  };
}

async function safeGetMetrics(
  provider: MetricsProvider,
  opts: Parameters<MetricsProvider['getMetrics']>[0],
): Promise<FunctionMetrics[]> {
  try {
    return await provider.getMetrics(opts);
  } catch {
    // Provider error : on dégrade silencieusement en "unknown" pour tout
    // le projet. La doctrine §22 dit que prod-truth est consultatif, jamais
    // bloquant — une panne du provider ne doit pas inonder l'agent d'erreurs.
    return [];
  }
}

function classifyHeat(
  m: FunctionMetrics | null,
  window_days: number,
): HeatLevel {
  if (!m || m.executions_count === null) return 'unknown';
  if (m.executions_count === 0) return 'cold';
  const window = m.window_days ?? window_days;
  const perDay = m.executions_count / Math.max(1, window);
  if (perDay >= 1) return 'hot';
  return 'warm';
}

function classifyCross(
  exposures: number,
  called_by: number,
  m: FunctionMetrics | null,
  heat: HeatLevel,
  error_threshold: number,
): CrossStatus {
  if (heat === 'unknown') return 'unknown';
  const errored =
    m !== null && m.error_rate !== null && m.error_rate >= error_threshold;
  if (errored) return 'errored';
  const visibleStatically = exposures > 0 || called_by > 0;
  if (!visibleStatically && heat === 'cold') return 'confirmed_dead';
  if (!visibleStatically && heat !== 'cold') return 'dispatched_dynamic';
  if (visibleStatically && heat === 'cold') return 'cold_exposed';
  return 'live';
}

function buildNote(
  cross: CrossStatus,
  heat: HeatLevel,
  m: FunctionMetrics | null,
  error_threshold: number,
): string {
  switch (cross) {
    case 'confirmed_dead':
      return 'aucune exposition statique + 0 exécution observée — candidate à la suppression (vérifier les triggers manuels avant).';
    case 'dispatched_dynamic':
      return 'aucune exposition statique mais exécutions observées — appelée par un chemin invisible au statique (trigger UI, lookup dynamique, callback). NE PAS supprimer.';
    case 'cold_exposed':
      return 'exposée statiquement (exposures > 0) mais aucune exécution observée — candidate au tri (validation manuelle requise).';
    case 'errored': {
      const rate = m?.error_rate;
      const pct = rate !== null && rate !== undefined ? `${(rate * 100).toFixed(1)} %` : '?';
      return `taux d'erreur observé ${pct} ≥ seuil ${(error_threshold * 100).toFixed(0)} % — fonction fragile en prod, redoubler de prudence à l'édition.`;
    }
    case 'live':
      return `exécutions cohérentes avec les expositions statiques (heat=${heat}).`;
    case 'unknown':
      return 'pas de données prod (provider no-op ou fonction non couverte).';
  }
}

function countByStatus(entries: ProdTruthEntry[]): ProdTruthReport['summary'] {
  return {
    total: entries.length,
    confirmed_dead: entries.filter((e) => e.cross_status === 'confirmed_dead').length,
    dispatched_dynamic: entries.filter((e) => e.cross_status === 'dispatched_dynamic').length,
    cold_exposed: entries.filter((e) => e.cross_status === 'cold_exposed').length,
    errored: entries.filter((e) => e.cross_status === 'errored').length,
    live: entries.filter((e) => e.cross_status === 'live').length,
    unknown: entries.filter((e) => e.cross_status === 'unknown').length,
  };
}

function buildAdvice(
  entries: ProdTruthEntry[],
  summary: ProdTruthReport['summary'],
): string[] {
  const out: string[] = [];
  if (summary.unknown === summary.total && summary.total > 0) {
    out.push(
      'aucune métrique remontée — brancher un MetricsProvider (Apps Script API `projects.getMetrics`, V3 §22.2, hors hook chaud) pour activer la vérité terrain.',
    );
    return out;
  }
  if (summary.confirmed_dead > 0) {
    const names = entries
      .filter((e) => e.cross_status === 'confirmed_dead')
      .slice(0, 5)
      .map((e) => e.function_name);
    out.push(
      `${summary.confirmed_dead} fonction(s) candidate(s) à la suppression (confirmed_dead) : ${names.join(', ')}${summary.confirmed_dead > 5 ? '…' : ''}. ` +
        `Vérifier les triggers manuels avant suppression.`,
    );
  }
  if (summary.dispatched_dynamic > 0) {
    const names = entries
      .filter((e) => e.cross_status === 'dispatched_dynamic')
      .slice(0, 5)
      .map((e) => e.function_name);
    out.push(
      `${summary.dispatched_dynamic} fonction(s) appelée(s) par un chemin invisible au statique (dispatched_dynamic) : ${names.join(', ')}${summary.dispatched_dynamic > 5 ? '…' : ''}. ` +
        `NE PAS supprimer ; ajouter ces noms à coverage.unresolved si pertinent.`,
    );
  }
  if (summary.errored > 0) {
    const items = entries
      .filter((e) => e.cross_status === 'errored')
      .slice(0, 5)
      .map((e) => `${e.function_name} (${((e.metrics?.error_rate ?? 0) * 100).toFixed(1)} %)`);
    out.push(
      `${summary.errored} fonction(s) en erreur fréquente : ${items.join(', ')}${summary.errored > 5 ? '…' : ''}. ` +
        `Redoubler de prudence à l'édition — code déjà fragile en production.`,
    );
  }
  if (summary.cold_exposed > 0) {
    out.push(
      `${summary.cold_exposed} fonction(s) exposée(s) mais sans exécutions sur la fenêtre — candidates au tri (validation manuelle).`,
    );
  }
  return out;
}

export function renderProdTruthText(report: ProdTruthReport): string {
  const s = report.summary;
  const lines: string[] = [];
  lines.push(
    `prod-truth  scope=${report.scope}  window=${report.window_days}d  ` +
      `total=${s.total}  live=${s.live}  ` +
      `confirmed_dead=${s.confirmed_dead}  dispatched_dynamic=${s.dispatched_dynamic}  ` +
      `cold_exposed=${s.cold_exposed}  errored=${s.errored}  unknown=${s.unknown}`,
  );
  if (s.total === 0) {
    lines.push('  (aucune fonction indexée)');
    return lines.join('\n');
  }
  const interesting = report.entries.filter(
    (e) => e.cross_status !== 'live' && e.cross_status !== 'unknown',
  );
  if (interesting.length === 0) {
    lines.push('  (rien de saillant — tout est live ou inconnu)');
  }
  for (const e of interesting) {
    const exec = e.metrics?.executions_count ?? '?';
    const errRate =
      e.metrics?.error_rate !== null && e.metrics?.error_rate !== undefined
        ? `${(e.metrics.error_rate * 100).toFixed(1)}%`
        : '?';
    lines.push(
      `  [${e.project}]  ${e.cross_status.padEnd(20)}  ${e.function_name}  ` +
        `(exp=${e.static_exposures_count} called_by=${e.static_called_by_count} ` +
        `exec=${exec} err=${errRate} heat=${e.heat})`,
    );
    lines.push(`        ${e.note}`);
  }
  for (const a of report.advice) {
    lines.push(`  → ${a}`);
  }
  return lines.join('\n');
}
