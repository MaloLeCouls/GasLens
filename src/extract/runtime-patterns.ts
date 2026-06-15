import type { SyntaxNode } from 'tree-sitter';

/**
 * Patterns runtime/quota détectés statiquement (V3 §21.3).
 * Heuristiques — émis avec confidence: medium/low côté lint-runtime.
 */

export interface ValueCallInLoop {
  method: string;
  loop_kind: LoopKind;
  line: number;
  col: number;
}

export interface FetchInLoop {
  loop_kind: LoopKind;
  line: number;
  col: number;
}

export interface LockAcquisition {
  method: 'waitLock' | 'tryLock';
  line: number;
  col: number;
  /** Vrai si un releaseLock() a été détecté dans une clause `finally` du même scope. */
  has_release_in_finally: boolean;
}

export interface TriggerCreate {
  line: number;
  col: number;
  /** Texte de l'argument de newTrigger(...) — null si non-littéral. */
  handler_name: string | null;
}

export interface RuntimePatternResult {
  value_calls_in_loops: ValueCallInLoop[];
  fetches_in_loops: FetchInLoop[];
  lock_acquisitions: LockAcquisition[];
  trigger_creates: TriggerCreate[];
  /** Présence d'au moins un appel à ScriptApp.deleteTrigger / deleteTrigger() — pour le cross-check trigger.orphan au niveau projet. */
  has_delete_trigger: boolean;
}

export type LoopKind =
  | 'for'
  | 'for_in'
  | 'for_of'
  | 'while'
  | 'do_while'
  | 'array.forEach'
  | 'array.map'
  | 'array.filter'
  | 'array.reduce'
  | 'array.every'
  | 'array.some';

/** Méthodes "single-cell" qui coûtent un round-trip si appelées dans une boucle. */
const QUOTA_VALUE_METHODS = new Set<string>([
  'getValue',
  'setValue',
  'getDisplayValue',
  'setFormula',
  'setFormulaR1C1',
  'appendRow',
  'setBackground',
  'setFontColor',
  'setNumberFormat',
  'setNote',
  'setHorizontalAlignment',
  'setVerticalAlignment',
]);

/** Types de noeuds tree-sitter considérés comme boucles syntaxiques. */
const STATEMENT_LOOP_TYPES = new Map<string, LoopKind>([
  ['for_statement', 'for'],
  ['for_in_statement', 'for_in'],
  // tree-sitter-javascript code aussi `for...of` comme `for_in_statement` parfois,
  // mais on tente les deux clés défensivement.
  ['while_statement', 'while'],
  ['do_statement', 'do_while'],
]);

/** Méthodes Array.prototype qui agissent comme une boucle pour l'analyse de quota. */
const ARRAY_LOOP_METHODS = new Map<string, LoopKind>([
  ['forEach', 'array.forEach'],
  ['map', 'array.map'],
  ['filter', 'array.filter'],
  ['reduce', 'array.reduce'],
  ['every', 'array.every'],
  ['some', 'array.some'],
]);

export function extractRuntimePatterns(body: SyntaxNode): RuntimePatternResult {
  const value_calls_in_loops: ValueCallInLoop[] = [];
  const fetches_in_loops: FetchInLoop[] = [];
  const lock_acquisitions: LockAcquisition[] = [];
  const trigger_creates: TriggerCreate[] = [];
  let has_delete_trigger = false;

  // 1. Boucles syntaxiques (for/while/do-while).
  for (const node of body.descendantsOfType('for_statement')) {
    scanLoopBody(node, 'for', value_calls_in_loops, fetches_in_loops);
  }
  for (const node of body.descendantsOfType('for_in_statement')) {
    scanLoopBody(node, 'for_in', value_calls_in_loops, fetches_in_loops);
  }
  for (const node of body.descendantsOfType('while_statement')) {
    scanLoopBody(node, 'while', value_calls_in_loops, fetches_in_loops);
  }
  for (const node of body.descendantsOfType('do_statement')) {
    scanLoopBody(node, 'do_while', value_calls_in_loops, fetches_in_loops);
  }

  // 2. Méthodes Array (forEach/map/...) — boucles "logiques".
  for (const call of body.descendantsOfType('call_expression')) {
    const fn = call.childForFieldName('function');
    if (!fn || fn.type !== 'member_expression') continue;
    const prop = fn.childForFieldName('property');
    if (!prop || prop.type !== 'property_identifier') continue;
    const methodName = prop.text;
    const arrayLoopKind = ARRAY_LOOP_METHODS.get(methodName);
    if (!arrayLoopKind) continue;
    // Le callback est le 1er argument (function_expression / arrow_function).
    const args = call.childForFieldName('arguments');
    if (!args) continue;
    const cb = args.namedChildren[0];
    if (!cb) continue;
    if (
      cb.type !== 'arrow_function' &&
      cb.type !== 'function_expression' &&
      cb.type !== 'function'
    )
      continue;
    const cbBody =
      cb.childForFieldName('body') ?? cb.lastNamedChild ?? cb;
    scanRangeForCalls(cbBody, arrayLoopKind, value_calls_in_loops, fetches_in_loops);
  }

  // 3. Lock acquisitions + releaseLock dans un finally du même scope.
  for (const call of body.descendantsOfType('call_expression')) {
    const fn = call.childForFieldName('function');
    if (!fn || fn.type !== 'member_expression') continue;
    const prop = fn.childForFieldName('property');
    if (!prop) continue;
    const methodName = prop.text;
    if (methodName !== 'waitLock' && methodName !== 'tryLock') continue;
    const enclosing = nearestEnclosingFunctionOrBlock(call);
    const hasFinallyRelease = enclosing
      ? scopeHasReleaseLockInFinally(enclosing)
      : false;
    lock_acquisitions.push({
      method: methodName,
      line: call.startPosition.row + 1,
      col: call.startPosition.column,
      has_release_in_finally: hasFinallyRelease,
    });
  }

  // 4. ScriptApp.newTrigger(...).create() & deleteTrigger.
  for (const call of body.descendantsOfType('call_expression')) {
    const fn = call.childForFieldName('function');
    if (!fn || fn.type !== 'member_expression') continue;
    const prop = fn.childForFieldName('property');
    if (!prop) continue;
    if (prop.text === 'create' && chainStartsAtScriptAppNewTrigger(fn)) {
      const handlerArg = newTriggerHandlerArg(fn);
      trigger_creates.push({
        line: call.startPosition.row + 1,
        col: call.startPosition.column,
        handler_name: handlerArg,
      });
    }
    if (prop.text === 'deleteTrigger') {
      has_delete_trigger = true;
    }
  }

  return {
    value_calls_in_loops,
    fetches_in_loops,
    lock_acquisitions,
    trigger_creates,
    has_delete_trigger,
  };
}

function scanLoopBody(
  loopNode: SyntaxNode,
  kind: LoopKind,
  values: ValueCallInLoop[],
  fetches: FetchInLoop[],
): void {
  const body =
    loopNode.childForFieldName('body') ?? loopNode.lastNamedChild ?? loopNode;
  scanRangeForCalls(body, kind, values, fetches);
}

function scanRangeForCalls(
  range: SyntaxNode,
  kind: LoopKind,
  values: ValueCallInLoop[],
  fetches: FetchInLoop[],
): void {
  for (const call of range.descendantsOfType('call_expression')) {
    // Ne pas attribuer une boucle imbriquée à la boucle externe.
    if (isInsideNestedLoop(call, range)) continue;
    const fn = call.childForFieldName('function');
    if (!fn || fn.type !== 'member_expression') continue;
    const prop = fn.childForFieldName('property');
    if (!prop) continue;
    const methodName = prop.text;
    if (QUOTA_VALUE_METHODS.has(methodName)) {
      values.push({
        method: methodName,
        loop_kind: kind,
        line: call.startPosition.row + 1,
        col: call.startPosition.column,
      });
    }
    if (methodName === 'fetch' && receiverRootText(fn) === 'UrlFetchApp') {
      fetches.push({
        loop_kind: kind,
        line: call.startPosition.row + 1,
        col: call.startPosition.column,
      });
    }
  }
}

function isInsideNestedLoop(call: SyntaxNode, outerRange: SyntaxNode): boolean {
  let cur: SyntaxNode | null = call.parent;
  while (cur && cur.id !== outerRange.id) {
    if (STATEMENT_LOOP_TYPES.has(cur.type)) return true;
    if (cur.type === 'call_expression') {
      const fn = cur.childForFieldName('function');
      if (fn?.type === 'member_expression') {
        const prop = fn.childForFieldName('property');
        if (prop && ARRAY_LOOP_METHODS.has(prop.text)) return true;
      }
    }
    cur = cur.parent;
  }
  return false;
}

function receiverRootText(memberExpr: SyntaxNode): string | null {
  let obj: SyntaxNode | null = memberExpr.childForFieldName('object');
  while (obj) {
    if (obj.type === 'identifier') return obj.text;
    if (obj.type === 'call_expression') {
      const innerFn = obj.childForFieldName('function');
      if (innerFn?.type === 'member_expression') {
        obj = innerFn.childForFieldName('object');
        continue;
      }
      return null;
    }
    if (obj.type === 'member_expression') {
      obj = obj.childForFieldName('object');
      continue;
    }
    return null;
  }
  return null;
}

function nearestEnclosingFunctionOrBlock(node: SyntaxNode): SyntaxNode | null {
  let cur: SyntaxNode | null = node.parent;
  while (cur) {
    if (
      cur.type === 'function_declaration' ||
      cur.type === 'function_expression' ||
      cur.type === 'arrow_function' ||
      cur.type === 'method_definition'
    ) {
      return cur.childForFieldName('body') ?? cur;
    }
    cur = cur.parent;
  }
  return null;
}

function scopeHasReleaseLockInFinally(scope: SyntaxNode): boolean {
  for (const tryStmt of scope.descendantsOfType('try_statement')) {
    const finalizer: SyntaxNode | null = tryStmt.childForFieldName('finalizer');
    if (!finalizer) continue;
    for (const call of finalizer.descendantsOfType('call_expression')) {
      const fn = call.childForFieldName('function');
      if (!fn || fn.type !== 'member_expression') continue;
      const prop = fn.childForFieldName('property');
      if (prop?.text === 'releaseLock') return true;
    }
  }
  return false;
}

function chainStartsAtScriptAppNewTrigger(fn: SyntaxNode): boolean {
  // On remonte la chaîne member_expression jusqu'à trouver
  // `ScriptApp.newTrigger(...).<...>...<.create()>` (fn est member_expression
  // dont le `.property = create`).
  let cur: SyntaxNode | null = fn.childForFieldName('object');
  while (cur) {
    if (cur.type === 'call_expression') {
      const innerFn = cur.childForFieldName('function');
      if (innerFn?.type === 'member_expression') {
        const innerProp = innerFn.childForFieldName('property');
        const innerObj: SyntaxNode | null = innerFn.childForFieldName('object');
        if (
          innerProp?.text === 'newTrigger' &&
          innerObj?.type === 'identifier' &&
          innerObj.text === 'ScriptApp'
        ) {
          return true;
        }
        cur = innerObj;
        continue;
      }
      return false;
    }
    if (cur.type === 'member_expression') {
      cur = cur.childForFieldName('object');
      continue;
    }
    return false;
  }
  return false;
}

function newTriggerHandlerArg(fn: SyntaxNode): string | null {
  let cur: SyntaxNode | null = fn.childForFieldName('object');
  while (cur) {
    if (cur.type === 'call_expression') {
      const innerFn = cur.childForFieldName('function');
      if (innerFn?.type === 'member_expression') {
        const innerProp = innerFn.childForFieldName('property');
        if (innerProp?.text === 'newTrigger') {
          const args = cur.childForFieldName('arguments');
          const a = args?.namedChildren[0];
          if (!a) return null;
          const m = /^['"`](.+)['"`]$/.exec(a.text);
          return m ? (m[1] ?? null) : null;
        }
        cur = innerFn.childForFieldName('object');
        continue;
      }
      return null;
    }
    if (cur.type === 'member_expression') {
      cur = cur.childForFieldName('object');
      continue;
    }
    return null;
  }
  return null;
}
