---
name: refresh-dev-data
description: Rafraîchit les données de dev d'une app GAS par lignes (pas par fichier) depuis la prod, avec scrub des données personnelles (PII). Hygiène de fond hebdomadaire (V4 L4), n'écrit JAMAIS vers la prod. Utilise cette skill quand les données de dev sont périmées et qu'il faut les ré-aligner sur une copie scrubée de la prod.
---

# refresh-dev-data — sync hebdo dev ← prod (scrubbé)

Cadence L4 (V4 §27) : hygiène de fond, à part du flux d'édition. Écrit en **dev
uniquement**.

## Procédure

1. **Lire** les lignes source en **prod** (Sheets API, lecture seule).
2. **Scrub PII** : anonymiser emails, noms, identifiants directs avant écriture
   (remplacement déterministe ou masquage). Documenter les colonnes scrubées.
3. **Écrire par lignes** dans la Sheet **dev** (`environments.dev.resources`) —
   pas de copie de fichier (préserve les IDs dev et les liaisons Form).
4. **Snapshot** éventuel des sources avant/après (skill `snapshot-sources`).

## Garde-fous

- **Jamais** d'écriture prod. La direction est strictement prod → dev.
- La cible dev est résolue via le manifeste maître, pas en dur.
- Tâche périodique : ne pas la mêler à une feature en cours.
