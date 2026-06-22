---
name: onboard-app
description: Onboarde une nouvelle app Google Apps Script dans un workspace gaslens — interview, scaffolding des deux projets dev/prod, clasp clone, mise à jour du manifeste maître et du CLAUDE.md d'app. Utilise cette skill quand l'utilisateur veut ajouter/intégrer une nouvelle app GAS au parc.
---

# onboard-app — intégrer une app au parc

Amène une app inexistante (ou existante côté Google) à un état géré par gaslens :
deux projets `dev`/`prod`, déclarée dans le manifeste maître, indexée.

## Interview (à mener avec l'utilisateur)

- Nom de l'app ; est-elle une **webapp** (`doGet`/`doPost`) et/ou une **lib** ?
- Si lib : préfixe d'exposition (`userSymbol`).
- Ressources logiques utilisées (Sheets/Forms/dossiers) → noms logiques.
- Existe-t-elle déjà côté Apps Script (script IDs) ou faut-il la créer ?

## Scaffolding

1. **`gaslens workspace add-app <app> [--library-prefix <X>]`** — crée
   `apps/<app>/{dev,prod}`, ajoute l'entrée `apps[]` au manifeste maître (2
   projets) et un `CLAUDE.md` d'app. Imprime les prochaines étapes.
2. `clasp clone <scriptId>` (ou `clasp create`) dans `apps/<app>/{dev,prod}`,
   puis **renseigner les `script_id`** dans `gaslens.workspace.json` (laissés
   vides par `add-app`, connus après le clone).
3. **Ressources** : déclarer par env dans `environments.<env>.resources`
   (provisionner les ressources dev via la skill `provision-env`).
4. **Index** : `gaslens scan apps/<app>/dev -o apps/<app>/dev/.gaslens/baseline.json`
   (sinon le hook reste silencieux pour ce projet — `gaslens doctor` le signale).
5. **Valider** : `gaslens env validate apps/<app>/prod` doit être CLEAN
   (lib figée en prod, pas d'id de ressource en dur).

## Suite

Provisionner les ressources dev → skill `provision-env`. Puis coder via
`gas-dev-loop`.
