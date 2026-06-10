import type { SyntaxNode } from 'tree-sitter';
import type {
  Array2dAccess,
  DestructuringContract,
  FunctionPatterns,
  PropertyKeyAccess,
  PropertyStore,
  TemplateBinding,
} from '../types.js';

/**
 * Extrait les patrons GAS de première classe (V2 §11) sur le corps d'une fonction.
 *
 * Cible :
 *  - destructuring : `const [a,b,c] = fn()` → contrat d'arité (§11.2)
 *  - PropertiesService / CacheService : clés string lues/écrites (§11.4)
 *  - tableaux 2D `getValues()` + accès `row[N]` via `.map/.forEach/.filter` (§11.1)
 *  - `template.data = {...}` (§11.3 côté serveur ; côté HTML alimenté ailleurs)
 *
 * Volontairement sans flow-analysis : ne suit pas les valeurs au-delà de la
 * fonction. Les cas non résolus sont muets ici et remontent via coverage.
 */
export function extractGasPatterns(
  body: SyntaxNode,
  file: string,
): FunctionPatterns {
  return {
    destructuring_contracts: findDestructuringContracts(body, file),
    property_keys: findPropertyKeys(body, file),
    array2d_access: findArray2dAccess(body, file),
    template_bindings: findTemplateBindings(body, file),
  };
}

function findDestructuringContracts(
  body: SyntaxNode,
  file: string,
): DestructuringContract[] {
  const out: DestructuringContract[] = [];
  for (const decl of body.descendantsOfType('variable_declarator')) {
    const name = decl.childForFieldName('name');
    const value = decl.childForFieldName('value');
    if (!name || !value) continue;
    if (name.type !== 'array_pattern') continue;
    const arity = name.namedChildren.length;
    let bound_to: string | null = null;
    if (value.type === 'call_expression') {
      const fn = value.childForFieldName('function');
      if (fn && fn.type === 'identifier') bound_to = fn.text;
    }
    out.push({
      at: { file, line: decl.startPosition.row + 1 },
      pattern: name.text,
      arity,
      bound_to,
    });
  }
  return out;
}

const PROP_OPS: Record<string, 'read' | 'write' | 'delete'> = {
  getProperty: 'read',
  setProperty: 'write',
  deleteProperty: 'delete',
};
const CACHE_OPS: Record<string, 'read' | 'write' | 'delete'> = {
  get: 'read',
  put: 'write',
  remove: 'delete',
};
const PROP_STORE_MAP: Record<string, PropertyStore> = {
  getScriptProperties: 'script',
  getUserProperties: 'user',
  getDocumentProperties: 'document',
};
const CACHE_STORE_MAP: Record<string, PropertyStore> = {
  getScriptCache: 'cache_script',
  getUserCache: 'cache_user',
  getDocumentCache: 'cache_document',
};

function findPropertyKeys(body: SyntaxNode, file: string): PropertyKeyAccess[] {
  const out: PropertyKeyAccess[] = [];
  for (const call of body.descendantsOfType('call_expression')) {
    const fn = call.childForFieldName('function');
    if (!fn || fn.type !== 'member_expression') continue;
    const prop = fn.childForFieldName('property');
    if (!prop) continue;
    const propName = prop.text;

    const inner = fn.childForFieldName('object');
    if (!inner || inner.type !== 'call_expression') continue;
    const innerFn = inner.childForFieldName('function');
    if (!innerFn || innerFn.type !== 'member_expression') continue;
    const innerProp = innerFn.childForFieldName('property');
    const innerRoot = innerFn.childForFieldName('object');
    if (!innerProp || !innerRoot || innerRoot.type !== 'identifier') continue;

    let op: 'read' | 'write' | 'delete' | undefined;
    let store: PropertyStore | undefined;
    if (innerRoot.text === 'PropertiesService' && propName in PROP_OPS) {
      op = PROP_OPS[propName];
      store = PROP_STORE_MAP[innerProp.text];
    } else if (innerRoot.text === 'CacheService' && propName in CACHE_OPS) {
      op = CACHE_OPS[propName];
      store = CACHE_STORE_MAP[innerProp.text];
    }
    if (!op || !store) continue;

    const args = call.childForFieldName('arguments');
    const firstArg = args?.namedChildren[0];
    if (!firstArg) continue;
    const literal = stringLiteralOf(firstArg.text);
    out.push({
      key: literal,
      key_text: firstArg.text,
      op,
      store,
      at: { file, line: call.startPosition.row + 1 },
    });
  }
  return out;
}

const ITER_METHODS = new Set([
  'map',
  'forEach',
  'filter',
  'reduce',
  'find',
  'some',
  'every',
  'flatMap',
]);

function findArray2dAccess(body: SyntaxNode, file: string): Array2dAccess[] {
  // a) trouver les variables assignées à `<X>.getValues()`
  const sources: Array<{ var_name: string; source_text: string; line: number }> = [];
  for (const decl of body.descendantsOfType('variable_declarator')) {
    const name = decl.childForFieldName('name');
    const value = decl.childForFieldName('value');
    if (!name || !value || name.type !== 'identifier') continue;
    if (value.type !== 'call_expression') continue;
    const fn = value.childForFieldName('function');
    if (!fn || fn.type !== 'member_expression') continue;
    const prop = fn.childForFieldName('property');
    if (!prop || prop.text !== 'getValues') continue;
    sources.push({
      var_name: name.text,
      source_text: value.text,
      line: decl.startPosition.row + 1,
    });
  }
  if (sources.length === 0) return [];

  const out: Array2dAccess[] = [];
  for (const src of sources) {
    const indices = new Set<number>();
    const via = new Set<string>();
    // b) <var>.map(lambda) / .forEach(...) / .filter(...) — récolter row[N]
    for (const call of body.descendantsOfType('call_expression')) {
      const fn = call.childForFieldName('function');
      if (!fn || fn.type !== 'member_expression') continue;
      const recv = fn.childForFieldName('object');
      const meth = fn.childForFieldName('property');
      if (!recv || !meth) continue;
      if (recv.type !== 'identifier' || recv.text !== src.var_name) continue;
      if (meth.type !== 'property_identifier' || !ITER_METHODS.has(meth.text)) continue;
      const args = call.childForFieldName('arguments');
      const lambda = args?.namedChildren[0];
      if (!lambda) continue;
      const lambdaInfo = lambdaFirstParamAndBody(lambda);
      if (!lambdaInfo) continue;
      via.add(meth.text);
      collectSubscriptIntegerIndices(lambdaInfo.body, lambdaInfo.firstParam, indices);
    }
    // c) for (const row of <var>) { row[N] }
    for (const forOf of body.descendantsOfType('for_in_statement')) {
      const left = forOf.childForFieldName('left');
      const right = forOf.childForFieldName('right');
      const forBody = forOf.childForFieldName('body');
      if (!left || !right || !forBody) continue;
      // tree-sitter exprime le kind 'of' vs 'in' via un token enfant ; on cherche
      // simplement la séquence (left, of, right). Pour v0 on accepte les deux.
      if (right.type !== 'identifier' || right.text !== src.var_name) continue;
      // left est typiquement variable_declaration > variable_declarator > name
      const rowName = identifierOfLeft(left);
      if (!rowName) continue;
      via.add('for_of');
      collectSubscriptIntegerIndices(forBody, rowName, indices);
    }

    if (indices.size === 0) continue;
    const sorted = [...indices].sort((a, b) => a - b);
    out.push({
      variable: src.var_name,
      source: src.source_text,
      defined_at: { file, line: src.line },
      column_indices_read: sorted,
      max_index: sorted[sorted.length - 1]!,
      via: [...via],
    });
  }
  return out;
}

function lambdaFirstParamAndBody(
  node: SyntaxNode,
): { firstParam: string; body: SyntaxNode } | null {
  if (
    node.type !== 'arrow_function' &&
    node.type !== 'function_expression' &&
    node.type !== 'function'
  )
    return null;
  const params = node.childForFieldName('parameters');
  const body = node.childForFieldName('body');
  if (!body) return null;
  // Arrow function single-param sans parens : params est directement l'identifier
  let firstParam: string | null = null;
  if (params && params.type === 'identifier') {
    firstParam = params.text;
  } else if (params) {
    const first = params.namedChildren[0];
    if (first && first.type === 'identifier') firstParam = first.text;
    else if (first && first.type === 'assignment_pattern') {
      const left = first.childForFieldName('left');
      if (left && left.type === 'identifier') firstParam = left.text;
    }
  }
  if (!firstParam) return null;
  return { firstParam, body };
}

function identifierOfLeft(node: SyntaxNode): string | null {
  // const x of …  : node = lexical_declaration > variable_declarator(name=identifier)
  if (node.type === 'identifier') return node.text;
  for (const child of node.namedChildren) {
    if (child.type === 'variable_declarator') {
      const name = child.childForFieldName('name');
      if (name && name.type === 'identifier') return name.text;
    }
  }
  return null;
}

function collectSubscriptIntegerIndices(
  body: SyntaxNode,
  paramName: string,
  out: Set<number>,
): void {
  for (const sub of body.descendantsOfType('subscript_expression')) {
    const obj = sub.childForFieldName('object');
    const idx = sub.childForFieldName('index');
    if (!obj || obj.type !== 'identifier' || obj.text !== paramName) continue;
    if (!idx || idx.type !== 'number') continue;
    const n = Number.parseInt(idx.text, 10);
    if (Number.isFinite(n) && n >= 0) out.add(n);
  }
}

function findTemplateBindings(
  body: SyntaxNode,
  file: string,
): TemplateBinding[] {
  // 1) variables = HtmlService.createTemplateFromFile('NAME')
  const templateVars = new Map<string, { template_file: string; line: number }>();
  for (const decl of body.descendantsOfType('variable_declarator')) {
    const name = decl.childForFieldName('name');
    const value = decl.childForFieldName('value');
    if (!name || !value || name.type !== 'identifier') continue;
    if (value.type !== 'call_expression') continue;
    const fn = value.childForFieldName('function');
    if (!fn || fn.type !== 'member_expression') continue;
    const recv = fn.childForFieldName('object');
    const meth = fn.childForFieldName('property');
    if (!recv || !meth || recv.type !== 'identifier') continue;
    if (recv.text !== 'HtmlService' || meth.text !== 'createTemplateFromFile') continue;
    const args = value.childForFieldName('arguments');
    const firstArg = args?.namedChildren[0];
    if (!firstArg) continue;
    const literal = stringLiteralOf(firstArg.text);
    if (literal === null) continue;
    templateVars.set(name.text, {
      template_file: `${literal}.html`,
      line: decl.startPosition.row + 1,
    });
  }
  if (templateVars.size === 0) return [];

  // 2) <var>.data = {...}
  const out: TemplateBinding[] = [];
  for (const assign of body.descendantsOfType('assignment_expression')) {
    const left = assign.childForFieldName('left');
    const right = assign.childForFieldName('right');
    if (!left || !right) continue;
    if (left.type !== 'member_expression') continue;
    const obj = left.childForFieldName('object');
    const prop = left.childForFieldName('property');
    if (!obj || !prop || obj.type !== 'identifier' || prop.text !== 'data') continue;
    const tv = templateVars.get(obj.text);
    if (!tv) continue;
    if (right.type !== 'object') continue;
    const fields: string[] = [];
    for (const pair of right.namedChildren) {
      if (pair.type === 'pair') {
        const key = pair.childForFieldName('key');
        if (!key) continue;
        if (key.type === 'property_identifier') fields.push(key.text);
        else if (key.type === 'string') {
          const lit = stringLiteralOf(key.text);
          if (lit !== null) fields.push(lit);
        }
      } else if (
        pair.type === 'shorthand_property_identifier' ||
        pair.type === 'shorthand_property_identifier_pattern'
      ) {
        fields.push(pair.text);
      }
    }
    out.push({
      template_file: tv.template_file,
      template_var: obj.text,
      assigned_at: { file, line: assign.startPosition.row + 1 },
      data_fields_set: dedupe(fields),
      data_fields_read_in_scriptlets: [],
      unread_data_fields: [],
      read_but_not_set: [],
    });
  }
  return out;
}

function stringLiteralOf(text: string): string | null {
  const t = text.trim();
  if (t.length < 2) return null;
  const first = t[0];
  const last = t[t.length - 1];
  if ((first === "'" || first === '"' || first === '`') && first === last) {
    return t.slice(1, -1);
  }
  return null;
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
