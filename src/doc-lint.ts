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
import { GAS_BUILTIN_SERVICES } from './gas-services.js';
import type { FunctionRecord, ProjectIndex } from './types.js';

export type DocCheck = 'undocumented' | 'drift' | 'return_drift' | 'stale_ref';

export interface DocLintOptions {
  /** Sous-ensemble de checks à exécuter ; vide/absent = tous. */
  checks?: Set<DocCheck>;
  /** N'examiner que les fonctions publiques (ignore les `_` privées). */
  publicOnly?: boolean;
}

/**
 * Globals JS/GAS toujours résolvables — ne jamais flaguer une référence doc
 * vers l'un d'eux en `stale_ref`. Complète `GAS_BUILTIN_SERVICES`.
 */
const KNOWN_GLOBALS = new Set<string>([
  'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date',
  'Promise', 'RegExp', 'Error', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol',
  'console', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'google',
]);

export interface DocLintReport {
  project: string;
  verdict: Verdict;
  summary: string;
  findings: Finding[];
}

export function lintDoc(index: ProjectIndex, opts: DocLintOptions = {}): DocLintReport {
  const run = (c: DocCheck): boolean => !opts.checks || opts.checks.size === 0 || opts.checks.has(c);
  const findings: Finding[] = [];
  const knownSymbols = new Set(index.functions.map((f) => f.name));

  for (const fn of index.functions) {
    if (opts.publicOnly && fn.definition.visibility === 'private') continue;
    if (run('undocumented')) {
      const f = checkUndocumented(fn, index.project);
      if (f) findings.push(f);
    }
    if (run('drift')) {
      findings.push(...checkParamDrift(fn, index.project));
    }
    if (run('return_drift')) {
      findings.push(...checkReturnDrift(fn, index.project));
    }
    if (run('stale_ref')) {
      findings.push(...checkStaleRefs(fn, index.project, knownSymbols));
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

/**
 * `doc.return_drift` — le `@returns` décrit un champ que la fonction ne produit
 * plus. On ne flague QUE quand la shape de retour est **autoritaire** (tous les
 * chemins renvoient un objet littéral, pas d'objet ouvert ni de retour opaque),
 * et on ne lit que les champs cités **entre backticks** dans la prose du
 * `@returns` (signal sans ambiguïté). Sévérité warn, confidence medium.
 */
function checkReturnDrift(fn: FunctionRecord, project: string): Finding[] {
  const desc = fn.definition.doc?.returns_desc ?? null;
  if (!desc) return [];
  const ra = fn.return_analysis;
  if (!ra.returns_only_object_literals) return []; // shape non autoritaire → on s'abstient
  const produced = new Set(ra.produced_object_fields ?? []);
  if (produced.size === 0) return [];

  const cited = backtickFieldRefs(desc);
  const out: Finding[] = [];
  for (const field of cited) {
    if (produced.has(field)) continue;
    out.push({
      severity: 'warn',
      symbol: `${project}::doc::${fn.name}`,
      consumer: { file: fn.definition.file, line: fn.definition.line },
      consumer_kind: 'doc.return_drift',
      reason:
        `'${fn.name}' documente le champ de retour \`${field}\` (via @returns) mais la valeur ` +
        `renvoyée ne le produit plus (champs réels : ${[...produced].join(', ')}) — la doc a dérivé de la shape`,
      fix_hint:
        `mettre à jour le @returns (champs réellement renvoyés : ${[...produced].join(', ')}), ` +
        `ou réintroduire \`${field}\` dans l'objet retourné`,
      confidence: 'medium',
    });
  }
  return out;
}

/**
 * Champs cités entre backticks dans une prose, restreints aux identifiants
 * « façon nom de champ » (commençant par une minuscule / `_` / `$`) — exclut
 * les Types (PascalCase) et les mots-clés (null, true…).
 */
function backtickFieldRefs(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /`([A-Za-z_$][\w$]*)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const tok = m[1]!;
    if (!/^[a-z_$]/.test(tok)) continue; // PascalCase / Type → ignoré
    if (RETURN_DESC_STOPWORDS.has(tok)) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

const RETURN_DESC_STOPWORDS = new Set<string>([
  'null', 'undefined', 'true', 'false', 'void', 'this', 'self', 'it',
  'string', 'number', 'boolean', 'object', 'array', 'value', 'result',
]);

/**
 * `doc.stale_ref` — la doc référence (via `{@link X}` / `@see X`) un symbole
 * introuvable : ni une fonction du projet, ni un service GAS natif, ni un global
 * JS connu. Signe d'un renommage/suppression non répercuté. Sévérité info
 * (consultatif — ne gate pas le hook), confidence medium.
 */
function checkStaleRefs(
  fn: FunctionRecord,
  project: string,
  known: Set<string>,
): Finding[] {
  const refs = fn.definition.doc?.refs ?? [];
  if (refs.length === 0) return [];
  const out: Finding[] = [];
  for (const ref of refs) {
    if (known.has(ref)) continue;
    if (GAS_BUILTIN_SERVICES.has(ref)) continue;
    if (KNOWN_GLOBALS.has(ref)) continue;
    out.push({
      severity: 'info',
      symbol: `${project}::doc::${fn.name}`,
      consumer: { file: fn.definition.file, line: fn.definition.line },
      consumer_kind: 'doc.stale_ref',
      reason:
        `la doc de '${fn.name}' référence '${ref}' (via {@link}/@see) mais aucun symbole ` +
        `'${ref}' n'existe (ni fonction du projet, ni service GAS) — référence probablement périmée`,
      fix_hint:
        `corriger la référence vers un symbole existant, ou la retirer si '${ref}' a été supprimé/renommé`,
      confidence: 'medium',
    });
  }
  return out;
}

function buildSummary(findings: Finding[]): string {
  if (findings.length === 0) return 'Documentation cohérente (intention présente, @param/@returns alignés).';
  const count = (k: string): number => findings.filter((f) => f.consumer_kind === k).length;
  const undoc = count('doc.undocumented');
  const drift = count('doc.param_drift');
  const retDrift = count('doc.return_drift');
  const stale = count('doc.stale_ref');
  const parts: string[] = [];
  if (undoc > 0) parts.push(`${undoc} sans intention`);
  if (drift > 0) parts.push(`${drift} @param en dérive`);
  if (retDrift > 0) parts.push(`${retDrift} @returns en dérive`);
  if (stale > 0) parts.push(`${stale} référence(s) périmée(s)`);
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
