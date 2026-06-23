---
name: promote-deploy
description: Promeut une feature validée en DEV vers la PROD d'une app GAS — versionne et déploie sur le MÊME deployment ID stable (le Google Site ne change pas). Cadence L3, sous GATE HUMAIN obligatoire (V4 §28). Utilise cette skill seulement quand la feature a passé l'inner loop ET la vérification MCP en DEV, et que l'utilisateur autorise explicitement la promotion.
---

# promote-deploy — promouvoir en prod (gate humain)

Cadence L3 (V4 §27) : le **seul** moment qui touche la prod. Grâce au Site +
deployment ID stable, c'est une **republication**, pas une reconfiguration.

## Préconditions (toutes requises)

- La feature a passé l'**inner loop** (hook CLEAN) ET la **vérification MCP** en
  DEV (pas de régression sémantique observée).
- `gaslens env validate --env prod` est **CLEAN** (lib figée, pas de fuite
  inter-env).
- `gaslens deploy-aware --use-apps-script-api` : tu sais quel déploiement live
  est touché.
- **L'utilisateur autorise explicitement** la promotion (gate humain — ne jamais
  l'inférer).

## Procédure

1. `clasp push` vers le **projet PROD**.
2. `clasp version "<note de promotion>"` → nouvelle version figée (numéro `<v>`).
3. `clasp deploy --deploymentId <ID stable> --versionNumber <v>` :
   republie sur le **même** deployment ID → le `/exec` ne change pas d'URL.
4. **Si l'app promue est la bibliothèque mère** (ou si la promotion publie une
   nouvelle version de la lib partagée) : **mettre à jour `library.prod_version`**
   dans `gaslens.workspace.json` avec le nouveau `<v>`, et aligner la `version`
   figée dans les `appsscript.json` des consommateurs prod. Sinon le manifeste se
   périme et `env validate --env prod` criera à tort (ou l'agent oublie en silence).
5. Vérifier que la lib prod pointe la **version figée** attendue
   (`gaslens env validate --env prod` → CLEAN).
6. Le **Google Site** sert automatiquement le nouveau `/exec` — aucune modif du
   Site nécessaire.

## Après

Snapshot de l'état promu (skill `snapshot-sources`) pour la traçabilité.
