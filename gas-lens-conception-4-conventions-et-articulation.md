# GAS-Lens — Volume 4

**Conventions de code agent-friendly + l'articulation complète de l'écosystème (qui tourne, quand, dans quel ordre).**

Complément des Volumes 1–3 et du document workspace. Deux objets ici :
1. **La convention « descriptions pour l'agent »** — ce qui va dans le JSDoc, ce qui n'y va *jamais*, et comment GasLens la maintient sans jamais écrire la prose à ta place (Partie 25).
2. **L'articulation de tout l'écosystème** — GasLens, le workspace, clasp, le MCP Chrome DevTools, le Google Site, la bibliothèque mère, le manifeste maître : qui occupe quelle position, à quelle cadence, et comment ils se passent la main (Parties 26–29).

Décisions de topologie actées dans ce volume (révision du V3 à la lumière du Google Site + de la sync hebdo) :
- **Deux environnements suffisent : `dev` et `prod`.** La « preprod » du V3 se dissout : le `/dev` donne un staging de code gratuit, le Site donne le routage de présentation.
- **Modèle « hard » (projets séparés) pour l'isolation des données.** Dès qu'on veut des données de dev isolées, il faut un projet `dev` et un projet `prod` par web app (Script Properties scopées au projet). La **bibliothèque reste unique** (dev→HEAD, prod→version figée).
- **Le Google Site est la couche de routage de présentation.** Les utilisateurs voient toujours du `/exec` ; promouvoir = republier sur le même deployment ID, le Site ne change pas.

---

## Partie 25 — La convention « descriptions pour l'agent »

### 25.1 Le principe directeur : intention durable dans le code, faits volatils à la demande

La règle tient en une ligne, et c'est la même frontière que `tsc`/GasLens (V2 §8) :

> **Une description ne porte que ce que le code ne dit pas ET que GasLens ne peut pas déduire.** Tout fait dérivable et volatil reste hors de la source ; l'agent le récupère frais via `gaslens inspect` ou `emit-dts`.

| Catégorie | Exemple | Où ça vit | Pourquoi |
|---|---|---|---|
| **Intention / sens métier** | « calcule la prime au prorata des jours travaillés » | **JSDoc** (écrit une fois) | non-dérivable du code ; c'est le *why* |
| **Unités / sémantique de valeur** | « durée **en secondes** », « statut ∈ {`ok`,`ko`} » | **JSDoc** | la couche que même `tsc` ne voit pas (V2 §10.4) |
| **Invariants / pièges** | « doit rester idempotent », « retour lu côté client — ne pas retirer `messageId` », « sensible à l'environnement » | **JSDoc** | avertissements durables ; sauvent l'agent |
| **Signature / types** | `(reportData: object, recipients: string[]) => {...}` | **`emit-dts`** (régénéré) | dérivable, volatil → sidecar, jamais à la main |
| **Lignes début/fin** | `email.gs:42–71` | **`inspect`** (à la demande) | change à *chaque* édition → périmé en commentaire |
| **Appels sortants / entrants** | appelle `formatReport`, appelé par `runWeeklyReport` | **`inspect --include callers,callees`** | dérivable, volatil → jamais en commentaire |
| **Shape de retour exacte** | `{success:boolean, messageId:string}` | **`inspect` / `emit-dts`** | dérivable ; le JSDoc n'en garde que le *sens* |

### 25.2 Pourquoi PAS de faits volatils dans les commentaires (l'erreur tentante)

Trois raisons, toutes issues des principes des volumes précédents :

1. **La péremption silencieuse.** « ligne 42 », « appelle X, Y » devient faux à la première édition. Une métadonnée périmée est *pire que pas de métadonnée* : elle trompe activement l'agent qui lui fait confiance (tout l'enjeu d'honnêteté du V1 §1.5). Le numéro de ligne est même auto-invalidant : l'écrire décale tout ce qui suit.
2. **La duplication.** GasLens fournit déjà ces faits, à jour. Les figer en commentaire, c'est maintenir deux sources de vérité dont une se trompe.
3. **Le gonflement du contexte.** Chaque lecture du fichier paie des tokens pour des faits interrogeables précisément — l'anti-pattern « force brute » du V1 §1.2 qui revient.

### 25.3 Ce qui est 100 % automatique : la détection, pas l'écriture

On n'auto-génère **pas** la prose d'intention : une description auto-écrite soit paraphrase le code (bruit), soit hallucine une intention absente. La partie utile est, par définition, non-dérivable. Ce qui est automatisable, c'est **repérer les manques et la dérive** — un nouveau sous-domaine GasLens, branché sur le hook `PostToolUse` comme `check` :

```
gaslens doc lint [<path>]
  --undocumented      liste les fonctions sans ligne d'intention (le "highlight")
  --drift             @param/@returns qui ne correspondent plus à la signature
  --stale-ref         description mentionnant un symbole/champ disparu
  --format json|text  (défaut: json ; "hook" pour ré-injection agent)
```

Findings (même grammaire `severity`/`fix_hint` que le V2) :

| Finding | Détecté par | Sévérité | `fix_hint` type |
|---|---|---|---|
| `doc.undocumented` | définition sans bloc JSDoc d'intention | `info`→`warn` | « ajouter une ligne décrivant le *pourquoi* / le sens métier » |
| `doc.param_drift` | `@param x` sans param `x` (renommé/supprimé) | `warn` | « mettre `@param` à jour : `x`→`y` » |
| `doc.return_drift` | `@returns` décrivant un champ que la shape ne produit plus | `warn` | « le retour ne contient plus `messageId` — corriger la doc ou le code » |
| `doc.stale_ref` | mention d'un symbole inexistant dans la description | `info` | « `oldHelper` n'existe plus — référence à corriger » |

Optionnel, si tu veux *aider* l'agent à rédiger sans rédiger à sa place : `gaslens doc stub <fn>` émet un **squelette** JSDoc (params/returns détectés, intention laissée vide à remplir) — l'agent/humain complète le seul champ non-dérivable.

### 25.4 La convention JSDoc minimale (à coller dans le CLAUDE.md)

```js
/**
 * Envoie le rapport hebdomadaire aux destinataires.            ← intention (REQUIS, le "why")
 * Idempotent : un second appel le même jour n'envoie rien.     ← invariant durable
 * @param {string[]} recipients  emails ; itérés, pas indexés.  ← sens, pas le type (emit-dts a le type)
 * @returns sens : succès + id de message LU CÔTÉ CLIENT        ← contrat sémantique, pas la shape exacte
 *          (dashboard.html) — ne pas retirer sans vérifier.
 */
```

Ce que ce bloc **ne contient pas** volontairement : numéros de ligne, liste d'appels, callers, arité, shape JSON complète. Tout ça → `gaslens inspect` / `emit-dts`, frais.

### 25.5 La navigation dans un fichier (la question « trier par ordre alphabétique »)

Ne **pas** réordonner les définitions source : churn de diff, brouille `body_fingerprint`, et l'ordre logique vaut mieux que l'alphabétique pour comprendre. À la place, **générer une vue** :
- défaut : `gaslens search --project <p> --kind function` donne la liste ordonnée/filtrable, fraîche ;
- si tu veux vraiment un repère *dans* le fichier : un bloc-sommaire auto-généré en tête (table alphabétique → ancres) qui **ne déplace aucune fonction**. À traiter comme un artefact régénéré (jamais édité à la main), au même titre que `emit-dts`.

---

## Partie 26 — L'articulation : le casting et ses positions

Cinq acteurs occupent cinq **positions** distinctes. Aucun ne fait le travail d'un autre — c'est ce qui les fait composer.

| Acteur | Position | Effets de bord | Ce qu'il possède en propre |
|---|---|---|---|
| **GasLens** | *Cerveau* — vérité statique | **Aucun** (déterministe) | le graphe ; les **deux axes d'environnement** (code via politique de version de lib ; ressources via la map du manifeste) ; les conventions doc |
| **clasp** | *Mains* — actionneur | réels (push, version, deploy) | l'acte de pousser / versionner / déployer |
| **Chrome DevTools MCP** | *Yeux* — vérité empirique | réels (exécute le code) | la couche **sémantique** que GasLens admet ne pas voir |
| **Google Site** | *Façade* — routage de présentation | aucun (embarque des URLs) | quelle déploiement les **utilisateurs** voient |
| **Bibliothèque mère** | *Noyau partagé* | — | le **levier d'isolation du code** : HEAD (dev) vs version figée (prod) |

Et deux artefacts non-acteurs mais structurants :
- **`gaslens.workspace.json`** (manifeste maître) : la source de vérité unique. *Lue* par GasLens, *écrite* par les skills de provisioning/onboarding.
- **La hiérarchie `CLAUDE.md` + les skills** : le contexte permanent et les procédures déclenchées. C'est ce qui dit à l'agent *sur quoi il peut s'appuyer* (le contrat de confiance) et *quelle procédure* lancer.

**Claude Code est le contrôleur** qui ferme la boucle entre les cinq.

---

## Partie 27 — Les cadences : ce qui tourne, et à quelle fréquence

Le point qui débloque l'articulation : **chaque chose tourne à sa propre cadence**, et plus la cadence est rapide, plus l'effet de bord doit être nul. On empile cinq couches, de la plus chaude (chaque frappe) à la plus froide (changement structurel).

```
CADENCE            CE QUI TOURNE                         EFFETS DE BORD   POSITION
──────────────────────────────────────────────────────────────────────────────────
L0  permanent      CLAUDE.md (hiérarchie) + manifeste    aucun            contexte
    (chargé)       maître → le "contrat de confiance"

L1  chaque         gaslens check  +  gaslens env         AUCUN            Cerveau
    édition        validate  +  gaslens doc lint         (déterministe)
    (~instant)     via hook PostToolUse                  → ré-injecté à l'agent si BREAK

L2  par feature    clasp push (→ projet DEV)             réels            Mains
    (s–min)        puis MCP pilote le /exec DEV          (exécute le      + Yeux
                   (clic, fill_form, console, network)   code, DONNÉES
                   → confronté au contrat inféré          DEV factices)

L3  par            promote-deploy : version + deploy      réels            Mains
    promotion      PROD sur le MÊME deployment ID         (touche la       + gate
    (gate humain)  → le Site sert la nouvelle version     prod)            HUMAIN

L4  périodique     refresh des LIGNES dev (prod→dev,      réels            hygiène
    (hebdo défaut) scrubbé) ; snapshot-sources ;          (écrit en dev    de fond
                   re-scan d'index éventuel               uniquement)

L5  structurel     onboard-app ; bump de version de       réels            occasionnel
    (occasionnel)  lib ; amendement manifeste ;           (variés)
                   "mémoire vivante" du CLAUDE.md
```

Lignes de force à retenir :
- **L1 est gratuit et permanent** : le cerveau gate *chaque* édition sans aucun effet de bord. C'est ce qui permet à l'agent d'arrêter de re-vérifier à la main.
- **L2 exécute pour de vrai → toujours en DEV, données factices.** C'est là, et seulement là, que les **régressions sémantiques** (que L1 ne peut pas voir) se font attraper par les Yeux.
- **L3 est le seul moment qui touche la prod, et il est sous gate humain.** Grâce au Site + deployment ID stable, c'est une republication, pas une reconfiguration.
- **L4/L5 sont de l'hygiène**, à part du flux d'édition, et n'écrivent jamais vers la prod.

---

## Partie 28 — La séquence de handoff (le trajet d'une feature, de bout en bout)

Comment les positions se passent la main pour une modification réelle. Chaque flèche est un passage de relais ; remarque que le cerveau gate *avant* que les mains agissent, et que les yeux vérifient *ce que le cerveau ne pouvait pas savoir*.

```
  [L0] manifeste + CLAUDE.md chargés  ──►  l'agent sait le contrat de confiance
        │
        ▼
  ┌─────────────────────── INNER LOOP (gratuit, DEV) ───────────────────────┐
  │  1. gaslens inspect <fn>        Cerveau : tout savoir avant de toucher   │
  │  2. éditer le .gs/.html         (l'agent)                                │
  │  3. hook PostToolUse  ─►  check + env validate + doc lint                │
  │        BREAK ?  ─► fix_hint ré-injecté ─► retour 2                       │
  │        CLEAN ?  ─► continuer                                             │
  └─────────────────────────────────────────────────────────────────────────┘
        │  (feature prête)
        ▼
  4. clasp push  ──►  projet DEV          Mains : le /exec DEV sert le code candidat
        │
        ▼
  5. MCP pilote /exec DEV                 Yeux : vrai navigateur, vraies conditions
        observe console / network /       → confronte ce que le successHandler REÇOIT
        evaluate_script                     au contrat inféré par GasLens
        │                                  (divergence = régression SÉMANTIQUE = signal)
        ▼
     régression ?  ─► retour inner loop
        │ OK
        ▼
  6. promote-deploy   ──►  GATE HUMAIN     Mains + humain
        version + deploy PROD (même deployment ID)
        │
        ▼
  7. le Google Site sert le nouveau /exec  Façade : utilisateurs à jour,
     (aucune modif du Site nécessaire)       URL inchangée
```

Le couplage non-évident, et précieux (étape 5) : `evaluate_script` du MCP lit **ce que le client a réellement reçu**, à confronter au **contrat que GasLens a inféré statiquement**. Quand les deux divergent, tu tiens une régression sémantique — exactement la classe que le statique admet ne pas voir (V2 §10.4 / workspace §11). Les Yeux comblent l'angle mort du Cerveau ; ce n'est pas redondant, c'est complémentaire par construction.

---

## Partie 29 — Les deux axes d'environnement, projetés sur le casting

Pour fermer la boucle avec le V3 : qui *possède* et qui *applique* chacun des deux axes.

| Axe | Possédé par | Appliqué à l'exécution par | Vérifié par |
|---|---|---|---|
| **CODE** (HEAD instable vs version figée) | la **bibliothèque** (politique de version) + le couple `/dev`÷`/exec` | clasp (push/deploy) + le manifeste de chaque webapp (`appsscript.json` → `libraries[].version`) | `gaslens env validate` → `env.library_version_mismatch` |
| **RESSOURCES** (Sheet/Form/dossier de dev vs prod) | le **manifeste maître** (`environments.<env>.resources`) | les **Script Properties** du projet (posées au provisioning) lues par `Config.get()` | `gaslens env validate` → `env.cross_env_leak`, `env.hardcoded_resource`, `env.undeclared_resource` |

Le désalignement des deux axes (du code prod figé pointant des ressources dev, ou pire l'inverse) est précisément ce que `gaslens env validate` attrape — le **finding-roi** `env.cross_env_leak`, branché sur L1 (donc gratuit et permanent). C'est la garantie qui rend le modèle « 2 projets par webapp » sûr sans audit manuel.

### Récapitulatif des « qui fait quoi », en une image

```
   UTILISATEURS
        │  consultent
        ▼
   ┌──────────────┐     embarque les /exec PROD
   │ Google Site  │◄──────────────────────────────┐   FAÇADE (routage)
   └──────────────┘                                │
                                                   │
   PROD : webapps (/exec, version figée) ──► lib v12 (figée)     ┐
          ressources = Sheets/Forms PROD                          │ NOYAU
   DEV  : webapps (/exec dev, ou /dev)   ──► lib HEAD             ┘ (1 seule lib)
          ressources = Sheets/Forms DEV (lignes rafraîchies hebdo)
        ▲              ▲                    ▲
        │ valide       │ pousse/déploie     │ pilote & observe
   ┌─────────┐   ┌──────────┐         ┌──────────────┐
   │ GasLens │   │  clasp   │         │ Chrome MCP   │
   │ CERVEAU │   │  MAINS   │         │    YEUX      │
   └─────────┘   └──────────┘         └──────────────┘
        ▲
        │ lit / écrit
   ┌──────────────────────────┐
   │ gaslens.workspace.json   │  SOURCE DE VÉRITÉ (apps, projets, lib, environnements, ressources)
   └──────────────────────────┘
```

---

## Partie 30 — Roadmap incrémentale (ce volume)

1. **Convention JSDoc** (25.4) collée dans le `CLAUDE.md` racine — coût nul, effet immédiat.
2. **`gaslens doc lint --undocumented`** (le « highlight ») branché sur le hook → l'agent voit les trous.
3. **`gaslens doc lint --drift / --stale-ref`** → la maintenance auto *de la détection* (jamais de la prose).
4. **`gaslens doc stub`** (optionnel) → squelette à compléter.
5. **Topologie 2-env « hard »** : un projet `dev` + un projet `prod` par webapp dans le manifeste ; lib unique HEAD/figée (reprise V3).
6. **Sync hebdo par lignes** (pas par fichier) + scrub PII → skill `refresh-dev-data` (L4).
7. **Google Site comme routeur** documenté dans le `CLAUDE.md` d'app (quelle page embarque quel `/exec`).
8. **`emit-dts` référencé côté client** pour fermer la couture des faits volatils sans les mettre en commentaire.

---

### Sources principales (vérifiées pour ce Volume 4)
- **Google for Developers — Apps Script** : *Web Apps* (embed dans Sites via l'URL déployée ; `/dev` réservé aux éditeurs ; plusieurs webapps embarquables ; `google.script.url` déconseillé en embed Sites) ; *Deployments* (head `/dev` vs versioned `/exec` ; mise à jour d'un déploiement sur le même ID en pointant une nouvelle version) ; *Properties Service* (stores scopés au projet) ; *Libraries / Dependencies manifest* (régime de version HEAD vs figé).
- **Volumes 1–3 + workspace** : frontière cerveau/mains/yeux, pattern `emit-*` (émettre, pas exécuter), hook `PostToolUse`, contrat de confiance, inner/outer loop, enveloppe `coverage`, les deux axes d'environnement, gate humain `promote-deploy`.
