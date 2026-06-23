import type { SyntaxNode } from 'tree-sitter';
import type { WebappHtmlSignal } from '../types.js';

/**
 * Détecte (G2) si un corps de fonction renvoie du HTML via HtmlService et avec
 * quel `setXFrameOptionsMode`. Sans `ALLOWALL`, une web app GAS embarquée dans
 * un Google Site échoue à s'afficher (« Refused to frame »).
 *
 * Volontairement **shallow et local** : on regarde les appels directs dans le
 * corps de CETTE fonction. Si le HTML est construit par un helper, on s'abstient
 * (faux négatif sûr, pas de faux positif). Intrinsèque au corps → le scan
 * incrémental le préserve sans plomberie (comme `produced_object_fields`).
 */
const HTML_CREATE =
  /^(createHtmlOutput|createHtmlOutputFromFile|createTemplate|createTemplateFromFile)$/;

export function analyzeWebappHtml(body: SyntaxNode): WebappHtmlSignal {
  let returns_html = false;
  let xframe_mode: WebappHtmlSignal['xframe_mode'] = null;

  for (const call of body.descendantsOfType('call_expression')) {
    const fn = call.childForFieldName('function');
    if (!fn || fn.type !== 'member_expression') continue;
    const prop = fn.childForFieldName('property')?.text ?? '';
    if (HTML_CREATE.test(prop)) {
      const obj = fn.childForFieldName('object');
      if (obj?.text === 'HtmlService') returns_html = true;
    } else if (prop === 'setXFrameOptionsMode') {
      const argText = call.childForFieldName('arguments')?.text ?? '';
      const mode = /\bALLOWALL\b/.test(argText)
        ? 'ALLOWALL'
        : /\bDENY\b/.test(argText)
          ? 'DENY'
          : /\bDEFAULT\b/.test(argText)
            ? 'DEFAULT'
            : null;
      // ALLOWALL prime (le mode le plus permissif gagne s'il y a plusieurs appels).
      if (mode === 'ALLOWALL' || xframe_mode === null) xframe_mode = mode;
    }
  }

  return { returns_html, xframe_mode };
}
