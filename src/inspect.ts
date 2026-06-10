import type {
  CallerInfo,
  Coverage,
  Exposure,
  FunctionPatterns,
  FunctionRecord,
  InferredContract,
  ProjectIndex,
} from './types.js';

export type DetailLevel = 'summary' | 'standard' | 'full' | 'graph';

export type IncludeField =
  | 'callers'
  | 'callees'
  | 'contract'
  | 'exposures'
  | 'coverage'
  | 'definition'
  | 'patterns'
  | 'all';

export type CoverageDetail = 'none' | 'summary' | 'full';

export interface InspectOptions {
  /** Niveau de détail (V1 §4.3). */
  detailLevel: DetailLevel;
  /** Sélection de champs façon GraphQL ; vide = laissé au detail_level. */
  include: IncludeField[];
  /** Plafonne le nombre de callers émis ; null = pas de limite. */
  maxCallers: number | null;
  /** Détail de la coverage : `none` la supprime, `summary` la résume. */
  coverageDetail: CoverageDetail;
  /** Si vrai et la fonction n'est pas trouvée, propose les noms proches. */
  fuzzy: boolean;
}

export interface InspectFound {
  kind: 'found';
  payload: InspectPayload;
}

export interface InspectNotFound {
  kind: 'not_found';
  name: string;
  /** Suggestions de noms proches (vide si --fuzzy=false). */
  suggestions: string[];
  message: string;
}

export type InspectResult = InspectFound | InspectNotFound;

export interface InspectPayload {
  id: string;
  name: string;
  project: string;
  signature: string;
  detail_level: DetailLevel;
  definition?: FunctionRecord['definition'];
  exposures?: Exposure[];
  callers?: CallersPayload;
  callees?: string[];
  contract?: ContractPayload;
  patterns?: FunctionPatterns;
  coverage?: CoveragePayload;
  truncated?: TruncationInfo;
}

export interface CallersPayload {
  total: number;
  shown: number;
  items: CallerInfo[];
}

export interface ContractPayload {
  params: FunctionRecord['definition']['params'];
  returns: FunctionRecord['definition']['returns'];
  serializable_return: boolean | null;
  source: 'from_jsdoc' | 'inferred_from_usage' | 'mixed' | 'unknown';
  /** Contrat inféré depuis la consommation des handlers côté client. */
  inferred: InferredContract | null;
}

export type CoveragePayload =
  | { resolved_pct: number; confidence: Coverage['confidence']; note: string }
  | Coverage;

export interface TruncationInfo {
  callers_truncated: boolean;
  callers_total: number;
  callers_shown: number;
}

const DEFAULT_INCLUDE_BY_LEVEL: Record<DetailLevel, IncludeField[]> = {
  summary: ['exposures'],
  standard: ['definition', 'callers', 'callees', 'exposures'],
  full: [
    'definition',
    'callers',
    'callees',
    'exposures',
    'contract',
    'patterns',
    'coverage',
  ],
  graph: ['callers', 'callees'],
};

export function inspect(
  index: ProjectIndex,
  name: string,
  opts: InspectOptions,
): InspectResult {
  const rec = index.functions.find((f) => f.name === name);
  if (!rec) {
    const suggestions = opts.fuzzy ? suggestNames(name, index, 5) : [];
    return {
      kind: 'not_found',
      name,
      suggestions,
      message: notFoundMessage(name, suggestions, opts.fuzzy),
    };
  }
  return { kind: 'found', payload: buildPayload(rec, opts) };
}

function buildPayload(rec: FunctionRecord, opts: InspectOptions): InspectPayload {
  const include = effectiveInclude(opts);
  const has = (f: IncludeField) =>
    include.includes('all') || include.includes(f);

  const payload: InspectPayload = {
    id: rec.id,
    name: rec.name,
    project: rec.project,
    signature: renderSignature(rec),
    detail_level: opts.detailLevel,
  };

  if (has('definition')) payload.definition = rec.definition;
  if (has('exposures')) payload.exposures = rec.exposures;
  if (has('callers')) {
    const limit = opts.maxCallers;
    const total = rec.called_by.length;
    const items =
      limit !== null && total > limit ? rec.called_by.slice(0, limit) : rec.called_by;
    payload.callers = { total, shown: items.length, items };
    if (limit !== null && total > limit) {
      payload.truncated = {
        callers_truncated: true,
        callers_total: total,
        callers_shown: items.length,
      };
    }
  }
  if (has('callees')) payload.callees = rec.calls_out;
  if (has('contract')) {
    const hasJsdoc =
      rec.definition.returns !== null ||
      rec.definition.params.some((p) => p.jsdoc_type !== null);
    const hasInferred =
      rec.inferred_contract !== null &&
      ((rec.inferred_contract.return_shape?.field_names.length ?? 0) > 0 ||
        (rec.inferred_contract.failure_signal?.field_names.length ?? 0) > 0);
    payload.contract = {
      params: rec.definition.params,
      returns: rec.definition.returns,
      serializable_return: rec.definition.serializable_return,
      source:
        hasJsdoc && hasInferred
          ? 'mixed'
          : hasInferred
            ? 'inferred_from_usage'
            : hasJsdoc
              ? 'from_jsdoc'
              : 'unknown',
      inferred: rec.inferred_contract,
    };
  }
  if (has('patterns')) {
    payload.patterns = rec.patterns;
  }
  if (has('coverage')) {
    payload.coverage = renderCoverage(rec.coverage, opts.coverageDetail);
  }
  return payload;
}

function effectiveInclude(opts: InspectOptions): IncludeField[] {
  if (opts.include.length === 0) return DEFAULT_INCLUDE_BY_LEVEL[opts.detailLevel];
  if (opts.include.includes('all')) return ['all'];
  return opts.include;
}

function renderSignature(rec: FunctionRecord): string {
  const params = rec.definition.params
    .map((p) => (p.jsdoc_type ? `${p.name}: ${p.jsdoc_type}` : p.name))
    .join(', ');
  const ret = rec.definition.returns?.jsdoc_type
    ? ` -> ${rec.definition.returns.jsdoc_type}`
    : '';
  return `${rec.name}(${params})${ret}`;
}

function renderCoverage(
  c: Coverage,
  detail: CoverageDetail,
): CoveragePayload | undefined {
  if (detail === 'none') return undefined;
  if (detail === 'summary') {
    return {
      resolved_pct: c.resolved_pct,
      confidence: c.confidence,
      note:
        c.unresolved.length === 0 && c.external_boundaries.length === 0
          ? 'rien de non résolu'
          : `${c.unresolved.length} non résolu(s), ${c.external_boundaries.length} frontière(s) externe(s) — passer --coverage-detail=full pour le détail`,
    };
  }
  return c;
}

function notFoundMessage(
  name: string,
  suggestions: string[],
  fuzzy: boolean,
): string {
  if (!fuzzy) {
    return (
      `La fonction '${name}' est introuvable dans l'index. ` +
      `Relance avec --fuzzy pour des suggestions de noms proches, ` +
      `ou vérifie d'abord que 'gaslens scan' a été exécuté sur le bon dossier.`
    );
  }
  if (suggestions.length === 0) {
    return (
      `La fonction '${name}' est introuvable, aucun nom proche dans le projet. ` +
      `Vérifie que 'gaslens scan' couvre bien le sous-dossier où la fonction est définie.`
    );
  }
  return (
    `La fonction '${name}' est introuvable. ` +
    `Noms proches : ${suggestions.map((s) => `'${s}'`).join(', ')}.`
  );
}

function suggestNames(
  target: string,
  index: ProjectIndex,
  k: number,
): string[] {
  const t = target.toLowerCase();
  const ranked = index.functions
    .map((f) => ({
      name: f.name,
      d: editDistance(t, f.name.toLowerCase()),
    }))
    .filter(
      (x) =>
        x.d <= Math.max(2, Math.floor(target.length / 3)) ||
        x.name.toLowerCase().includes(t),
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
