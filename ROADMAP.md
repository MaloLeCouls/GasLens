# GAS-Lens — Roadmap (Volumes 4 & 5)

> Dérivée de la lecture intégrale de `gas-lens-conception-4-conventions-et-articulation.md`
> (V4) et `gas-lens-conception-5-installation-et-packaging.md` (V5), croisée avec l'état
> réel du code au 2026-06-22.

## Constat d'écart

Le **moteur d'analyse V1–V3 est quasi complet** (19/19 grandes features, ~12k lignes,
~350 tests, 18 évals). Les volumes 4 et 5 n'y touchent presque pas : ils ajoutent **quatre
couches neuves** quasi absentes du code.

Vérifié dans `src/cli.ts` : les commandes présentes (`scan, map, manifest, validate-api,
lint-runtime, lint-webapp, resolve-live, prod-truth, deploy-aware, inspect, impact, diff,
check, hook, emit-dts, emit-contract-tests, eval, commands, init`) **n'incluent ni `env`,
ni `doc`, ni `doctor`, ni `workspace`**. Grep `cross_env_leak / library_version_mismatch /
doc lint / undocumented / param_drift` → **0 fichier**.

**Déjà présent, à NE PAS refaire :** `emit-dts` ; le hook PostToolUse (existe, mais ne lance
que `check`) ; `init --section` (à promouvoir, pas réécrire) ; `extract/jsdoc.ts`
(réutilisable pour `doc lint`) ; `scanWorkspace()` / `WorkspaceIndex`.

Ordre de marche conseillé : **A → B → C → D**. `A1` (schéma manifeste) est le verrou :
`env validate` et la topologie 2-env en dépendent.

---

## 🟦 LOT A — Nouvelles analyses du moteur (V4) · *haute valeur, faible risque, 100 % statique*

- [x] **A1 — Schéma du manifeste maître `gaslens.workspace.json`** : `apps[].projects.{dev,prod}`,
  lib unique (HEAD↔figée), `environments.<env>.resources`. → `src/workspace-manifest.ts` (Zod + loader
  + helpers), 11 tests. (V4 §26–29)
- [x] **A2 — `gaslens env validate`** (vague 1) → findings `env.cross_env_leak` (le roi, BREAK),
  `env.library_version_mismatch` (axe CODE, BREAK/WARN), `env.hardcoded_resource` (WARN).
  → `src/env-validate.ts`, commande CLI `env validate`, intégré à `runCheck`, 8 tests.
  ↳ **A2-bis (fait)** : `env.undeclared_resource` (cohérence du manifeste : ressource déclarée dans
  un env mais absente d'un autre, WARN). ↳ **A2-ter (différé)** : migration de la détection de
  littéraux vers un extracteur d'index (hot-path) + extension du harnais d'éval. (V4 §29)
- [x] **A3 — Famille `doc`** : `gaslens doc lint --undocumented/--drift` + `gaslens doc stub <fn>`
  → findings `doc.undocumented` (info), `doc.param_drift` (warn). Extracteur étendu
  (`FunctionDefinition.doc`), `src/doc-lint.ts`, 9 tests. *`return_drift`/`stale_ref` → vague 2.*
  (V4 §25.3)
- [x] **A4 — Hook L1 étendu** : le hook lançait *seulement* le diff structurel ; il lance désormais
  le pipeline complet `check + doc + env` (`applyEnrichments` partagé). Un break manifest/api/env
  bloque maintenant l'édition. MAJ `hook.ts` + `check.ts`, +1 test. (V4 §27, V5 §32.3)
- [x] **A5 — Micro-MAJ** : convention JSDoc (§25.4) dans `CLAUDE_MD_ROOT` (`init.ts`) ;
  `engines` `node>=20` → `>=22`. (V4 §25.4 / V5 §34)

> **+ Correctif latent** : ajout d'un `.gitattributes` (LF forcé) — sans lui, le checkout Windows
> (`core.autocrlf=true`) convertissait les fixtures en CRLF et cassait 3 tâches d'éval.

## 🟩 LOT B — Outillage de setup (V5) · *moteur*

- [x] **B1 — `gaslens doctor`** (+ `--hook --quiet-when-ok`) : Node≥22, binaire gaslens/clasp sur
  le PATH, clasp connecté, plugin câblé, manifeste maître + index. Honnête : API Apps Script /
  Chrome marqués `manual`. Exit code exploitable. → `src/doctor.ts`, 6 tests. (V5 §34)
- [x] **B2 — `gaslens workspace init <nom>`** : scaffolder complet (CLAUDE.md, README,
  `gaslens.workspace.json` squelette, `.gitignore`, `.claude/settings.json` déclarant le plugin,
  `.mcp.json`, `apps/`, `backlog/{inbox,triaged,archive}/`, `docs/`). Flags `--no-plugin/--mcp/--no-git`.
  → `src/workspace-init.ts`, 6 tests. (V5 §33)
  ↳ *Reste branchement SessionStart→doctor : c'est le `hooks/hooks.json` du LOT C (C2).*

## 🟨 LOT C — Distribution : la « face plugin » du repo (V5) · *packaging, pas d'analyse*

- [x] **C1 — `.claude-plugin/`** : `plugin.json` + `marketplace.json` (rend `MaloLeCouls/GasLens`
  installable via `/plugin marketplace add` + `/plugin install`). (V5 §32.1–32.2)
- [x] **C2 — `hooks/hooks.json`** (PostToolUse→hook, **SessionStart→doctor**) + `.mcp.json` racine
  (chrome-devtools `--autoConnect`) + `templates/` (workspace + fragments CLAUDE.md). (V5 §32.3–32.4)
- [x] **C3 — 7 skills** `skills/<nom>/SKILL.md` : `gas-dev-loop, intake-triage, onboard-app,
  provision-env, refresh-dev-data, snapshot-sources, promote-deploy`. (V5 §32)
- [x] **C4 — Slash commands** : `/gaslens-onboard-app`, `/gaslens-promote`, `/gaslens-doctor`,
  `/gaslens-init-workspace`. (V5 §37.6)
- [x] **C5 — Packaging npm** : `gaslens@0.0.1` → **`@malolecouls/gaslens`** + `publishConfig.access=public`
  + repository/homepage ; `files`(dist/bin/README) + bins inchangés. ⚠️ **`npm publish` NON lancé**
  (besoin de l'auth npm + accord explicite). Structure validée par `tests/plugin-structure.test.ts`
  (16 tests). (V5 §37.1)

## 🟧 LOT D — Validation & durcissement

- [x] **D1 — Éval d'installation « jour-1 à blanc »** : test d'intégration de bout en bout
  (scaffold → doctor → onboard app → env validate → scan/doc lint) → `tests/install-flow.test.ts`
  (2 tests). (V5 §37.7)
- [x] **D2 — Épingler les versions** : `chrome-devtools-mcp@1.3.0` dans les deux `.mcp.json`
  (racine + scaffolder) + garde-fou de test « pas `@latest` » ; pin plugin `#vX` documenté (README).
  (V5 §37.8)
- [x] **D3 — Google Site routeur** + **`emit-dts` côté client** documentés dans
  `templates/claude-md/app.md` (la référence triple-slash `/// <reference>` est déjà émise par
  `emit-dts`). (V4 §30.7–30.8)

---

## 🟥 LOT E — Durcissement multi-repo & ergonomie agent

> Issu d'une **simulation réelle** d'un workspace multi-repo (lib partagée `Core` +
> webapps `dash`/`intake`, avec erreurs piégées). `env validate` a attrapé les 3 pièges
> (cross_env_leak, library_version_mismatch, undeclared_resource, exit 3 ✓), MAIS la
> simulation a exposé des trous entre la topologie V4/V5 (2 projets par app) et le moteur
> `scan`/workspace (conçu pour un monorepo plat V1-V3). Objectif du lot : que l'outil
> **aide massivement** un agent sur un vrai parc multi-repo, pas seulement sur 1 app.

### Constats de la simulation (la preuve)

- **G1 — Collision de noms de projet.** Le layout prescrit `apps/<app>/{dev,prod}` fait que
  `scan` nomme par `basename` → `projects: dev, prod, dev, prod, dev, prod` (6 projets, 2 noms).
  `--project` devient ambigu, impossible de cibler `dash/dev`, sorties `doc lint` illisibles.
- **G2 — Edges cross-repo non résolus.** La lib partagée `Core` est vue `external`,
  `cross_project_edges: []`. Un changement de signature dans `Core` **ne propage aucune
  régression** vers `dash`/`intake`. Cause : `scan` ne lit pas le manifeste maître, donc ne
  mappe pas `library_prefix`/`script_id` → projet `core`.
- **Coutures setup/auth non gardées** : (a) `script_id` du manifeste vs `.clasp.json` de
  chaque projet — aucune création/sync/validation, drift silencieux = push sur le mauvais
  projet ; (b) `doctor` ne vérifie pas l'**ADC** (requis par resolve-live/prod-truth/deploy-aware) ;
  (c) `doctor` ne vérifie pas la **baseline par projet** (le hook skip en silence sinon) ;
  (d) `doctor` « plugin activé » ne teste que la présence de `.claude/settings.json`.
- **Limites honnêtes du modèle** : `cross_env_leak` n'attrape qu'un id **déclaré** ; un id en
  dur **oublié** passe ; `undeclared_resource` est pure cohérence manifeste (un projet qui
  hardcode tout sans rien déclarer ressort CLEAN) ; `plugin.json` non testé contre le chargeur
  réel de Claude Code.

### Correctifs priorisés

- [ ] **E1 (P0) — Nommage de projet désambiguïsé.** En mode workspace, nommer chaque projet par
  son **chemin relatif à la racine** (POSIX), p. ex. `apps/dash/dev` (le plat `AppA` reste
  inchangé). `--project` accepte le chemin exact OU un suffixe (`dash/dev`) ; ambigu → liste les
  candidats. Corrige **G1**.
- [ ] **E2 (P0) — Résolution cross-repo via le manifeste maître.** `scan`/`check` lisent
  (optionnellement) `gaslens.workspace.json` pour mapper `library_prefix`/`library.script_id` →
  projet fournisseur, et résoudre les appels `Lib.fn()` inter-repos en `cross_project_edges`
  (env-aware : un consommateur `dev` se lie au fournisseur `dev`). Corrige **G2** → la
  propagation de régression cross-repo fonctionne enfin.
- [ ] **E3 (P1) — `doctor` durci.** Vérifier : cohérence `.clasp.json` ↔ `script_id` du manifeste
  (par app) ; présence de l'**ADC** (`gcloud auth application-default`) ; **baseline par app**
  (itérer `apps[]`) ; déclaration réelle du plugin dans `.claude/settings.json`. → l'agent
  demande les prérequis **avant** d'échouer.
- [ ] **E4 (P1) — `gaslens workspace add-app <nom>`.** Crée `apps/<nom>/{dev,prod}`, écrit
  l'entrée `apps[]` + les ressources squelette dans le manifeste, copie le fragment
  `claude-md/app.md`, et rappelle `clasp clone`/`clasp create`. Réduit la partie la plus
  manuelle/risquée du parcours.
- [ ] **E5 (P2 / ex-A2-ter) — Extracteur de littéraux de ressources.** Capturer les littéraux
  « qui ressemblent à un id de ressource Google » dans l'index → `env validate` flague aussi les
  ids **non déclarés** (plus seulement ceux du manifeste) et sert le hot-path sans relire les
  sources. Lève la limite de `cross_env_leak`.

### Preuve de réalisation
Re-jouer la simulation multi-repo : après E1+E2, attendre `projects` à noms distincts
(`apps/dash/dev`…) et `cross_project_edges` non vide (Core.formatDate ← dash). Test
d'intégration dédié (`tests/multirepo.test.ts`).

---

### Chemin critique « démo jour-1 »
Si la distribution prime : **C5 + C1 + B1 + B2** suffisent à `npm i -g` → `workspace init` →
`/plugin install` → `doctor`.

### Discipline (CLAUDE.md du repo)
Toute nouvelle détection = **nouvelle task d'éval + test** ; `break` réservé au structurellement
certain ; sorties auto-suffisantes ; cœur 100 % statique/hors-ligne (APIs opt-in hors hook).
