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

export const GASLENS_SKILL_MD = `---
name: gaslens
description: Analyse statique d'un projet Google Apps Script (.gs / .html / appsscript.json) : détecte les régressions structurelles, les méthodes API hallucinées, les décalages avec appsscript.json (libs/scopes/services avancés), les anti-patterns quota et les bugs web app. Utilise cette skill chaque fois que tu édites, refactores, debugges ou raisonnes sur du code GAS. Outils CLI hors-ligne, instantanés, exit codes structurés.
---

# Quand utiliser cette skill

Tu travailles sur un projet **Google Apps Script** (présence d'\`appsscript.json\`,
de fichiers \`.gs\`, de templates \`.html\` servis par HtmlService). Avant de
modifier ou raisonner sur du code GAS, utilise \`gaslens\` pour obtenir le
contexte structurel que \`tsc\` / un linter générique ne donne pas (couture
\`google.script.run\`, scriptlets, triggers par chaîne, méthodes API,
manifeste, web app sandbox).

# Setup (une seule fois par projet)

\`\`\`bash
# 1. Construit l'index baseline (à la racine du projet ou du workspace).
gaslens scan <root> -o <root>/.gaslens/baseline.json

# 2. (Optionnel mais recommandé) Câble le hook PostToolUse Claude Code.
gaslens init --section settings-json   # bloc .claude/settings.json prêt à coller

# 3. (Re-scan rapide après édits) — fast-path si rien n'a réellement changé.
gaslens scan <root> --incremental <root>/.gaslens/baseline.json -o <root>/.gaslens/index.json
\`\`\`

Quand le hook est câblé, \`gaslens check\` tourne automatiquement après chaque
édition. Sinon, lance-le manuellement (cf. ci-dessous).

# Workflow par tâche (économie de tokens)

1. **Carte du projet (~300 tokens)** — la table des matières anti-orientation.
   \`\`\`bash
   gaslens map --format text
   \`\`\`
   Tu obtiens en une vue : entry points web (doGet/doPost), triggers, fonctions
   exposées au client via \`google.script.run\`, librairies consommées/exposées,
   templates scriptlet. Lis-le AVANT d'explorer.

2. **Avant d'éditer une fonction serveur** :
   \`\`\`bash
   gaslens inspect <fonction> --detail-level standard --compact
   \`\`\`
   Signature, expositions, callers, callees, contrat de retour inféré (incluant
   les champs lus par les \`successHandler\` côté client).

3. **Pour une mutation envisagée** (avant d'écrire la modif) :
   \`\`\`bash
   gaslens impact <fonction> --change 'change-return-shape:-msgId,+ok' --compact
   # autres DSL : remove-param:name | rename:newName | rename-param:old=new
   \`\`\`

   Si la fonction concernée est \`doGet\`/\`doPost\`/un trigger add-on et que
   le projet est déployé en prod, double l'impact avec :
   \`\`\`bash
   gaslens deploy-aware --use-apps-script-api
   \`\`\`
   pour savoir si le déploiement live est touché immédiatement.

4. **Après édition** (auto si le hook est câblé) :
   \`\`\`bash
   gaslens check --baseline ./.gaslens/baseline.json
   \`\`\`
   Enrichi avec : diff structurel + manifest + validate-api + lint-runtime
   + lint-webapp. Si verdict=BREAK, corrige selon les \`fix_hint\` avant de
   continuer.

# Commandes (toutes acceptent --format json|text et --compact)

| Commande | Rôle |
|---|---|
| \`scan <root>\` | Construit l'index. \`--incremental [baseline]\` : fast-path si rien n'a changé (~10× plus rapide) |
| \`map\` | Aperçu compact projet/workspace |
| \`inspect <fn>\` | Tout sur une fonction (signature, callers, contrat) |
| \`impact <fn> --change\` | Régressions potentielles d'une mutation décrite |
| \`diff --from <baseline> --to <current>\` | Compare deux index |
| \`check --baseline\` | Diff + manifest + API + lint runtime + lint webapp |
| \`manifest\` | Croise code ↔ appsscript.json (libs/scopes/services/whitelist) |
| \`validate-api\` | Méthodes GAS hallucinées + arity manquante |
| \`lint-runtime\` | Quota/lock/trigger anti-patterns (warn/info) |
| \`lint-webapp\` | mixed_content / link_target / form_submit (warn) |
| \`emit-dts\` | .d.ts pour \`google.script.run\` côté client |
| \`emit-contract-tests\` | Harnais de test de contrat. \`--runner clasp\` (.gs sandbox) ou \`--runner gas-fakes\` (.mjs local, recommandé V3 §23) |
| \`commands\` | Liste compacte JSON de toutes les commandes |
| \`init\` | Recettes CLAUDE.md / settings.json / skill |
| \`eval\` | Rejoue le dataset de référence (tests d'intégration) |

# Capacités optionnelles hors hook chaud (V3 §22)

Ces commandes ne tournent **jamais** automatiquement dans le hook : elles
sont opt-in, parlent à l'API Google (ADC requis) ou au cache disque, et
peuvent prendre quelques secondes. Utilise-les explicitement quand la
question concerne la prod ou les dépendances externes :

| Commande | Quand l'invoquer |
|---|---|
| \`resolve-live\` | Tu veux savoir si une lib externe (\`OAuth2\`, etc.) est récupérable et comment ses appels résolvent côté lib. Le cache disque \`.gaslens/lib-cache/\` est actif par défaut ; \`--use-apps-script-api\` fetch via l'API ; \`--enrich-output\` produit un WorkspaceIndex enrichi exploitable par \`impact\`/\`check\`. |
| \`prod-truth\` | Tu envisages de supprimer une fonction (« est-elle vraiment morte ? »), ou tu veux savoir laquelle est instable (\`errored\`). \`--use-apps-script-api\` agrège \`processes:listScriptProcesses\` par fonction. Classification : \`confirmed_dead\` / \`dispatched_dynamic\` (NE PAS supprimer) / \`cold_exposed\` / \`errored\` / \`live\`. |
| \`deploy-aware\` | Tu vas toucher \`doGet\`/\`doPost\`/\`onOpen\` — est-ce que ça impacte un déploiement live EN CE MOMENT ? \`--use-apps-script-api\` lit \`projects.deployments\` + \`projects.versions\`. Classification : \`live_web_app\` / \`live_addon\` / \`live_api\` / \`head_only\` / \`unknown\`. |

scriptId résolu automatiquement via \`<root>/.clasp.json\` (sinon
\`--script-id <id>\` ou \`--script-id-map <json>\`).

# Discipline d'honnêteté (lis ceci avant de raisonner)

- \`gaslens\` marque EXPLICITEMENT ce qu'il ne peut pas trancher dans
  \`coverage.unresolved\` et \`coverage.external_boundaries\`. Si la couverture
  < 100 %, vérifie UNIQUEMENT les points listés — pas tout le repo.
- \`break\` (verdict BREAK) est réservé aux régressions **structurellement
  certaines**. Les heuristiques (\`lint-*\`, \`manifest.scope.*\`,
  \`manifest.urlfetch.*\`) sortent en \`warn\`/\`info\` avec \`confidence:
  medium|low\`.
- \`gaslens\` ne voit JAMAIS : régressions sémantiques (champ identique, sens
  changé), code mort réel vs apparent, comportement sous charge.

# Exit codes (scripting, hook, CI)

  0 = CLEAN
  3 = BREAK (régression structurelle — bloque)
  4 = WARN (heuristique — examiner)
  2 = erreur d'outillage (chemin introuvable, JSON cassé, etc.)

# Économie de tokens

- \`--compact\` partout : JSON sans indentation (~30 % tokens en moins).
- \`--format text\` pour \`map\`/\`manifest\`/\`validate-api\`/\`lint-*\` : encore
  plus dense, idéal pour aperçus.
- \`inspect --detail-level summary\` pour une vue minimale ; \`full\` pour tout.
- Plafond \`--max-callers <n>\` sur \`inspect\` pour les fonctions très appelées.

# Erreurs typiques (et leur fix)

- \`index introuvable à ./.gaslens/index.json\` →
  \`gaslens scan <root> -o <root>/.gaslens/index.json\`
- \`La fonction 'X' est introuvable\` → relance avec \`--fuzzy\` pour les
  suggestions de noms proches.
- Workspace ambigu (\`'X' existe dans plusieurs projets\`) → précise
  \`--project <nom>\`.

# Notes de design (V1/V2/V3)

GAS-Lens est conçu comme un **outil pour agent IA**, pas pour humain. Sorties
auto-suffisantes (\`verdict\` + \`summary\` en tête), IDs sémantiques
\`Project::file::fn\`, chemins relatifs + ligne partout. Cœur 100 % statique
et hors-ligne — pas de réseau ni d'auth dans le chemin chaud (V2 §15.2).
`;

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

4. (Optionnel) Installe la Skill pour Claude Code (chargement paresseux,
   zéro coût de schéma quand inutilisée) :
     gaslens init --section skill --write
   → écrit .claude/skills/gaslens/SKILL.md à la racine du repo.

5. (Optionnel) Pour chaque sous-projet, ajoute un CLAUDE.md local (V2 §16.2).
`;

export interface InitWriteResult {
  written: string[];
  skipped: Array<{ path: string; reason: string }>;
}
