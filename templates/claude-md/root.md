# Workspace {{NOM}} (Google Apps Script, piloté par agent)

Analysé par **gaslens** (le *cerveau* : vérité statique, zéro effet de bord).
Casting (V4 §26) : gaslens = cerveau, clasp = mains (push/deploy), Chrome
DevTools MCP = yeux (exécution réelle). Source de vérité du parc :
`gaslens.workspace.json` — *lue* par gaslens, *écrite* par les skills.

## Sources de vérité du parc

Deux fichiers font foi avant toute action :

- `gaslens.workspace.json` à la racine du workspace — le manifeste maître
  (topologie multi-app dev/prod, bibliothèque, environnements, ressources).
- `REGISTRY.md` à la racine du workspace — la cartographie scriptId / URLs
  `/dev` et `/exec` / embeds Sites par app et par environnement, générée par
  `gaslens workspace overview --format registry --write REGISTRY.md`. À
  régénérer après chaque changement de déploiement ou d'embed.

## Contrat de confiance

À chaque édition de `.gs`/`.html`, le hook PostToolUse lance le pipeline
`gaslens check` complet (diff + manifest + API + lint + doc + env). Un BREAK
(régression structurelle ou `env.cross_env_leak`) est ré-injecté dans ta boucle.
Tu n'as pas à re-vérifier ces points à la main.

Deux environnements : `dev` (lib HEAD, ressources dev) et `prod` (lib figée,
ressources prod). `gaslens env validate` garantit leur alignement.

## S'orienter dans le parc

`gaslens workspace overview` en un appel : apps × dev/prod, version de la
bibliothèque mère consommée, verdict `env validate` par app/env, couverture doc.
À lancer en début de session pour situer l'état du parc avant d'agir.

## Faire grandir l'outil (auto-évolution)

Si tu **refais à la main** une analyse que GasLens pourrait câbler, butes sur un
**garde-fou absent**, ou aimerais une commande/un check qui manque : logue-le
plutôt que de le subir en silence —
`gaslens request add "<besoin>" --kind check|command|perf|guardrail|doc`.
Les besoins récurrents (dédupliqués par fréquence) priorisent les évolutions de
l'outil. `gaslens request list` pour les revoir.

## Mémoire vivante

<!-- Décisions durables, pièges, conventions locales du parc. -->
