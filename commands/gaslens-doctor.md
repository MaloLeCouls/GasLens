---
description: Lance gaslens doctor et aide à régler les prérequis manquants
---

Lance `gaslens doctor --format text` à la racine du workspace courant et
présente le résultat.

Pour chaque check `error` ou `warn`, propose l'action de correction (le
`fix_hint`) et, si c'est sûr et que l'utilisateur le souhaite, exécute-la
(ex: `npm i -g @malolecouls/gaslens`, `clasp login`). Les checks `manual`
(API Apps Script, Chrome remote-debugging) ne peuvent pas être vérifiés
hors-ligne : rappelle-les sans prétendre les valider.

Ne touche à rien d'autre : doctor est en lecture seule sur l'environnement.
