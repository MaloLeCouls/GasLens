---
name: gas-dev-loop
description: La boucle de développement GAS de bout en bout (V4 §28) — inner loop gratuite (édition → hook gaslens) puis outer loop par feature (clasp push vers DEV → Chrome MCP pilote le /exec DEV). Utilise cette skill quand tu codes/refactores une fonctionnalité Apps Script dans un workspace gaslens et que tu veux la valider avant promotion.
---

# gas-dev-loop — coder une feature de bout en bout

Le principe (V4 §27) : chaque chose tourne à sa cadence ; plus c'est chaud, plus
l'effet de bord doit être nul.

## Inner loop (L1 — gratuit, DEV, ~instant)

1. **Avant d'éditer** une fonction serveur :
   `gaslens inspect <fn> --detail-level standard --compact`
   → callers, expositions, contrat de retour inféré (champs lus côté client).
2. **Édite** le `.gs`/`.html`.
3. Le **hook PostToolUse** lance le pipeline `gaslens check` complet
   (diff + manifest + API + lint + doc + env). 
   - **BREAK ?** → corrige selon les `fix_hint` ré-injectés, retour 2.
   - **CLEAN ?** → continue.

Tout ce que gaslens vérifie, ne le re-grep pas à la main. Ce qu'il ne voit PAS
(sémantique, unités, logique métier) reste à ta charge — c'est l'outer loop.

## Outer loop (L2 — par feature, DEV, effets réels)

4. `clasp push` vers le **projet DEV** (jamais prod).
5. **Chrome DevTools MCP** pilote le `/exec` DEV : clic, `fill_form`, `console`,
   `network`, `evaluate_script`. Confronte ce que le `successHandler` REÇOIT au
   contrat inféré par gaslens — une divergence = **régression sémantique**
   (la classe d'angle mort du statique).
6. Régression → retour inner loop. OK → la feature est prête à promouvoir
   (voir la skill `promote-deploy`, sous gate humain).

## Garde-fous

- DEV utilise des **données factices** : on exécute pour de vrai sans risque.
- Ne touche jamais la prod ici. La promotion est un acte séparé, sous gate.
