import type { FunctionRecord, ProjectIndex } from './types.js';
import { extractReturnFieldSet } from './diff.js';

export interface EmitDtsOptions {
  /** Inclure les fonctions sans client_call/scriptlet (toutes les publiques). */
  include_all_public: boolean;
}

/**
 * Génère un fichier `.d.ts` décrivant l'API `google.script.run` d'un projet
 * GAS (V2 §8.4). Permet à `tsc` côté client de checker :
 *   - existence de la fonction serveur (typo → erreur de compilation) ;
 *   - signature (arité, types des arguments) ;
 *   - shape de retour (via interface nommée référencée par le handler).
 */
export function emitDts(
  project: ProjectIndex,
  opts: EmitDtsOptions = { include_all_public: true },
): string {
  const exposed = pickExposedFunctions(project, opts);
  const lines: string[] = [];

  lines.push(
    `// Généré par \`gaslens emit-dts\` — projet « ${project.project} ».`,
    `// Décrit l'API google.script.run côté client.`,
    `// Ne pas éditer à la main : regénérer avec \`gaslens emit-dts\`.`,
    `//`,
    `// Fichier d'ambient declarations (pas un module ES). Référencer via`,
    `// triple-slash dans le code client : /// <reference path="./gaslens.d.ts" />`,
    `// ou ajouter le chemin dans tsconfig.json -> files.`,
    ``,
  );

  // 1) Interfaces de retour (une par fonction qui a une shape connue).
  const returnInterfaces = new Map<string, string>();
  for (const fn of exposed) {
    const fields = effectiveReturnFields(fn);
    if (fields.length === 0) continue;
    const iface = returnInterfaceName(fn.name);
    returnInterfaces.set(fn.name, iface);
    lines.push(`/** Retour de \`${fn.name}\` côté serveur. */`);
    lines.push(`interface ${iface} {`);
    for (const f of fields) {
      lines.push(`  ${f.name}: ${f.type};`);
    }
    lines.push(`}`);
    lines.push(``);
  }

  // 2) Interface du runner avec une méthode par fonction serveur publique.
  lines.push(`/**`);
  lines.push(` * Runner google.script.run avec les fonctions serveur typées du projet.`);
  lines.push(` * Utilisation côté client :`);
  lines.push(` *   google.script.run`);
  lines.push(` *     .withSuccessHandler((res: ${[...returnInterfaces.values()][0] ?? 'unknown'}) => { ... })`);
  lines.push(` *     .withFailureHandler(err => { ... })`);
  lines.push(` *     .${exposed[0]?.name ?? 'maFonction'}(...args)`);
  lines.push(` */`);
  lines.push(`interface GoogleScriptRunner {`);
  lines.push(`  withSuccessHandler(handler: (result: any, userObject?: unknown) => void): GoogleScriptRunner;`);
  lines.push(`  withFailureHandler(handler: (error: Error, userObject?: unknown) => void): GoogleScriptRunner;`);
  lines.push(`  withUserObject(userObject: unknown): GoogleScriptRunner;`);
  lines.push(``);
  for (const fn of exposed) {
    const args = renderArgs(fn);
    const returnIface = returnInterfaces.get(fn.name);
    if (returnIface) {
      lines.push(`  /** Retour: ${returnIface} (passé au successHandler). */`);
    } else if (fn.definition.returns?.jsdoc_type) {
      lines.push(`  /** Retour (JSDoc): ${fn.definition.returns.jsdoc_type}. */`);
    }
    lines.push(`  ${fn.name}(${args}): void;`);
  }
  lines.push(`}`);
  lines.push(``);

  // 3) Globale `google.script.run` (déclaration ambient, pas exportée).
  lines.push(`declare const google: {`);
  lines.push(`  script: {`);
  lines.push(`    run: GoogleScriptRunner;`);
  lines.push(`    host?: {`);
  lines.push(`      close(): void;`);
  lines.push(`      setHeight(h: number): void;`);
  lines.push(`      setWidth(w: number): void;`);
  lines.push(`    };`);
  lines.push(`  };`);
  lines.push(`};`);
  lines.push(``);
  return lines.join('\n');
}

function pickExposedFunctions(
  project: ProjectIndex,
  opts: EmitDtsOptions,
): FunctionRecord[] {
  const out: FunctionRecord[] = [];
  for (const fn of project.functions) {
    if (fn.definition.visibility !== 'public') continue;
    if (!opts.include_all_public) {
      // Seulement celles avec une exposition client_call ou scriptlet
      const exposed = fn.exposures.some(
        (e) => e.type === 'client_call' || e.type === 'scriptlet',
      );
      if (!exposed) continue;
    }
    out.push(fn);
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function effectiveReturnFields(fn: FunctionRecord): Array<{ name: string; type: string }> {
  // 1) Shape inférée a la priorité (= ce que les consommateurs lisent vraiment).
  const inferred = fn.inferred_contract?.return_shape?.field_names ?? [];
  // 2) Compléter / fallback : champs JSDoc.
  const jsdocFields = extractReturnFieldSet(fn.definition.returns?.jsdoc_type ?? null) ?? [];
  const fieldNames = dedupe([...inferred, ...jsdocFields]);
  if (fieldNames.length === 0) return [];
  // Pour les types : on essaie d'extraire `name: TypeText` du JSDoc, sinon `unknown`.
  const jsdocTypes = parseJsdocFieldTypes(fn.definition.returns?.jsdoc_type ?? null);
  return fieldNames.map((name) => ({
    name,
    type: jsdocTypes.get(name) ?? 'unknown',
  }));
}

function parseJsdocFieldTypes(jsdocType: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!jsdocType) return out;
  const t = jsdocType.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return out;
  const inner = t.slice(1, -1);
  let depth = 0;
  let start = 0;
  const parts: string[] = [];
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
  for (const p of parts) {
    const m = /^\s*([A-Za-z_$][\w$]*)\s*\??\s*:\s*(.+?)\s*$/.exec(p);
    if (m) out.set(m[1]!, normalizeJsdocType(m[2]!));
  }
  return out;
}

function renderArgs(fn: FunctionRecord): string {
  return fn.definition.params
    .map((p) => {
      const type = normalizeJsdocType(p.jsdoc_type ?? '');
      return `${p.name}: ${type || 'unknown'}`;
    })
    .join(', ');
}

/** Normalise un type JSDoc vers TypeScript. */
function normalizeJsdocType(t: string): string {
  const trimmed = t.trim();
  if (!trimmed) return 'unknown';
  // `Object` JSDoc usuellement = "objet quelconque" → `object`. `*` ou `any` → `unknown`.
  if (/^object$/i.test(trimmed)) return 'object';
  if (trimmed === '*' || /^any$/i.test(trimmed)) return 'unknown';
  // Array<X> → X[]
  const arrayMatch = /^Array<(.+)>$/.exec(trimmed);
  if (arrayMatch) return `${normalizeJsdocType(arrayMatch[1]!)}[]`;
  // X[] → X[] (déjà OK)
  // {a: T, b: T} → { a: T; b: T } (séparateur `;`)
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const inner = trimmed.slice(1, -1).trim();
    const fields = inner.split(',').map((f) => f.trim().replace(/\s*,\s*$/, ''));
    return `{ ${fields.join('; ')} }`;
  }
  return trimmed;
}

function returnInterfaceName(fnName: string): string {
  // sendEmailReport → SendEmailReportResult
  return fnName[0]!.toUpperCase() + fnName.slice(1) + 'Result';
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
