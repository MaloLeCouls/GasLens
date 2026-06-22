## Projet {{APP}} / {{ENV}}

Projet Apps Script concret (`script_id` dans `gaslens.workspace.json` →
`apps[].projects.{{ENV}}`). Cloné via clasp dans ce dossier.

- Environnement : **{{ENV}}**.
- Bibliothèque mère : {{ENV}} → {{ "HEAD (developmentMode)" si dev, "version figée" si prod }}.
- Ressources : lues via Config/Script Properties (jamais d'id en dur).

Avant d'éditer une fonction exposée comme librairie : des projets EXTERNES non
indexés peuvent l'appeler — `gaslens check` le signale en
`coverage.external_boundaries`. Prudence.
