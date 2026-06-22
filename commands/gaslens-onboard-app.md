---
description: Onboarde une nouvelle app GAS dans le workspace (interview + scaffolding dev/prod)
argument-hint: [nom-app]
---

Intègre une nouvelle app Google Apps Script au parc en suivant la skill
**onboard-app**.

Déroule l'interview (webapp et/ou lib ? préfixe d'exposition ? ressources
logiques ? script IDs existants ou à créer ?), puis scaffolde les deux projets
`dev`/`prod`, mets à jour `gaslens.workspace.json` (entrée `apps[]` +
`environments.<env>.resources`), copie le fragment `templates/claude-md/app.md`
en `apps/<app>/CLAUDE.md`, construis la baseline (`gaslens scan`) et valide avec
`gaslens env validate apps/<app>/prod` (doit être CLEAN).

Nom d'app éventuel en argument : $ARGUMENTS. Termine en proposant
`/gaslens` provision-env pour isoler les ressources de dev.
