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
    uncertainty.ts             alimente coverage (dispatch dynamique, etc.)
  inspect.ts / impact.ts / diff.ts / check.ts / hook.ts    les commandes
  map.ts                       table des matières compacte (V3 §21.5) — projection seule de l'index
  manifest.ts                  parse complet d'appsscript.json (scopes, libs, advanced services, whitelist)
  manifest-analysis.ts         croise code ↔ manifeste (V3 §21.1) : library.undeclared/.unused, advanced_service.missing/.unused, scope.missing/.unused, urlfetch.not_whitelisted
  scopes.ts                    table service GAS → scope(s) OAuth (Gmail/Drive/Spreadsheets/Calendar/UrlFetchApp/Session/…)
  validate-api.ts              valide les chaînes d'appels GAS contre gas-api.ts (V3 §21.2) : api.unknown_method + suggestions fuzzy
  gas-api.ts                   registre curé Service→Method→ReturnType pour ~15 services natifs (source: doc + @types/google-apps-script)
  emit-dts.ts / emit-contract-tests.ts                     ponts vers tsc / tests de contrat
  eval.ts                      rejoue eval/tasks/*.json (inclut findings manifeste + validate-api via enrichWith*Findings)
  init.ts                      recettes CLAUDE.md / settings.json (V2 §16)
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
npm test             # vitest run  (doit rester vert ; ~207 tests)
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

Implémenté : `scan`, `map`, `manifest`, `validate-api`, `inspect`, `impact`, `diff`, `check`, `hook`, `emit-dts`, `emit-contract-tests`, `eval`, `init`.

`manifest` (V3 §21.1) — Phases 1 + 2 livrées : `library.undeclared/.unused`, `advanced_service.missing/.unused` (phase 1, confidence high), `scope.missing/.unused` (WARN/INFO, confidence medium, **silencieux quand `oauthScopes` n'est pas explicite** car l'auto-détection Google joue), `urlfetch.not_whitelisted` (WARN, **silencieux quand `urlFetchWhitelist` est absent**, URLs littérales seulement). Câblé dans `check` via `enrichWithManifestFindings`. Table service→scope dans `scopes.ts`. **Restent** : `scope.over_broad` (info, prudent), gestion de `@OnlyCurrentDoc`.

`validate-api` (V3 §21.2) — Phase 1 livrée : `api.unknown_method` (BREAK) + suggestions fuzzy. Registre curé dans `gas-api.ts` (~15 services, ~400 méthodes). Honnête : s'arrête sur les types `unknown` ou tableaux (pas de faux positif). Câblé dans `check` via `enrichWithApiFindings`. **À étendre** : `api.wrong_arity` (registre stocke déjà l'arity grossière côté chaîne, manque côté registre), `api.deprecated` (méthodes Rhino-only sous V8).

À construire (détail + intérêt dans V3) :
- **`lint-webapp`** / **`lint-runtime`** (V3 §21.4/§21.3) — `warn`/`info` (mixed content, target, forms ; quota/6 min/lock/trigger orphelin).
- Optionnels API (V3 §22, hors hook) : `resolve-live` (libs externes via Apps Script API), `prod-truth` (getMetrics/processes).
- `emit-contract-tests --runner gas-fakes` (V3 §23) ; wrapper **MCP** + **Skill** (V3 §24).

---

## Pièges à ne jamais réintroduire (V2 §13)

- Espace de noms **global** par projet : `foo()` dans `fileA.gs` résout vers `function foo` de `fileB.gs`. L'incrémental doit re-résoudre.
- `withUserObject(ctx)` **décale** les args du handler (`(retourServeur, userObject)`) — ne pas prendre `userObject` pour la shape de retour.
- Les **scriptlets** `<?= fn() ?>` sont des call sites : un `check` qui les rate dit `CLEAN` à tort.
- `google.script.run` : retour **non sérialisable** = bug latent (`serializable.broke`), pas une erreur d'analyse.

---

## Tenir ce fichier à jour

À chaque ajout/changement de commande, de `consumer_kind`, de dépendance ou d'invariant : **mettre à jour ce fichier dans le même commit** (carte du repo, état courant, recette). Si une section dépasse l'utile, élaguer plutôt qu'empiler — la concision est une feature (cf. en-tête). Les volumes V1/V2/V3 restent la référence longue ; ce fichier n'en est que l'index opérationnel.
