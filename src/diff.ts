import type { FunctionRecord, ProjectIndex } from './types.js';
import {
  aggregateVerdict,
  summarize,
  type ConsumerKind,
  type DerivedChange,
  type DerivedDeltaKind,
  type DiffReport,
  type Finding,
} from './findings.js';

export interface DiffOptions {
  baselineLabel: string;
  currentLabel: string;
  severity_threshold: 'info' | 'warn' | 'break';
}

/**
 * Compare deux index et dérive un *change set* sémantique, puis confronte chaque
 * delta aux consommateurs présents dans l'état "current" (V2 §9).
 *
 * Note v0 : on n'utilise pas (encore) un `body_fingerprint` pour la détection de
 * renommage façon git — fonction ajoutée + fonction retirée sont traitées comme
 * deux deltas séparés.
 */
export function diffIndexes(
  baseline: ProjectIndex,
  current: ProjectIndex,
  opts: DiffOptions = {
    baselineLabel: 'baseline',
    currentLabel: 'current',
    severity_threshold: 'warn',
  },
): DiffReport {
  const derived: DerivedChange[] = [];
  const breaks: Finding[] = [];
  const warns: Finding[] = [];
  const safe: Finding[] = [];

  const blByName = new Map(baseline.functions.map((f) => [f.name, f]));
  const curByName = new Map(current.functions.map((f) => [f.name, f]));

  // Détection préalable des renames via body_fingerprint (V2 §13.2). Un retrait
  // + un ajout partageant la même empreinte = même fonction renommée, pas deux
  // changements indépendants.
  const removed: FunctionRecord[] = [];
  const added: FunctionRecord[] = [];
  for (const [name, fn] of blByName) {
    if (!curByName.has(name)) removed.push(fn);
  }
  for (const [name, fn] of curByName) {
    if (!blByName.has(name)) added.push(fn);
  }
  const renamePairs = pairByFingerprint(removed, added);
  const renamedOldNames = new Set(renamePairs.map((p) => p.old.name));
  const renamedNewNames = new Set(renamePairs.map((p) => p.new.name));

  for (const { old: blFn, new: curFn } of renamePairs) {
    derived.push({
      symbol: curFn.id,
      delta: 'function_renamed',
      detail: `'${blFn.name}' renommée en '${curFn.name}' (même corps)`,
      confidence: 'high',
    });
    // Tout consommateur en current qui réfère encore l'ancien nom est cassé.
    for (const u of current.unresolved_calls) {
      if (!referencesName(u.callee_text, blFn.name)) continue;
      breaks.push({
        severity: 'break',
        symbol: curFn.id,
        consumer: { file: u.file, line: u.line },
        consumer_kind: classifyUnresolved(u.callee_text),
        reason: `${u.callee_text} référence encore '${blFn.name}' alors qu'elle a été renommée en '${curFn.name}'`,
        fix_hint: `remplacer '${blFn.name}' par '${curFn.name}' au site ${u.file}:${u.line}`,
        caused_by: `${blFn.name} / function_renamed:${curFn.name}`,
      });
    }
  }

  // Functions removed (en baseline mais ni en current ni dans un rename) — WARN
  for (const blFn of removed) {
    if (renamedOldNames.has(blFn.name)) continue;
    derived.push({
      symbol: blFn.id,
      delta: 'function_removed',
      detail: `fonction '${blFn.name}' présente en baseline, absente en current`,
      confidence: 'high',
    });
    warns.push({
      severity: 'warn',
      symbol: blFn.id,
      consumer: { file: blFn.definition.file, line: blFn.definition.line },
      consumer_kind: 'internal_caller',
      reason: `fonction '${blFn.name}' supprimée — vérifier qu'aucun consommateur ne la cherchait`,
      caused_by: `${blFn.name} / function_removed`,
    });
  }

  // Functions added (en current mais ni en baseline ni dans un rename) — INFO
  for (const curFn of added) {
    if (renamedNewNames.has(curFn.name)) continue;
    derived.push({
      symbol: curFn.id,
      delta: 'function_added',
      detail: `nouvelle fonction '${curFn.name}'`,
      confidence: 'high',
    });
    safe.push({
      severity: 'safe',
      symbol: curFn.id,
      consumer: { file: curFn.definition.file, line: curFn.definition.line },
      consumer_kind: 'internal_caller',
      reason: `ajout de '${curFn.name}' — aucune régression`,
    });
  }

  // Per-function shape diff
  for (const [name, blFn] of blByName) {
    const curFn = curByName.get(name);
    if (!curFn) continue;

    diffReturnShape(blFn, curFn, derived, breaks);
    diffParams(blFn, curFn, derived, breaks);
    diffArray2dColumns(blFn, curFn, derived, breaks);
    diffTemplateBindings(blFn, curFn, derived, breaks, warns);
    diffSerializableReturn(blFn, curFn, derived, breaks);
    diffNullability(blFn, curFn, derived, warns);
  }

  // Project-level: property_keys
  diffPropertyKeys(baseline, current, derived, warns);

  const filtered = filterBySeverity(breaks, warns, safe, opts.severity_threshold);
  const coveragePct = aggregateCoveragePct(current);
  const verdict = aggregateVerdict(filtered.breaks, filtered.warns);

  return {
    baseline_label: opts.baselineLabel,
    current_label: opts.currentLabel,
    derived_change_set: derived,
    breaks: filtered.breaks,
    warns: filtered.warns,
    safe: filtered.safe,
    coverage: {
      resolved_pct: coveragePct,
      confidence: coveragePct >= 90 ? 'high' : coveragePct >= 70 ? 'medium' : 'low',
      unresolved: [],
      external_boundaries: [],
    },
    verdict,
    summary: summarize(filtered.breaks, filtered.warns, coveragePct),
  };
}

function diffReturnShape(
  bl: FunctionRecord,
  cur: FunctionRecord,
  derived: DerivedChange[],
  breaks: Finding[],
): void {
  // 1) Comparer la PROMESSE (JSDoc) — c'est ce que le serveur déclare retourner.
  const blPromised = extractReturnFieldSet(bl.definition.returns?.jsdoc_type ?? null);
  const curPromised = extractReturnFieldSet(cur.definition.returns?.jsdoc_type ?? null);

  if (blPromised && curPromised) {
    const removed = blPromised.filter((f) => !curPromised.includes(f));
    const added = curPromised.filter((f) => !blPromised.includes(f));
    for (const field of removed) {
      pushReturnRemoved(cur, field, derived, breaks);
    }
    for (const field of added) {
      derived.push({
        symbol: cur.id,
        delta: 'return.field_added',
        detail: `champ '${field}' ajouté au retour de ${cur.name}`,
        confidence: 'high',
      });
    }
    return;
  }

  // 2) Pas de JSDoc des deux côtés : tomber sur la shape inférée (consumer-side).
  //    Un champ qui disparaît de l'inférence côté current peut signifier deux choses :
  //      - le consommateur l'a retiré aussi (clean)
  //      - aucun consommateur ne le lit plus
  //    Dans les deux cas, ce n'est pas une régression côté consumer.
  //    Donc on n'émet rien ici.
}

function pushReturnRemoved(
  cur: FunctionRecord,
  field: string,
  derived: DerivedChange[],
  breaks: Finding[],
): void {
  derived.push({
    symbol: cur.id,
    delta: 'return.field_removed',
    detail: `champ '${field}' retiré du retour de ${cur.name}`,
    confidence: 'high',
  });
  const reads = cur.inferred_contract?.return_shape?.fields_read ?? [];
  for (const r of reads) {
    if (r.field !== field) continue;
    breaks.push({
      severity: 'break',
      symbol: cur.id,
      consumer: { file: r.file, line: r.line },
      consumer_kind: 'client_call.success_handler',
      reason: `le successHandler '${r.handler}' lit result.${field} → deviendra undefined`,
      fix_hint: `soit retirer la lecture de '${field}' côté client (${r.file}:${r.line}), soit conserver le champ`,
      caused_by: `${cur.name} / return.field_removed:${field}`,
    });
  }
}

function diffParams(
  bl: FunctionRecord,
  cur: FunctionRecord,
  derived: DerivedChange[],
  breaks: Finding[],
): void {
  const blNames = bl.definition.params.map((p) => p.name);
  const curNames = cur.definition.params.map((p) => p.name);

  // Paramètres retirés (positionnels)
  for (let i = 0; i < blNames.length; i++) {
    const name = blNames[i]!;
    if (curNames.includes(name)) continue;
    derived.push({
      symbol: cur.id,
      delta: 'param.removed',
      detail: `paramètre '${name}' retiré en position ${i}`,
      confidence: 'high',
    });
    for (const caller of cur.called_by) {
      if (caller.arguments_text.length > i) {
        breaks.push({
          severity: 'break',
          symbol: cur.id,
          consumer: { file: caller.file, line: caller.line },
          consumer_kind: 'internal_caller',
          reason: `${caller.caller} passe un argument en position ${i} ('${caller.arguments_text[i]}') qui serait ignoré`,
          fix_hint: `retirer cet argument`,
          caused_by: `${cur.name} / param.removed:${name}`,
        });
      }
    }
    for (const exp of cur.exposures) {
      if (exp.type !== 'client_call') continue;
      const args = exp.arguments_text ?? [];
      if (args.length > i) {
        breaks.push({
          severity: 'break',
          symbol: cur.id,
          consumer: { file: exp.file, line: exp.line },
          consumer_kind: 'client_call.invocation',
          reason: `google.script.run.${cur.name} passe un argument en position ${i} ('${args[i]}') qui serait ignoré`,
          fix_hint: `retirer l'argument du site google.script.run`,
          caused_by: `${cur.name} / param.removed:${name}`,
        });
      }
    }
  }
  // Paramètres ajoutés (positionnels) — derived seul
  for (let i = 0; i < curNames.length; i++) {
    const name = curNames[i]!;
    if (blNames.includes(name)) continue;
    derived.push({
      symbol: cur.id,
      delta: 'param.added',
      detail: `paramètre '${name}' ajouté en position ${i}`,
      confidence: 'high',
    });
  }
  // Détection naïve de réordonnancement (mêmes noms, ordre différent)
  if (
    blNames.length === curNames.length &&
    blNames.every((n) => curNames.includes(n)) &&
    blNames.some((n, idx) => curNames[idx] !== n)
  ) {
    derived.push({
      symbol: cur.id,
      delta: 'param.reordered',
      detail: `params réordonnés : [${blNames.join(', ')}] → [${curNames.join(', ')}]`,
      confidence: 'high',
    });
    for (const caller of cur.called_by) {
      breaks.push({
        severity: 'break',
        symbol: cur.id,
        consumer: { file: caller.file, line: caller.line },
        consumer_kind: 'internal_caller',
        reason: `${caller.caller} passe des arguments dans l'ancien ordre — la sémantique des positions change`,
        fix_hint: `réordonner les arguments du site d'appel`,
        caused_by: `${cur.name} / param.reordered`,
      });
    }
  }
}

function diffArray2dColumns(
  bl: FunctionRecord,
  cur: FunctionRecord,
  derived: DerivedChange[],
  breaks: Finding[],
): void {
  if (bl.patterns.array2d_access.length === 0 || cur.patterns.array2d_access.length === 0)
    return;
  // Pour chaque variable 2D présente dans les deux états, comparer column_indices_read.
  for (const blA of bl.patterns.array2d_access) {
    const curA = cur.patterns.array2d_access.find((a) => a.variable === blA.variable);
    if (!curA) continue;
    const blSet = new Set(blA.column_indices_read);
    const curSet = new Set(curA.column_indices_read);
    const added: number[] = curA.column_indices_read.filter((i) => !blSet.has(i));
    const removed: number[] = blA.column_indices_read.filter((i) => !curSet.has(i));
    if (added.length === 0 && removed.length === 0) continue;
    derived.push({
      symbol: cur.id,
      delta: 'array.column_indices_changed',
      detail: `${cur.name} : indices ${blA.variable}[*] avant=[${[...blSet].sort().join(',')}] → après=[${[...curSet].sort().join(',')}]`,
      confidence: 'medium',
    });
    if (curA.max_index > blA.max_index) {
      derived.push({
        symbol: cur.id,
        delta: 'array.max_index_grew',
        detail: `max_index ${blA.variable}[*] : ${blA.max_index} → ${curA.max_index}`,
        confidence: 'medium',
      });
      breaks.push({
        severity: 'break',
        symbol: cur.id,
        consumer: { file: curA.defined_at.file, line: curA.defined_at.line },
        consumer_kind: 'array2d_consumer',
        reason: `${cur.name} accède à ${blA.variable}[${curA.max_index}] alors que la source (${blA.source}) doit fournir au moins ${curA.max_index + 1} colonnes — vérifier le mapping de colonnes côté feuille`,
        fix_hint: `confirmer la structure de la feuille source ou aligner l'index sur la nouvelle colonne`,
        caused_by: `${cur.name} / array.max_index_grew`,
      });
    }
  }
}

function diffTemplateBindings(
  bl: FunctionRecord,
  cur: FunctionRecord,
  derived: DerivedChange[],
  breaks: Finding[],
  warns: Finding[],
): void {
  // Compare data_fields_set d'un binding identique (même template_file).
  for (const curTb of cur.patterns.template_bindings) {
    const blTb = bl.patterns.template_bindings.find(
      (t) => t.template_file === curTb.template_file,
    );
    if (!blTb) continue;
    const blSet = new Set(blTb.data_fields_set);
    const curSet = new Set(curTb.data_fields_set);
    const removed = blTb.data_fields_set.filter((f) => !curSet.has(f));
    const added = curTb.data_fields_set.filter((f) => !blSet.has(f));
    for (const field of removed) {
      derived.push({
        symbol: cur.id,
        delta: 'template.binding_field_removed',
        detail: `${cur.name} : '${field}' retiré de tpl.data pour ${curTb.template_file}`,
        confidence: 'high',
      });
      // Le scriptlet lit-il encore data.<field> dans le current HTML ?
      if (curTb.data_fields_read_in_scriptlets.includes(field)) {
        breaks.push({
          severity: 'break',
          symbol: cur.id,
          consumer: {
            file: curTb.template_file,
            line: curTb.assigned_at.line,
          },
          consumer_kind: 'template_scriptlet_reader',
          reason: `${curTb.template_file} lit encore data.${field} mais ${cur.name} ne le passe plus → undefined au rendu`,
          fix_hint: `réajouter '${field}' à tpl.data côté serveur, ou retirer data.${field} du template`,
          caused_by: `${cur.name} / template.binding_field_removed:${field}`,
        });
      }
    }
    for (const field of added) {
      derived.push({
        symbol: cur.id,
        delta: 'template.binding_field_added',
        detail: `${cur.name} : '${field}' ajouté à tpl.data pour ${curTb.template_file}`,
        confidence: 'high',
      });
    }
    // Champs lus mais non posés (orphelins côté template) — warn même sans delta
    for (const field of curTb.read_but_not_set) {
      warns.push({
        severity: 'warn',
        symbol: cur.id,
        consumer: { file: curTb.template_file, line: curTb.assigned_at.line },
        consumer_kind: 'template_scriptlet_reader',
        reason: `${curTb.template_file} lit data.${field} mais ${cur.name} ne le pose pas → undefined au rendu`,
      });
    }
  }
}

function diffSerializableReturn(
  bl: FunctionRecord,
  cur: FunctionRecord,
  derived: DerivedChange[],
  breaks: Finding[],
): void {
  if (bl.return_analysis.serializable !== true) return;
  if (cur.return_analysis.serializable !== false) return;
  // Le retour est devenu non-sérialisable. Si la fonction est exposée à un
  // google.script.run, c'est un BREAK certain (V2 §11.5).
  derived.push({
    symbol: cur.id,
    delta: 'serializable.broke',
    detail: `retour de ${cur.name} n'est plus sérialisable : ${
      cur.return_analysis.non_serializable_reasons
        .map((r) => r.reason)
        .join(' ; ') || 'cause inconnue'
    }`,
    confidence: 'high',
  });
  for (const exp of cur.exposures) {
    if (exp.type !== 'client_call') continue;
    breaks.push({
      severity: 'break',
      symbol: cur.id,
      consumer: { file: exp.file, line: exp.line },
      consumer_kind: 'client_call.invocation',
      reason: `${cur.name} est exposée via google.script.run mais son retour contient désormais une valeur non transmissible (${cur.return_analysis.non_serializable_reasons[0]?.reason ?? 'non-sérialisable'})`,
      fix_hint: `aplatir la valeur retournée en primitives / objets composés de primitives, ou retirer l'exposition client_call`,
      caused_by: `${cur.name} / serializable.broke`,
      confidence: 'high',
    });
  }
}

function diffNullability(
  bl: FunctionRecord,
  cur: FunctionRecord,
  derived: DerivedChange[],
  warns: Finding[],
): void {
  if (bl.return_analysis.nullable) return;
  if (!cur.return_analysis.nullable) return;
  // Le retour est devenu nullable.
  derived.push({
    symbol: cur.id,
    delta: 'return.nullability_changed',
    detail: `${cur.name} a maintenant ${cur.return_analysis.null_paths.length} chemin(s) de retour null/undefined`,
    confidence: 'medium',
  });
  // Consommateurs : on flag les handlers/callers qui lisent un champ du retour
  // (présume déréférencement sans garde).
  const reads = cur.inferred_contract?.return_shape?.fields_read ?? [];
  for (const r of reads) {
    warns.push({
      severity: 'warn',
      symbol: cur.id,
      consumer: { file: r.file, line: r.line },
      consumer_kind: 'client_call.success_handler',
      reason: `${r.handler} lit result.${r.field} sans garde ; ${cur.name} peut renvoyer null → TypeError possible`,
      fix_hint: `ajouter une vérification \`if (result) ...\` ou retirer le chemin null côté serveur`,
      caused_by: `${cur.name} / return.nullability_changed`,
      confidence: 'medium',
    });
  }
  // Callers internes qui assignent le résultat puis l'utilisent → warn générique.
  for (const caller of cur.called_by) {
    if (caller.return_used_as && caller.return_used_as !== 'returned') {
      warns.push({
        severity: 'warn',
        symbol: cur.id,
        consumer: { file: caller.file, line: caller.line },
        consumer_kind: 'internal_caller',
        reason: `${caller.caller} assigne le retour de ${cur.name} (${caller.return_used_as}) ; ce retour peut maintenant être null`,
        fix_hint: `vérifier que le caller gère le cas null`,
        caused_by: `${cur.name} / return.nullability_changed`,
        confidence: 'medium',
      });
    }
  }
}

function diffPropertyKeys(
  baseline: ProjectIndex,
  current: ProjectIndex,
  derived: DerivedChange[],
  warns: Finding[],
): void {
  const idxBaseline = new Map(
    baseline.property_keys.map((k) => [`${k.store}::${k.key}`, k]),
  );
  for (const cur of current.property_keys) {
    const bl = idxBaseline.get(`${cur.store}::${cur.key}`);
    if (!bl) continue;
    if (bl.status === 'ok' && cur.status === 'write_only') {
      derived.push({
        symbol: `property_key:${cur.store}::${cur.key}`,
        delta: 'property_key.write_only',
        detail: `clé '${cur.key}' (${cur.store}) n'est plus lue dans current`,
        confidence: 'high',
      });
      if (cur.writes.length > 0) {
        const w = cur.writes[0]!;
        warns.push({
          severity: 'warn',
          symbol: `property_key:${cur.store}::${cur.key}`,
          consumer: { file: w.file, line: w.line },
          consumer_kind: 'property_key_writer',
          reason: `'${cur.key}' est désormais write-only — le code qui la lisait a-t-il été migré ?`,
        });
      }
    }
    if (bl.status === 'ok' && cur.status === 'read_only') {
      derived.push({
        symbol: `property_key:${cur.store}::${cur.key}`,
        delta: 'property_key.read_only',
        detail: `clé '${cur.key}' (${cur.store}) n'est plus écrite dans current`,
        confidence: 'high',
      });
      if (cur.reads.length > 0) {
        const r = cur.reads[0]!;
        warns.push({
          severity: 'warn',
          symbol: `property_key:${cur.store}::${cur.key}`,
          consumer: { file: r.file, line: r.line },
          consumer_kind: 'property_key_reader',
          reason: `'${cur.key}' n'est plus écrite nulle part — le reader trouvera-t-il une valeur ?`,
        });
      }
    }
  }
}

function aggregateCoveragePct(idx: ProjectIndex): number {
  if (idx.functions.length === 0) return 100;
  const sum = idx.functions.reduce((n, f) => n + f.coverage.resolved_pct, 0);
  return Math.round(sum / idx.functions.length);
}

function filterBySeverity(
  breaks: Finding[],
  warns: Finding[],
  safe: Finding[],
  threshold: 'info' | 'warn' | 'break',
): { breaks: Finding[]; warns: Finding[]; safe: Finding[] } {
  if (threshold === 'break') return { breaks, warns: [], safe: [] };
  if (threshold === 'warn') return { breaks, warns, safe: [] };
  return { breaks, warns, safe };
}

function pairByFingerprint(
  removed: FunctionRecord[],
  added: FunctionRecord[],
): Array<{ old: FunctionRecord; new: FunctionRecord }> {
  if (removed.length === 0 || added.length === 0) return [];
  // Index des candidats added par fingerprint.
  const addedByFp = new Map<string, FunctionRecord[]>();
  for (const a of added) {
    const fp = a.definition.body_fingerprint;
    if (!fp) continue;
    const list = addedByFp.get(fp) ?? [];
    list.push(a);
    addedByFp.set(fp, list);
  }
  const pairs: Array<{ old: FunctionRecord; new: FunctionRecord }> = [];
  const usedAdded = new Set<FunctionRecord>();
  for (const r of removed) {
    const fp = r.definition.body_fingerprint;
    if (!fp) continue;
    const candidates = addedByFp.get(fp);
    if (!candidates) continue;
    const match = candidates.find((c) => !usedAdded.has(c));
    if (!match) continue;
    usedAdded.add(match);
    pairs.push({ old: r, new: match });
  }
  return pairs;
}

function referencesName(calleeText: string, name: string): boolean {
  if (calleeText === name) return true;
  // google.script.run.<name> ou ScriptApp.newTrigger('<name>') ou Lib.<name>
  return new RegExp(`(^|\\b|['"])${escapeRegex(name)}(\\b|['"]|$)`).test(calleeText);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function classifyUnresolved(calleeText: string): ConsumerKind {
  if (calleeText.startsWith('google.script.run')) return 'client_call.invocation';
  if (calleeText.includes('newTrigger')) return 'installable_trigger';
  return 'internal_caller';
}

export function extractReturnFieldSet(jsdocType: string | null): string[] | null {
  if (!jsdocType) return null;
  const t = jsdocType.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return null;
  const inner = t.slice(1, -1);
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '{' || c === '<' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === '>' || c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  const fields: string[] = [];
  for (const p of parts) {
    const m = /^\s*([A-Za-z_$][\w$]*)\s*\??\s*:/.exec(p);
    if (m) fields.push(m[1]!);
  }
  return fields;
}
