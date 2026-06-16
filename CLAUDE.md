<!-- CLAUDE.md — guide de développement de GAS-Lens (l'outil lui-même).
     Ne PAS confondre avec le CLAUDE.md généré par `gaslens init` (V2 §16),
     qui sert aux utilisateurs sur LEURS repos GAS. Celui-ci gouverne le dev DU repo GasLens.
     Garder ce fichier < ~200 lignes : au-delà, l'adhérence de l'agent baisse (cf. V2 §16). -->

# GAS-Lens — guide de développement (pour Claude Code)

Outil CLI d'analyse statique de Google Apps Script **conçu pour être consommé par un agent IA**.
Il indexe un parc GAS (`.gs` + `.html` + `appsscript.json`) et matérialise les *coutures* que
`tsc` ne voit pas (`google.script.run`, scriptlets, triggers/clés par chaîne, tableaux 2D,
`template.data`, sérialisabilité), puis vérifie automatiquement les régressions après chaque édition.

**La source de vérité conceptuelle, ce sont les trois volumes** — les lire avant toute décision de design :
- `gas-lens-conception.md` (V1) : philosophie outil-pour-agent, modèle GAS, `scan`/`inspect`/`search`/`impact`.
- `gas-lens-conception-2-verification-et-agent.md` (V2) : `diff`/`check`, moteur de *shapes*, hooks, pièges de correction.
- `gas-lens-conception-3-usages-agent-et-extensions.md` (V3) : familles d'usage, trous à tokens, capacités à venir, priorisation.

Quand le code et un volume divergent, **le code fait foi pour le comportement, les volumes pour l'intention** ; signaler la divergence plutôt que la laisser.

---

## Invariants NON négociables (ne jamais régresser)

1. **Statique, local, sans effet de bord, et rapide.** Le cœur tourne hors-ligne, instantanément, à chaque édition (il est câblé dans un hook `PostToolUse`). Aucune dépendance réseau / auth / exécution dans le chemin chaud. Toute capacité qui touche au réseau ou aux API Google (V3 §22) est **optionnelle, explicite, et hors hook**.
2. **Honnêteté de la couverture.** Ce que l'analyse ne peut pas trancher part EXPLICITEMENT dans `coverage.unresolved` / `external_boundaries`, avec localisation + raison. Ne jamais bluffer une certitude. C'est ce qui rend l'outil fiable pour un agent.
3. **`break` est sacré.** Réservé aux régressions *structurelles certaines* (champ retiré lu ailleurs, arité, sérialisabilité…). Les heuristiques (lints quota/web app) sortent en `warn`/`info` avec `confidence: medium|low`. Ne jamais diluer le signal `break`.
4. **Sorties auto-suffisantes, info importante en tête.** JSON structuré, `verdict` + `summary` d'abord (V2 §9.3). Chemins relatifs + ligne partout. IDs sémantiques `Project::file::fn`, jamais de hash opaque côté sortie.
5. **Erreurs pédagogiques.** Pas de code nu : nom introuvable → suggérer les noms proches + `--fuzzy` (V1 §Principe 6).
6. **Discipline d'éval.** Toute nouvelle détection s'accompagne d'une tâche dans `eval/tasks/*.json` ET d'un test vitest. `gaslens eval` doit rester à 100 %.

---

## Carte du repo

```
bin/gaslens.js                 launcher (appelle le main compilé)
src/
  cli.ts        (~880)         câblage commander : 1 sous-commande = 1 bloc .command()
  scanner.ts    (~918)         orchestration : scanProject / scanWorkspace → index
  parser.ts                    init tree-sitter (tree-sitter + tree-sitter-javascript)
  types.ts      (~299)         modèle de données (FunctionRecord, Coverage, ProjectIndex…) ; miroir de V2 §14
  findings.ts                  monnaie commune : Severity, Confidence, ConsumerKind, Finding, ImpactReport
  extract/                     EXTRACTEURS (un fichier = un patron) :
    definitions.ts             défs de fonctions + params + visibilité (_ = private)
    calls.ts                   call sites internes
    exposures.ts               doGet/doPost, triggers, exposition client
    google-script-run.ts       le pont client→serveur (+ withSuccessHandler/withUserObject, V2 §13.3)
    html.ts                    parsing .html + scriptlets <? ?> / <?= ?> / <?!= ?>
    jsdoc.ts                   @param/@returns
    gas-patterns.ts (~347)     tableaux 2D getValues(), destructuration, template.data, clés Properties
    handler-shapes.ts          shape lue par les successHandler
    return-analysis.ts         shape de retour, nullabilité, sérialisabilité
    api-chains.ts              chaînes d'appels Service.m1().m2()… (alimente validate-api)
    runtime-patterns.ts        signaux pour lint-runtime (calls dans boucles, lock/finally, trigger create/delete)
    html-webapp.ts             signaux pour lint-webapp (refs http://, <a> sans target, <form> sans preventDefault, <base target>)
    uncertainty.ts             alimente coverage (dispatch dynamique, etc.)
  inspect.ts / impact.ts / diff.ts / check.ts / hook.ts    les commandes
  map.ts                       table des matières compacte (V3 §21.5) — projection seule de l'index
  manifest.ts                  parse complet d'appsscript.json (scopes, libs, advanced services, whitelist)
  manifest-analysis.ts         croise code ↔ manifeste (V3 §21.1) : library.undeclared/.unused, advanced_service.missing/.unused, scope.missing/.unused, urlfetch.not_whitelisted
  scopes.ts                    table service GAS → scope(s) OAuth (Gmail/Drive/Spreadsheets/Calendar/UrlFetchApp/Session/…)
  validate-api.ts              valide les chaînes d'appels GAS contre gas-api.ts (V3 §21.2) : api.unknown_method + suggestions fuzzy
  gas-api.ts                   registre curé Service→Method→ReturnType pour ~15 services natifs (source: doc + @types/google-apps-script) ; couche d'arity séparée (GAS_API_ARITY) pour api.wrong_arity
  lint-runtime.ts              lint heuristique GAS-aware (V3 §21.3) : quota.value_in_loop, urlfetch.in_loop, lock.no_finally, trigger.orphan
  lint-webapp.ts               lint des .html servis (V3 §21.4) : webapp.mixed_content, webapp.link_target, webapp.form_submit
  mcp-server.ts                serveur MCP stdio (V3 §24) — 4 outils consolidés (map/inspect/impact/check) ; bin/gaslens-mcp.js launcher
  emit-dts.ts / emit-contract-tests.ts                     ponts vers tsc / tests de contrat
  eval.ts                      rejoue eval/tasks/*.json (inclut findings manifeste + validate-api via enrichWith*Findings)
  init.ts                      recettes CLAUDE.md / settings.json / SKILL.md (V2 §16, V3 §24) — `init --write` écrit aux bons chemins
  stale-check.ts               compare scanned_at à la plus récente mtime des sources ; warn stderr + commande de re-scan
  gas-services.ts              liste de NOMS de services natifs (utilisée par le scanner pour classifier les receivers ; validation par méthode = gas-api.ts)
eval/tasks/*.json              jeu de tâches de référence (édition → verdict attendu)
tests/                         vitest ; fixtures/sample-project + fixtures/sample-workspace
```

**Stack** : Node 20+ · TypeScript `strict` + `noUncheckedIndexedAccess` · `commander` · `tree-sitter` + `tree-sitter-javascript` · `vitest`. Pas d'autre dépendance runtime — rester léger.

---

## Pipeline (mental model)

```
scan  →  extract/* peuplent un FunctionRecord par fonction  →  index (ProjectIndex|WorkspaceIndex)
                                                                   │
   inspect (lire)   impact (intention décrite → graphe inverse)   diff/check (2 états → change set dérivé)
                                                                   │
                                              findings (break/warn/info) + coverage  →  verdict
```
- `impact` part d'une **intention décrite** (DSL `--change`). `check`/`diff` **dérivent** le changement en comparant deux index — pas de description requise (V2 §7).
- L'incrémental doit **re-résoudre les arêtes**, pas seulement re-parser les fichiers modifiés (espace de noms global GAS, V2 §13.1).
- Détection de renommage par `body_fingerprint` (V2 §13.2), sinon `diff` voit « supprimée + ajoutée ».

---

## Boucle de dev

```bash
npm run build        # tsc
npm run dev          # tsc --watch
npm test             # vitest run  (doit rester vert ; ~257 tests)
node bin/gaslens.js eval   # rejoue le dataset de référence ; doit rester à 100 %
```
Toujours : build + test + eval verts avant de considérer une tâche terminée.

---

## Recette : ajouter une détection (le cas le plus fréquent)

1. **Extraire le fait** : nouvel extracteur dans `src/extract/`, branché par `scanner.ts`, stocké dans le `FunctionRecord` (`types.ts`).
2. **Le rendre comparable** : si `diff`/`check` doit le surveiller, ajouter un *delta* dérivé (V2 §9.1) et le câbler dans `diff.ts`.
3. **Émettre un finding** : nouveau `ConsumerKind` dans `findings.ts` + production du `Finding` (sévérité honnête, `fix_hint`, `confidence`).
4. **Couvrir l'incertitude** : ce qui n'est pas résoluble → `coverage.unresolved` via `uncertainty.ts`.
5. **Exposer** (si commande) : bloc `.command()` dans `cli.ts`, paramètres tous documentés + défauts + exemples (V1 §Principe 8).
6. **Prouver** : 1 tâche `eval/tasks/NN-*.json` + 1 test vitest (cas positif ET cas « clean » qui ne doit pas déclencher).

Préférer **étendre** `check` (nouveau `consumer_kind`) plutôt qu'une commande isolée : le hook profite alors automatiquement de la détection.

---

## État courant & prochaines marches (V3, ROI décroissant)

Implémenté : `scan`, `map`, `manifest`, `validate-api`, `lint-runtime`, `lint-webapp`, `inspect`, `impact`, `diff`, `check`, `hook`, `emit-dts`, `emit-contract-tests`, `commands`, `eval`, `init`.

**Ergonomie LLM (V3 §24 + extensions)** :
- `commands` — quick reference compact (~250 tokens) que l'agent peut interroger pour découvrir la surface.
- `init --section skill --write` — installe `.claude/skills/gaslens/SKILL.md` (chargement paresseux, zéro coût tant qu'inutilisé).
- `--compact` sur toutes les commandes read-only — JSON sans indentation, ~30 % tokens en moins.
- Détection d'index stale (`stale-check.ts`) — warning stderr automatique quand une source est plus récente que l'index, avec la commande exacte de re-scan.
- **Serveur MCP** (`bin/gaslens-mcp.js`) — expose 4 outils consolidés (`gaslens_map`, `gaslens_inspect`, `gaslens_impact`, `gaslens_check`) sur stdio. Pour Claude Code, ajouter dans `.mcp.json` : `{"mcpServers":{"gaslens":{"command":"node","args":["./bin/gaslens-mcp.js"]}}}` (ou `npx gaslens-mcp` après publication).

**Perf (fondations + fast-path incrémental)** :
- `ProjectIndex.file_hashes` : sha1 de chaque source (.gs/.html/appsscript.json) stockée dans l'index.
- `ProjectIndex.scan_duration_ms` : timing total du scan.
- `gaslens scan --bench` : breakdown des phases sur stderr (read / parse+extract / rest). Sample-project : 40 ms total (1 read + 21 parse+extract + 18 rest).
- **Fast-path incrémental** (`gaslens scan --incremental [baseline]`) : si aucune source n'a une mtime > baseline.scanned_at ET que l'ensemble des fichiers est identique → retour direct du baseline. **×13 sur le sample-project (40 → 3 ms).** Câblé automatiquement dans le hook PostToolUse (réutilise `.gaslens/baseline.json`).
- **True-incremental partiel** : quand fast-path KO mais que le manifeste est inchangé, on saute le parse + extract des .gs dont le hash matche baseline.file_hashes et on réutilise leurs FunctionRecord + caches per-file (`pending_library_calls_by_file`, `unresolved_calls_by_file`). Contributions HTML des .html inchangés appliquées seulement aux records frais (les cachés les ont déjà). `rebuildCalledByFromOutboundCalls(records)` reconstruit `called_by` proprement (purge entries stales des records cachés). **×5 sur sample-project quand 1 .gs change** (40 → 8 ms).
- **Partial étendu aux .html** : un changement .html est désormais supporté en partial (V3 §21, suite). Mécanique : (a) le scanner classe les .html en `unchanged` / `changed` par hash ; (b) `subtractHtmlContribsFromRecord` retire des records cachés les exposures, `inferred_contract.fields_read` et `unresolved_handlers` provenant des .html changés (via `Exposure.file` / `FieldRead.file` / `unresolved_handlers.where`) ; (c) les .html changés sont ré-extraits frais, leurs contribs ré-appliquées à TOUS les records (cachés + frais) ; les contribs des .html inchangés restent appliquées aux frais seulement. Fallback full scan uniquement si appsscript.json a changé ou si le set des fichiers diffère.
- `FunctionRecord.outbound_calls` : substrat sérialisable du chemin partial.
- Caches per-file dans l'index : `html_contributions`, `pending_library_calls_by_file`, `unresolved_calls_by_file`.

`manifest` (V3 §21.1) — Phases 1 + 2 + 3 livrées : `library.undeclared/.unused`, `advanced_service.missing/.unused` (phase 1, confidence high), `scope.missing/.unused` (WARN/INFO, confidence medium, **silencieux quand `oauthScopes` n'est pas explicite** car l'auto-détection Google joue), `urlfetch.not_whitelisted` (WARN, **silencieux quand `urlFetchWhitelist` est absent**, URLs littérales seulement), `scope.over_broad` (INFO, confidence medium, 2 patterns ultra-prudents : **(A)** `@OnlyCurrentDoc` détecté + scope plein `auth/spreadsheets`/`documents`/`forms`/`presentations` au lieu de `.currentonly` ; **(B)** `MailApp` utilisé seul (pas `GmailApp`) + scope Gmail large déclaré → suggère `script.send_mail`). Câblé dans `check` via `enrichWithManifestFindings` (les INFO restent dans le rapport `manifest` détaillé sans bruiter `check`, par convention). Table service→scope dans `scopes.ts`. Détection `@OnlyCurrentDoc` côté scanner : champ `only_current_doc_files` dans `ProjectIndex`, préservé dans le path incrémental partial.

`validate-api` (V3 §21.2) — Phases 1 + 2 + 3 livrées : `api.unknown_method` (BREAK) + suggestions fuzzy, `api.wrong_arity` (BREAK, seulement « trop peu d'args »), `api.deprecated` (WARN, dépréciations confirmées par la doc Apps Script officielle : `Utilities.jsonParse/jsonStringify` → JSON natif ; `ScriptApp.getProjectKey` → `getScriptId()` ; `User.getUserLoginId` → `user.getEmail()`). Registre curé `gas-api.ts` (~15 services, ~400 méthodes ; couches `GAS_API_ARITY` et `GAS_API_DEPRECATED` séparées et facilement extensibles). Honnête : s'arrête sur les types `unknown`/tableaux, et s'abstient sur les méthodes overloadées. Câblé dans `check` via `enrichWithApiFindings`.

`lint-runtime` (V3 §21.3) — Phase 1 livrée (WARN/INFO, jamais BREAK) : `quota.value_in_loop` (getValue/setValue/appendRow/… dans for/while/forEach/map), `urlfetch.in_loop` (suggère fetchAll), `lock.no_finally` (waitLock/tryLock sans releaseLock dans finally du même scope), `trigger.orphan` (INFO niveau projet — newTrigger().create() sans deleteTrigger). Câblé dans `check` via `enrichWithLintRuntimeFindings`. **Restent** : `longrun.no_state` (heuristique 6 min, peu net pour V1).

`lint-webapp` (V3 §21.4) — Phase 1 livrée (WARN, confidence high/medium) : `webapp.mixed_content` (http:// dans tags script/link/img/iframe/source/video/audio + fetch/XHR/img.src côté JS client), `webapp.link_target` (`<a href>` de navigation sans target=, silencieux si `<base target="_top">` global), `webapp.form_submit` (`<form>` avec input/button submit sans `preventDefault`/`return false`). Câblé dans `check` via `enrichWithLintWebappFindings`. **Restent** : `webapp.run_out_of_context` (vague pour V1).

À construire (détail + intérêt dans V3) :
- Optionnels API (V3 §22, hors hook) : `resolve-live` (libs externes via Apps Script API), `prod-truth` (getMetrics/processes).
- `emit-contract-tests --runner gas-fakes` (V3 §23).
- Étendre `GAS_API_DEPRECATED` au fil des observations terrain (Ui.showDialog + ScriptProperties/UserProperties demandent d'ajouter les roots Ui/ScriptProperties au registre GAS_API).

---

## Pièges à ne jamais réintroduire (V2 §13)

- Espace de noms **global** par projet : `foo()` dans `fileA.gs` résout vers `function foo` de `fileB.gs`. L'incrémental doit re-résoudre.
- `withUserObject(ctx)` **décale** les args du handler (`(retourServeur, userObject)`) — ne pas prendre `userObject` pour la shape de retour.
- Les **scriptlets** `<?= fn() ?>` sont des call sites : un `check` qui les rate dit `CLEAN` à tort.
- `google.script.run` : retour **non sérialisable** = bug latent (`serializable.broke`), pas une erreur d'analyse.

---

## Tenir ce fichier à jour

À chaque ajout/changement de commande, de `consumer_kind`, de dépendance ou d'invariant : **mettre à jour ce fichier dans le même commit** (carte du repo, état courant, recette). Si une section dépasse l'utile, élaguer plutôt qu'empiler — la concision est une feature (cf. en-tête). Les volumes V1/V2/V3 restent la référence longue ; ce fichier n'en est que l'index opérationnel.
