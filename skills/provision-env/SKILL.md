---
name: provision-env
description: Provisionne l'environnement dev d'une app GAS (V3) — copie des ressources prod vers dev (Sheets/Forms/dossiers), ré-liage du Form à sa Sheet de réponses, injection de la config (Script Properties scopées au projet). Utilise cette skill quand une app est onboardée mais que son env dev n'a pas encore ses ressources isolées.
---

# provision-env — isoler les données de dev

Le modèle « hard » (V4 §26) exige des ressources de dev distinctes de la prod,
référencées par Script Properties scopées au projet — jamais en dur.

## Procédure

1. **Copier** chaque ressource prod déclarée (`environments.prod.resources`)
   vers une copie dev (DriveApp/Sheets API) → nouveaux IDs.
2. **Ré-lier** : si l'app a un Form lié à une Sheet de réponses, recréer le lien
   Form→Sheet côté dev (sinon les soumissions de test polluent la prod).
3. **Déclarer** les nouveaux IDs dans `environments.dev.resources` du manifeste
   maître (mêmes noms logiques que prod — la symétrie est vérifiée par
   `env.undeclared_resource`).
4. **Injecter** la config : poser les Script Properties du **projet dev**
   (`PropertiesService.getScriptProperties()`) avec les IDs dev, lues par
   `Config.get()`.
5. **Valider** : `gaslens env validate --env dev` → CLEAN (pas de
   `cross_env_leak`, pas d'`undeclared_resource`).

## Garde-fou

Ne jamais pointer un projet dev vers une ressource prod (ni l'inverse) : c'est
exactement le `env.cross_env_leak` que gaslens bloque en L1.
