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

Rappelle que le plugin gaslens (skills/hooks/commands/MCP) s'installe à part,
une fois, via `/plugin install gaslens@gaslens` — `workspace init` génère le
workspace, pas le plugin.
