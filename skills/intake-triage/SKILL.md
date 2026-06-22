---
name: intake-triage
description: Trie les demandes entrantes d'un workspace GAS (dossier backlog/) — de inbox vers triaged ou archive, avec qualification (app cible, type, effort, risque). Utilise cette skill quand l'utilisateur dépose une demande/idée/bug à classer, ou demande de faire le point sur le backlog.
---

# intake-triage — qualifier le backlog

Le workspace a un dossier `backlog/{inbox,triaged,archive}/` (généré par
`gaslens workspace init`). Cette skill amène une demande de `inbox` à `triaged`.

## Procédure

1. **Lire** la demande brute dans `backlog/inbox/`.
2. **Qualifier** :
   - **app cible** (une entrée de `gaslens.workspace.json` → `apps[]`) ;
   - **type** : feature | bug | refactor | data | infra ;
   - **effort** : S | M | L (heuristique) ;
   - **risque** : touche-t-il un entry point déployé, une lib partagée, ou des
     ressources prod ? (`gaslens deploy-aware`, `gaslens map`).
3. **Écrire** une fiche normalisée dans `backlog/triaged/<slug>.md`
   (titre, app, type, effort, risque, critères d'acceptation).
4. **Archiver/supprimer** la demande brute si traitée
   (`backlog/inbox` et `backlog/archive` sont gitignored).

## Sortie

Une fiche actionnable par la skill `onboard-app` (si app nouvelle) ou
`gas-dev-loop` (si app existante). Ne décide pas seul d'une promotion : c'est
toujours un gate humain.
