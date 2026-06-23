import type { Param, ReturnDoc } from '../types.js';

export interface ParsedJsdoc {
  /** Un bloc `/** ... *​/` valide a été fourni. */
  present: boolean;
  /** Texte d'intention (lignes avant le premier `@tag`), ou null. */
  summary: string | null;
  params: Map<string, { type: string | null; desc: string | null }>;
  /** Noms déclarés dans les tags `@param`, dans l'ordre de déclaration. */
  paramTagNames: string[];
  returns: ReturnDoc | null;
  /**
   * Symboles référencés via `{@link X}` / `{@linkcode X}` / `{@linkplain X}` /
   * `@see X` (X = identifiant nu). Base de `doc.stale_ref`.
   */
  refs: string[];
}

/**
 * Parser JSDoc minimal v0 : intention (summary), @param et @returns.
 * Gère les accolades imbriquées dans les types (ex: `{{a:number, b:string}}`).
 */
export function parseJsdoc(commentText: string | null): ParsedJsdoc {
  const empty: ParsedJsdoc = {
    present: false,
    summary: null,
    params: new Map(),
    paramTagNames: [],
    returns: null,
    refs: [],
  };
  if (!commentText) return empty;
  if (!commentText.startsWith('/**')) return empty;

  const body = commentText
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, ''))
    .join('\n');

  const params = new Map<string, { type: string | null; desc: string | null }>();
  const paramTagNames: string[] = [];
  let returns: ReturnDoc | null = null;

  for (const tag of scanTags(body)) {
    if (tag.name === 'param') {
      const r = parseParamTag(tag.value);
      if (r) {
        params.set(r.name, { type: r.type, desc: r.desc });
        paramTagNames.push(r.name);
      }
    } else if (tag.name === 'returns' || tag.name === 'return') {
      const r = parseReturnTag(tag.value);
      if (r) returns = { jsdoc_type: r.type, desc: r.desc };
    }
  }

  return {
    present: true,
    summary: extractSummary(body),
    params,
    paramTagNames,
    returns,
    refs: extractRefs(body),
  };
}

/**
 * Extrait les symboles explicitement référencés dans la doc. Deux sources, les
 * seules sans ambiguïté (faux positifs quasi nuls) :
 *   - les tags inline `{@link X}` / `{@linkcode X}` / `{@linkplain X}` ;
 *   - le tag `@see X` quand X est un identifiant nu (pas une URL ni de la prose).
 * On retient l'identifiant de tête (on dépouille `#membre`, `()` et le texte
 * d'affichage `X|libellé`). Dédupliqué, ordre d'apparition conservé.
 */
function extractRefs(body: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string | undefined): void => {
    if (!raw) return;
    const head = raw.trim().split(/[|\s]/)[0] ?? '';
    const sym = head.replace(/[#(].*$/, '');
    if (!/^[A-Za-z_$][\w$]*$/.test(sym)) return;
    if (seen.has(sym)) return;
    seen.add(sym);
    refs.push(sym);
  };
  const link = /\{@link(?:code|plain)?\s+([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = link.exec(body)) !== null) add(m[1]);
  const see = /@see\s+([^\n}]+)/g;
  while ((m = see.exec(body)) !== null) {
    const v = (m[1] ?? '').trim();
    // `@see` peut contenir une URL ou de la prose : on ne retient qu'un
    // identifiant nu (éventuellement préfixé d'un `{@link}` déjà capturé).
    if (/^https?:/i.test(v) || /\s/.test(v.replace(/[#(].*$/, '').trim())) continue;
    if (v.startsWith('{@link')) continue; // déjà couvert par la passe link
    add(v);
  }
  return refs;
}

/** L'intention = les lignes avant le premier `@tag` (description libre). */
function extractSummary(body: string): string | null {
  const lines: string[] = [];
  for (const line of body.split('\n')) {
    if (/^\s*@[A-Za-z]/.test(line)) break;
    lines.push(line);
  }
  const summary = lines.join('\n').trim();
  return summary.length > 0 ? summary : null;
}

interface RawTag {
  name: string;
  value: string;
}

function scanTags(body: string): RawTag[] {
  const tags: RawTag[] = [];
  const re = /@([A-Za-z_]+)\b/g;
  let m: RegExpExecArray | null;
  const starts: { name: string; start: number }[] = [];
  while ((m = re.exec(body)) !== null) {
    starts.push({ name: m[1]!, start: m.index + m[0].length });
  }
  for (let i = 0; i < starts.length; i++) {
    const cur = starts[i]!;
    const next = starts[i + 1];
    const end = next ? next.start - 1 - next.name.length - 1 : body.length;
    tags.push({ name: cur.name, value: body.slice(cur.start, end).trim() });
  }
  return tags;
}

/** Lit un bloc `{...}` au début de `s`, accolades équilibrées. */
function leadingBraceBlock(s: string): { type: string; rest: string } | null {
  const t = s.trimStart();
  if (!t.startsWith('{')) return null;
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        const inner = t.slice(1, i);
        const rest = t.slice(i + 1);
        return { type: inner.trim(), rest };
      }
    }
  }
  return null;
}

function parseParamTag(
  value: string,
): { name: string; type: string | null; desc: string | null } | null {
  let type: string | null = null;
  let rest = value;
  const block = leadingBraceBlock(rest);
  if (block) {
    type = block.type;
    rest = block.rest;
  }
  rest = rest.trimStart();
  const nm = /^([A-Za-z_$][\w$]*)\s*(.*)$/s.exec(rest);
  if (!nm) return null;
  const name = nm[1]!;
  const desc = (nm[2] ?? '').trim() || null;
  return { name, type, desc };
}

function parseReturnTag(
  value: string,
): { type: string | null; desc: string | null } | null {
  let type: string | null = null;
  let rest = value;
  const block = leadingBraceBlock(rest);
  if (block) {
    type = block.type;
    rest = block.rest;
  }
  const desc = rest.trim() || null;
  return { type, desc };
}

export function applyJsdocToParams(
  paramNames: string[],
  jsdoc: ParsedJsdoc,
): Param[] {
  return paramNames.map((name) => {
    const doc = jsdoc.params.get(name);
    return {
      name,
      jsdoc_type: doc?.type ?? null,
      desc: doc?.desc ?? null,
    };
  });
}
