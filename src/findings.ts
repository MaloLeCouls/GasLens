/**
 * Types partagés par `impact`, `diff` et `check` (V1 §4.3 et V2 §9).
 */

export type Severity = 'break' | 'warn' | 'safe' | 'info';
export type Verdict = 'CLEAN' | 'WARN' | 'BREAK';

export type ConsumerKind =
  | 'internal_caller'
  | 'client_call.success_handler'
  | 'client_call.failure_handler'
  | 'client_call.invocation'
  | 'scriptlet'
  | 'installable_trigger'
  | 'entry_point_web'
  | 'simple_trigger'
  | 'property_key_reader'
  | 'property_key_writer'
  | 'array2d_consumer'
  | 'template_scriptlet_reader'
  | 'manifest.library'
  | 'manifest.advanced_service'
  | 'manifest.scope'
  | 'manifest.urlfetch_whitelist'
  | 'api.unknown_method'
  | 'api.wrong_arity'
  | 'api.deprecated'
  | 'lint.quota_in_loop'
  | 'lint.urlfetch_in_loop'
  | 'lint.lock_no_finally'
  | 'lint.trigger_orphan'
  | 'webapp.mixed_content'
  | 'webapp.link_target'
  | 'webapp.form_submit';

export type Confidence = 'high' | 'medium' | 'low';

export interface Finding {
  severity: Severity;
  symbol: string;
  consumer: { file: string; line: number };
  consumer_kind: ConsumerKind;
  reason: string;
  fix_hint?: string;
  caused_by?: string;
  /** Confiance dans la détection : high=structurel, medium=indirect, low=heuristique. */
  confidence?: Confidence;
}

export interface ImpactReport {
  symbol: string;
  proposed_change: string;
  breaks: Finding[];
  warns: Finding[];
  safe: Finding[];
  coverage: {
    resolved_pct: number;
    confidence: 'high' | 'medium' | 'low';
    unresolved: Array<{ what: string; where: string; reason: string }>;
    external_boundaries: string[];
  };
  verdict: Verdict;
  summary: string;
}

export interface DerivedChange {
  symbol: string;
  delta: DerivedDeltaKind;
  detail: string;
  confidence: 'high' | 'medium' | 'low';
}

export type DerivedDeltaKind =
  | 'function_added'
  | 'function_removed'
  | 'function_renamed'
  | 'return.field_removed'
  | 'return.field_added'
  | 'return.nullability_changed'
  | 'serializable.broke'
  | 'param.added'
  | 'param.removed'
  | 'param.reordered'
  | 'array.column_indices_changed'
  | 'array.max_index_grew'
  | 'template.binding_field_removed'
  | 'template.binding_field_added'
  | 'property_key.write_only'
  | 'property_key.read_only'
  | 'signature.fingerprint_changed';

export interface DiffReport {
  baseline_label: string;
  current_label: string;
  derived_change_set: DerivedChange[];
  breaks: Finding[];
  warns: Finding[];
  safe: Finding[];
  coverage: ImpactReport['coverage'];
  verdict: Verdict;
  summary: string;
}

export function aggregateVerdict(breaks: Finding[], warns: Finding[]): Verdict {
  if (breaks.length > 0) return 'BREAK';
  if (warns.length > 0) return 'WARN';
  return 'CLEAN';
}

export function summarize(
  breaks: Finding[],
  warns: Finding[],
  coveragePct: number,
): string {
  if (breaks.length === 0 && warns.length === 0) {
    return `Aucune régression détectée. Couverture ${coveragePct} %.`;
  }
  const parts: string[] = [];
  if (breaks.length > 0) parts.push(`${breaks.length} régression(s) bloquante(s)`);
  if (warns.length > 0) parts.push(`${warns.length} avertissement(s)`);
  parts.push(`couverture ${coveragePct} %`);
  return parts.join('. ') + '.';
}
