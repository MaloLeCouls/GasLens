# GAS-Lens

**Analyse statique anti-régression pour Google Apps Script, pensée pour être consommée par un agent IA.**

GAS-Lens indexe ton parc GAS (`.gs` + `.html` + `appsscript.json`) et **matérialise les coutures que `clasp` et `tsc` ne voient pas** : `google.script.run`, scriptlets `<? … ?>`, triggers par chaîne, clés `PropertiesService`, tableaux 2D `getValues()`, sérialisabilité côté client, services avancés et scopes du manifeste. Un hook se branche dans Claude Code (ou tout autre agent) pour bloquer toute régression structurelle dès qu'elle apparaît.

100 % statique, 100 % local, hors-ligne, **instantané** (~40 ms sur un petit projet, fast-path incrémental ×13 dès qu'on a un baseline).

---

## Pourquoi

Imagine un agent qui édite `sendEmailReport` et retire le champ `messageId` de la valeur de retour. Pour `tsc`, ça passe : aucun `.ts` n'importe cette fonction. Pour `clasp push`, ça passe : aucune erreur de syntaxe. Pour toi, ça casse — parce que `dashboard.html:24` fait `result.messageId` côté `successHandler`. Tu ne le verras qu'à l'usage, après déploiement.

GAS-Lens **voit cette couture**. À chaque édition, il vérifie :

- chaque champ retourné par une fonction serveur, croisé avec ce que les `successHandler` côté HTML lisent,
- chaque `ScriptApp.newTrigger('runJob')` croisé avec l'existence de `runJob`,
- chaque `SpreadsheetApp.getRange(...).getValuesAll()` (méthode hallucinée — la vraie c'est `getValues`),
- chaque `setProperty('LAST_RUN')` (oublié l'argument `value`),
- chaque librairie utilisée vs déclarée dans `appsscript.json`,
- chaque `setValue()` glissé dans une boucle (quota épuisé en quelques secondes),
- chaque `<a href>` sans `target="_top"` (clic bloqué par l'iframe de la web app)…

Doctrine : **`break` est sacré, réservé aux régressions structurellement certaines**. Heuristiques en `warn`/`info`. Tout ce qui n'est pas tranchable atterrit honnêtement dans `coverage.unresolved` — l'outil ne bluffe jamais.

---

## Installation

```bash
git clone https://github.com/MaloLeCouls/GasLens.git
cd GasLens
npm install
npm run build
```

Binaires disponibles à `./bin/gaslens.js` et `./bin/gaslens-mcp.js`. `npm link` pour avoir les alias `gaslens` / `gaslens-mcp` globaux.

Prérequis : Node.js 20+. Aucun token, aucune API à activer, aucun déploiement nécessaire.

---

## Démarrage rapide

```bash
# 1. Indexe le projet (auto-détecte workspace multi-projets via appsscript.json).
gaslens scan ./mon-projet -o ./mon-projet/.gaslens/baseline.json

# 2. Lis la carte du projet (300 tokens) AVANT de toucher au code.
gaslens map --index-path ./mon-projet/.gaslens/baseline.json --format text

# 3. Avant de modifier une fonction, regarde ses callers / contrat.
gaslens inspect sendEmailReport --detail-level full

# 4. Vérifie l'impact d'une mutation envisagée.
gaslens impact sendEmailReport --change 'change-return-shape:-messageId,+ok'

# 5. Après édition, vérifie que rien n'est cassé.
gaslens check ./mon-projet --baseline ./mon-projet/.gaslens/baseline.json
```

Exit codes : `0` CLEAN · `3` BREAK · `4` WARN · `2` erreur d'outillage.

---

## Catalogue des commandes

| Commande | Rôle |
|---|---|
| `gaslens scan <root>` | Construit l'index. `--incremental [baseline]` saute les fichiers inchangés (×5–13 plus rapide) |
| `gaslens map` | Aperçu compact projet/workspace (~300 tokens) — table des matières pour l'agent |
| `gaslens inspect <fn>` | Signature, callers, callees, contrat de retour inféré, coverage |
| `gaslens impact <fn> --change <dsl>` | Régressions potentielles d'une mutation décrite |
| `gaslens diff --from <idx> --to <idx>` | Compare deux index, change set sémantique dérivé |
| `gaslens check --baseline <idx>` | Diff + manifest + validate-api + lint-runtime + lint-webapp |
| `gaslens manifest` | Croise code ↔ `appsscript.json` : libs/scopes/services avancés/`urlFetchWhitelist` |
| `gaslens validate-api` | Méthodes GAS hallucinées + arity manquante + méthodes dépréciées |
| `gaslens lint-runtime` | Anti-patterns quota/lock/trigger (warn/info) |
| `gaslens lint-webapp` | `mixed_content` / `link_target` / `form_submit` sur les `.html` servis |
| `gaslens resolve-live` | Inventaire des libs (`local` / `external_*` / `declared_unused`). Cache disque + `--use-apps-script-api` + `--enrich-output` pour fusionner les libs dans le WorkspaceIndex |
| `gaslens prod-truth` | Croise expositions × métriques prod (`confirmed_dead` / `errored` / `dispatched_dynamic`). `--use-apps-script-api` agrège `processes:listScriptProcesses` |
| `gaslens deploy-aware` | Conscience des déploiements (`live_web_app` / `live_addon` / `live_api` / `head_only`). `--use-apps-script-api` lit `projects.deployments` + `projects.versions` |
| `gaslens emit-dts` | `.d.ts` pour `google.script.run` côté client (pont vers `tsc`) |
| `gaslens emit-contract-tests` | Harnais `.gs` de test de contrat (sandbox uniquement — effets de bord réels) |
| `gaslens commands` | Liste compacte des commandes (utile pour un agent qui découvre l'outil) |
| `gaslens init --section <name>` | Recettes prêtes à coller (CLAUDE.md / settings.json / SKILL.md) |
| `gaslens hook --event post-tool-use` | Hook PostToolUse Claude Code (lit le payload sur stdin) |
| `gaslens eval` | Rejoue le dataset de tâches de référence (régression auto) |

Toutes les commandes acceptent `--format json|text` et `--compact` (JSON sans indentation — ~30 % de tokens en moins, idéal pour la consommation par un agent IA).

---

## Ce que GAS-Lens vérifie

### ✅ Régressions structurelles (verdict BREAK)

- **Callers internes** : signature, arité, nullabilité — tout `caller_function(args)` confronté à la définition courante.
- **Coutures client↔serveur** : `google.script.run.fn(...)` ↔ champs lus par `successHandler` ↔ retour réel de `fn`. Si le retour perd un champ que le handler lit, `BREAK`.
- **Sérialisabilité** : un retour contenant `new MyClass()` (autre que `Date`) ne franchit pas `google.script.run` → `BREAK`.
- **Scriptlets** : `<?= fn() ?>` est un call site. Renommer `fn` casse le template silencieusement.
- **Triggers par chaîne** : `ScriptApp.newTrigger('runJob')` vérifié contre l'existence de `runJob`.
- **Librairies inter-projets** : préfixes déclarés dans `appsscript.json` croisés avec les appels `Lib.fn()` ; manquant = `BREAK`.
- **Services avancés** : `Drive.Files.list()` sans entrée dans `enabledAdvancedServices` = `BREAK` (= `ReferenceError` à l'exécution).
- **Méthodes API hallucinées** : `range.getValuesAll()` → suggère `getValues`. Registre curé contre `@types/google-apps-script`.
- **Arity** : `Properties.setProperty('LAST_RUN')` (1 arg, attendu 2) = `BREAK`. Conservatif : seules les méthodes à arité non ambiguë sont vérifiées (les overloads comme `getRange(...)` restent en silencieux).
- **Renommage** : détection par empreinte du corps (`body_fingerprint`, façon `git --find-renames`) — pas vu comme « supprimée + ajoutée ».

### ⚠ Heuristiques (verdict WARN/INFO)

- **`manifest.scope.*`** : code utilise `GmailApp.sendEmail` mais `oauthScopes` est explicite et ne couvre pas Gmail. Silencieux quand l'auto-détection Google joue.
- **`manifest.urlfetch.*`** : `UrlFetchApp.fetch('https://api.x')` vs `urlFetchWhitelist`.
- **`api.deprecated`** : usages `Utilities.jsonParse` / `Utilities.jsonStringify` (préférer JSON natif sous V8).
- **`lint-runtime`** : `setValue/getValue/appendRow` dans une boucle ; `UrlFetchApp.fetch` dans une boucle (préférer `fetchAll`) ; `LockService.waitLock` sans `releaseLock` dans un `finally` ; `newTrigger().create()` sans `deleteTrigger` ailleurs dans le projet.
- **`lint-webapp`** : `<script src="http://...">` (bloqué par le sandbox HTTPS) ; `<a href>` sans `target="_top"` (clic bloqué dans l'iframe) ; `<form>` avec `<button type="submit">` sans `preventDefault`.

### ⚠ Ce que GAS-Lens NE peut PAS voir (à toi de juger)

- **Régressions sémantiques** : même nom de champ, sens changé (unités, statuts, logique métier).
- **Dispatch dynamique** : `handlers[name](payload)` — l'outil le marque honnêtement dans `coverage.unresolved`.
- **Bugs sous charge** : récursion de triggers, contention LockService, dépassement 6 min — repérés statiquement comme heuristiques, confirmés seulement à l'exécution.
- **Librairies externes non indexées** : marquées `coverage.external_boundaries`.

**Règle d'or** : quand la couverture est < 100 %, vérifie UNIQUEMENT les points listés dans `coverage.unresolved` — pas tout le repo.

---

## Boucle agentique automatique

### Claude Code (recommandé)

```bash
# 1. Baseline initial.
gaslens scan ./mon-projet -o ./mon-projet/.gaslens/baseline.json

# 2. Hook PostToolUse (relance check à chaque édition .gs/.html).
gaslens init --section settings-json --write

# 3. Brief CLAUDE.md (contrat de confiance avec l'agent).
gaslens init --section claude-md --write

# 4. Skill Claude Code (chargement paresseux — l'agent y accède à la demande).
gaslens init --section skill --write
```

À chaque `Write`/`Edit`/`MultiEdit` sur un `.gs`/`.html`, le hook lance `gaslens check`. Si BREAK : Claude Code reçoit un `{decision:"block", reason:"…"}` qui ré-injecte la régression dans la boucle de raisonnement, avec les `fix_hint` actionnables.

Le hook utilise automatiquement le **scan incrémental** — l'overhead par édition est typiquement de quelques ms.

### Autres agents (Cursor, etc.) — serveur MCP

```bash
node bin/gaslens-mcp.js   # serveur stdio JSON-RPC
```

Dans `.mcp.json` (ou équivalent côté client) :

```json
{
  "mcpServers": {
    "gaslens": { "command": "node", "args": ["./bin/gaslens-mcp.js"] }
  }
}
```

Quatre outils consolidés exposés (doctrine « peu d'outils à fort impact ») : `gaslens_map`, `gaslens_inspect`, `gaslens_impact`, `gaslens_check`.

---

## Vérification côté client par `tsc`

Si tu fais éditer ton HTML côté client en TypeScript (via `clasp` + `esbuild`, par exemple) :

```bash
gaslens emit-dts -o ./client/gaslens.d.ts
```

Une fois référencé dans le `tsconfig`, `tsc --strict` attrape :

- les typos de noms de fonctions serveur (`google.script.run.sendEmaiReport(...)`),
- les accès à des champs qui n'existent plus (`result.messageId`),
- les arguments mal typés.

C'est le complément côté client de `validate-api` (qui couvre le code serveur).

---

## Workspace multi-projets

Tu as un monorepo avec plusieurs projets GAS qui se référencent via librairies ?

```bash
gaslens scan ./monorepo   # auto-détecte tous les appsscript.json
```

Les appels `CommonUtils.formatDate(...)` depuis `AppA` sont résolus vers la fonction réelle de `CommonUtils`, avec `caller_project` correctement renseigné et `cross_project_edges` exposés. `gaslens check` propage les régressions cross-projet.

Pour cibler un sous-projet : `--project <nom>` sur les commandes consommatrices.

### Librairies externes (V3 §22.1)

Quand une lib n'est pas dans le workspace (ex: `OAuth2` mainteint hors-monorepo) :

```bash
# Audit local — inventaire honnête sans réseau.
gaslens resolve-live --index-path ./.gaslens/index.json

# Récupère la source via Apps Script API (ADC : `gcloud auth application-default login`).
gaslens resolve-live --use-apps-script-api

# Cache disque (`.gaslens/lib-cache/<scriptId>/<version>/`) actif par défaut :
# les runs suivants servent depuis le cache, sans réseau.
gaslens resolve-live --refresh           # force le re-fetch
gaslens resolve-live --no-cache          # désactive lecture+écriture

# Enrichit le WorkspaceIndex avec les libs récupérées, exploitable par impact/check.
gaslens resolve-live --use-apps-script-api --enrich-output ./.gaslens/index.enriched.json
```

Strictement opt-in, **hors hook chaud** — la doctrine V3 §22 exige que ces capacités API ne s'invitent jamais dans `check`.

### Vérité d'exécution (V3 §22.2)

Pour distinguer `confirmed_dead` (à supprimer) de `dispatched_dynamic` (NE PAS supprimer — appelée par un chemin invisible au statique) :

```bash
# Audit local — tout en 'unknown' (inventaire de la surface).
gaslens prod-truth --index-path ./.gaslens/index.json

# Branche le provider Apps Script API (scope `script.processes`).
# scriptId résolu automatiquement depuis <root>/.clasp.json.
gaslens prod-truth --use-apps-script-api --window-days 30

# Workspace multi-projets : map projet → scriptId explicite.
gaslens prod-truth --use-apps-script-api --script-id-map '{"AppA":"sid-a","AppB":"sid-b"}'
```

Sortie : `confirmed_dead` / `dispatched_dynamic` / `cold_exposed` / `errored` / `live` / `unknown` par fonction, avec advice actionnables. Jamais bloquant — consultatif uniquement.

### Conscience des déploiements (V3 §22.3)

Pour savoir si `doGet` sert une web app live **en ce moment** (et donc qu'éditer sa signature est critique immédiat) :

```bash
# Audit local — tout en 'unknown' (inventaire de la surface).
gaslens deploy-aware --index-path ./.gaslens/index.json

# Branche le provider Apps Script API (scope `script.deployments.readonly`).
gaslens deploy-aware --use-apps-script-api

# Workspace : map projet → scriptId explicite (override .clasp.json).
gaslens deploy-aware --use-apps-script-api --script-id-map '{"AppA":"sid-a"}'
```

Sortie : annotations `live_web_app` / `live_addon` / `live_api` / `head_only` / `unknown` par fonction, plus détection de **version drift** (un déploiement live qui pointe sur une version antérieure à la dernière publiée — utile pour distinguer « édité en HEAD » de « édité + déployé »). Strictement consultatif, jamais bloquant.

---

## Performance

Sur un petit projet (7 fichiers, 23 fonctions) :

| Cas | Temps |
|---|---|
| Full scan (initial baseline) | ~40 ms |
| Fast-path incrémental (rien changé) | ~3 ms (×13) |
| Partial-per-file (1 fichier modifié) | ~8 ms (×5) |

`gaslens scan --bench` affiche le breakdown des phases sur `stderr`. Sur de plus gros projets, le gain incrémental est proportionnel au ratio fichiers inchangés / total.

L'incrémental garantit **correctness > perf** : tout changement détecté incertain (HTML modifié, `appsscript.json` modifié) déclenche un full scan. Pas de faux positif.

---

## Évaluation

`eval/tasks/*.json` contient un dataset de tâches : chacune décrit une mutation réaliste (retrait d'un champ, renommage, méthode hallucinée, scope manquant…) et le verdict attendu.

```bash
gaslens eval
# → 15/15 tâches PASS, taux de détection 100 %
```

Toute régression de détection casse une tâche → le test vitest correspondant échoue. Discipline : **chaque nouvelle règle s'accompagne d'au moins une tâche d'éval + un test unitaire**.

---

## Dev

```bash
npm test            # vitest run — 335 tests
npm run build       # tsc → dist/
gaslens eval        # régression sur le dataset de référence
```

Conception complète :
- [`gas-lens-conception.md`](gas-lens-conception.md) (V1, philosophie + modèle GAS)
- [`gas-lens-conception-2-verification-et-agent.md`](gas-lens-conception-2-verification-et-agent.md) (V2, moteur de vérification + intégration agent)
- [`gas-lens-conception-3-usages-agent-et-extensions.md`](gas-lens-conception-3-usages-agent-et-extensions.md) (V3, usages agent + extensions)
- [`CLAUDE.md`](CLAUDE.md) (index opérationnel)

---

## Stack

Node.js 20+ · TypeScript (`strict`, `noUncheckedIndexedAccess`) · [`tree-sitter-javascript`](https://github.com/tree-sitter/tree-sitter-javascript) · `commander` · `vitest`. MCP server via [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk). Testé sur Windows / macOS / Linux.

Pas de réseau, pas d'auth, pas de déploiement nécessaire — tout le cœur tourne hors-ligne.
