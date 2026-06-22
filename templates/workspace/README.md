# templates/

Gabarits **de référence** émis/copiés lors du scaffolding d'un workspace.

- `workspace/` — structure de référence d'un workspace (le scaffolder
  `gaslens workspace init` génère l'arborescence réelle ; ces fichiers
  documentent l'intention).
- `claude-md/` — fragments `CLAUDE.md` réutilisables :
  - `root.md`    — racine du workspace (contrat de confiance + accueil).
  - `app.md`     — une app (entry points, ressources, préfixe de lib).
  - `project.md` — un projet `dev`/`prod` d'une app.

Le générique (ces gabarits) est versionné dans le plugin ; le scaffolder les
matérialise dans le repo du workspace pour édition locale (V5 §36).
