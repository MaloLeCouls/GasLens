---
description: Promeut une feature validée vers la PROD (gate humain, même deployment ID)
argument-hint: <app>
---

Promeut en PROD l'app `$ARGUMENTS` en suivant la skill **promote-deploy**.

C'est la cadence L3 (V4) — le SEUL moment qui touche la prod, sous **gate humain
obligatoire**. Avant toute action, vérifie les préconditions et NE PROMEUS PAS
sans confirmation explicite de l'utilisateur :

1. La feature a passé l'inner loop (hook CLEAN) et la vérification MCP en DEV.
2. `gaslens env validate --env prod` est CLEAN (lib figée, pas de fuite inter-env).
3. `gaslens deploy-aware --use-apps-script-api` : montre quel déploiement live
   sera touché.

Si tout est vert ET que l'utilisateur autorise : `clasp push` (projet prod) →
`clasp version` → `clasp deploy` sur le **même deployment ID stable** (le Google
Site ne change pas). Sinon, arrête-toi et explique ce qui bloque.
