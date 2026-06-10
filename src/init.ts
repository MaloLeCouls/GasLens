/**
 * Recettes prêtes à coller (V2 §16) : CLAUDE.md racine, CLAUDE.md sous-repo,
 * et .claude/settings.json (hook PostToolUse câblé à `gaslens hook`).
 *
 * `gaslens init` les imprime sur stdout. Avec --write, écrit ceux qui n'existent
 * pas déjà (jamais d'écrasement par défaut).
 */

export const CLAUDE_MD_ROOT = `## Outil d'analyse GAS — gaslens (anti-régression)

Ce repo Google Apps Script est indexé par \`gaslens\`. Un hook
\`PostToolUse\` lance \`gaslens hook --event post-tool-use\` après chaque édition
de \`.gs\`/\`.html\` ; si la modif casse un consommateur, le hook ré-injecte la
régression dans ta boucle de raisonnement.

AVANT de modifier une fonction serveur, lance :
  \`gaslens inspect <fonction> --detail-level standard\`
→ tu obtiens ses call sites, ses expositions, son contrat de retour inféré
  (y compris les champs lus par les successHandler côté client).

APRÈS édition, le hook tourne automatiquement. S'il renvoie un verdict BREAK,
corrige selon les \`fix_hint\` avant de continuer.

CE QUE gaslens VÉRIFIE DÉJÀ (ne re-grep pas ces points à la main) :
- call sites internes ; appels \`google.script.run\` + champs lus par successHandler ;
- scriptlets de templates \`<?= fn() ?>\` ; triggers \`ScriptApp.newTrigger('X')\` ;
- préfixes de librairie inter-projets \`Lib.fn()\` ; clés PropertiesService/CacheService ;
- arité des tableaux 2D \`getValues()\` (\`row[N]\`) et des déstructurations ;
- contrats \`template.data\` ↔ scriptlets ; sérialisabilité des retours \`google.script.run\`.

CE QUE TU DOIS ENCORE ÉVALUER TOI-MÊME (gaslens ne peut pas) :
- régressions sémantiques (même champ, sens changé : unités, statuts, logique métier) ;
- tout ce qui est listé dans \`coverage.unresolved\` (dispatch dynamique, clés calculées,
  librairies externes non indexées, services Google) ;
- la pertinence métier du changement.

Si \`gaslens check\` renvoie une couverture < 100 %, vérifie UNIQUEMENT les points
listés dans \`coverage.unresolved\` — pas tout le repo.
`;

export function claudeMdSubrepo(projectName: string, libPrefix?: string): string {
  return `## Projet ${projectName} (GAS)
${libPrefix ? `\nPréfixe de librairie exposé aux autres projets : \`${libPrefix}\`\n(les appels \`${libPrefix}.fn()\` depuis les autres sous-repos sont résolus par gaslens).\n` : ''}
Entry points web de ce projet : \`doGet\` / \`doPost\` (cf. \`gaslens inspect doGet\`).
Fonctions privées : suffixe \`_\` (non appelables par \`google.script.run\`).

Avant de toucher une fonction exposée comme librairie, garde en tête que
des projets EXTERNES non indexés peuvent l'appeler : \`gaslens check\` le signalera
en \`coverage.external_boundaries\`. Traite ces cas avec prudence.
`;
}

export const CLAUDE_SETTINGS_JSON = `{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "gaslens hook --event post-tool-use"
          }
        ]
      }
    ]
  }
}
`;

export const SETUP_GUIDE = `# gaslens — configuration anti-régression

1. Indexe ton projet (à la racine du monorepo si tu en as un) :
     gaslens scan <chemin> -o <chemin>/.gaslens/baseline.json

2. Colle le bloc ci-dessous dans <chemin>/CLAUDE.md :

${CLAUDE_MD_ROOT}

3. Colle le bloc ci-dessous dans <chemin>/.claude/settings.json :

${CLAUDE_SETTINGS_JSON}

4. (Optionnel) Pour chaque sous-projet, ajoute un CLAUDE.md local (V2 §16.2).
`;

export interface InitWriteResult {
  written: string[];
  skipped: Array<{ path: string; reason: string }>;
}
