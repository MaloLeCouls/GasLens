# GAS-Lens

**Outil CLI d'analyse statique de Google Apps Script, conçu pour être consommé par un agent IA.**

GAS-Lens construit un index sémantique d'un projet GAS (`.gs` + `.html`) et matérialise les coutures que `tsc` ne voit pas — `google.script.run`, scriptlets `<?= … ?>`, triggers par chaîne, clés `PropertiesService`, tableaux 2D `getValues()`, `template.data`, sérialisabilité côté `google.script.run`. Un hook `PostToolUse` Claude Code détecte automatiquement les régressions après chaque édition.

## Pourquoi

Un agent qui modifie une fonction serveur sans savoir que `dashboard.html:17` lit `result.messageId` retirera le champ sans hésiter et cassera silencieusement la web app. GAS-Lens fait le pont sur ces coutures pour qu'un agent puisse **arrêter de tout re-vérifier à la main** sur la classe « ✅ vérifié » et **concentrer son raisonnement** sur ce qui reste vraiment incertain.

Conception complète : [`gas-lens-conception.md`](gas-lens-conception.md) (V1, philosophie + modèle GAS) et [`gas-lens-conception-2-verification-et-agent.md`](gas-lens-conception-2-verification-et-agent.md) (V2, moteur de vérification + intégration agent).

## Installation

```bash
git clone https://github.com/MaloLeCouls/GasLens.git
cd GasLens
npm install
npm run build
```

Bin disponible à `./bin/gaslens.js`. Utiliser `node bin/gaslens.js <cmd>` ou `npm link` pour un alias `gaslens` global.

## Démarrage rapide

```bash
# 1. Indexer le projet
gaslens scan ./mon-projet-gas

# 2. Consulter une fonction avant de la modifier
gaslens inspect sendEmailReport --detail-level full

# 3. Planifier un changement
gaslens impact sendEmailReport --change "change-return-shape:-messageId"

# 4. Vérifier après édition (filet de sécurité)
gaslens check ./mon-projet-gas --baseline ./mon-projet-gas/.gaslens/baseline.json
```

## Boucle agentique automatique (Claude Code)

```bash
gaslens scan ./mon-projet -o ./mon-projet/.gaslens/baseline.json
gaslens init --section settings-json > ./.claude/settings.json
gaslens init --section claude-md         # à coller dans ./CLAUDE.md
```

Chaque édition `.gs`/`.html` par l'agent déclenche `gaslens hook` qui scanne, diff contre la baseline et ré-injecte les BREAKs (avec leurs `fix_hint`) dans la session.

## Vérification côté client par tsc

```bash
gaslens emit-dts -o ./client/gaslens.d.ts
```

Une fois référencé dans le `tsconfig`, `tsc --strict` attrape :
- les typos de noms de fonctions serveur (`.sendEmaiReport(...)`),
- les accès à des champs qui n'existent plus (`result.messageId`),
- les arguments mal typés.

## Catalogue des sous-commandes

| Commande | Rôle |
|---|---|
| `gaslens scan <path>` | Construit l'index (auto-détecte workspace multi-projets) |
| `gaslens inspect <fn>` | Tout savoir avant de modifier une fonction |
| `gaslens impact <fn> --change <spec>` | Planification a priori |
| `gaslens diff --from <idx>` | Compare deux index |
| `gaslens check --baseline <idx>` | Garde-fou (exit 0 / 3 BREAK / 4 WARN) |
| `gaslens hook --event post-tool-use` | Hook PostToolUse (lit stdin JSON) |
| `gaslens emit-dts` | `.d.ts` pour `google.script.run` + tsc |
| `gaslens emit-contract-tests` | Harnais `.gs` sandbox (V2 §12.3) |
| `gaslens eval [<dataset>]` | Rejoue un jeu de tâches de référence |
| `gaslens init --section …` | Recettes prêtes à coller |

## Ce que GAS-Lens couvre

**✅ Vérifié automatiquement — ne plus regrep à la main** :
- call sites internes + cross-projet via préfixes de librairie
- `google.script.run.fn(...)` + champs lus par les `successHandler`
- scriptlets `<? fn() ?>` et `<?= fn() ?>` côté HTML
- `ScriptApp.newTrigger('fnName')` (liens par chaîne)
- clés `PropertiesService` / `CacheService` (R/W + orphelines)
- arité des tableaux 2D `getValues()` (`row[N]`) et des destructurations
- contrats `template.data` ↔ scriptlets
- sérialisabilité des retours franchissant `google.script.run`
- détection de renommage (`body_fingerprint`, façon `git --find-renames`)

**⚠ À la charge de l'agent** :
- régressions sémantiques (même champ, sens changé : unités, statuts, logique métier)
- tout ce qui est listé dans `coverage.unresolved` (dispatch dynamique, `eval`, librairies externes non indexées)
- pertinence métier du changement

## Évaluation

Un dataset de tâches d'éval (`eval/tasks/*.json`) décrit des éditions réalistes et le verdict attendu :

```bash
gaslens eval
# → 7/7 tâches PASS, taux de détection 100 %
```

Ces tâches tournent aussi dans `vitest` — toute régression d'implémentation casse le test correspondant.

## Dev

```bash
npm test            # 165 tests vitest
npm run build       # compile vers dist/
gaslens eval        # régression auto sur le dataset de référence
```

## Stack

Node.js 20+ · TypeScript (`strict`, `noUncheckedIndexedAccess`) · `tree-sitter-javascript` · `commander` · `vitest`. Testé sur Windows / macOS / Linux.
