# GAS-Lens — Volume 5

**Installation, packaging & harmonisation : faire de l'ensemble un seul outil de travail, natif et installable en une commande.**

Complément des Volumes 1–4 et du document workspace. Objet de ce volume : répondre à *« comment setup le workspace avec GasLens facilement, en natif, sans dézipper quoi que ce soit, avec tout dans le repo GitHub »*, et trancher la question *« qu'est-ce que l'utilisateur doit configurer dans Claude (MCP / tools / plugins) ? »*.

La réponse tient en une idée : **GasLens se distribue sur deux canaux qui partent du même repo GitHub et se câblent l'un à l'autre.** Le moteur d'analyse reste un binaire CLI (npm) ; toute la couche agent (skills, hooks, slash commands, config MCP, CLAUDE.md) devient un **plugin Claude Code** installable en une commande. Un scaffolder (`gaslens workspace init`) génère le workspace, et un vérificateur (`gaslens doctor`) remplace le « README que personne ne lit ».

> Décision d'harmonisation actée : **on ne demande jamais à l'utilisateur de copier-coller de la config à la main.** Le générique s'installe via le plugin (versionné, mis à jour par `/plugin update`) ; le spécifique au workspace est généré par le scaffolder et committé dans le repo du workspace.

---

## Partie 31 — Les deux canaux de distribution (le cœur de l'harmonisation)

| Canal | Ce qu'il porte | Mécanisme | Pourquoi séparé |
|---|---|---|---|
| **1. Le moteur** (`gaslens`) | l'analyse statique : `scan`, `inspect`, `impact`, `check`, `diff`, `hook`, `emit-dts`, `env`, `doc`, `doctor`, `workspace init` | **paquet npm** (`npm i -g` ou `npx`) | déterministe, sans état Claude ; c'est ce que les hooks *appellent* |
| **2. La couche agent** (le *plugin*) | skills + hooks + slash commands + config MCP (Chrome) + fragments CLAUDE.md | **plugin Claude Code** via marketplace | c'est ce qui *vit dans Claude Code* ; installable en une commande, versionné |

Un plugin Claude Code est un **répertoire auto-contenu** qui regroupe skills, sous-agents, hooks, slash commands et serveurs MCP ; l'installer **active tous ses composants d'un coup**. C'est exactement le mécanisme « natif / builtin / pas de dézip » recherché : il supprime le problème du « config à recopier dans chaque repo / savoir tribal dans un wiki ».

Les deux canaux **partent du même repo `MaloLeCouls/GasLens`** : le repo est à la fois le paquet npm (dossiers `src/`, `bin/`) **et** la source du plugin (dossier `.claude-plugin/` + composants + `marketplace.json`).

---

## Partie 32 — Le repo GasLens, en monorepo à deux faces

```
GasLens/                              ← un seul repo GitHub, deux faces
├── src/  bin/  tests/                ← FACE 1 : le moteur (paquet npm)
├── package.json                      ←   "bin": { "gaslens": "bin/gaslens.js" }
│
├── .claude-plugin/                   ← FACE 2 : le plugin Claude Code
│   ├── plugin.json                   ←   manifeste du plugin (nom, version, auteur)
│   └── marketplace.json              ←   catalogue (rend le repo installable comme marketplace)
├── skills/                           ←   les skills du workspace (composants à la RACINE du plugin)
│   ├── gas-dev-loop/SKILL.md
│   ├── intake-triage/SKILL.md
│   ├── onboard-app/SKILL.md
│   ├── provision-env/SKILL.md        ←   (V3) copie + ré-liage Form + injection config
│   ├── refresh-dev-data/SKILL.md     ←   (V4) sync hebdo par lignes + scrub PII
│   ├── snapshot-sources/SKILL.md
│   └── promote-deploy/SKILL.md
├── commands/                         ←   slash commands explicites
│   ├── gaslens-init-workspace.md
│   ├── gaslens-onboard-app.md
│   ├── gaslens-promote.md
│   └── gaslens-doctor.md
├── hooks/                            ←   hooks de cycle de vie
│   └── hooks.json                    ←   PostToolUse → check/env validate/doc lint ; SessionStart → doctor
├── .mcp.json                         ←   défaut Chrome DevTools MCP (les "yeux")
└── templates/                        ←   gabarits émis par `gaslens workspace init`
    ├── workspace/                    ←   structure de workspace (manifeste, apps/, backlog/…)
    └── claude-md/                    ←   fragments CLAUDE.md (racine / app / projet)
```

Seul `plugin.json` (et `marketplace.json`) vit dans `.claude-plugin/` ; **les dossiers de composants (`skills/`, `commands/`, `hooks/`, `.mcp.json`) sont à la racine du plugin.**

### 32.1 `.claude-plugin/plugin.json`

```json
{
  "name": "gaslens",
  "version": "1.0.0",
  "description": "Analyse statique GAS anti-régression + workspace multi-projets agent-friendly",
  "author": "MaloLeCouls",
  "mcpServers": ".mcp.json"
}
```

### 32.2 `.claude-plugin/marketplace.json` (rend le repo installable)

```json
{
  "name": "gaslens",
  "plugins": [
    { "name": "gaslens", "source": ".", "description": "GasLens + workspace GAS agent" }
  ]
}
```

Installation côté utilisateur, en deux slash commands :

```
/plugin marketplace add MaloLeCouls/GasLens     # ajoute le repo comme marketplace (épinglable via #v1.0.0)
/plugin install gaslens@gaslens                 # active skills + hooks + commands + MCP d'un coup
```

### 32.3 `hooks/hooks.json` (le garde-fou, câblé par l'installation du plugin)

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [{ "type": "command", "command": "gaslens hook --event post-tool-use" }]
      }
    ],
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "gaslens doctor --hook --quiet-when-ok" }] }
    ]
  }
}
```

- **PostToolUse** → après chaque édition `.gs`/`.html`, `gaslens hook` lance `check` + `env validate` + `doc lint` ciblés et ré-injecte les BREAK (V2 §15). Installer le plugin câble ça sans toucher au `settings.json` à la main.
- **SessionStart** → `gaslens doctor` vérifie l'environnement au lancement (Partie 34) et n'affiche que ce qui manque.

> Impératif rappelé (V2 §15.2) : le PostToolUse appelle le **binaire installé** (`gaslens`), pas `npx gaslens` — pas de latence réseau à chaque édition. D'où le binaire en prérequis (Partie 34), vérifié par `doctor`.

### 32.4 `.mcp.json` (les yeux — Chrome DevTools MCP)

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest", "--autoConnect"]
    }
  }
}
```

`--autoConnect` fait que le MCP se rattache à **ta session Chrome déjà authentifiée** au lieu d'en lancer une vierge — exactement ce qu'exige le test du `/dev` (réservé aux éditeurs loggés, workspace §7). Avertissement à connaître : en auto-connect, l'agent **hérite de ta session** (comptes connectés, cookies) ; à n'utiliser qu'avec un agent de confiance et un profil dédié si tes données sont sensibles.

---

## Partie 33 — `gaslens workspace init` : la commande unique de setup

Elle remplace l'actuel `gaslens init --section …` (qui n'émettait que des bouts) par un scaffolder complet. Elle **génère le workspace**, pas le plugin (le plugin s'installe à part, une fois).

```
gaslens workspace init <nom>
  --with-plugin <bool>     (défaut: true)  écrit .claude/settings.json déclarant la marketplace + le plugin
  --mcp chrome|none        (défaut: chrome) écrit .mcp.json (ou délègue au plugin)
  --git <bool>             (défaut: true)  git init + premier commit (la baseline du 1er check)
```

Arborescence émise (reprend le workspace, Partie 1 du doc workspace) :

```
<nom>/
├── CLAUDE.md                     ← fragment racine (contrat de confiance + accueil + mémoire vivante)
├── README.md                    ← le checklist de setup HUMAIN, généré (Partie 34)
├── gaslens.workspace.json       ← manifeste maître squelette (apps/lib/environments vides)
├── .gitignore                   ← .gaslens/, .clasprc.json, backlog/inbox, backlog/archive
├── .claude/
│   └── settings.json            ← déclare la marketplace + le plugin gaslens (→ install auto-proposée)
├── .mcp.json                    ← chrome-devtools --autoConnect (si --mcp chrome)
├── apps/                        ← vide, prêt pour `/gaslens-onboard-app`
├── backlog/{inbox,triaged,archive}/
└── docs/
```

Le `.claude/settings.json` généré **déclare le plugin** pour que l'ouverture du workspace propose l'installation automatiquement :

```json
{
  "extraKnownMarketplaces": { "gaslens": { "source": "MaloLeCouls/GasLens" } },
  "enabledPlugins": ["gaslens@gaslens"]
}
```

C'est le motif recommandé « repo-scoped » : cloner le workspace + lancer Claude + accepter le dialogue de confiance ⇒ Claude propose d'installer la marketplace et le plugin déclarés. Le générique (plugin) et le spécifique (ce settings.json + le manifeste) arrivent **avec le code**, pas par un wiki.

---

## Partie 34 — `gaslens doctor` : le checklist qui se vérifie tout seul

C'est la réponse à *« il faut noter quelque part ce que l'utilisateur doit configurer »*. On le note **deux fois** : en clair dans le `README.md` généré, **et** en exécutable dans `gaslens doctor` (lancé par le hook SessionStart). L'utilisateur n'a pas à lire un doc : au lancement, Claude lui dit ce qui manque, avec le `fix_hint`.

| Vérifié par `doctor` | Pourquoi | `fix_hint` type |
|---|---|---|
| binaire `gaslens` sur le PATH + version | les hooks l'appellent | `npm i -g @malolecouls/gaslens` |
| **Node ≥ 22** | requis par chrome-devtools-mcp | « mettre Node à jour (nvm install 22) » |
| `clasp` installé + **loggé** (`~/.clasprc.json`) | les *mains* (push/deploy) | `npm i -g @google/clasp && clasp login` |
| **API Apps Script activée** | requise par clasp | « activer sur script.google.com/home/usersettings » |
| Chrome lançable en remote-debugging (si MCP `--autoConnect`) | les *yeux* sur le `/dev` authentifié | « lancer Chrome avec `--remote-debugging-port=9222` » |
| plugin `gaslens` activé (`/plugin`) | skills/hooks/commands | « /plugin install gaslens@gaslens » |
| `gaslens.workspace.json` valide + index présent | socle d'analyse | « gaslens scan . » |

`gaslens doctor` sort un code de retour exploitable (comme `check`) : `0` tout est prêt ; `≠0` + liste des manques. En mode `--hook --quiet-when-ok`, il est silencieux si tout va bien — donc invisible 90 % du temps.

---

## Partie 35 — Le flux « jour 1 », de zéro à productif

```
1.  npm i -g @malolecouls/gaslens         # le MOTEUR (une commande, pas de dézip)
2.  gaslens workspace init mon-workspace  # SCAFFOLD : manifeste, apps/, .claude/, .mcp.json, README
3.  cd mon-workspace && claude            # lancer Claude Code à la racine
4.  [dialogue de confiance] → Claude voit .claude/settings.json
       → propose : installer la marketplace gaslens + le plugin ? → OUI
       → skills + hooks + slash commands + Chrome MCP : ACTIFS
5.  [SessionStart hook] gaslens doctor    # te liste ce qui manque encore :
       → clasp login ?  Chrome remote-debugging ?  API Apps Script ?
6.  régler les 2-3 prérequis listés (une fois pour toutes)
7.  /gaslens-onboard-app                  # interview + scaffolding 1re app + clasp clone
       → on code (V4 : inner loop gratuite, outer loop par feature)
```

Étapes 1–2 = une commande chacune. Étapes 3–4 = clics de confirmation. Étape 5 = Claude te dit quoi faire. **C'est le « rapidement, avec une commande, je setup » demandé**, sans rien dézipper et avec tout répertorié dans le repo.

---

## Partie 36 — Qui possède quoi : la règle de placement (générique vs spécifique)

Pour ne jamais hésiter sur « où va cette config » :

| Élément | Où | Raison |
|---|---|---|
| skills, hooks, slash commands, MCP par défaut | **plugin** (repo GasLens) | générique à tous les workspaces ; versionné ; `/plugin update` |
| fragments CLAUDE.md de référence | **plugin** (templates) → copiés par le scaffolder | générique, mais matérialisé dans le workspace pour édition locale |
| `gaslens.workspace.json` (apps, lib, environnements, IDs) | **repo du workspace** | 100 % spécifique |
| CLAUDE.md d'app / de projet | **repo du workspace** | spécifique (entry points, ressources, lib préfixe) |
| `.mcp.json` (port Chrome, options) | **repo du workspace** (peut surcharger le défaut du plugin) | dépend de la machine/session |
| déclaration marketplace + plugin | **repo du workspace** (`.claude/settings.json`) | pour que cloner ⇒ proposer l'install |
| prérequis humains (clasp, Node, Chrome) | **`README.md` généré + `gaslens doctor`** | hors de Claude ; vérifiés, pas seulement écrits |

Règle d'une ligne : **le comportement de l'agent → plugin ; la vérité du parc → repo du workspace ; les prérequis machine → doctor.**

### Note de confiance (à connaître, pas à craindre)

Un plugin **exécute du code avec tes privilèges** (ses hooks tournent, son MCP est un process local). Ici la source est **ton propre repo**, que tu contrôles — le risque est donc le tien à committer proprement. Si un jour tu publies sur une marketplace communautaire, épingle une version (`#v1.0.0`) et traite chaque mise à jour comme l'ajout d'une dépendance qui s'exécute.

---

## Partie 37 — Roadmap d'harmonisation (ce volume)

1. **Publier le moteur sur npm** (`@malolecouls/gaslens`) → `npm i -g` / `npx` au lieu de clone+build. *(débloque « une commande »)*
2. **Ajouter la face plugin au repo** : `.claude-plugin/plugin.json` + `marketplace.json` + déplacer skills/commands/hooks/.mcp.json à la racine du plugin.
3. **`gaslens workspace init`** : promouvoir l'actuel `init --section` en scaffolder complet (manifeste + `.claude/settings.json` déclarant le plugin + `.mcp.json` + arbo).
4. **`gaslens doctor`** (+ mode `--hook`) branché sur SessionStart.
5. **Migrer les skills du workspace** (gas-dev-loop, intake-triage, onboard-app, provision-env, refresh-dev-data, snapshot-sources, promote-deploy) dans le plugin.
6. **Slash commands** d'entrée (`/gaslens-onboard-app`, `/gaslens-promote`, `/gaslens-doctor`).
7. **Tester le flux jour-1 à blanc** sur une machine vierge → c'est l'éval d'installation (le pendant des évals d'analyse du V1 §5).
8. **Épingler les versions** (plugin `#vX`, `chrome-devtools-mcp@<pin>`) pour stabiliser l'installation dans le temps.

---

### Sources principales (vérifiées pour ce Volume 5)
- **Claude Code — Plugins & Marketplaces** : plugin = répertoire auto-contenu regroupant skills, sous-agents, hooks, slash commands, serveurs MCP, activés tous à l'install ; composants à la racine, seul `plugin.json` dans `.claude-plugin/` ; marketplace = repo git avec `.claude-plugin/marketplace.json` ; install via `/plugin marketplace add owner/repo` puis `/plugin install name@marketplace` (épinglable `#ref`) ; déclaration repo-scoped via `.claude/settings.json` (`enabledPlugins`) → install proposée à l'ouverture ; MCP d'un plugin déclaré en `.mcp.json` à la racine ; hooks de cycle de vie `PostToolUse`/`SessionStart` ; modèle de confiance (code exécuté avec tes privilèges).
- **Claude Code — Skills** : skills auto-activés par contexte (vs slash commands explicites) ; `.claude/skills/` de sous-dossier chargé paresseusement.
- **Chrome DevTools MCP** : paquet `chrome-devtools-mcp` (npm), config `{"command":"npx","args":["-y","chrome-devtools-mcp@latest"]}`, Node ≥ 22 + Chrome stable requis, `--autoConnect` pour se rattacher à une session Chrome authentifiée existante.
- **clasp** : `clasp login` (→ `~/.clasprc.json`), API Apps Script à activer ; distinct dev/prod par projet (V3).
- **GasLens README + Volumes 1–4** : commandes existantes (`scan/inspect/impact/check/diff/hook/emit-dts/init`), pattern `emit-*`, hook PostToolUse, les deux axes d'environnement, le casting cerveau/mains/yeux.
