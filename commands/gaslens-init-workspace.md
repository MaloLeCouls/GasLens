---
description: Scaffold un nouveau workspace GAS gaslens
argument-hint: <nom-du-workspace>
---

Crée un nouveau workspace GAS piloté par agent.

Exécute `gaslens workspace init $ARGUMENTS` (le nom du workspace est en
argument). Si aucun nom n'est fourni, demande-le d'abord.

Puis :
1. Rappelle les prochaines étapes affichées (`cd <nom> && claude`, accepter
   l'installation de la marketplace + du plugin, puis `gaslens doctor`).
2. Ne lance PAS `git init` toi-même si l'utilisateur l'a désactivé
   (`--no-git`) ; sinon le scaffolder s'en charge.
3. **Bootstrap du parc multi-webapp** : le manifeste scaffoldé est volontairement
   vide (pas de `library`). Si le parc aura une **bibliothèque partagée** (cas
   classique multi-webapp), demande à l'utilisateur son `script_id` + sa **version
   prod figée** (entier) et écris le bloc `library` dans `gaslens.workspace.json`.
   Confirme aussi les environnements voulus (par défaut `dev`/`prod`). `gaslens
   doctor` signalera `library: DORMANT` tant que ce n'est pas fait dès qu'une app
   exposera un `library_prefix`.

Rappelle que le plugin gaslens (skills/hooks/commands/MCP) s'installe à part,
une fois, via `/plugin install gaslens@gaslens` — `workspace init` génère le
workspace, pas le plugin.
