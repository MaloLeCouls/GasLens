# Workspace {{NOM}} (Google Apps Script, piloté par agent)

Analysé par **gaslens** (le *cerveau* : vérité statique, zéro effet de bord).
Casting (V4 §26) : gaslens = cerveau, clasp = mains (push/deploy), Chrome
DevTools MCP = yeux (exécution réelle). Source de vérité du parc :
`gaslens.workspace.json` — *lue* par gaslens, *écrite* par les skills.

## Contrat de confiance

À chaque édition de `.gs`/`.html`, le hook PostToolUse lance le pipeline
`gaslens check` complet (diff + manifest + API + lint + doc + env). Un BREAK
(régression structurelle ou `env.cross_env_leak`) est ré-injecté dans ta boucle.
Tu n'as pas à re-vérifier ces points à la main.

Deux environnements : `dev` (lib HEAD, ressources dev) et `prod` (lib figée,
ressources prod). `gaslens env validate` garantit leur alignement.

## Mémoire vivante

<!-- Décisions durables, pièges, conventions locales du parc. -->
