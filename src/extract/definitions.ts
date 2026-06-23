import { createHash } from 'node:crypto';
import type { SyntaxNode } from 'tree-sitter';
import type { FunctionDefinition, FunctionDoc, Visibility } from '../types.js';
import { applyJsdocToParams, parseJsdoc, type ParsedJsdoc } from './jsdoc.js';

export interface RawDefinition {
  name: string;
  definition: FunctionDefinition;
  bodyNode: SyntaxNode;
  defNode: SyntaxNode;
}

/**
 * Extrait les définitions de fonctions au *niveau supérieur* du fichier.
 * GAS partage un namespace global au niveau projet : seules les défs top-level
 * sont visibles depuis les autres .gs du même projet.
 *
 * Reconnu :
 *   - function_declaration (function foo() {})
 *   - lexical_declaration / variable_declaration → variable_declarator(name, arrow_function|function_expression)
 */
export function extractDefinitions(
  rootNode: SyntaxNode,
  fileRelative: string,
): RawDefinition[] {
  const out: RawDefinition[] = [];

  for (const child of rootNode.namedChildren) {
    if (child.type === 'function_declaration') {
      const def = fromFunctionDeclaration(child, fileRelative);
      if (def) out.push(def);
    } else if (
      child.type === 'lexical_declaration' ||
      child.type === 'variable_declaration'
    ) {
      for (const declarator of child.namedChildren) {
        if (declarator.type !== 'variable_declarator') continue;
        const def = fromVariableDeclarator(declarator, fileRelative);
        if (def) out.push(def);
      }
    }
  }

  return out;
}

function precedingJsdoc(node: SyntaxNode): string | null {
  // On ne considère QUE le sibling immédiatement précédent. S'il n'est pas
  // un comment /** ... */ collé (≤ 2 lignes de gap), il n'y a pas de JSDoc
  // applicable. Ça évite le piège « la fonction d'avant a un JSDoc, on le
  // récupère par erreur pour celle-ci ».
  const prev = node.previousSibling;
  if (!prev) return null;
  if (prev.type !== 'comment') return null;
  if (!prev.text.startsWith('/**')) return null;
  const gap = node.startPosition.row - prev.endPosition.row;
  if (gap > 2) return null;
  return prev.text;
}

function paramNames(parametersNode: SyntaxNode | null): string[] {
  if (!parametersNode) return [];
  const names: string[] = [];
  for (const c of parametersNode.namedChildren) {
    if (c.type === 'identifier') {
      names.push(c.text);
    } else if (c.type === 'assignment_pattern') {
      const left = c.childForFieldName('left');
      if (left && left.type === 'identifier') names.push(left.text);
    } else if (c.type === 'rest_pattern') {
      const id = c.namedChild(0);
      if (id && id.type === 'identifier') names.push('...' + id.text);
    }
    // object_pattern / array_pattern : v0 — on saute l'inférence du nom détaillé
  }
  return names;
}

function visibilityOf(name: string): Visibility {
  return name.endsWith('_') ? 'private' : 'public';
}

function docFrom(jsdoc: ParsedJsdoc): FunctionDoc {
  return {
    present: jsdoc.present,
    summary: jsdoc.summary,
    param_tags: jsdoc.paramTagNames,
    returns_desc: jsdoc.returns?.desc ?? null,
    refs: jsdoc.refs,
  };
}

function fromFunctionDeclaration(
  node: SyntaxNode,
  file: string,
): RawDefinition | null {
  const nameNode = node.childForFieldName('name');
  const paramsNode = node.childForFieldName('parameters');
  const bodyNode = node.childForFieldName('body');
  if (!nameNode || !bodyNode) return null;
  const name = nameNode.text;
  const jsdoc = parseJsdoc(precedingJsdoc(node));
  const params = applyJsdocToParams(paramNames(paramsNode), jsdoc);

  return {
    name,
    bodyNode,
    defNode: node,
    definition: {
      file,
      line: node.startPosition.row + 1,
      col: node.startPosition.column,
      end_line: node.endPosition.row + 1,
      params,
      returns: jsdoc.returns,
      doc: docFrom(jsdoc),
      visibility: visibilityOf(name),
      serializable_return: null,
      body_fingerprint: bodyFingerprint(bodyNode.text),
    },
  };
}

function fromVariableDeclarator(
  declarator: SyntaxNode,
  file: string,
): RawDefinition | null {
  const nameNode = declarator.childForFieldName('name');
  const valueNode = declarator.childForFieldName('value');
  if (!nameNode || !valueNode) return null;
  if (nameNode.type !== 'identifier') return null;
  if (
    valueNode.type !== 'arrow_function' &&
    valueNode.type !== 'function_expression' &&
    valueNode.type !== 'function'
  ) {
    return null;
  }
  const name = nameNode.text;
  const paramsNode = valueNode.childForFieldName('parameters');
  const bodyNode = valueNode.childForFieldName('body');
  if (!bodyNode) return null;

  // JSDoc est attaché au lexical/variable_declaration (parent), pas au declarator.
  const declStatement = declarator.parent;
  const jsdoc = parseJsdoc(declStatement ? precedingJsdoc(declStatement) : null);
  const params = applyJsdocToParams(paramNames(paramsNode), jsdoc);

  return {
    name,
    bodyNode,
    defNode: declarator,
    definition: {
      file,
      line: declarator.startPosition.row + 1,
      col: declarator.startPosition.column,
      end_line: declarator.endPosition.row + 1,
      params,
      returns: jsdoc.returns,
      doc: docFrom(jsdoc),
      visibility: visibilityOf(name),
      serializable_return: null,
      body_fingerprint: bodyFingerprint(bodyNode.text),
    },
  };
}

/**
 * Empreinte normalisée du corps : whitespace collapsé en single space, trim.
 * Préserve les identifiants, littéraux et structure. Hash SHA-256 tronqué à
 * 16 hex chars (suffisant pour détection de rename à l'échelle d'un projet GAS).
 */
export function bodyFingerprint(bodyText: string): string {
  const normalized = bodyText.replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}
