import type { SyntaxNode } from 'tree-sitter';

export interface RawCallSite {
  /** Texte brut du callee (identifier ou member_expression). */
  callee_text: string;
  /** Pour `Foo.bar(...)` : "Foo". Null si callee = identifier simple. */
  receiver: string | null;
  /** Pour `Foo.bar(...)` ou `foo(...)` : nom final ("bar" / "foo"). */
  final_name: string;
  /** Vrai si callee est `identifier` simple (candidat à résolution interne projet). */
  is_bare_identifier: boolean;
  line: number;
  col: number;
  arguments_text: string[];
  /** Le call_expression node. */
  node: SyntaxNode;
}

/**
 * Extrait *toutes* les call_expression descendantes d'un node racine
 * (typiquement le body d'une fonction, ou le program entier pour calls top-level).
 */
export function extractCallSites(root: SyntaxNode): RawCallSite[] {
  const out: RawCallSite[] = [];
  const calls = root.descendantsOfType('call_expression');
  for (const call of calls) {
    const fn = call.childForFieldName('function');
    if (!fn) continue;

    let receiver: string | null = null;
    let final_name: string;
    let is_bare = false;

    if (fn.type === 'identifier') {
      final_name = fn.text;
      is_bare = true;
    } else if (fn.type === 'member_expression') {
      const obj = fn.childForFieldName('object');
      const prop = fn.childForFieldName('property');
      if (!prop || prop.type !== 'property_identifier') continue;
      final_name = prop.text;
      if (obj && obj.type === 'identifier') {
        receiver = obj.text;
      } else if (obj) {
        receiver = obj.text;
      }
    } else {
      // call sur autre chose (call_expression, parenthesized, etc.) : v0 — on saute
      continue;
    }

    const argsNode = call.childForFieldName('arguments');
    const argTexts: string[] = [];
    if (argsNode) {
      for (const a of argsNode.namedChildren) {
        argTexts.push(a.text);
      }
    }

    out.push({
      callee_text: fn.text,
      receiver,
      final_name,
      is_bare_identifier: is_bare,
      line: call.startPosition.row + 1,
      col: call.startPosition.column,
      arguments_text: argTexts,
      node: call,
    });
  }
  return out;
}
