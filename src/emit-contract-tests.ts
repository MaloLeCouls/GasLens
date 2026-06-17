import type { FunctionRecord, ProjectIndex } from './types.js';

/**
 * Cible d'exécution du harnais généré.
 *
 *  - `clasp` (défaut) : harnais `.gs` à déployer dans un projet GAS sandbox.
 *    Exécution dans le cloud Google avec EFFETS DE BORD RÉELS (emails,
 *    écritures Sheets, quota OAuth). Bonne pour valider l'intégration avec
 *    les vraies API mais lent et risqué.
 *
 *  - `gas-fakes` (V3 §23) : harnais `.js` exécutable en local sur Node via
 *    [gas-fakes](https://github.com/brucemcpherson/gas-fakes). gas-fakes
 *    traduit les appels GAS vers les vraies API Google, mais le code Node
 *    s'exécute localement — boucle save & refresh quasi instantanée, et le
 *    mode `vm` permet une sandbox sans permissions. C'est désormais la cible
 *    de premier choix pour les tests de contrat (cf. doctrine V3 §23
 *    « Amendement au V2 §12 »).
 */
export type ContractTestRunner = 'clasp' | 'gas-fakes';

export interface EmitContractTestsOptions {
  /**
   * Si true, génère un test pour CHAQUE fonction publique. Par défaut, on ne
   * génère que les fonctions ayant un `inferred_contract.return_shape` non
   * vide (= au moins un consommateur connu lit un champ → on a un assert utile).
   */
  include_all_public: boolean;
  /** Cible d'exécution — défaut `clasp` (V2 §12.3 historique). */
  runner?: ContractTestRunner;
}

/**
 * Génère un harnais `.gs` (V2 §12.3) qui :
 *   - appelle chaque fonction publique du projet ;
 *   - asserte que le retour contient les champs lus par les consommateurs
 *     (issus de `inferred_contract.return_shape.field_names`) ;
 *   - rapporte succès / échec via Logger.log + throw.
 *
 * Ce harnais N'EST PAS exécuté par gaslens. Il est conçu pour être déployé
 * dans un projet GAS **sandbox dédié** et lancé via `clasp run runGaslensContractTests`
 * ou depuis l'éditeur. Les TODO marquent les arguments à compléter avant run.
 */
export function emitContractTests(
  project: ProjectIndex,
  opts: EmitContractTestsOptions = { include_all_public: false },
): string {
  const eligible = pickEligibleFunctions(project, opts);
  const runner: ContractTestRunner = opts.runner ?? 'clasp';
  const lines: string[] = [];

  emitHeader(project, runner, lines);

  if (eligible.length === 0) {
    lines.push(`// Aucune fonction n'a de shape de retour connue (inferred_contract).`);
    lines.push(`// Lance \`gaslens scan\` après avoir consommé des fonctions côté client,`);
    lines.push(`// ou utilise \`--include-all\` pour générer des tests squelettes.`);
    lines.push(``);
  }

  // Helper d'assertion — partagé par tous les tests.
  lines.push(`/** @private — utilitaire d'assertion partagé. */`);
  lines.push(`function _gaslensAssertShape_(fnName, result, expectedFields, opts) {`);
  lines.push(`  opts = opts || {};`);
  lines.push(`  if (result === null || result === undefined) {`);
  lines.push(`    throw new Error('[gaslens] ' + fnName + ' a retourné ' + (result === null ? 'null' : 'undefined') +`);
  lines.push(`      ' — un consommateur lit au moins un champ et ne tolère pas cette nullité');`);
  lines.push(`  }`);
  lines.push(`  if (typeof result !== 'object') {`);
  lines.push(`    throw new Error('[gaslens] ' + fnName + ' a retourné un ' + typeof result +`);
  lines.push(`      ' mais on attendait un objet avec les champs : ' + expectedFields.join(', '));`);
  lines.push(`  }`);
  lines.push(`  var missing = [];`);
  lines.push(`  for (var i = 0; i < expectedFields.length; i++) {`);
  lines.push(`    var f = expectedFields[i];`);
  lines.push(`    if (!(f in result)) missing.push(f);`);
  lines.push(`  }`);
  lines.push(`  if (missing.length > 0) {`);
  lines.push(`    throw new Error('[gaslens] ' + fnName + ' : champs manquants dans le retour : ' + missing.join(', ') +`);
  lines.push(`      ' (consommés par les handlers ' + (opts.handlers || []).join(', ') + ')');`);
  lines.push(`  }`);
  lines.push(`  Logger.log('[gaslens] ' + fnName + ' OK (' + expectedFields.length + ' champ(s) vérifié(s))');`);
  lines.push(`}`);
  lines.push(``);

  // Un test par fonction éligible.
  for (const fn of eligible) {
    emitTestForFunction(fn, lines);
  }

  // Runner agrégateur.
  lines.push(`/**`);
  lines.push(` * Lance tous les tests de contrat. Retourne un résumé loggé.`);
  if (runner === 'gas-fakes') {
    lines.push(` * Exécution locale via gas-fakes :  node ${suggestedFileName(runner)}`);
  } else {
    lines.push(` * À appeler depuis l'éditeur GAS ou via clasp run.`);
  }
  lines.push(` */`);
  lines.push(`function runGaslensContractTests() {`);
  lines.push(`  var passes = 0;`);
  lines.push(`  var failures = [];`);
  for (const fn of eligible) {
    const safe = sanitizeIdentifier(fn.name);
    lines.push(`  try { _test_${safe}_(); passes++; }`);
    lines.push(`  catch (e) { failures.push('${escapeSingleQuotes(fn.name)}: ' + (e && e.message || e)); }`);
  }
  lines.push(`  Logger.log('[gaslens] ' + passes + '/' + (passes + failures.length) + ' test(s) passés');`);
  lines.push(`  for (var i = 0; i < failures.length; i++) Logger.log('  ✗ ' + failures[i]);`);
  lines.push(`  if (failures.length > 0) {`);
  lines.push(`    throw new Error('[gaslens] ' + failures.length + ' test(s) en échec — voir Logger.log');`);
  lines.push(`  }`);
  lines.push(`  return { passes: passes, failures: failures.length };`);
  lines.push(`}`);
  lines.push(``);
  if (runner === 'gas-fakes') {
    emitGasFakesFooter(lines);
  }
  return lines.join('\n');
}

/**
 * En-tête du harnais : commentaires de mise en garde + avertissement de
 * cible. Diffère selon le runner — gas-fakes est local et sans permissions,
 * clasp est cloud avec effets de bord réels.
 */
function emitHeader(
  project: ProjectIndex,
  runner: ContractTestRunner,
  lines: string[],
): void {
  lines.push(`/**`);
  lines.push(` * Tests de contrat générés par \`gaslens emit-contract-tests\``);
  lines.push(` * — projet « ${project.project} », runner : ${runner}.`);
  lines.push(` *`);
  if (runner === 'gas-fakes') {
    lines.push(` * Cible : exécution LOCALE via gas-fakes (V3 §23).`);
    lines.push(` * gas-fakes traduit les appels GAS (SpreadsheetApp, GmailApp, …) vers les`);
    lines.push(` * vraies API Google côté Node — boucle save & refresh quasi instantanée,`);
    lines.push(` * et le mode \`vm\` permet une sandbox sans permissions.`);
    lines.push(` *`);
    lines.push(` * Prérequis : \`npm install gas-fakes\` (la commande d'import ci-dessous`);
    lines.push(` * suppose le bootstrap global recommandé par la doc gas-fakes).`);
    lines.push(` *`);
    lines.push(` * Lancement :  node ${suggestedFileName(runner)}`);
  } else {
    lines.push(` * ⚠ À DÉPLOYER DANS UN PROJET GAS DE SANDBOX UNIQUEMENT.`);
    lines.push(` * Ces tests appellent les fonctions serveur pour de vrai : ils peuvent`);
    lines.push(` * envoyer des emails, écrire en feuille, consommer du quota OAuth.`);
    lines.push(` * Ne JAMAIS pointer leur déploiement sur des données de production.`);
    lines.push(` *`);
    lines.push(` * Lancement :`);
    lines.push(` *   - depuis l'éditeur GAS : exécuter \`runGaslensContractTests\``);
    lines.push(` *   - via clasp : \`clasp run runGaslensContractTests\``);
  }
  lines.push(` *`);
  lines.push(` * Chaque test marqué \`TODO\` requiert que tu remplaces les arguments`);
  lines.push(` * \`null\` par des valeurs réalistes de ton sandbox avant exécution.`);
  lines.push(` */`);
  lines.push(``);
  if (runner === 'gas-fakes') {
    lines.push(`// Bootstrap gas-fakes : expose SpreadsheetApp, GmailApp, Logger, etc. en globals.`);
    lines.push(`// Ajuster le chemin d'import si nécessaire (cf. doc gas-fakes / package.json).`);
    lines.push(`import 'gas-fakes';`);
    lines.push(``);
  }
}

/**
 * Pied du harnais gas-fakes : exécute le runner et propage le code de sortie
 * pour intégration CI (process.exit(1) en cas d'échec, 0 en succès).
 */
function emitGasFakesFooter(lines: string[]): void {
  lines.push(`// Auto-exécution : lance la batterie et propage le code de sortie pour CI.`);
  lines.push(`try {`);
  lines.push(`  runGaslensContractTests();`);
  lines.push(`  process.exit(0);`);
  lines.push(`} catch (e) {`);
  lines.push(`  // Le runner aura déjà loggé via Logger.log ; on imprime aussi sur stderr.`);
  lines.push(`  process.stderr.write('[gaslens] ' + (e && e.message || e) + '\\n');`);
  lines.push(`  process.exit(1);`);
  lines.push(`}`);
  lines.push(``);
}

function suggestedFileName(runner: ContractTestRunner): string {
  return runner === 'gas-fakes' ? 'gaslens-contract-tests.mjs' : 'gaslensContractTests.gs';
}

function pickEligibleFunctions(
  project: ProjectIndex,
  opts: EmitContractTestsOptions,
): FunctionRecord[] {
  return project.functions
    .filter((f) => f.definition.visibility === 'public')
    .filter((f) => {
      if (opts.include_all_public) return true;
      const fields = f.inferred_contract?.return_shape?.field_names ?? [];
      return fields.length > 0;
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function emitTestForFunction(fn: FunctionRecord, lines: string[]): void {
  const safe = sanitizeIdentifier(fn.name);
  const fields = fn.inferred_contract?.return_shape?.field_names ?? [];
  const handlers = uniqueHandlers(fn);

  const argsTodo = fn.definition.params.length > 0;

  lines.push(`/**`);
  lines.push(` * Contrat inféré : ${
    fields.length > 0
      ? fields.map((f) => `result.${f}`).join(', ') +
        ` (lu par ${handlers.length > 0 ? handlers.join(', ') : 'au moins un consommateur'})`
      : 'aucun champ connu'
  }.`);
  if (argsTodo) {
    lines.push(` * TODO: remplacer les \`null\` ci-dessous par des arguments réalistes du sandbox.`);
  }
  lines.push(` */`);
  lines.push(`function _test_${safe}_() {`);
  const argList = fn.definition.params
    .map((p) => `/* ${p.name}${p.jsdoc_type ? `: ${p.jsdoc_type}` : ''} */ null`)
    .join(', ');
  lines.push(`  var result = ${fn.name}(${argList});`);

  if (fields.length > 0) {
    const fieldsArr = fields.map((f) => `'${escapeSingleQuotes(f)}'`).join(', ');
    const handlersArr = handlers.map((h) => `'${escapeSingleQuotes(h)}'`).join(', ');
    lines.push(`  _gaslensAssertShape_('${escapeSingleQuotes(fn.name)}', result, [${fieldsArr}], { handlers: [${handlersArr}] });`);
  } else {
    lines.push(`  // Pas de shape inférée : on vérifie seulement que la fonction renvoie sans throw.`);
    lines.push(`  Logger.log('[gaslens] ${escapeSingleQuotes(fn.name)} a renvoyé sans throw (shape non vérifiée)');`);
  }
  lines.push(`}`);
  lines.push(``);
}

function uniqueHandlers(fn: FunctionRecord): string[] {
  const set = new Set<string>();
  for (const r of fn.inferred_contract?.return_shape?.fields_read ?? []) {
    set.add(r.handler);
  }
  return [...set].sort();
}

function sanitizeIdentifier(name: string): string {
  // Garde uniquement [a-zA-Z0-9_$]
  return name.replace(/[^a-zA-Z0-9_$]/g, '_');
}

function escapeSingleQuotes(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
