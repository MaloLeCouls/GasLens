# GasLens × Ultracode — Playbook qualité pour Google Apps Script

> **But de ce document.** Te donner tout ce qu'il faut mettre en place pour qu'ultracode
> (Claude Code, Opus 4.7+) produise le contenu le plus **fiable** possible quand tu travailles
> sur tes vrais projets Google Apps Script — en s'appuyant sur GasLens comme garde-fou et comme
> « table des matières » de ton parc.
>
> Doctrine de ce playbook, calquée sur celle de GasLens : on ne demande jamais à un agent de
> bluffer une certitude. Ultracode amplifie un agent ; il n'a de valeur que si le terrain est
> préparé pour qu'il raisonne **juste**, pas seulement **beaucoup**.
>
> Source officielle ultracode / dynamic workflows : https://code.claude.com/docs/en/workflows

---

## 0. La règle d'or (à lire avant tout)

> **Glossaire express** (à garder en tête tout le long du document) :
> - **L0** = `CLAUDE.md` du workspace + manifeste maître (contrat de confiance, contexte permanent).
> - **L1** = hook `gaslens check` (statique, local, instantané, déterministe — chemin chaud).
> - **L2** = `clasp push` DEV + Chrome MCP (vérification sémantique avant promotion).
> - **L3** = `clasp deploy` prod sous gate humain.
> - **LX** = ultracode fan-out (orthogonal aux niveaux — mobilisé sur tâche parc-wide).
> - **BREAK** = régression structurelle certaine · **WARN** = anomalie probable à confirmer · **INFO** = signal contextuel.
> - **ADC** = Application Default Credentials (`gcloud auth application-default login`).
> - **MCP** = Model Context Protocol · **parc** = workspace GasLens = ensemble multi-app géré par `gaslens.workspace.json`.
> - **gate humain** = action manuelle hors-agent (l'humain tape lui-même la commande).

Ultracode = `xhigh` + orchestration automatique de *dynamic workflows* (Claude écrit un script
JS qui fanne des dizaines à des centaines de sous-agents en arrière-plan). Sa **seule** zone de
pertinence : les tâches **parc-wide où la couverture est la métrique** — audits, migrations
propagées, recherche croisée. Pour une édition ciblée, c'est du gaspillage de tokens et de latence.

```
                      ┌─────────────────────────────────────────────┐
   ÉDITION CIBLÉE     │  L1 — hook gaslens check (statique, instant) │   ← JAMAIS ultracode
   (le quotidien)     │  L2 — clasp push DEV + Chrome MCP (sémantique)│   ← JAMAIS ultracode
                      └─────────────────────────────────────────────┘
                                          ▲
   TÂCHE PARC-WIDE    ┌─────────────────────────────────────────────┐
   (audit/migration)  │  LX — ultracode : fan-out sur tout le parc   │   ← ICI, chirurgical
                      └─────────────────────────────────────────────┘
                                          ▲
   PROMOTION PROD     ┌─────────────────────────────────────────────┐
   (gate humain)      │  L3 — clasp deploy prod (confirmation manuelle)│  ← JAMAIS ultracode
                      └─────────────────────────────────────────────┘
```

Trois interdits non négociables, justifiés en §6 (avec deux garde-fous additionnels détaillés à part) :

1. **Jamais dans le hook / l'inner loop** (L1). Ça trahirait l'invariant « statique, local, instant, sans effet de bord » du chemin chaud.
2. **Jamais pour promouvoir en prod** (L3). Un workflow n'accepte aucune entrée humaine en cours de run ; ton gate humain ne tient plus.
3. **Jamais `/effort ultracode` laissé allumé toute la session.** On l'invoque à la tâche, puis on redescend à `/effort high`.

---

## 1. Prérequis

| Élément | Pourquoi | Vérification |
|---|---|---|
| Opus 4.7+ | Seul modèle qui débloque ultracode (effort `xhigh`) | `/model` |
| Claude Code ≥ v2.1.154 | Version minimale des dynamic workflows | `claude --version` |
| Plan payant (Pro `/config` → Dynamic workflows, ou Max/Team/Enterprise) | Feature gated par plan | menu `/config` |
| Plugin GasLens installé | Câble hook + doctor + skills + MCP | `/plugin install gaslens@gaslens` |
| Workspace `gaslens` scaffoldé | Manifeste maître, baselines, `.claude/settings.json` | `gaslens workspace init <nom>` puis `gaslens doctor` |

Si `gaslens doctor` n'est pas tout vert (Node ≥ 22, clasp connecté, ADC pour les capacités API,
baseline par projet, manifeste maître cohérent), **corrige avant** de lancer le moindre workflow.
Un fan-out sur un terrain incohérent produit du bruit cher.

---

## 2. Le modèle mental : préparer le terrain AVANT le fan-out

La qualité d'un run ultracode dépend à 80 % de ce que Claude **voit** au démarrage. GasLens te
donne précisément les artefacts qui orientent les sous-agents sans gaspiller de tokens. Avant tout
workflow parc-wide, fais générer / rafraîchir ces trois choses et mentionne-les dans ton prompt :

1. **Le plan de masse** — `gaslens workspace overview --format registry` → `REGISTRY.md`
   (scriptId, projet GCP, URLs `/exec` + `/dev`, id Drive, embeds Site). C'est la carte du
   territoire : un sous-agent qui l'a en tête ne confond pas `dash/dev` et `dash/prod`.
2. **La vue parc** — `gaslens workspace overview` → apps × dev/prod, version de lib consommée,
   verdict `env validate` par projet, couverture doc. Donne à Claude l'état de santé d'un coup.
3. **La table des matières par projet** — `gaslens map --format text` (~300 tokens). À faire
   pointer en début de chaque sous-tâche pour cadrer l'exploration au lieu de laisser un agent
   re-grep le repo.

> **Principe d'économie.** Tout ce que GasLens sait déjà, l'agent ne doit pas le redécouvrir à la
> main. `map` / `inspect` / `overview` sont les yeux ; un workflow qui les ignore brûle des tokens
> à reconstruire ce qui est déjà indexé.

---

## 3. Setup qui maximise la qualité

### 3.1 Allowlist (le plus important pour un run long)

Les sous-agents tournent en `acceptEdits` et héritent de ton allowlist, **mais** une commande
shell hors allowlist peut interrompre un run de 30 min pour te demander une permission. Avant un
gros audit, mets dans ton allowlist (`/permissions` ou `.claude/settings.json`) au minimum :

```
gaslens scan, gaslens map, gaslens inspect, gaslens impact, gaslens diff,
gaslens check, gaslens env validate, gaslens doc lint, gaslens manifest,
gaslens validate-api, gaslens workspace overview
```

Pour un audit qui peut écrire (migration, génération de doc) : ajoute aussi les commandes de build/
test de **ton** projet GAS si tu en as (lint, vitest…). En revanche **n'ajoute pas** les commandes à
effet réseau/effet de bord (`clasp push`, `clasp deploy`, `gaslens *--use-apps-script-api`) à une
allowlist « large » : tu veux qu'elles te demandent toujours. Voir §6.

### 3.2 Le `CLAUDE.md` du workspace (le contrat de raisonnement)

C'est le fichier que chaque sous-agent lit en priorité. Pour qu'un workflow produise du contenu
qualitatif, il doit y trouver, de façon dense et explicite :

- **La doctrine de confiance GasLens** : `break` est sacré (régression structurelle certaine) ;
  ce que l'analyse ne tranche pas part dans `coverage.unresolved` ; on ne re-grep pas ce que
  GasLens voit déjà ; ce que GasLens **ne voit pas** (sémantique métier, unités, dispatch
  dynamique, bugs sous charge) reste à vérifier en L2 (Chrome MCP), pas à inventer.
- **La topologie 2-env** : chaque app = projet `dev` (lib HEAD, données factices) + projet `prod`
  (lib figée). Un id de ressource d'un env codé en dur dans l'autre = fuite (`cross_env_leak`).
- **Le pointeur vers le plan de masse** (`REGISTRY.md`) et le manifeste maître
  (`gaslens.workspace.json`) comme sources de vérité du parc.
- **La cadence** : L1 hook / L2 feature / L3 promo sous gate humain — et le fait qu'un workflow
  ultracode ne franchit jamais L3 tout seul.

`gaslens init --section claude-md --write` pose déjà la base ; complète-la avec ces points si ton
parc est multi-app.

### 3.3 Donner le contexte au bon niveau de granularité

Un bon prompt ultracode **nomme la décomposition** au lieu de la laisser deviner. Mauvais : « audite
mon parc ». Bon : « un agent par couple (app, env), chacun lance `gaslens env validate` scopé à son
projet, puis un reviewer recroise les BREAK contre `REGISTRY.md` ». Plus la maille des sous-agents
est explicite, plus la couverture est garantie et moins il y a de chevauchement.

### 3.4 Pré-flight obligatoire pour workflows écrivants

Avant de lancer un workflow qui écrit (§5.2, §5.3, §5.5), exige un working tree git **propre**
(`git status` clean, aucune modification non commitée). Sinon, ce qui est non commité dans ton arbre
de travail risque d'être écrasé au merge des worktrees isolés — et tu n'auras pas de filet pour
revenir en arrière. C'est non négociable : un `git stash` ou un commit WIP avant le run, point.

Le **partitionnement explicite** des sous-agents est obligatoire : un agent = un projet (jamais deux
agents sur le même fichier en parallèle, même en worktree). La doctrine du fan-out repose sur
l'indépendance des angles ; deux agents qui écrivent au même endroit transforment le merge en pari.

Après la phase d'implémentation, prévoir une **phase de merge sérialisée** : un worktree à la fois,
avec relance des tests à chaque merge. Pas de merge automatique si un test casse — c'est exactement
le signal qu'on voulait capter.

Si un agent veut toucher un fichier **partagé** (ex : `Core.gs` consommé par N webapps), il doit
être seul à le faire — ce qui annule le bénéfice du fan-out et ramène le travail à `/effort high`.
La règle : si une migration touche un fichier mutualisé, fais-la en un seul agent ; n'utilise le
fan-out que pour la propagation aval (adaptation des consommateurs).

### 3.5 Triangulation obligatoire (éviter la monoculture d'hypothèses)

Pattern observé : phase 1 cartographie → phase 2 applique → phase 3 reviewer. Si le reviewer
recroise contre la **même** source que phase 1 (`REGISTRY.md`, output JSON de phase 1), une erreur
de phase 1 se propage **non détectée** jusqu'au verdict final. Le reviewer ne *review* plus, il
*confirme* — biais de confirmation institutionnalisé.

Règle : tout finding qui déclenche une action écrivante doit être **triangulé par au moins deux
sources indépendantes** — par exemple `gaslens impact` ET `gaslens prod-truth` ET un grep textuel
direct. Si les trois divergent, le finding part dans `coverage.unresolved`, pas dans le plan d'action.

Pour les workflows critiques (migrations §5.2, suppressions §5.5), ajoute un sous-agent **« devil's
advocate »** dont le seul rôle est de produire un **contre-exemple non vide** au finding (« trouve
un call site que phase 1 a manqué », « trouve une raison de garder cette fonction »). Si l'avocat
du diable échoue à produire un contre-exemple, le finding est confirmé ; sinon, on revoit.

Doctrine : « ne jamais bluffer une certitude » s'applique aux sous-agents comme à l'agent maître.
Un reviewer qui n'a pas de source indépendante n'a pas le droit de dire « confirmé ».

---

## 4. Quand déclencher ultracode (check-list de pertinence)

Coche **au moins 3** avant de lancer. Sinon, reste en `/effort high` (un seul agent suffit).

- [ ] La tâche couvre **plusieurs projets / fichiers** du parc (pas une fonction isolée).
- [ ] **La couverture est la métrique** : un trou manqué coûte cher (fuite prod, régression propagée).
- [ ] La tâche **se décompose en angles indépendants** qui gagnent à être recroisés (par app, par service, par règle).
- [ ] Le mode d'échec à battre est **l'abandon précoce** d'un agent unique (il s'arrête à la moitié).
- [ ] Ce n'est **ni** une édition interactive **ni** une action prod (pas besoin de te reprendre la main en cours de route).

---

## 5. Workflows prêts à coller (taillés pour le GAS)

Pattern d'usage : prompt one-shot avec le mot-clé `ultracode:` en tête. Quand un run te convient,
`/workflows` → sélectionne le run → `s` pour le sauver en `/<nom>` dans `.claude/workflows/` (partagé
au repo) ou `~/.claude/workflows/` (perso). Les workflows sauvegardés acceptent des `args` pour les
scoper. **Toujours jauger sur une tranche d'abord** (une seule app) avant le parc entier.

### 5.1 Audit env parc-wide (le finding-roi : `cross_env_leak`)

*Quand :* avant une release, ou après un gros refactor multi-app.

```text
ultracode: audite l'isolation dev/prod de tout le parc. Un agent par couple
(app, env) déclaré dans gaslens.workspace.json. Chacun lance
`gaslens env validate --project <app> --env <env> --compact` et relève
cross_env_leak (BREAK), library_version_mismatch (BREAK), hardcoded_resource (WARN),
undeclared_resource (WARN), library_scope_missing (WARN). Un agent reviewer recroise
chaque BREAK contre REGISTRY.md (l'id fuité appartient-il vraiment à l'autre env ?).
Sortie : tableau app×env trié BREAK→WARN, chaque ligne avec fichier:ligne et le
fix_hint. Ne modifie aucun fichier. Doctrine : break sacré, ne jamais bluffer.
```

*Sortie attendue :* un rapport de fuites priorisé, recoupé, prêt à corriger en L1.

### 5.2 Migration de signature d'une lib partagée, propagée à tous les consommateurs

*Quand :* tu changes le contrat d'une fonction de ta lib `Core` consommée par plusieurs webapps.

```text
ultracode: je veux changer la signature de Core.<fn> (<décris le changement>).
Phase 1 — un agent cartographie tous les consommateurs via
`gaslens impact Core.<fn> --change '<dsl>'` et les cross_project_edges. Phase 2 —
un agent par consommateur applique l'adaptation dans son worktree isolé et relance
`gaslens check` jusqu'à CLEAN. Phase 3 — un reviewer vérifie qu'aucun consommateur
n'a été oublié (recoupe contre la liste de phase 1) et que les contrats client↔serveur
(google.script.run) restent satisfaits. Ne touche QUE le code dev, jamais prod.
```

*Pourquoi ultracode ici :* la propagation cross-repo est exactement le cas « migration de N
fichiers » où un agent seul oublie des call sites. Le fan-out + reviewer garantit la couverture.

### 5.3 Audit doc / JSDoc parc-wide

*Quand :* mettre à niveau la doc d'intention avant d'ouvrir le parc à d'autres devs/agents.

```text
ultracode: audite la couverture doc de tout le parc. Un agent par projet lance
`gaslens doc lint --undocumented --drift --return-drift --stale-ref --compact`.
Pour chaque doc.undocumented sur une fonction PUBLIQUE, l'agent rédige un JSDoc
d'intention (pas de paraphrase du code : le POURQUOI). Pour chaque param_drift /
return_drift, il corrige la dérive. Un reviewer vérifie qu'aucun JSDoc ajouté ne
ment sur la shape réelle (croise avec `gaslens inspect <fn>`). Worktrees isolés.
```

### 5.4 Deep-research « nouveautés plateforme GAS »

*Quand :* veille — institutionnaliser ta confrontation à l'état de l'art.

```text
/deep-research Quelles nouveautés de la plateforme Google Apps Script (services
avancés, quotas, API V8, runtime, déploiements) sont apparues sur les 6 derniers
mois, et lesquelles impactent un parc multi-webapp dev/prod piloté par agent ?
```

*Note :* `/deep-research` est un workflow **bundled** — il vote sur chaque affirmation et écarte
celles qui ne survivent pas au recoupement. Idéal pour ne pas halluciner des capacités GAS.

### 5.5 Sweep « code mort vs dispatch dynamique » (⚠ API opt-in)

*Quand :* nettoyage — mais **avec prudence**, car ça touche aux capacités réseau.

```text
ultracode: croise la surface exposée du parc avec la vérité d'exécution prod.
Un agent par projet lance `gaslens prod-truth --use-apps-script-api --window-days 30`.
Classe chaque fonction parmi les 6 catégories émises par prod-truth :
confirmed_dead (candidate suppression), dispatched_dynamic (NE JAMAIS supprimer —
appelée par un chemin invisible au statique), cold_exposed (exposée mais sans hit
récent — NE PAS supprimer, élargir la fenêtre), unknown (donnée insuffisante — à
traiter comme suspected_dead), errored, live.
Un reviewer ne propose à la suppression QUE les confirmed_dead recoupés. Aucune
suppression auto : produis une liste de candidates pour validation humaine.
```

*⚠ Garde-fou :* `--use-apps-script-api` sort du périmètre offline et exige l'ADC. Ne mets jamais ce
flag dans l'allowlist large, et garde la suppression sous décision humaine (c'est consultatif).

---

## 6. Garde-fous (les NON, et pourquoi)

| Interdit | Raison de fond |
|---|---|
| **Ultracode dans le hook `check` / `guard`** | Le chemin chaud doit rester statique, local, instantané, déterministe (invariant #1 de GasLens). Un workflow est lourd, en arrière-plan, non-déterministe. Faute de conception. |
| **Promotion prod par workflow autonome** | Un workflow n'accepte aucune entrée humaine en cours de run. Ta skill `promote-deploy` impose un gate humain. Incompatible. La promo reste manuelle (L3). |
| **`/effort ultracode` laissé on toute la session** | La doctrine officielle : appliqué à *chaque* tâche substantielle, il alourdit le travail routinier. Invoque-le à la tâche, puis `/effort high`. |
| **Flags API Google (`--use-apps-script-api`) dans une allowlist large** | Ils sortent du cœur offline et ont des effets réseau. Ils doivent toujours demander confirmation. |
| **Laisser un workflow supprimer du code / pousser sur clasp sans revue** | `dispatched_dynamic` et la sémantique métier sont invisibles au statique. La suppression et le push restent sous validation. |

### 6.2 Confinement des secrets

Les sous-agents ultracode ont par défaut **le même accès fichier que toi**. Ils peuvent lire
`.clasprc.json`, `.env`, `~/.config/gcloud/application_default_credentials.json` — et tout autre
porteur de credentials. Pire : un prompt injection planqué dans un fichier audité (ex : JSDoc
commenté dans le workflow §5.3, contenu d'un Doc Drive remonté par un agent) peut tenter
d'exfiltrer ces secrets via `WebFetch` ou un `curl` insoupçonné. Le fan-out multiplie la surface
d'attaque par le nombre d'agents.

Garde-fous à mettre dans `.claude/settings.json` pour les sessions ultracode :

- `permissions.deny` : `Read(~/.config/gcloud/**)`, `Read(.clasprc.json)`, `Read(.env)`, `Read(.env.*)`.
- `permissions.deny` : `Bash(curl*)`, `Bash(wget*)` — pas de canal sortant ad hoc.
- `WebFetch` : si tu l'utilises, **restreins par domaine allowlisté** (developers.google.com,
  code.claude.com, docs internes). Pas de WebFetch ouvert sur le run.

`gaslens doctor --secrets-scan` (à venir) détecte les fichiers porteurs de secrets non gitignorés
et les patterns de tokens dans les fichiers trackés — à exécuter avant tout fan-out écrivant.

`REGISTRY.md` contient des `scriptId`, projets GCP, URLs `/exec` : traite-le comme **donnée
semi-confidentielle**. Ne le commit pas dans un repo public, et ne le donne pas à un sous-agent qui
a aussi `WebFetch` sur des domaines non allowlistés.

---

## 7. Coût & jaugeage

Un workflow lance beaucoup d'agents → un run consomme **bien plus** de tokens que la même tâche en
conversation, et compte dans tes limites comme une session normale. Réflexes :

- **Une tranche d'abord.** Lance sur **une seule app** avant le parc entier ; la vue `/workflows`
  montre la conso par agent en temps réel, et tu peux **stopper sans perdre** le travail déjà fait.
- **Caps de sécurité.** Le runtime borne à 16 agents concurrents et 1 000 agents par run — ça limite
  le coût d'un script qui partirait en boucle.
- **Modèle par étape.** Pour les phases qui n'ont pas besoin du modèle le plus fort (collecte,
  inventaire), demande explicitement un modèle plus léger dans ton prompt.
- **Worktrees isolés.** Les fan-outs qui écrivent tournent dans des worktrees séparés : ton arbre de
  travail (et tes tests verts) ne sont pas écrasés. C'est un filet, pas une dispense de revue.

---

## 7.bis Diagnostiquer un run cassé

**Logs.** `/workflows` → sélectionne le run → Entrée pour le détail. Les transcripts complets sont
sous `.claude/projects/<projet>/subagents/workflows/<run-id>/`. Les fichiers `agent-*.jsonl`
contiennent un événement par tool call — c'est la source primaire pour comprendre où ça a coincé.

**Checkpoints.** Pour les workflows écrivants, exige que chaque agent écrive un fichier
`resultats/<app>.json` après chaque étape importante (cartographie terminée, application terminée,
tests verts). Un crash de l'agent 8/12 ne perd alors que l'agent 8, pas les 7 d'avant — et tu peux
reprendre exactement où ça s'est arrêté.

**Replay partiel.** `Workflow({scriptPath, resumeFromRunId: <id>})` rejoue uniquement les agents
non terminés du run précédent. Combiné aux checkpoints, ça transforme un crash à mi-course en
incident local plutôt qu'en perte sèche.

**Timeouts.** Chaque appel `agent()` peut être encadré par un timeout côté orchestrateur. Pour un
parc de 30 apps, prévois un **budget temps par agent** (ex : 5 min) + un **cap global au workflow**
(ex : 60 min) — sinon un agent bloqué sur un prompt mal cadré peut tirer tout le run en longueur.

**Triage premier-crash.** Lire les 3 dernières lignes de chaque `.jsonl` d'agent qui n'a pas
`state: done`, identifier les patterns récurrents (rate limit, fichier introuvable, test cassé,
OOM). Un seul mode d'échec qui touche 5 agents = bug systémique du prompt, pas malchance.

---

## 8. Boucle d'amélioration continue

1. **Logue les manques.** Quand un workflow révèle un trou récurrent de GasLens lui-même, fais
   `gaslens request add "<le manque>"` — le canal d'auto-évolution dédup par fréquence et te
   priorise quoi améliorer (`gaslens request list`).
2. **Capitalise les bons workflows.** Dès qu'un run fait exactement ce que tu veux, sauve-le en
   commande (`s` dans `/workflows`) dans `.claude/workflows/` pour le partager au repo.
3. **Rejoue à chaque release.** Les audits §5.1 (env) et §5.3 (doc) et la veille §5.4 sont faits
   pour tourner avant chaque promotion : c'est leur rejouabilité qui fait la valeur.

---

## 9. Annexe — cheat-sheet

```text
# Activer pour une seule tâche (recommandé pour le GAS) :
ultracode: <ta tâche parc-wide>

# Activer pour la session entière (rare ; pense à redescendre après) :
/effort ultracode
/effort high                      # ← revenir au travail de routine

# Workflow bundled de recherche croisée :
/deep-research <question>

# Suivre / piloter les runs :
/workflows                        # liste runs ; Entrée pour le détail
#   p = pause/reprise · x = stop · s = sauver en commande · Ctrl+G = ouvrir le script

# Désactiver les workflows (si besoin) :
/config → Dynamic workflows off   # ou "disableWorkflows": true dans settings.json

# Préparer le terrain avant un fan-out :
gaslens workspace overview --format registry --write REGISTRY.md   # plan de masse (le flag --write doit être présent)
gaslens workspace overview                     # vue parc (env validate + doc)
gaslens map --format text                      # table des matières (~300 tokens)
gaslens doctor                                 # tout doit être vert d'abord
```

---

### Rappel final

Ultracode ne remplace ni le hook, ni Chrome MCP, ni ton jugement sur la sémantique métier. Il
**amplifie la couverture** sur des tâches parc-wide, à condition que le terrain soit préparé
(plan de masse, allowlist, CLAUDE.md dense) et que les angles morts du statique (dispatch dynamique,
unités, logique métier) restent vérifiés en L2 et sous gate humain en L3. Préparé ainsi, tu obtiens
le meilleur des deux mondes : la puissance du fan-out **sans** sacrifier la doctrine « ne jamais
bluffer une certitude » qui fait la fiabilité de ton outillage.
