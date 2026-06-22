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

- [ ] **D1 — Éval d'installation « jour-1 à blanc »** sur machine vierge (pendant des évals
  d'analyse V1 §5). (V5 §37.7)
- [ ] **D2 — Épingler les versions** : plugin `#vX`, `chrome-devtools-mcp@<pin>`. (V5 §37.8)
- [ ] **D3 — Google Site routeur** documenté dans le `CLAUDE.md` d'app + `emit-dts` référencé
  côté client HTML. (V4 §30.7–30.8)

---

### Chemin critique « démo jour-1 »
Si la distribution prime : **C5 + C1 + B1 + B2** suffisent à `npm i -g` → `workspace init` →
`/plugin install` → `doctor`.

### Discipline (CLAUDE.md du repo)
Toute nouvelle détection = **nouvelle task d'éval + test** ; `break` réservé au structurellement
certain ; sorties auto-suffisantes ; cœur 100 % statique/hors-ligne (APIs opt-in hors hook).
