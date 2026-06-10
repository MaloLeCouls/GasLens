import type { Param, ReturnDoc } from '../types.js';

export interface ParsedJsdoc {
  params: Map<string, { type: string | null; desc: string | null }>;
  returns: ReturnDoc | null;
}

/**
 * Parser JSDoc minimal v0 : @param et @returns.
 * Gère les accolades imbriquées dans les types (ex: `{{a:number, b:string}}`).
 */
export function parseJsdoc(commentText: string | null): ParsedJsdoc {
  const empty: ParsedJsdoc = { params: new Map(), returns: null };
  if (!commentText) return empty;
  if (!commentText.startsWith('/**')) return empty;

  const body = commentText
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, ''))
    .join('\n');

  const params = new Map<string, { type: string | null; desc: string | null }>();
  let returns: ReturnDoc | null = null;

  for (const tag of scanTags(body)) {
    if (tag.name === 'param') {
      const r = parseParamTag(tag.value);
      if (r) params.set(r.name, { type: r.type, desc: r.desc });
    } else if (tag.name === 'returns' || tag.name === 'return') {
      const r = parseReturnTag(tag.value);
      if (r) returns = { jsdoc_type: r.type, desc: r.desc };
    }
  }

  return { params, returns };
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
