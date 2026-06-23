---
name: request-evolution
description: Logue un besoin d'évolution de GasLens lui-même — quand l'agent refait à la main une analyse que l'outil pourrait câbler, bute sur un garde-fou absent, ou aimerait une commande/un check qui n'existe pas. Utilise cette skill (ou directement `gaslens request add`) dès qu'un manque RÉCURRENT de l'outillage apparaît pendant le travail, au lieu de le subir en silence.
---

# request-evolution — faire grandir GasLens par l'usage

GasLens est le *cerveau* anti-régression. Quand, en travaillant, tu constates
qu'il te **manque** quelque chose côté outil — pas côté webapp — logue-le. La
fréquence des demandes priorise les évolutions : l'outil s'adapte à la prod et à
l'usage réels.

> ⚠️ À ne pas confondre avec le backlog `inbox/triaged/archive` (= demandes
> **sur les webapps**). Ici on parle d'évolutions **de GasLens lui-même**.

## Quand loguer

- Tu **refais à la main** une analyse que GasLens pourrait matérialiser
  (ex: « j'ai dû grep tous les `CacheService.get` pour vérifier les clés »).
- Un **garde-fou déterministe** manque (ex: « rien n'a empêché le push prod »).
- Une **commande / un check** te ferait gagner des tokens ou éviterait une
  régression (ex: « j'aimerais un `consumer_kind` pour X »).
- Une sortie est **trop verbeuse / pas assez ciblée** pour un agent.

## Comment

```bash
gaslens request add "<besoin en une phrase>" \
  --kind check|command|perf|guardrail|doc|other \
  --context "<ce que tu faisais>" \
  --suggest "<consumer_kind ou commande envisagée>"
```

Le même besoin reformulé est **dédupliqué** (compteur d'occurrences ++). Pas
besoin de vérifier s'il existe déjà : logue, GasLens agrège.

## Revue (humain / mainteneur)

```bash
gaslens request list          # triées par fréquence — le haut = à câbler en premier
```

Les demandes les plus fréquentes deviennent un lot du `ROADMAP.md`. C'est la
boucle : usage → `gaslens request` → triage → nouvelle capacité en dur.
