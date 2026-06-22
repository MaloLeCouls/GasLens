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

### Façade — le Google Site comme routeur de présentation (V4 §26)

Les utilisateurs voient toujours une page du Site, jamais l'URL `/exec` brute.
Le Site est la **couche de routage** : chaque page embarque un `/exec` PROD via
son deployment ID stable. Documenter ici la correspondance page ↔ déploiement :

| Page du Site | Déploiement embarqué (deployment ID) | Webapp |
|---|---|---|
| `/accueil` | `AKfycb… (prod)` | {{APP}} |

Promouvoir = republier sur le **même** deployment ID (skill `promote-deploy`) →
le Site sert la nouvelle version sans aucune modification ; l'URL ne change pas.

### Faits volatils côté client (ne pas les mettre en commentaire — V4 §25)

La signature et la shape de retour des fonctions `google.script.run` sont
dérivables et volatiles : ne les fige pas dans des commentaires. Régénère-les et
référence-les depuis le client :

```bash
gaslens emit-dts > apps/{{APP}}/client/gaslens.d.ts
```

Puis, en tête du `.html`/`.gs.html` client (ou via `tsconfig.json → files`) :

```js
/// <reference path="./gaslens.d.ts" />
```

`tsc` côté client checke alors l'existence de la fonction serveur, l'arité, et
les champs lus sur le retour — sans une seule métadonnée écrite à la main.
