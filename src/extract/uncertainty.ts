import type { SyntaxNode } from 'tree-sitter';
import type { CoverageNote } from '../types.js';

/**
 * Détecte les sources d'incertitude statique dans un corps de fonction
 * (V2 §10.4) : dispatch dynamique, eval / new Function. Ces cas restent
 * majoritairement minoritaires en GAS, mais les déclarer honnêtement dans
 * `coverage.unresolved` permet à l'agent de cibler exactement ce qu'il doit
 * encore vérifier manuellement.
 */
export function analyzeUncertainty(
  body: SyntaxNode,
  file: string,
): CoverageNote[] {
  const out: CoverageNote[] = [];

  for (const call of body.descendantsOfType('call_expression')) {
    const fn = call.childForFieldName('function');
    if (!fn) continue;

    // Dispatch dynamique `obj[expr]()` ou `this[m]()`.
    if (fn.type === 'subscript_expression') {
      const obj = fn.childForFieldName('object');
      const index = fn.childForFieldName('index');
      if (obj && index) {
        out.push({
          what: `dispatch dynamique \`${obj.text}[${index.text}](...)\``,
          where: `${file}:${call.startPosition.row + 1}`,
          reason: 'la cible ne peut pas être résolue statiquement (clé calculée)',
          suggestion: `vérifier manuellement ce que peut contenir \`${obj.text}\` à l'exécution`,
        });
      }
      continue;
    }

    // eval(...) — gigantesque trou noir
    if (fn.type === 'identifier' && fn.text === 'eval') {
      out.push({
        what: 'appel à eval(...)',
        where: `${file}:${call.startPosition.row + 1}`,
        reason: 'le code évalué est inconnu statiquement',
        suggestion: 'éviter eval ou vérifier toute la chaîne de construction de la string',
      });
      continue;
    }

    // new Function(...) (le constructor de Function)
    if (fn.type === 'identifier' && fn.text === 'Function') {
      // Ce serait Function() appelé sans new — bizarre. Le cas `new Function(...)`
      // est un new_expression, traité plus bas.
      out.push({
        what: 'appel direct au constructeur Function',
        where: `${file}:${call.startPosition.row + 1}`,
        reason: 'le code généré est inconnu statiquement',
      });
    }
  }

  // new Function(...)
  for (const exp of body.descendantsOfType('new_expression')) {
    const ctor = exp.childForFieldName('constructor');
    if (ctor && ctor.text === 'Function') {
      out.push({
        what: 'new Function(...)',
        where: `${file}:${exp.startPosition.row + 1}`,
        reason: 'le code généré dynamiquement est inconnu statiquement',
        suggestion: 'remplacer par une fonction concrète si possible',
      });
    }
  }

  return out;
}
