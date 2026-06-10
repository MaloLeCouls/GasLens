import type { SyntaxNode } from 'tree-sitter';

export interface FieldAccessHit {
  field: string;
  /** Ligne (row 0-based) du member_expression dans la source du chunk. */
  chunk_row: number;
  /** Colonne (0-based) idem. */
  chunk_col: number;
}

/**
 * Trouve tous les accès `paramName.<field>` dans un corps de handler.
 * Détecte uniquement les member_expression simples ; pas de destructuration
 * ni d'accès calculés (`paramName[k]`) — v0.
 */
export function readFieldsOnParam(
  body: SyntaxNode,
  paramName: string,
): FieldAccessHit[] {
  if (!paramName) return [];
  const out: FieldAccessHit[] = [];
  const seen = new Set<string>();
  for (const me of body.descendantsOfType('member_expression')) {
    const obj = me.childForFieldName('object');
    if (!obj || obj.type !== 'identifier' || obj.text !== paramName) continue;
    const prop = me.childForFieldName('property');
    if (!prop || prop.type !== 'property_identifier') continue;
    const key = `${prop.text}@${me.startPosition.row}:${me.startPosition.column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      field: prop.text,
      chunk_row: me.startPosition.row,
      chunk_col: me.startPosition.column,
    });
  }
  return out;
}

export interface ScriptFunctionEntry {
  bodyNode: SyntaxNode;
  firstParamName: string | null;
}

/**
 * Extrait les définitions de fonctions du *niveau supérieur* d'un AST
 * (typiquement un bloc &lt;script&gt;). Reconnaît :
 *   - function_declaration
 *   - variable_declarator avec arrow_function / function_expression
 */
export function extractTopLevelFunctions(
  root: SyntaxNode,
): Map<string, ScriptFunctionEntry> {
  const out = new Map<string, ScriptFunctionEntry>();
  for (const child of root.namedChildren) {
    if (child.type === 'function_declaration') {
      const name = child.childForFieldName('name');
      const body = child.childForFieldName('body');
      const params = child.childForFieldName('parameters');
      if (name && body) {
        out.set(name.text, {
          bodyNode: body,
          firstParamName: firstParamNameOf(params),
        });
      }
    } else if (
      child.type === 'lexical_declaration' ||
      child.type === 'variable_declaration'
    ) {
      for (const decl of child.namedChildren) {
        if (decl.type !== 'variable_declarator') continue;
        const name = decl.childForFieldName('name');
        const value = decl.childForFieldName('value');
        if (!name || !value || name.type !== 'identifier') continue;
        if (
          value.type !== 'arrow_function' &&
          value.type !== 'function_expression' &&
          value.type !== 'function'
        ) {
          continue;
        }
        const body = value.childForFieldName('body');
        const params = value.childForFieldName('parameters');
        if (body) {
          out.set(name.text, {
            bodyNode: body,
            firstParamName: firstParamNameOf(params),
          });
        }
      }
    }
  }
  return out;
}

function firstParamNameOf(params: SyntaxNode | null): string | null {
  if (!params) return null;
  const first = params.namedChildren[0];
  if (!first) return null;
  if (first.type === 'identifier') return first.text;
  if (first.type === 'assignment_pattern') {
    const left = first.childForFieldName('left');
    if (left && left.type === 'identifier') return left.text;
  }
  return null;
}
