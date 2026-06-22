---
name: snapshot-sources
description: Capture un instantané des sources GAS d'un ou plusieurs projets (clasp pull + index gaslens horodaté) pour disposer d'une baseline de comparaison. Utilise cette skill avant un refactor risqué, avant une promotion, ou pour figer un point de référence du parc.
---

# snapshot-sources — figer une baseline

Un snapshot = l'état des sources + l'index gaslens à un instant T, pour pouvoir
comparer (`gaslens diff`) ou revenir.

## Procédure

1. `clasp pull` dans le(s) projet(s) ciblé(s) pour récupérer l'état HEAD réel.
2. `gaslens scan <projet> -o <projet>/.gaslens/snapshot-<label>.json`
   (label = date ou nom de milestone — la date est fournie par l'environnement,
   pas inventée).
3. Optionnel : comparer à une baseline existante —
   `gaslens diff --from <baseline> --to <snapshot>`.

## Usages

- **Avant refactor** : snapshot → refactor → `gaslens diff` pour voir l'impact réel.
- **Avant promotion** : capturer l'état exact promu (traçabilité).
- **Cadence L4** : snapshot périodique du parc.

N'écrit rien côté Google ; lecture seule (clasp pull) + index local.
