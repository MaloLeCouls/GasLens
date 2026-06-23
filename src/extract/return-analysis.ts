import type { SyntaxNode } from 'tree-sitter';
import type { ReturnAnalysis } from '../types.js';

/**
 * Analyse les `return_statement` d'un corps de fonction pour produire :
 *   - nullability (V2 §10.3) : un chemin retourne null/undefined ?
 *   - serializability (V2 §11.5) : le retour franchirait-il google.script.run ?
 *   - has_open_object : le retour contient-il un objet à clé calculée ?
 *
 * Reste volontairement local à la fonction (pas de flow inter-fonctions en v0).
 */
export function analyzeReturns(body: SyntaxNode, file: string): ReturnAnalysis {
  const out: ReturnAnalysis = {
    nullable: false,
    null_paths: [],
    serializable: 'unknown',
    non_serializable_reasons: [],
    has_open_object: false,
    produced_object_fields: [],
    returns_only_object_literals: false,
  };

  const returns = body.descendantsOfType('return_statement');
  if (returns.length === 0) {
    // Pas de return explicite → renvoie implicitement undefined → considéré comme
    // 'unknown' (le call site peut ne pas attendre de valeur).
    if (body.type !== 'statement_block') {
      // Arrow à corps-expression : la shape produite est l'expression elle-même.
      analyzeProducedShape(body, out);
    }
    finalizeProducedShape(out);
    return out;
  }

  // Si la fonction est aussi une arrow function avec body=expression, le retour
  // est implicite. On traite ça séparément en regardant si le body est lui-même
  // une expression (non-statement_block).
  if (body.type !== 'statement_block') {
    classifyReturnValue(body, file, body.startPosition.row + 1, out);
    if (out.serializable === 'unknown') out.serializable = true;
    analyzeProducedShape(body, out);
    finalizeProducedShape(out);
    return out;
  }

  let anyAnalyzable = false;
  for (const ret of returns) {
    const value = ret.namedChildren[0];
    const line = ret.startPosition.row + 1;
    if (!value) {
      // `return;` → undefined
      out.nullable = true;
      out.null_paths.push({ file, line });
      continue;
    }
    anyAnalyzable = true;
    classifyReturnValue(value, file, line, out);
    analyzeProducedShape(value, out);
  }
  // Si tous les returns sont non-sérialisables, on garde false. Sinon true.
  if (anyAnalyzable && out.serializable === 'unknown') {
    out.serializable = out.non_serializable_reasons.length > 0 ? false : true;
  }
  finalizeProducedShape(out);
  return out;
}

/**
 * État interne accumulé pendant l'analyse de la *shape produite* (clés des
 * objets renvoyés). Séparé de `ReturnAnalysis` (qui n'expose que le résultat
 * final dédupliqué) pour suivre les drapeaux d'autorité.
 */
const SHAPE_STATE = new WeakMap<
  ReturnAnalysis,
  { fields: Set<string>; sawObjectLiteral: boolean; sawOpaque: boolean }
>();

function shapeState(out: ReturnAnalysis) {
  let s = SHAPE_STATE.get(out);
  if (!s) {
    s = { fields: new Set<string>(), sawObjectLiteral: false, sawOpaque: false };
    SHAPE_STATE.set(out, s);
  }
  return s;
}

/**
 * Classifie la valeur d'un return *au niveau supérieur* pour la shape produite :
 *   - objet littéral → collecte les clés littérales (les clés calculées /
 *     spreads rendent la shape non-autoritaire) ;
 *   - null / undefined → neutre ;
 *   - ternaire → récurse sur les deux branches ;
 *   - parenthèses → unwrap ;
 *   - tout le reste (appel, identifiant, tableau, `new`, …) → opaque
 *     (on s'abstiendra de flaguer une dérive).
 */
function analyzeProducedShape(value: SyntaxNode, out: ReturnAnalysis): void {
  const s = shapeState(out);
  if (isNullOrUndefined(value)) return;
  switch (value.type) {
    case 'object': {
      s.sawObjectLiteral = true;
      for (const child of value.namedChildren) {
        if (child.type === 'pair') {
          const key = child.childForFieldName('key');
          if (!key) continue;
          if (key.type === 'property_identifier') s.fields.add(key.text);
          else if (key.type === 'string') s.fields.add(stripQuotes(key.text));
          else s.sawOpaque = true; // clé calculée → shape non fermée
        } else if (child.type === 'shorthand_property_identifier') {
          s.fields.add(child.text);
        } else if (child.type === 'method_definition') {
          const name = child.childForFieldName('name');
          if (name) s.fields.add(name.text);
        } else if (child.type === 'spread_element') {
          s.sawOpaque = true; // `{...other}` → champs inconnus
        }
      }
      return;
    }
    case 'parenthesized_expression': {
      const inner = value.namedChildren[0];
      if (inner) analyzeProducedShape(inner, out);
      return;
    }
    case 'ternary_expression': {
      const cons = value.childForFieldName('consequence');
      const alt = value.childForFieldName('alternative');
      if (cons) analyzeProducedShape(cons, out);
      if (alt) analyzeProducedShape(alt, out);
      return;
    }
    default:
      s.sawOpaque = true;
      return;
  }
}

function finalizeProducedShape(out: ReturnAnalysis): void {
  const s = SHAPE_STATE.get(out);
  if (!s) return;
  out.produced_object_fields = [...s.fields].sort();
  out.returns_only_object_literals = s.sawObjectLiteral && !s.sawOpaque;
  SHAPE_STATE.delete(out);
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'" || s[0] === '`')) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Classifie la valeur d'un `return`. On reste **shallow** : on inspecte la
 * structure DIRECTE de l'expression renvoyée, sans plonger à l'intérieur des
 * appels (la valeur réelle de retour d'une `f(...)` n'est pas analysable ici).
 *
 *   - `return new Foo()` → non-sérialisable (sauf Date)
 *   - `return () => ...` / `return function() {...}` → non-sérialisable
 *   - `return { a: 1, b: <expr> }` → analyse récursive des propriétés
 *   - `return [<expr>, ...]` → analyse récursive des éléments
 *   - `return f(...)` / `return obj.foo(...)` → 'unknown' (la valeur dépend du callee)
 *   - `return null / undefined` → nullable
 */
function classifyReturnValue(
  value: SyntaxNode,
  file: string,
  line: number,
  out: ReturnAnalysis,
): void {
  // null / undefined literal
  if (isNullOrUndefined(value)) {
    out.nullable = true;
    out.null_paths.push({ file, line });
    return;
  }

  switch (value.type) {
    case 'new_expression': {
      const ctor = value.childForFieldName('constructor');
      const ctorName = ctor?.text ?? '?';
      if (ctorName !== 'Date') {
        out.serializable = false;
        out.non_serializable_reasons.push({
          file,
          line: value.startPosition.row + 1,
          reason: `retour est \`new ${ctorName}()\` — non transmissible via google.script.run`,
        });
      }
      return;
    }
    case 'arrow_function':
    case 'function_expression':
    case 'function':
      out.serializable = false;
      out.non_serializable_reasons.push({
        file,
        line: value.startPosition.row + 1,
        reason: `retour est une expression de fonction — non transmissible via google.script.run`,
      });
      return;
    case 'object':
      classifyObjectLiteral(value, file, out);
      return;
    case 'array':
      for (const elem of value.namedChildren) {
        classifyReturnValue(elem, file, elem.startPosition.row + 1, out);
      }
      return;
    case 'call_expression':
    case 'member_expression':
    case 'subscript_expression':
      // Valeur dépend de l'expression — inanalysable localement, on garde
      // serializable = 'unknown'. Pas de non_serializable_reason ajouté.
      return;
    case 'parenthesized_expression': {
      const inner = value.namedChildren[0];
      if (inner) classifyReturnValue(inner, file, line, out);
      return;
    }
    case 'ternary_expression': {
      const cons = value.childForFieldName('consequence');
      const alt = value.childForFieldName('alternative');
      if (cons) classifyReturnValue(cons, file, cons.startPosition.row + 1, out);
      if (alt) classifyReturnValue(alt, file, alt.startPosition.row + 1, out);
      return;
    }
    default:
      // Identifier (return foo;), littéraux (number/string/true/false) → safe.
      return;
  }
}

function classifyObjectLiteral(
  obj: SyntaxNode,
  file: string,
  out: ReturnAnalysis,
): void {
  for (const child of obj.namedChildren) {
    if (child.type === 'pair') {
      const key = child.childForFieldName('key');
      if (key && key.type === 'computed_property_name') {
        out.has_open_object = true;
      }
      const valueNode = child.childForFieldName('value');
      if (valueNode) {
        classifyReturnValue(
          valueNode,
          file,
          valueNode.startPosition.row + 1,
          out,
        );
      }
    } else if (child.type === 'shorthand_property_identifier') {
      // { name } → la valeur est juste l'identifier homonyme : safe.
    } else if (child.type === 'method_definition') {
      // { foo() {} } équivaut à `{ foo: function() {} }` → non-sérialisable.
      out.serializable = false;
      out.non_serializable_reasons.push({
        file,
        line: child.startPosition.row + 1,
        reason: `retour contient une méthode définie (équivaut à une function expression) — non transmissible via google.script.run`,
      });
    }
  }
}

function isNullOrUndefined(node: SyntaxNode): boolean {
  if (node.type === 'null') return true;
  if (node.type === 'undefined') return true;
  if (node.type === 'identifier' && node.text === 'undefined') return true;
  return false;
}
