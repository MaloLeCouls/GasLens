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
- `gas-lens-conception-4-conventions-et-articulation.md` (V4) : conventions JSDoc agent (`doc`), écosystème cerveau/mains/yeux, **2 axes d'environnement** (`env`).
- `gas-lens-conception-5-installation-et-packaging.md` (V5) : 2 canaux (npm `@malolecouls/gaslens` + **plugin Claude Code**), `workspace init`, `doctor`.

`ROADMAP.md` (racine) trace l'implémentation des LOTs A→E (analyses V4, packaging V5, durcissement multi-repo).

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
  guard.ts                     `guard --event pre-tool-use` — garde-fou déterministe (G3) : bloque un clasp push/deploy vers un projet prod si env validate est BREAK ; calque hook.ts (lit stdin)
  map.ts                       table des matières compacte (V3 §21.5) — projection seule de l'index
  manifest.ts                  parse complet d'appsscript.json (scopes, libs, advanced services, whitelist)
  manifest-analysis.ts         croise code ↔ manifeste (V3 §21.1) : library.undeclared/.unused, advanced_service.missing/.unused, scope.missing/.unused, urlfetch.not_whitelisted
  scopes.ts                    table service GAS → scope(s) OAuth (Gmail/Drive/Spreadsheets/Calendar/UrlFetchApp/Session/…)
  validate-api.ts              valide les chaînes d'appels GAS contre gas-api.ts (V3 §21.2) : api.unknown_method + suggestions fuzzy
  gas-api.ts                   registre curé Service→Method→ReturnType pour ~15 services natifs (source: doc + @types/google-apps-script) ; couche d'arity séparée (GAS_API_ARITY) pour api.wrong_arity
  lint-runtime.ts              lint heuristique GAS-aware (V3 §21.3) : quota.value_in_loop, urlfetch.in_loop, lock.no_finally, trigger.orphan
  lint-webapp.ts               lint des .html servis (V3 §21.4) : webapp.mixed_content, webapp.link_target, webapp.form_submit
  resolve-live.ts              inventaire des libs (V3 §22.1 phases 1+2+3) ; LibraryFetcher pluggable ; expose fetched_sources
  enrich-workspace.ts          enrichit ProjectIndex/WorkspaceIndex avec les libs récupérées (V3 §22.1 phase 3) ; renameProject ; appelle resolveCrossProjectLinks
  prod-truth.ts                vérité d'exécution (V3 §22.2 phase 1) ; MetricsProvider pluggable
  fetchers/apps-script-api.ts  fetcher Apps Script API (projects.getContent, ADC + fetch natif ; V3 §22.1 phase 2)
  fetchers/lib-cache.ts        cache disque scannable pour LibraryFetcher (V3 §22.1 phase 3) ; --refresh, readOnly
  providers/apps-script-metrics.ts  provider MetricsProvider via processes:listScriptProcesses (V3 §22.2 phase 2) ; pagination + agrégation par function_name + cache mémoire
  providers/apps-script-deployments.ts  provider DeploymentsProvider via projects.deployments + projects.versions (V3 §22.3) ; pagination + cache mémoire par scriptId
  deploy-aware.ts              conscience des déploiements (V3 §22.3) ; live_web_app / live_addon / live_api / head_only ; version drift detection
  script-id.ts                 résolution du scriptId par projet : .clasp.json à la racine + overrides CLI
  mcp-server.ts                serveur MCP stdio (V3 §24) — 4 outils consolidés (map/inspect/impact/check) ; bin/gaslens-mcp.js launcher
  emit-dts.ts / emit-contract-tests.ts                     ponts vers tsc / tests de contrat
  eval.ts                      rejoue eval/tasks/*.json (inclut findings manifeste + validate-api via enrichWith*Findings)
  init.ts                      recettes CLAUDE.md / settings.json / SKILL.md (V2 §16, V3 §24) — `init --write` écrit aux bons chemins
  stale-check.ts               compare scanned_at à la plus récente mtime des sources ; warn stderr + commande de re-scan
  gas-services.ts              liste de NOMS de services natifs (utilisée par le scanner pour classifier les receivers ; validation par méthode = gas-api.ts)
  ── V4 / V5 / multi-repo (LOTs A→E) ──
  workspace-manifest.ts        manifeste maître gaslens.workspace.json (schéma zod + loader + helpers) — source de vérité du parc (V4 §26-29)
  env-validate.ts              `env validate` — 2 axes d'env : env.cross_env_leak / library_version_mismatch / hardcoded_resource / undeclared_resource (V4 §29) / **library_scope_missing** (G1, scopes OAuth requis par la lib absents d'un consommateur à oauthScopes explicite) ; ids en dur via openById/… ET openByUrl (F5a)
  doc-lint.ts                  `doc lint` / `doc stub` — doc.undocumented / doc.param_drift / doc.return_drift / doc.stale_ref (V4 §25, F4) ; réutilise extract/jsdoc.ts (FunctionDoc.returns_desc + refs) + return_analysis.produced_object_fields
  doctor.ts                    `doctor` — prérequis (Node≥22, clasp, ADC, clasp-config↔manifeste, baselines par app, plugin, bibliothèque mère déclarée) ; SessionStart (V5 §34, E3, F-corr B)
  workspace-init.ts            `workspace init` — scaffolder (manifeste, .claude/settings.json, .mcp.json, apps/backlog) + **setup complet G6** (scripts/{push-dev,deploy-prod,run-tests}.sh, .github/workflows/gas-ci.yml, docs/{deploy,scopes}.md) (V5 §33)
  workspace-add-app.ts         `workspace add-app` — onboarde une app (apps[] + apps/<nom>/{dev,prod} + rappel clasp clone) (E4)
  parc-overview.ts             `workspace overview` — vue parc d'un coup (F6) : apps × dev/prod, version lib, verdict env validate par app/env, couverture doc ; `--format registry` = plan de masse REGISTRY.md (G4 : gcp_project_id/exec_url/dev_url/container_id/description/site_embeds) ; réutilise runEnvValidate
  evolution-requests.ts        `request add`/`request list` — canal d'auto-évolution (G0) : l'agent logue ses manques récurrents (.gaslens/evolution-requests.jsonl), dédup par fréquence
.claude-plugin/ skills/ commands/ hooks/ templates/ .mcp.json   FACE PLUGIN Claude Code (V5 §32) — installable via /plugin
scripts/bench-scale.mjs        bench à l'échelle (F3) — parc synthétique, chronométre full/incrémental/env validate/overview (`npm run bench:scale`)
.github/workflows/ci.yml       CI (F1) — build + test + eval sur matrice windows-latest + ubuntu-latest, Node 22
eval/tasks/*.json              jeu de tâches de référence (édition → verdict attendu)
tests/                         vitest ; fixtures/sample-project + fixtures/sample-workspace
```

**Stack** : Node **22+** (requis par chrome-devtools-mcp) · TypeScript `strict` + `noUncheckedIndexedAccess` · `commander` · `zod` (schéma du manifeste maître) · `tree-sitter` + `tree-sitter-javascript` · `vitest`. **`google-auth-library` en `optionalDependencies`** (chargée uniquement par `resolve-live --use-apps-script-api`, via import dynamique). Pas d'autre dépendance runtime — rester léger.

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
npm test             # vitest run  (doit rester vert ; ~440 tests)
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

Implémenté : `scan`, `map`, `manifest`, `validate-api`, `lint-runtime`, `lint-webapp`, `resolve-live`, `prod-truth`, `deploy-aware`, `inspect`, `impact`, `diff`, `check`, `hook`, `emit-dts`, `emit-contract-tests`, `commands`, `eval`, `init`, **`env validate`**, **`doc lint`/`doc stub`**, **`doctor`**, **`workspace init`/`workspace add-app`/`workspace overview`**.

**V4 / V5 / multi-repo (LOTs A→E)** — voir `ROADMAP.md` :
- **`env validate`** (V4 §29) : 2 axes d'environnement. `env.cross_env_leak` (BREAK, le finding-roi : id de ressource d'un autre env en dur), `env.library_version_mismatch` (prod en HEAD / mauvaise version figée), `env.hardcoded_resource` (id du bon env en dur, OU id non déclaré via openById/getFileById — E5), `env.undeclared_resource` (ressource déclarée dans un env mais pas un autre). Lit le manifeste maître ; intégré au pipeline `check`.
- **`doc lint`/`doc stub`** (V4 §25, étendu F4) : `doc.undocumented` (info), `doc.param_drift` (warn), `doc.return_drift` (warn, medium — `@returns` cite un champ backtické que la shape **autoritaire** ne produit plus ; s'abstient si retour opaque), `doc.stale_ref` (info — `{@link}`/`@see` vers un symbole ni du projet, ni service GAS, ni global JS). N'écrit jamais la prose. Extracteur étendu : `FunctionDoc.{returns_desc,refs}` + `ReturnAnalysis.{produced_object_fields,returns_only_object_literals}`.
- **Le hook L1 lance désormais le pipeline `check` COMPLET** (`applyEnrichments` partagé) = diff + manifest + api + lint + **doc** + **env**. Avant E/A4 il ne faisait que le diff structurel — un break manifest/api/env ne bloquait pas. Les 6 `enrichWith*Findings` sont factorisés en `mergeFindings` (F10), façades exportées préservées.
- **Multi-repo (LOT E)** : `scanWorkspace` nomme les projets par **chemin relatif** (`apps/dash/dev`, plus de collision `dev`/`prod` — E1) et lit le manifeste maître pour résoudre les appels `Lib.fn()` inter-repos en `cross_project_edges` **env-aware** (E2, `loadLibraryProviders`). `--project` accepte un suffixe (`dash/dev`).
- **Face plugin** (V5 §32) : `.claude-plugin/{plugin,marketplace}.json`, `skills/` (8, dont `request-evolution` G0), `commands/` (4), `hooks/hooks.json` (**PreToolUse(Bash)→guard** G3, PostToolUse→hook, SessionStart→doctor), `.mcp.json` (chrome-devtools épinglé `@1.3.0`), `templates/`. `package.json` → `@malolecouls/gaslens` (non publié).
- **LOT F (durcissement post-merge)** : `workspace overview` (vue parc F6), `env validate` voit `openByUrl` (F5a), CI matricielle Win+Linux (F1), bench à l'échelle (F3, `npm run bench:scale`), test différentiel incrémental≡full (F2). **F2 a corrigé un vrai bug moteur** (cf. Pièges). Reste F5b (extracteur d'index, non urgent d'après le bench) et F9 (valider le plugin contre le vrai chargeur).

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
- **Fast-path incrémental** (`gaslens scan --incremental [baseline]`) : si l'ensemble des fichiers est identique ET que le **hash de contenu** de chaque source matche `baseline.file_hashes` → retour direct du baseline. **Détection par HASH, pas par mtime** (E2) : le mtime juste après une écriture est non fiable (Windows/NTFS peut renvoyer un mtime périmé → un changement réel raté, hook CLEAN à tort). Un `touch` (mtime avancé, contenu identique) reste un no-op. Câblé automatiquement dans le hook PostToolUse (réutilise `.gaslens/baseline.json`).
- **True-incremental partiel** : quand fast-path KO mais que le manifeste est inchangé, on saute le parse + extract des .gs dont le hash matche baseline.file_hashes et on réutilise leurs FunctionRecord + caches per-file (`pending_library_calls_by_file`, `unresolved_calls_by_file`). Contributions HTML des .html inchangés appliquées seulement aux records frais (les cachés les ont déjà). `rebuildCalledByFromOutboundCalls(records)` reconstruit `called_by` proprement (purge entries stales des records cachés). **×5 sur sample-project quand 1 .gs change** (40 → 8 ms).
- **Partial étendu aux .html** : un changement .html est désormais supporté en partial (V3 §21, suite). Mécanique : (a) le scanner classe les .html en `unchanged` / `changed` par hash ; (b) `subtractHtmlContribsFromRecord` retire des records cachés les exposures, `inferred_contract.fields_read` et `unresolved_handlers` provenant des .html changés (via `Exposure.file` / `FieldRead.file` / `unresolved_handlers.where`) ; (c) les .html changés sont ré-extraits frais, leurs contribs ré-appliquées à TOUS les records (cachés + frais) ; les contribs des .html inchangés restent appliquées aux frais seulement. Fallback full scan uniquement si appsscript.json a changé ou si le set des fichiers diffère.
- `FunctionRecord.outbound_calls` : substrat sérialisable du chemin partial.
- Caches per-file dans l'index : `html_contributions`, `pending_library_calls_by_file`, `unresolved_calls_by_file`.

`manifest` (V3 §21.1) — Phases 1 + 2 + 3 livrées : `library.undeclared/.unused`, `advanced_service.missing/.unused` (phase 1, confidence high), `scope.missing/.unused` (WARN/INFO, confidence medium, **silencieux quand `oauthScopes` n'est pas explicite** car l'auto-détection Google joue), `urlfetch.not_whitelisted` (WARN, **silencieux quand `urlFetchWhitelist` est absent**, URLs littérales seulement), `scope.over_broad` (INFO, confidence medium, 2 patterns ultra-prudents : **(A)** `@OnlyCurrentDoc` détecté + scope plein `auth/spreadsheets`/`documents`/`forms`/`presentations` au lieu de `.currentonly` ; **(B)** `MailApp` utilisé seul (pas `GmailApp`) + scope Gmail large déclaré → suggère `script.send_mail`). Câblé dans `check` via `enrichWithManifestFindings` (les INFO restent dans le rapport `manifest` détaillé sans bruiter `check`, par convention). Table service→scope dans `scopes.ts`. Détection `@OnlyCurrentDoc` côté scanner : champ `only_current_doc_files` dans `ProjectIndex`, préservé dans le path incrémental partial.

`validate-api` (V3 §21.2) — Phases 1 + 2 + 3 livrées : `api.unknown_method` (BREAK) + suggestions fuzzy, `api.wrong_arity` (BREAK, seulement « trop peu d'args »), `api.deprecated` (WARN, dépréciations confirmées par la doc Apps Script officielle : `Utilities.jsonParse/jsonStringify` → JSON natif ; `ScriptApp.getProjectKey` → `getScriptId()` ; `User.getUserLoginId` → `user.getEmail()` ; `Ui.showDialog` → `showModalDialog`/`showModelessDialog` ; **services top-level `ScriptProperties` et `UserProperties`** entièrement dépréciés via wildcard `*` → `PropertiesService.getScriptProperties()` / `.getUserProperties()`). Registre curé `gas-api.ts` (couches `GAS_API_ARITY` et `GAS_API_DEPRECATED` séparées et facilement extensibles ; `getMethodDeprecation` supporte le wildcard `*` pour les services entièrement dépréciés). Honnête : s'arrête sur les types `unknown`/tableaux, et s'abstient sur les méthodes overloadées. Câblé dans `check` via `enrichWithApiFindings`.

`lint-runtime` (V3 §21.3) — Phase 1 livrée (WARN/INFO, jamais BREAK) : `quota.value_in_loop` (getValue/setValue/appendRow/… dans for/while/forEach/map), `urlfetch.in_loop` (suggère fetchAll), `lock.no_finally` (waitLock/tryLock sans releaseLock dans finally du même scope), `trigger.orphan` (INFO niveau projet — newTrigger().create() sans deleteTrigger), **`perf.library_chatty_ui`** (INFO niveau projet, G5 — lib GAS consommée + ≥3 call sites google.script.run → coût de démarrage). Câblé dans `check` via `enrichWithLintRuntimeFindings`. **Restent** : `longrun.no_state` (heuristique 6 min, peu net pour V1).

`lint-webapp` (V3 §21.4) — Phase 1 livrée (WARN, confidence high/medium) : `webapp.mixed_content` (http:// dans tags script/link/img/iframe/source/video/audio + fetch/XHR/img.src côté JS client), `webapp.link_target` (`<a href>` de navigation sans target=, silencieux si `<base target="_top">` global), `webapp.form_submit` (`<form>` avec input/button submit sans `preventDefault`/`return false`), **`webapp.xframe_missing`** (G2 — doGet/doPost renvoyant du HTML sans `setXFrameOptionsMode(ALLOWALL)` → iframe Google Site refusée ; signal intrinsèque `FunctionRecord.webapp_html` via `extract/webapp-html.ts`. **INFO par défaut** car on ne sait pas statiquement si la webapp est embarquée ; élevé à **WARN** via `lintWebapp(idx, {embeddedInSite})` quand le registre G4 déclare un embed Site). Câblé dans `check` via `enrichWithLintWebappFindings`. **Restent** : `webapp.run_out_of_context` (vague pour V1).

`resolve-live` (V3 §22.1) — Phases 1 + 2 + 3 livrées :
- **Phase 1** : croise `manifest.libraries` × workspace × `receiver_usage` et classe chaque lib en `local` / `external_unfetched` / `external_resolved` / `external_unresolvable` / `declared_unused`. **Interface `LibraryFetcher` pluggable** (default `NoopFetcher` qui renvoie null — audit local sans réseau ni auth).
- **Phase 2** : `createAppsScriptApiFetcher` (`src/fetchers/apps-script-api.ts`) implémente le fetcher via `projects.getContent` de l'API Apps Script. ADC par défaut (`google-auth-library` chargée en **import dynamique** depuis `optionalDependencies` — coût zéro tant que la commande n'est pas invoquée). 403/404 → null (frontière honnête : container-bound, scope manquant, droits absents). Cache mémoire `${scriptId}#${version}`. Activation explicite via `gaslens resolve-live --use-apps-script-api`. `getAccessToken` injectable pour les tests (in-process http.createServer + token bouchon).
- **Phase 3** : `createDiskCachedFetcher` (`src/fetchers/lib-cache.ts`) wrap n'importe quel `LibraryFetcher` avec un cache disque scannable. Layout : `<cacheDir>/<scriptId>/<version|HEAD>/` (matérialise chaque fichier comme `.gs` / `.html` / `appsscript.json` + `__gaslens_meta.json`). Activé par défaut côté CLI ; `--no-cache` le coupe, `--refresh` force le re-fetch + écrase. Cohérent : sans `--use-apps-script-api`, le cache disque sert seul (audit local hors-ligne, lecture si déjà fetché auparavant). `enrichWorkspaceWithLibraries` (`src/enrich-workspace.ts`) consomme `ResolveLiveReport.fetched_sources`, scanne les libs matérialisées via `scanProject`, les renomme d'après leur `user_symbol` consommateur, et reéexécute `resolveCrossProjectLinks` sur l'ensemble pour produire un `WorkspaceIndex` exploitable par `impact`/`inspect`/`check`. Activation : `--enrich-output <path>`.

Production de `advice` actionnables. Optionnel, **strictement hors hook chaud** (la doctrine V3 §22 exige que ces capacités API ne s'invitent jamais dans `check`).

`prod-truth` (V3 §22.2) — Phases 1 + 2 livrées :
- **Phase 1** : croise les expositions statiques (`exposures` + `called_by`) avec les métriques prod (`executions_count`, `error_rate`, `last_execution_at`) pour annoter chaque fonction d'un `cross_status` parmi `confirmed_dead` / `dispatched_dynamic` / `cold_exposed` / `errored` / `live` / `unknown`, et d'un `heat` parmi `hot|warm|cold|unknown`. **Interface `MetricsProvider` pluggable** (default `NoopMetricsProvider` qui renvoie `[]` — tout est alors `unknown`, et la commande sert d'inventaire de la surface à enrichir). Provider en erreur dégrade silencieusement en `unknown` (consultatif, jamais bloquant). Production d'`advice` actionnables (`NE PAS supprimer` sur dispatched_dynamic, etc.).
- **Phase 2** : `createAppsScriptMetricsProvider` (`src/providers/apps-script-metrics.ts`) implémente le provider via `processes:listScriptProcesses`. Stratégie : 1 appel API par `scriptId` × fenêtre (pas un par fonction — pagination + agrégation client), classification des `processStatus` (FAILED + TIMED_OUT → `error_count`), `last_execution_at` = max start time. Cache mémoire keyé par `scriptId#window_days`. `max_pages` (défaut 20, ≈ 1000 processes) avec flag `FunctionMetrics.truncated` quand on coupe avant la fin. ADC via `google-auth-library` (import dynamique depuis `optionalDependencies`, scope `script.processes`) ; `getAccessToken` injectable pour les tests (mock server). Résolution `scriptId` (`src/script-id.ts`) : lit `.clasp.json` à la racine projet par défaut, supporte les overrides CLI `--script-id` (mono-projet) et `--script-id-map <json>` (workspace). Activation : `gaslens prod-truth --use-apps-script-api`.

Strictement hors hook chaud (la doctrine V3 §22 exige que ces capacités API ne s'invitent jamais dans `check`).

`deploy-aware` (V3 §22.3) — Phases 1 + 2 livrées :
- **Phase 1** : croise les expositions statiques (`doGet`/`doPost`/`onOpen`/`onInstall`/…) avec `projects.deployments.list` et `projects.versions.list` pour annoter chaque fonction d'un `deployment_status` parmi `live_web_app` / `live_addon` / `live_api` / `head_only` / `unknown`. Priorité décroissante (web_app > addon > api > head_only) — la sévérité de l'alerte décroît dans l'ordre. **Interface `DeploymentsProvider` pluggable** (default `NoopDeploymentsProvider`, idem doctrine §22). `createAppsScriptDeploymentsProvider` (`src/providers/apps-script-deployments.ts`) implémente la lecture API avec scope `script.deployments.readonly` (ADC, import dynamique). Détection de **version drift** au niveau numéro : si un déploiement live pointe sur une version antérieure à `max(versions.versionNumber)`, le rapport signale l'écart.
- **Phase 2** : confirmation/infirmation de la dérive au niveau **code** (V3 §22.3, suite). `AnalyzeDeployAwareOpts.contentFetcher` accepte un `LibraryFetcher` (réutilise `createAppsScriptApiFetcher` de resolve-live — 0 duplication d'auth / cache). Pour chaque déploiement live avec `version_number` non null, on fetche le contenu de la version via `projects.getContent?versionNumber=X` et on compare au HEAD local (`ProjectIndex.file_hashes`) — granularité fichier, par sha1. Résultat dans `ProjectDeploymentSummary.content_drift` : `files_modified` / `files_added_locally` / `files_removed_locally` / `in_sync`. Memoize les fetches par version_number (un déploiement A et B sur même version = 1 seul fetch). Fetcher en erreur dégradé silencieusement (consultatif). CLI : `--no-diff-content` pour opt-out ; sinon actif par défaut avec `--use-apps-script-api`.

scriptId résolu via `script-id.ts` (`.clasp.json` ou overrides CLI). Activation globale : `gaslens deploy-aware --use-apps-script-api`. Strictement consultatif, hors hook chaud.

`emit-contract-tests` (V2 §12.3 + V3 §23) — Deux runners livrés :
- **`clasp`** (défaut, historique) : harnais `.gs` à déployer dans un projet GAS sandbox dédié. Exécution dans le cloud Google avec effets de bord réels (emails, écritures Sheets, quota OAuth).
- **`gas-fakes`** (V3 §23) : harnais `.mjs` exécutable LOCALEMENT via [gas-fakes](https://github.com/brucemcpherson/gas-fakes). Bootstrap `import 'gas-fakes';` en tête + footer auto-exécuté avec `process.exit(0|1)` pour intégration CI. C'est désormais la cible recommandée pour les tests de contrat (boucle save & refresh quasi instantanée, mode `vm` sandbox sans permissions). Activation : `gaslens emit-contract-tests --runner gas-fakes`.

Les roadmaps V3, V4, V5 et le durcissement multi-repo (LOT E) sont livrés. Marches possibles futures (cf. `ROADMAP.md`) :
- **`npm publish`** (`@malolecouls/gaslens`, accès public déjà configuré) + tag de release `vX.Y.Z` pour épingler le plugin (`#vX`) — nécessite l'auth npm de l'auteur (non fait).
- Migrer la détection de littéraux de ressources (E5) vers un **extracteur d'index** (hot-path sans relire les sources) — touche l'agrégation incrémentale, à faire prudemment.
- Étendre le serveur MCP au-delà des 4 outils consolidés — contre-doctrine V3 §24, à n'envisager que si demande terrain forte.
- Continuer à étendre `GAS_API_DEPRECATED` / `GAS_API` selon observations.

---

## Pièges à ne jamais réintroduire (V2 §13)

- Espace de noms **global** par projet : `foo()` dans `fileA.gs` résout vers `function foo` de `fileB.gs`. L'incrémental doit re-résoudre.
- **Scan partial (F2)** : un fichier **caché** (inchangé) qui appelle une fonction supprimée/renommée dans un fichier **modifié** doit voir son `outbound_call` **reclassé en `unresolved`** (miroir du full scan). Sinon le hook dit `CLEAN` à tort sur un renommage cassant. Garde-fou : `tests/incremental-differential.test.ts` (incrémental ≡ full sur les findings).
- `withUserObject(ctx)` **décale** les args du handler (`(retourServeur, userObject)`) — ne pas prendre `userObject` pour la shape de retour.
- Les **scriptlets** `<?= fn() ?>` sont des call sites : un `check` qui les rate dit `CLEAN` à tort.
- `google.script.run` : retour **non sérialisable** = bug latent (`serializable.broke`), pas une erreur d'analyse.
- **Multi-repo** : en workspace, un projet se nomme par son **chemin relatif** (`apps/dash/dev`), jamais le basename (sinon `apps/*/dev` collisionnent). La résolution cross-repo passe par le **manifeste maître** (`library_prefix`→projet), pas par le nom — `scan` le lit (`loadLibraryProviders`).
- `env validate` lit le **manifeste maître + relit les sources** (pas l'index) : volontaire, hors hot-path index. Le fast-path incrémental se détecte par **hash**, jamais par mtime.

---

## Tenir ce fichier à jour

À chaque ajout/changement de commande, de `consumer_kind`, de dépendance ou d'invariant : **mettre à jour ce fichier dans le même commit** (carte du repo, état courant, recette). Si une section dépasse l'utile, élaguer plutôt qu'empiler — la concision est une feature (cf. en-tête). Les volumes V1/V2/V3 restent la référence longue ; ce fichier n'en est que l'index opérationnel.
