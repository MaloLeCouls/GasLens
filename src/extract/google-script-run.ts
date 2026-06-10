import type { SyntaxNode } from 'tree-sitter';

export interface GsrHandler {
  /** Nom de la fonction passée si identifier ; sinon '<inline>'. */
  name: string;
  inline: boolean;
  line: number;
  col: number;
}

export interface GsrCall {
  /** Nom de la fonction serveur ciblée (ex. 'sendEmailReport'). */
  server_function: string;
  /** Textes des arguments de l'appel serveur. */
  arguments_text: string[];
  success_handler: GsrHandler | null;
  failure_handler: GsrHandler | null;
  /** Texte brut de l'argument de withUserObject(...), s'il y en a un. */
  user_object: string | null;
  /** Position du call_expression *le plus extérieur* (celui qui invoque la fn serveur). */
  line: number;
  col: number;
}

/**
 * Scanne `root` à la recherche de chaînes `google.script.run...fnServer(args)`.
 * Retourne uniquement les chaînes complètes (= le call extérieur), pas les
 * intermédiaires (`.withSuccessHandler(...)`).
 */
export function findGoogleScriptRunCalls(root: SyntaxNode): GsrCall[] {
  const out: GsrCall[] = [];
  const candidates = root.descendantsOfType('call_expression');
  for (const call of candidates) {
    // Filtre 1 : on ne considère un call que s'il est *extérieur* d'une chaîne.
    // Un intermédiaire a son parent = member_expression utilisé comme function
    // d'un call_expression englobant.
    if (isChainIntermediate(call)) continue;

    const parsed = parseGsrChain(call);
    if (parsed) out.push(parsed);
  }
  return out;
}

function isChainIntermediate(call: SyntaxNode): boolean {
  const p = call.parent;
  if (!p || p.type !== 'member_expression') return false;
  const pp = p.parent;
  if (!pp || pp.type !== 'call_expression') return false;
  return pp.childForFieldName('function') === p;
}

function parseGsrChain(outerCall: SyntaxNode): GsrCall | null {
  // outerCall doit être call_expression(member_expression(<receiver>, server_function), args).
  if (outerCall.type !== 'call_expression') return null;
  const outerFn = outerCall.childForFieldName('function');
  if (!outerFn || outerFn.type !== 'member_expression') return null;
  const serverNameNode = outerFn.childForFieldName('property');
  if (!serverNameNode || serverNameNode.type !== 'property_identifier') return null;
  const serverName = serverNameNode.text;

  // En remontant la chaîne, on collecte les with*Handlers ; le bas de la chaîne
  // doit être google.script.run.
  const withCalls: SyntaxNode[] = [];
  let receiver: SyntaxNode | null = outerFn.childForFieldName('object');
  while (receiver) {
    if (isGoogleScriptRun(receiver)) {
      // Bout de la chaîne atteint.
      const args = outerCall.childForFieldName('arguments');
      const argTexts: string[] = args
        ? args.namedChildren.map((a) => a.text)
        : [];
      return {
        server_function: serverName,
        arguments_text: argTexts,
        success_handler: extractHandler(withCalls, 'withSuccessHandler'),
        failure_handler: extractHandler(withCalls, 'withFailureHandler'),
        user_object: extractUserObject(withCalls),
        line: outerCall.startPosition.row + 1,
        col: outerCall.startPosition.column,
      };
    }
    if (receiver.type !== 'call_expression') return null;
    withCalls.push(receiver);
    const memb = receiver.childForFieldName('function');
    if (!memb || memb.type !== 'member_expression') return null;
    receiver = memb.childForFieldName('object');
  }
  return null;
}

function extractHandler(
  withCalls: SyntaxNode[],
  method: 'withSuccessHandler' | 'withFailureHandler',
): GsrHandler | null {
  for (const c of withCalls) {
    const fn = c.childForFieldName('function');
    if (!fn || fn.type !== 'member_expression') continue;
    const prop = fn.childForFieldName('property');
    if (!prop || prop.text !== method) continue;
    const args = c.childForFieldName('arguments');
    if (!args) return null;
    const first = args.namedChildren[0];
    if (!first) return null;
    if (first.type === 'identifier') {
      return {
        name: first.text,
        inline: false,
        line: first.startPosition.row + 1,
        col: first.startPosition.column,
      };
    }
    if (
      first.type === 'arrow_function' ||
      first.type === 'function_expression' ||
      first.type === 'function'
    ) {
      return {
        name: '<inline>',
        inline: true,
        line: first.startPosition.row + 1,
        col: first.startPosition.column,
      };
    }
    return {
      name: first.text,
      inline: false,
      line: first.startPosition.row + 1,
      col: first.startPosition.column,
    };
  }
  return null;
}

function extractUserObject(withCalls: SyntaxNode[]): string | null {
  for (const c of withCalls) {
    const fn = c.childForFieldName('function');
    if (!fn || fn.type !== 'member_expression') continue;
    const prop = fn.childForFieldName('property');
    if (!prop || prop.text !== 'withUserObject') continue;
    const args = c.childForFieldName('arguments');
    const first = args?.namedChildren[0];
    if (!first) return null;
    return first.text;
  }
  return null;
}

function isGoogleScriptRun(node: SyntaxNode): boolean {
  // node doit être member_expression(member_expression(identifier 'google', 'script'), 'run').
  if (node.type !== 'member_expression') return false;
  const prop = node.childForFieldName('property');
  if (!prop || prop.text !== 'run') return false;
  const inner = node.childForFieldName('object');
  if (!inner || inner.type !== 'member_expression') return false;
  const inProp = inner.childForFieldName('property');
  if (!inProp || inProp.text !== 'script') return false;
  const root = inner.childForFieldName('object');
  if (!root || root.type !== 'identifier') return false;
  return root.text === 'google';
}
