# Audit ultracode du playbook ultracode-gas-playbook.md

> Audit multi-agents (13 agents, 603k tokens, 4 phases — Inventory → Verify → Review → Synthesis)
> contre l'etat reel du repo GasLens. Source : run `wf_99e93a86-e12`.

## TL;DR
- Playbook globalement solide et doctrinalement aligne avec GasLens, mais comporte 3 inexactitudes factuelles bloquantes et des trous de securite/reproductibilite serieux : **7/10**.
- **Action 1 : corriger les inexactitudes CLI** (`--project <app>/<env>` n'existe pas ; categories `prod-truth` incompletes ; version `Opus 4.8` discutable).
- **Action 2 : resoudre la collision semantique du label `L0`** qui designe deja le contexte permanent dans `gas-lens-conception-4` (ligne 114) et non ultracode.
- **Action 3 : ajouter les garde-fous securite manquants** (confinement secrets, deny rules contre wrappers/exfiltration, pre-flight `git status`, anti-runaway).

## Findings critiques (HIGH)

- **[Collision de label L0]** (lignes 29-31, 33) — Le playbook reassigne `L0` a "ultracode fan-out", mais `gas-lens-conception-4-conventions-et-articulation.md:114` definit deja `L0 = CLAUDE.md + manifeste maitre (contrat de confiance, contexte permanent)`. Cree une contradiction frontale avec la doctrine. **Correction** : renommer en `LX` ou `L0-bis` ; ou inserer un schema explicite `L0=contexte, L1=hook, L2=feature, L3=prod, LX=ultracode parc-wide`.

- **[Syntaxe CLI inexacte `gaslens env validate --project <app>/<env>`]** (ligne 158) — La CLI reelle (`src/cli.ts:1468-1471` + `src/env-validate.ts:164-166`) attend DEUX flags separes : `--project <app> --env <env>`. La syntaxe slash n'est pas parsee. **Correction** : remplacer par `gaslens env validate --project <app> --env <env> --compact`.

- **[Categories `prod-truth` incompletes]** (lignes 216-217) — Le playbook liste 4 categories (`confirmed_dead, dispatched_dynamic, errored, live`) mais `src/prod-truth.ts:82-85` en emet 6 : il manque `cold_exposed` et `unknown`. Un agent peut classer a tort ou ignorer. **Correction** : completer la liste et preciser le traitement de `cold_exposed` (expose mais sans hit recent → NE PAS supprimer, fenetre a elargir) et `unknown` (donnee insuffisante → suspected_dead).

- **[Acronymes L0/L1/L2/L3 jamais definis explicitement]** (lignes 25-35) — Le schema ASCII est lisible mais sans glossaire ; convention de numerotation inversee. **Correction** : ajouter un mini-glossaire en tete de section 0.

- **[BREAK utilise sans definition]** (sec 5.1, 5.2, 0 ligne 40) — Severite centrale jamais glosee dans le corps. **Correction** : encadre en debut de section 5 : "BREAK = regression structurelle certaine ; WARN = anomalie probable a confirmer ; INFO = signal contextuel".

- **[Doctrine 'ne jamais bluffer' non verifiable a posteriori]** (lignes 8-10, 161, 303) — Aucun mecanisme operationnel pour detecter qu'un sous-agent a invente un finding ou paraphrase du code en JSDoc. **Correction** : imposer un format de sortie verifiable (file:line + sha + citation + regle gaslens) et une etape `gaslens audit-findings <run.json>` qui rejoue chaque finding contre la baseline.

- **[Allowlist §3.1 contournable]** (lignes 86-100) — Prefixes ouverts permettent : (a) shim Bash qui spawn clasp/curl, (b) chainage `gaslens scan && clasp push`, (c) flag interdit accole a une commande autorisee (`gaslens env validate --use-apps-script-api`). **Correction** : ajouter des `deny` rules explicites (`Bash(clasp push*)`, `Bash(*--use-apps-script-api*)`, `Bash(curl*)`, `Bash(*&&*)`, `Bash(*;*)`) et un hook PreToolUse qui rejette les tokens interdits dans toute commande resolue.

- **[Anti-runaway absent du tableau §6]** (sec 6 lignes 228-236 vs §7 ligne 247) — Caps mentionnes en §7 (16/1000) sont des limites runtime, pas des regles de prompt ; aucun garde contre recursion (`workflow qui lance ultracode`), retry infini sur rate-limit, fan-out en background pendant 30 min. **Correction** : ajouter `max_subagents`, `max_runtime`, `no_recursive_workflow`, check de progression toutes les 5 min.

- **[Fan-out qui ecrase du travail non commit]** (§7 ligne 250-251, §5.2 lignes 170-178) — "Worktrees isoles" est une *mention* dans le prompt, pas un guard machine. Pas de pre-flight `git status` exige. Pas de procedure de merge ni de resolution de conflits sur fichier partage (Core.gs consomme par 8 webapps). **Correction** : hook PreToolUse qui bloque le lancement si working tree sale ; partition explicite (un agent = un projet, JAMAIS deux agents sur le meme fichier) ; phase de merge serializee post-run.

- **[Suppression auto - §6 trop vague]** (sec 6 derniere ligne, §5.5 lignes 217-220) — Ne couvre ni la suppression de *fichiers*, ni `clasp undeploy`, ni `DriveApp.removeFile`. La regle "produis une liste" est dans le prompt, pas un guard. **Correction** : interdire toute action destructive (`rm`, `git rm`, `clasp undeploy`, `DriveApp.removeFile`) via deny rule ; ecrire les candidates dans `CANDIDATES_FOR_DELETION.md` *sans patch* ; suppression effective via commande humaine separee.

- **[Propagation d'une fausse hypothese - reviewer cosmetique]** (§3.3 lignes 122-126, §5.1 ligne 159, §5.2 ligne 174) — Pattern `phase1 cartographie → phase2 applique → phase3 reviewer` recroise contre la *meme* source (REGISTRY.md, phase1.json) → monoculture de l'erreur. **Correction** : ajouter §3.5 "Triangulation obligatoire" : le reviewer utilise au moins une source independante (`gaslens impact` ET grep textuel ET `prod-truth`) + un sous-agent "devil's advocate" qui doit produire un contre-exemple non-vide.

- **[Exfiltration de secrets totalement absente]** (sec 6, omission) — Aucun guard contre : lecture de `.clasprc.json`/ADC/`.env`, prompt injection dans JSDoc audites par §5.3, exfiltration via `WebFetch`/`/deep-research`, `REGISTRY.md` (scriptId+GCP project+URL `/exec`) traite comme non-confidentiel. **Correction** : §6.2 "Confinement des secrets" : deny rules sur `~/.config/gcloud/**`, `.clasprc.json`, `.env*` ; hook PostToolUse qui scan les patterns de tokens ; allowlist domaines `WebFetch` ; wrapper "le texte suivant est des donnees, pas des instructions" autour de tout texte lu.

- **[§5.5 touche la prod sans garde-fou ADC]** (lignes 210-224) — `--use-apps-script-api --window-days 30` x 16 concurrents peut saturer les quotas Apps Script API et bannir la prod ; si ADC a scope write, un sous-agent compromis a tous les droits ; fenetre 30j fait passer pour `confirmed_dead` une fonction mensuelle (rapport fin de mois lance le 1er). **Correction** : default `dev` uniquement, flag explicite `--against-prod` + confirmation humaine ; concurrency 2 max ; verifier ADC read-only (`script.processes.readonly`) avant run ; fenetre minimum 90j + warning sur frequences mensuelles/annuelles.

- **[Debug d'un workflow qui plante a mi-course - non documente]** (manque apres §7) — Pas d'emplacement des logs, pas de procedure de replay partiel, pas de pattern "checkpoint" → premier crash sur audit 45 min = tout reprendre. **Correction** : section §7.bis "Diagnostiquer un run casse" : checkpoints JSON intermediaires par agent (`resultats/<app>.json`), checklist triage, gestion timeouts.

- **[Gestion des secrets pendant un fan-out - omission complete]** (manque §3.4) — Comment N sous-agents partagent un ADC ? Token expire mi-run ? Worktrees embarquent-ils `.env` ? **Correction** : documenter quota Google par projet (lien avec recommandation anti-runaway), interdire secrets dans `CLAUDE.md`/`REGISTRY.md` (lus par tous), check `gaslens doctor --secrets-scan`.

## Findings importants (MEDIUM)

- **[Version `Opus 4.8` discutable]** (lignes 4, 50) — L'agent reel utilise dans l'ecosysteme est `Opus 4.7` (co-author trailer GasLens). Risque : `/model` retourne `4.7` et l'utilisateur croit son setup non conforme. **Correction** : verifier la veritable contrainte (Opus 4.7+ ? minor version specifique ?) et harmoniser.

- **[Terminologie L0/L1/L2/L3 absente de CLAUDE.md]** (lignes 25-35, 40, 116, 142, 165, 301-302) — Sigles utilises comme acquis mais nulle part dans `CLAUDE.md`. Un agent qui lit CLAUDE.md en priorite ne saura pas les decoder. **Correction** : soit introduire le mapping dans CLAUDE.md ("Invariants"), soit utiliser le vocabulaire reel ("hook PostToolUse", "promote-deploy") dans le playbook.

- **[Sec 0 promet "3 interdits", sec 6 en liste 5]** (lignes 38-42 vs 230-235) — Elargissement non annonce → un lecteur retient "3" et loupe 2 garde-fous. **Correction** : annoncer "5 interdits" en sec 0, ou separer "3 interdits non-negociables" et "garde-fous additionnels".

- **[CLAUDE.md du workspace : reference circulaire non clarifiee]** (§3.2 ligne 118-119) — Le playbook recommande `gaslens init --section claude-md --write` ; le CLAUDE.md du repo GasLens ouvre par "Ne PAS confondre avec le CLAUDE.md genere par gaslens init". **Correction** : ajouter en §3.2 "NB : il s'agit du CLAUDE.md du repo utilisateur, distinct du CLAUDE.md interne au repo GasLens."

- **[Reference a la skill `promote-deploy` non verifiee]** (ligne 232) — CLAUDE.md ligne 91 mentionne `scripts/deploy-prod.sh`, pas une skill `promote-deploy`. **Correction** : verifier dans `.claude-plugin/skills/` et harmoniser le nom.

- **[Prompt §5.1 - format de sortie non specifie]** (lignes 153-162) — "tableau app×env trie BREAK→WARN" sans format (markdown/CSV/JSON) ni traitement des findings hors liste connue. **Correction** : "tableau markdown, colonnes app | env | severity | code | fichier:ligne | fix_hint ; finding inconnu → section unknown_finding".

- **[Prompt §5.2 - placeholders `<fn>`/`<dsl>` sans grammaire]** (lignes 170-178) — `<dsl>` cryptique → invention plausible mais incorrecte. Verification "contrats client↔serveur" sans critere mesurable. **Correction** : documenter le DSL en encadre (`change-return-shape:-x,+y` | `remove-param:name` | `rename:newName` | `rename-param:old=new`) et pour la phase 3 → croiser via `gaslens inspect --client-calls` ; si verification UI requise, ESCALADER en L2 Chrome MCP.

- **[Prompt §5.3 - "fonction PUBLIQUE" non defini]** (lignes 187-194) — Toutes les fonctions GAS sont publiques par defaut. **Correction** : "publique = top-level dans fichier non prefixe `_internal_`, OU listee dans `gaslens.workspace.json/exports`". Donner exemples positifs/negatifs de JSDoc d'intention.

- **[Prompt §5.5 - critere de recoupement absent]** (lignes 213-220) — "QUE les confirmed_dead recoupes" - recoupes contre quoi ? Sans regle → recoupement tautologique. **Correction** : ET logique entre (a) prod-truth 30j = confirmed_dead, (b) aucun call site statique, (c) pas un point d'entree GAS, (d) `gaslens inspect --dynamic-entry-points` ne la liste pas.

- **[Vocabulaire `parc` (playbook) vs `workspace` (CLI)]** (16+ occurrences vs `gaslens workspace ...`) — Un agent peut chercher `gaslens parc ...`. **Correction** : ajouter en sec 0 "*parc* = *workspace GasLens* = ensemble multi-repo gere par gaslens.workspace.json", ou aligner sur "workspace".

- **[`Gate humain` jamais defini operationnellement]** (lignes 34, 232, 301) — Acceptation interactive `acceptEdits` peut etre prise pour un gate. **Correction** : "action manuelle hors-agent : l'humain tape lui-meme `gaslens promote-deploy <app>` ou `clasp deploy` apres lecture d'un rapport".

- **[Schema ASCII §0 inverse la convention de niveaux]** (lignes 23-36) — Direction de lecture ambigue, fleches non legendees. **Correction** : ajouter une legende explicite.

- **[Caps `16 / 1000` non sources, non rejoues dans CLAUDE.md]** (lignes 246-247) — Valeurs precises mais non datees. **Correction** : footnote source + date "Verifie le YYYY-MM-DD".

- **[Templates CLAUDE.md ne pointent pas vers REGISTRY.md]** (claim §3.2 lignes 113-114) — Le playbook prescrit ("doit pointer vers"), mais `templates/claude-md/root.md` et `src/init.ts:CLAUDE_MD_ROOT` ne le contiennent pas. **Correction** : soit completer les templates en amont, soit marquer la consigne comme "a ajouter manuellement".

- **[`REGISTRY.md` n'est pas un artefact ecrit par la commande]** (§3.1 lignes 69-71, cheat-sheet ligne 288) — `gaslens workspace overview --format registry` sort sur stdout : l'utilisateur doit rediriger. **Correction** : montrer `> REGISTRY.md` dans le cheat-sheet et dans le corps.

- **[Boucle d'amelioration §8 sans KPI]** (lignes 256-263) — "Capitaliser les bons workflows" sans definition de "bon". **Correction** : 4 KPI minimum (precision/efficience/wall-time vs estimation/overlap_rate) ; commande `gaslens workflow report <run-id>`.

- **[Idempotence des workflows ecrivants non garantie]** (§5.2, §5.3) — Relance apres crash partiel → re-ajout de JSDoc en doublon, re-application de migration. **Correction** : clause d'idempotence obligatoire dans chaque prompt d'ecriture, tag `// @migration:Core.fn:v2`, test "relance immediate = 0 ecriture".

- **[Integration CI/CD absente]** (manque §10) — Playbook 100% interactif. **Correction** : tableau "declencheur → workflow → blocking?" (pre-commit, PR check, nightly, pre-release) + mode `--dry-run --json` + interdiction L3 en headless.

- **[Comparaison cout-benefice quantifiee vs `/effort high` manquante]** (§4) — "Coche au moins 3" qualitatif → sur/sous-utilisation. **Correction** : modele simple + tableau decisionnel `<3 projets → high ; 3-8 → mixte ; >8 → ultracode`.

- **[Persistance malicieuse entre runs non couverte]** (§6 et §8) — Sous-agent compromis peut modifier `CLAUDE.md`, `.claude/settings.json`, hooks, workflows sauvegardes. **Correction** : deny Write sur `.claude/**` et `CLAUDE.md` pour tout sous-agent ultracode ; hook PostToolUse qui diff `.claude/` apres chaque run ; en §8, relire integralement tout workflow avant `s`.

- **[§5.2 cross-project sans transaction atomique]** — Si phase 3 detecte un echec, etats partiels dans N-1 worktrees + push potentiel sur clasp dev. **Correction** : interdire `clasp push` en phases 2/3 ; commande `gaslens workflow rollback <run-id>`.

- **[Audit trail des decisions d'agents absent]** (§7 et §8) — Impossible de tracer qui a fait quoi en cas d'incident. **Correction** : hook PostToolUse → `.gaslens/audit/<run-id>.jsonl` (timestamp, agent_id, tool, input_hash, output_hash, cwd) ; livrable obligatoire.

- **[Interdit "ultracode dans le hook" non enforce techniquement]** (§0 ligne 41, §6 ligne 231) — Regle ecrite, pas guard. **Correction** : `gaslens doctor` scanne `.claude/settings.json` et hooks pour les patterns `ultracode`/`xhigh` et echoue.

- **[Conditions §4 - seuil "au moins 3" arbitraire]** (lignes 130-138) — Non justifie ; criteres correles. **Correction** : "OBLIGATOIRE : case 2 + case 5 ; RECOMMANDE : 1 parmi {1,3,4}".

- **[Topologies de workflow (independant/pipeline/scatter-gather) non explicites]** (avant §5.1) — Chaque utilisateur reinvente le pattern. **Correction** : §5.0 avec 3 topologies canoniques + prompt-squelette pour chacune.

- **[Caps de securite §7 et flag plan payant - assertions externes non datees]** (lignes 50-52, 246-247, 285) — `Opus 4.8`, `v2.1.154`, `disableWorkflows`, plan Pro/Max : valeurs specifiques non verifiables depuis le repo. **Correction** : ajouter une date "Verifie le YYYY-MM-DD" et un pointeur vers la source officielle pour chacune.

## Findings cosmetiques (LOW)

- **[Inconsistance casse `BREAK` vs `break`]** (playbook §5.1 lignes 159-161 vs CLAUDE.md:30) — Le code emet probablement `break` minuscule. **Correction** : harmoniser sur minuscules + backticks.
- **[`finding-roi` ambigu (ROI vs roi?)]** (ligne 150) — **Correction** : "le finding a plus haut impact" ou expliciter le jeu de mots.
- **[ADC sans expansion]** (lignes 56-57, 222) — **Correction** : "ADC (Application Default Credentials, `gcloud auth application-default login`)" a la premiere occurrence.
- **[MCP sans definition]** (lignes 26, 53, 110, 298, 300) — **Correction** : glose "Chrome MCP = serveur Model Context Protocol exposant un navigateur Chrome".
- **[`parc` jamais defini formellement]** (30+ occurrences) — Cf. finding MEDIUM ; cosmetique si fix MEDIUM applique.
- **[Deux "tables des matieres" (parc REGISTRY.md vs projet `gaslens map`)]** (lignes 6 et 74) — **Correction** : "plan de masse" vs "index symbolique".
- **[Decalage de registre playbook coach vs CLAUDE.md spec]** (global) — Si statuts normatifs differents, l'expliciter en tete.
- **[`gaslens.workspace.json` vs `manifeste maitre` sans liaison initiale]** (lignes 54, 113-114, 154) — **Correction** : premiere occurrence "Manifeste maitre (`gaslens.workspace.json` a la racine du workspace)".
- **[Prompt §5.4 `/deep-research` portee temporelle floue]** (lignes 200-204) — **Correction** : dates absolues + exigence ≥2 sources independantes.
- **[Versioning des workflows sauvegardes]** (§8.2) — Header YAML (auteur, date, gaslens_version_min) + dossier `deprecated/`.
- **[Plugin install `gaslens@gaslens` vs package npm `@malolecouls/gaslens` non publie]** (§1 ligne 53) — Verifier `.claude-plugin/marketplace.json` ; documenter cas "installation locale".
- **[Allowlist user vs project]** (§3.1 ligne 88) — Preciser : "`.claude/settings.json` du workspace (project scope), pas `~/.claude/settings.json`".
- **[Auto-downgrade `/effort high` non automatise]** (§6 ligne 233) — Hook qui detecte `xhigh` actif sans Task() spawn → reminder.

## Verifications par categorie

### command-verification (35 verdicts)
**Stats : 19 confirmed / 1 inaccurate / 0 aspirational / 15 unverifiable.**
- **Confirme** : toutes les commandes `gaslens *` du playbook existent litteralement (`scan`, `map`, `inspect`, `impact`, `diff`, `check`, `env validate`, `doc lint`, `manifest`, `validate-api`, `workspace overview`, `workspace init`, `doctor`, `prod-truth`, `request add/list`, `init --section claude-md --write`, `--use-apps-script-api` sur resolve-live/prod-truth/deploy-aware avec mention "ADC requis, hors hook chaud"). Sources : `src/cli.ts:107,236,296,364,936,1035,1106,1158,1453,1489,1567,1574,1600,1620,1679,1703,1748`.
- **Inexact (c25, ligne 158)** : `gaslens env validate --project <app>/<env>` n'est pas parse ; la CLI attend `--project <app> --env <env>` (cf. `src/cli.ts:1468-1471`).
- **Unverifiable (c1, c2, c3, c10, c28, c30, c31, c32, c35)** : commandes built-in Claude Code (`/model`, `claude --version`, `/config`, `/permissions`, `/deep-research`, `/workflows`, `/effort`, `disableWorkflows`). Plausibles ; non testables depuis le repo.

### doctrinal_coherence (45 verdicts)
**Stats : 41 confirmed / 1 inaccurate / 0 aspirational / 3 unverifiable.**
- **Inexact (C005, lignes 29-31)** : reassignation de `L0` a ultracode contredit `gas-lens-conception-4-conventions-et-articulation.md:114` qui definit `L0 = CLAUDE.md + manifeste maitre`. Severite haute.
- **Confirme avec nuance (C002, lignes 20-21)** : positionnement de la "zone de pertinence" coherent mais le label `L0` parasite la doctrine officielle.
- **Confirme (C001, C003, C004, C006-C008, C012-C034, C037-C038, C041-C045)** : toute la doctrine "break sacre", "ne jamais bluffer", "topologie 2-env", "cross_env_leak finding-roi", "L1=hook statique", "L3=gate humain", "ADC hors hook", "request add/list dedup par frequence" est restituee fidelement (citations litterales de CLAUDE.md:28-31, 87-94, 151-154 et README.md:155-159, 258-262, 299, 311).
- **Unverifiable (C009, C010, C011, C031, C036, C039, C040)** : regles ergonomiques ultracode (`/effort` discipline, caps `16/1000`, worktrees, Opus 4.8) qui sont propres au runtime externe.

### artifacts-and-commands-existence-check (27 verdicts)
**Stats : 20 confirmed / 0 inaccurate / 1 aspirational / 6 unverifiable.**
- **Aspirational (C11, lignes 113-114)** : "Le CLAUDE.md doit pointer vers REGISTRY.md et gaslens.workspace.json" - aucun des templates (`templates/claude-md/root.md`, `src/init.ts:CLAUDE_MD_ROOT`, `src/workspace-init.ts:rootClaudeMd`) ne pointe vers REGISTRY.md.
- **Inexact (C22, lignes 216-217)** : 4 categories `prod-truth` listees au lieu des 6 reelles (`src/prod-truth.ts:82-85` : ajoutez `cold_exposed`, `unknown`).
- **Confirme avec nuance (C3, C25)** : `gaslens workspace overview --format registry` produit la sortie sur stdout ; l'utilisateur doit rediriger `> REGISTRY.md`. Le playbook le presente comme "artefact" sans la redirection.
- **Confirme avec nuance (C7)** : `.claude/settings.json` est bien cree par `workspace-init.ts` mais ne contient PAS de cle `permissions.allow` - l'allowlist gaslens-specifique reste a poser manuellement.
- **Unverifiable (C13, C24, C26, C27)** : convention `.claude/workflows/`, cle `disableWorkflows` : conventions Claude Code hors perimetre gaslens.

### external_quantitative_references (28 verdicts)
**Stats : 6 confirmed / 0 inaccurate / 0 aspirational / 22 unverifiable.**
- **Confirme (C07, C08, C09, C23, C24, C25, C26, C27)** : tout ce qui touche au code gaslens (Node>=22 dans `package.json:31-33` et `doctor.ts:58`, ADC dans `doctor.ts:107`/`249-251`, `--use-apps-script-api` ADC requis, `init --section claude-md --write`, `clasp deploy` standard, `chrome-devtools-mcp` configure dans `.mcp.json`, `/plugin install gaslens@gaslens` litteral dans README.md:45).
- **Unverifiable mais plausible** : `Opus 4.8` (C01, C04), `Claude Code >= v2.1.154` (C05), caps `16/1000` (C15), keybindings TUI workflows `p/x/s/Ctrl+G` (C20), cle `disableWorkflows` (C21). Toutes externes au repo, plausibles, non datees.

## Trous identifies

Sections additionnelles a creer (par priorite) :

1. **§6.2 Confinement des secrets** (HIGH) — deny rules ADC/.env/.clasprc, scan PostToolUse des outputs, allowlist domaines `WebFetch`, traitement de `REGISTRY.md` comme secret.
2. **§3.4 Pre-flight obligatoire pour workflows ecrivants** (HIGH) — hook `git status` propre, cwd worktree impose par l'orchestrateur, rapport post-run avant merge.
3. **§3.5 Triangulation obligatoire** (HIGH) — au moins 2 sources independantes par finding, sous-agent "devil's advocate".
4. **§3.7 Audit trail** (MEDIUM-HIGH) — `.gaslens/audit/<run-id>.jsonl` obligatoire, livrable de chaque run.
5. **§7.bis Diagnostiquer un run casse** (HIGH) — logs, checkpoints JSON intermediaires, replay partiel, gestion timeouts.
6. **§5.0 Topologies de workflow (fan-out / pipeline / scatter-gather)** (MEDIUM) — schemas + prompt-squelettes.
7. **§10 Integration CI/CD** (MEDIUM) — tableau "declencheur → workflow → blocking" ; interdiction L3 en headless ; auth via Workload Identity Federation.
8. **§4.bis Break-even ultracode vs `/effort high`** (MEDIUM) — modele quantitatif + tableau decisionnel.
9. **§8.4 KPI / post-mortem** (MEDIUM) — 4 KPI minimum + `gaslens workflow report`.
10. **§3.6 Auto-downgrade `/effort`** (LOW) — reminder apres N min sans Task() spawn.
11. **§5.bis Idempotence des workflows ecrivants** (MEDIUM) — clause obligatoire dans chaque prompt + test "relance = 0 ecriture".
12. **§8.2 enrichi : versioning des workflows sauvegardes** (LOW) — header YAML, dossier `deprecated/`.

## Conclusion

Le playbook est **utilisable en interactif sur un parc maitrise**, apres correction des trois inexactitudes factuelles (syntaxe `env validate`, categories `prod-truth`, version Opus) et resolution de la collision de label `L0`. Il n'est **pas encore pret pour un usage prod multi-utilisateurs** : les omissions securite (secrets, anti-runaway, pre-flight `git status`, persistance malicieuse) et l'absence de verifiabilite a posteriori de la doctrine "ne jamais bluffer" creent des risques operationnels reels. Priorite absolue avant diffusion : corriger les HIGH factuels, ajouter §6.2 / §3.4 / §3.5 / §7.bis, et reformuler le label `L0`. Les findings MEDIUM peuvent suivre en V2 du playbook.
