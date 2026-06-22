## App {{APP}} (GAS)

Préfixe de librairie exposé (si lib) : `{{LIB_PREFIX}}` — les appels
`{{LIB_PREFIX}}.fn()` depuis les autres projets sont résolus par gaslens.

Entry points web : `doGet` / `doPost` (cf. `gaslens inspect doGet`).
Fonctions privées : suffixe `_` (non appelables par `google.script.run`).

### Environnements (modèle « hard » : 2 projets par webapp)

- `dev`  → `apps/{{APP}}/dev`  : lib en HEAD, ressources de dev.
- `prod` → `apps/{{APP}}/prod` : lib figée, ressources de prod, deployment ID stable.

Ressources (Sheets/Forms/dossiers) : **jamais en dur** dans le code — passer par
Config/Script Properties scopées à l'environnement (`gaslens env validate`
attrape `env.cross_env_leak` et `env.hardcoded_resource`).

### Façade

Le Google Site embarque le `/exec` PROD. Promouvoir = republier sur le même
deployment ID ; le Site ne change pas.
