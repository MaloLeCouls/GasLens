import type { SyntaxNode } from 'tree-sitter';

/**
 * Une chaîne d'appels enracinée sur un identifiant simple.
 * Exemples (root = "SpreadsheetApp") :
 *   - `SpreadsheetApp.getActive()` → methods = [getActive]
 *   - `SpreadsheetApp.getActive().getSheets()` → methods = [getActive, getSheets]
 *
 * Le chaînage s'arrête sur la première forme non-chaînable (indexation, parens,
 * binaire, etc.) — méthode placée dans `methods`, la suite (la racine elle-même)
 * marquée comme tronquée via `truncated_at_root`.
 */
export interface ApiCallChain {
  root: string;
  methods: ApiChainCall[];
  start_line: number;
  /** Vrai si la chaîne a été tronquée à cause d'une forme non-chaînable en amont. */
  truncated_at_root: boolean;
}

export interface ApiChainCall {
  name: string;
  arity: number;
  arguments_text: string[];
  line: number;
  col: number;
}

/**
 * Extrait toutes les chaînes d'appels du sous-arbre `root`.
 * Une chaîne est émise pour chaque call_expression *outermost* (i.e. qui n'est
 * pas elle-même le receiver d'un autre call_expression chaîné).
 */
export function extractApiCallChains(root: SyntaxNode): ApiCallChain[] {
  const calls = root.descendantsOfType('call_expression');
  const out: ApiCallChain[] = [];
  for (const call of calls) {
    if (!isOutermostInChain(call)) continue;
    const chain = buildChain(call);
    if (chain && chain.root.length > 0) out.push(chain);
  }
  return out;
}

/**
 * Vrai si `call` est l'appel le plus externe d'une chaîne — i.e. son
 * grand-parent n'est *pas* une member_expression dont l'object pointe sur lui.
 */
function isOutermostInChain(call: SyntaxNode): boolean {
  const parent = call.parent;
  if (!parent) return true;
  if (parent.type !== 'member_expression') return true;
  const objField = parent.childForFieldName('object');
  if (objField?.id !== call.id) return true;
  const grand = parent.parent;
  if (grand?.type !== 'call_expression') return true;
  // call est l'object d'un member_expression qui est la fonction d'un
  // call_expression amont → pas outermost.
  const grandFn = grand.childForFieldName('function');
  return grandFn?.id !== parent.id;
}

function buildChain(outermost: SyntaxNode): ApiCallChain | null {
  const calls: ApiChainCall[] = [];
  let cur: SyntaxNode | null = outermost;
  let truncated = false;
  while (cur && cur.type === 'call_expression') {
    const fn: SyntaxNode | null = cur.childForFieldName('function');
    if (!fn || fn.type !== 'member_expression') {
      // bare identifier call → fin de chaîne, racine = identifier ; mais
      // alors il n'y a pas de chaîne enracinée sur un service.
      return null;
    }
    const prop: SyntaxNode | null = fn.childForFieldName('property');
    if (!prop || prop.type !== 'property_identifier') return null;
    const { arity, args } = extractArgs(cur);
    calls.unshift({
      name: prop.text,
      arity,
      arguments_text: args,
      line: cur.startPosition.row + 1,
      col: cur.startPosition.column,
    });
    const obj: SyntaxNode | null = fn.childForFieldName('object');
    if (!obj) return null;
    if (obj.type === 'identifier') {
      return {
        root: obj.text,
        methods: calls,
        start_line: outermost.startPosition.row + 1,
        truncated_at_root: false,
      };
    }
    if (obj.type === 'call_expression') {
      cur = obj;
      continue;
    }
    if (obj.type === 'member_expression') {
      // Racine = X.Y (chaîne statique, ex: Drive.Files.list()).
      // On enregistre le root comme l'identifier le plus à gauche, et on
      // déclare la chaîne tronquée — validate-api n'essaiera pas de la
      // valider via le registre (pas exhaustif sur les sous-namespaces).
      const leftmost = leftmostIdentifier(obj);
      if (leftmost) {
        return {
          root: leftmost,
          methods: calls,
          start_line: outermost.startPosition.row + 1,
          truncated_at_root: true,
        };
      }
      return null;
    }
    // Toute autre forme (subscript, parenthesized, this, etc.) → bail-out.
    truncated = true;
    break;
  }
  if (truncated) return null;
  return null;
}

function leftmostIdentifier(node: SyntaxNode): string | null {
  let cur: SyntaxNode | null = node;
  while (cur) {
    if (cur.type === 'identifier') return cur.text;
    if (cur.type === 'member_expression') {
      cur = cur.childForFieldName('object');
      continue;
    }
    return null;
  }
  return null;
}

function extractArgs(callNode: SyntaxNode): { arity: number; args: string[] } {
  const argsNode = callNode.childForFieldName('arguments');
  if (!argsNode) return { arity: 0, args: [] };
  const children = argsNode.namedChildren;
  return { arity: children.length, args: children.map((c) => c.text) };
}
