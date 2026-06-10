# GAS-Lens — Volume 2

**Le moteur de vérification anti-régression & l'intégration agent.**

Ce document est le **complément direct** de `gas-lens-conception.md` (le « Volume 1 »). Il en reprend la numérotation des parties (le Volume 1 s'arrêtait à la Partie 6, celui-ci commence à la Partie 7), s'appuie sur tout ce qui y est posé, et **l'amende sur trois points précis** listés ci-dessous. Lus ensemble, les deux documents décrivent le projet dans sa globalité : le Volume 1 fixe la philosophie, le modèle GAS et les trois commandes de consultation (`scan` / `inspect` / `search` / `impact`) ; le Volume 2 ajoute la pièce qui transforme l'outil en *garde-fou réellement utile pour un agent* — un outil qui ne se contente pas de répondre quand on l'interroge, mais qui **vérifie automatiquement** qu'une modification ne casse rien, et qui le fait *à la place* de l'agent.

> **Le but, reformulé sans ambiguïté.** On veut pouvoir écrire, dans le `CLAUDE.md` à la racine du repo (multi sous-repos), une phrase du genre : *« Avant de modifier une fonction `.gs`, lance `gaslens inspect` ; après chaque édition, `gaslens check` tourne tout seul et te signale les régressions — tu n'as donc PLUS besoin de greper manuellement les call sites, les `successHandler`, les scriptlets, les accès par index aux tableaux 2D, ni les clés de `PropertiesService`. »* Si l'agent peut s'appuyer là-dessus, il arrête de re-vérifier à la main ce que l'outil garantit déjà. C'est *ça*, le gain de temps réel.

### Amendements au Volume 1

1. **§4.2 (modèle de données par fonction)** : le modèle gagne plusieurs champs (signatures de *shape*, contrats de déstructuration, bindings de template, références de clés `PropertiesService`, hash de corps pour la détection de renommage). Voir Partie 14.
2. **§4.3 (commande `scan`, « idéalement incrémental »)** : l'incrémental ne peut **pas** se contenter de re-parser les fichiers modifiés, à cause de l'espace de noms global de GAS. Correction détaillée en Partie 13.1.
3. **§6 (roadmap)** : la roadmap est révisée pour intégrer la commande de vérification, le moteur de *shapes* et l'intégration par hooks. Voir Partie 17.

---

## Partie 7 — Le recadrage décisif : de l'outil qui *répond* à l'outil qui *vérifie*

Le Volume 1 conçoit trois commandes qui sont toutes des commandes **« pull »** : l'agent *demande* (`inspect`, `search`, `impact`) et l'outil *répond*. Même `impact` reste déclaratif — l'agent doit *décrire* son intention dans un mini-DSL (`--change change-return-shape:'-messageId'`). Cela suppose deux choses fragiles :

- que l'agent **pense** à appeler l'outil au bon moment ;
- qu'il **traduise correctement** ce qu'il s'apprête à faire en une description de changement.

Or l'objectif anti-régression (les ~75 % « sans casse au premier coup ») exige précisément l'inverse : que la détection parte **du code réellement modifié**, et non de la description que l'agent en fait. Un garde-fou qui ne se déclenche que quand l'agent y pense, et seulement sur l'intention qu'il a su formuler, laisse passer exactement la classe de bugs la plus dangereuse : **les changements que l'agent ne savait pas qu'il faisait.** (Il renomme un champ « au passage », il réordonne deux colonnes d'un tableau, il transforme un retour en `null` dans une branche d'erreur… sans réaliser qu'un consommateur distant en dépend.)

Il manque donc un **deuxième mode**, en « push » / vérification, qui constitue le cœur de ce Volume 2 :

| Mode | Commande | Quand | Question à laquelle il répond |
|---|---|---|---|
| **Planification** (existant, V1 §4.3) | `gaslens impact` | *avant* d'éditer | « Si je faisais ce changement, qu'est-ce que ça casserait ? » |
| **Vérification** (nouveau) | `gaslens check` / `gaslens diff` | *après* avoir édité, ou en continu | « Voici ce que je **viens de** changer — l'outil dérive lui-même l'impact réel et me le renvoie. » |

Les deux sont complémentaires et ne se remplacent pas. `impact` sert au raisonnement *a priori* (« je réfléchis à retirer ce paramètre »). `check`/`diff` est le filet de sécurité *a posteriori*, et c'est lui qu'on câblera en automatique (Partie 15). La différence décisive : **`check` n'a pas besoin que l'agent décrive son changement — il compare l'avant et l'après et le dérive.**

---

## Partie 8 — La répartition du travail avec TypeScript / `tsc` (ce que GAS-Lens ne réinvente pas)

Avant de spécifier le moteur, il faut trancher une question de périmètre, sous peine de réécrire — moins bien — un vérificateur de types qui existe déjà.

### 8.1 La réalité GAS + TypeScript aujourd'hui

Deux configurations coexistent dans les projets GAS réels, et l'outil doit gérer les deux :

- **Projet « brut »** : des fichiers `.gs` et `.html` édités directement (dans l'éditeur web ou poussés tels quels via `clasp push`). C'est le cas par défaut supposé par le Volume 1.
- **Projet « source TS/JS + build »** : on écrit du TypeScript (ou du JS annoté JSDoc) dans une arborescence `src/`, un bundler (Rollup, esbuild, webpack) produit le `.gs` déployable, et `clasp push` envoie ce produit de build. **Point à connaître et qui a changé : `clasp` ne transpile plus lui-même le TypeScript** ; la voie recommandée est désormais TS + bundler en amont du push. Cela offre un support TS plus complet, les modules ESM et les paquets npm.

> **Conséquence de conception, importante.** Quand un build existe, GAS-Lens doit indexer **la source que l'agent édite** (le `.ts`/`.js` dans `src/`), pas l'artefact `.gs` généré — sinon les positions `file:line` renvoyées pointeraient vers du code que l'agent ne touche jamais. L'outil a donc besoin d'une notion de *mapping source → projet déployé* (configurable). En projet brut, source = artefact, le problème disparaît.

### 8.2 `tsc --noEmit` est déjà un analyseur d'impact inter-fichiers — gratuit et meilleur

Partout où le projet est typé (TS, ou JS + JSDoc avec `checkJs`), **`tsc --noEmit` fait déjà la moitié du travail anti-régression**, et le fait mieux que tout ce que tu coderais : retire un champ d'un type de retour, et *tous* les lecteurs typés lèvent une erreur ; change un type de paramètre, et les incompatibilités d'appel remontent. C'est, pour tout ce qui est exprimable dans le typage, **exactement le détecteur automatique recherché**, éprouvé sur des millions de projets.

Il ne faut donc pas que GAS-Lens reconstruise une vérification structurelle *intra-langage*. **Règle de partage :**

- **`tsc` possède** la vérification structurelle à l'intérieur d'un même langage typé (signatures, types de retour, champs d'objets, compatibilité d'appels JS↔JS).
- **GAS-Lens possède les frontières que `tsc` ne voit pas** — et c'est *là* toute sa valeur ajoutée.

### 8.3 La frontière aveugle de `tsc` = le territoire de GAS-Lens

`tsc` s'arrête net à trois endroits, qui sont précisément les coutures spécifiques de GAS :

1. **Le pont `google.script.run`** : le JS *client* (dans les `.html`) n'est pas typé contre les signatures *serveur*, et `google.script.run.maFonction()` est résolu **par nom, dynamiquement** — `tsc` n'a aucune idée que `maFonction` existe côté serveur, ni de ce que son `successHandler` reçoit.
2. **Les scriptlets de templates** (`<?= getUserName() ?>`, `<?!= include('styles') ?>`) : du code serveur qui vit *dans du HTML*, invisible au compilateur.
3. **Les liens « par chaîne »** : `ScriptApp.newTrigger('maFonction')`, les clés de `PropertiesService.getProperty('API_KEY')`, le préfixe de librairie `LibName.fn()` entre sous-repos. Ce sont des références exprimées en *strings*, qu'aucun typeur ne suit.

C'est exactement la taxonomie d'exposition du Volume 1 (§3.8). **GAS-Lens fait le pont sur ces trois coutures**, et c'est tout ce qu'il a à faire de plus que `tsc`.

### 8.4 Le levier qui multiplie l'effet : émettre des `.d.ts` du serveur pour typer le client

Puisque GAS-Lens connaît les signatures et les contrats inférés de chaque fonction serveur, il peut **émettre un fichier de déclarations** (`gaslens emit-dts`) décrivant l'API `google.script.run` du projet — typiquement une interface `GoogleScriptRun` avec, pour chaque fonction serveur exposée, sa signature et le type que reçoit le `successHandler`. (L'idée n'est pas neuve : des outils communautaires génèrent déjà des `.d.ts` pour `google.script.run`.) Une fois ce `.d.ts` référencé dans le code client, **`tsc` retrouve la vue sur la couture n°1** : retirer un champ d'un retour serveur fait alors échouer la compilation côté client *automatiquement*.

Cela donne une stratégie en deux temps, élégante : GAS-Lens *génère* le pont de types, puis laisse `tsc` *vérifier* à travers lui — et GAS-Lens ne garde la responsabilité directe que des coutures qu'aucun `.d.ts` ne peut exprimer (scriptlets, triggers-par-chaîne, clés de propriétés, arité des tableaux 2D issus de `getValues()`).

---

## Partie 9 — `gaslens check` & `gaslens diff` : la dérivation automatique de l'impact

C'est la commande qui matérialise le mode vérification. Deux verbes, une même mécanique : indexer **deux états** du code et **dériver le changement sémantique** entre eux, puis confronter chaque consommateur au contrat — sans que l'agent ait à décrire quoi que ce soit.

### 9.1 `gaslens diff` — comparer deux états indexés et dériver le *change set*

```
gaslens diff
  --from <ref>               état de référence : git:HEAD | git:<sha> | index:<path> | snapshot:<id>
  --to   <ref>               état comparé      : working-tree (défaut) | git:<sha> | index:<path>
  --scope changed|all        (défaut: changed) limiter aux symboles touchés entre from et to
  --derive-shapes <bool>     (défaut: true)     activer le moteur de shapes (Partie 10)
  --severity-threshold info|warn|break   (défaut: warn)
  --detail-level summary|standard|full   (défaut: standard)
  --format json|ndjson|text  (défaut: json)
  --coverage-detail none|summary|full    (défaut: summary)
```

Le cœur, c'est que l'outil **dérive un *change set* sémantique** à partir de la comparaison des deux index — pas de la description d'un humain. Vocabulaire des deltas qu'il sait reconnaître (extensible) :

| Delta dérivé | Détecté par comparaison de… | Exemple concret |
|---|---|---|
| `return.field_removed` / `return.field_added` | shape de retour avant/après | le retour perd `messageId` |
| `return.field_renamed` | shape + heuristique de renommage | `messageId` → `msgId` |
| `return.nullability_changed` | présence d'un chemin renvoyant `null`/`undefined` | une branche d'erreur renvoie désormais `null` |
| `param.added` / `param.removed` / `param.reordered` | liste des params + leur consommation | un 3ᵉ paramètre apparaît |
| `param.usage_changed` | comment le param est consommé en interne | `recipients` passe d'itéré (`.forEach`) à indexé (`[0]`) |
| `array.arity_changed` | arité de tableau littéral / déstructuré | un tuple retourné passe de 3 à 4 éléments |
| `array.column_order_changed` | accès par index sur tableau 2D | l'ordre des colonnes d'une ligne `getValues()` change |
| `template.binding_changed` | shape de `template.data` vs `<?= data.x ?>` | un champ injecté au template disparaît |
| `property_key.renamed` | strings passées à `PropertiesService`/`CacheService` | la clé `'API_KEY'` devient `'APP_API_KEY'` |
| `serializable.broke` | sérialisabilité du retour franchissant `google.script.run` | le retour contient désormais un objet `new ...` non transmissible |
| `signature.fingerprint_changed` | empreinte globale de signature | filet large pour tout le reste |

Pour chaque delta, l'outil parcourt le **graphe inverse** (les `called_by`, les `exposures`, les handlers) et marque chaque consommateur affecté avec une **sévérité** (`break` / `warn` / `info` / `safe`) et un **`fix_hint`**.

### 9.2 `gaslens check` — la commande « tout-en-un » du garde-fou (c'est elle qu'on câble)

`check` est un raccourci opérationnel pensé pour tourner *tout seul* : il prend une baseline, ré-indexe l'état courant (incrémental), dérive le change set, confronte au contrat, et **sort un code de retour exploitable par un hook**.

```
gaslens check [<chemin...>]
  --baseline git:HEAD        (défaut) référence de comparaison
  --changed-only <bool>      (défaut: true)  ne ré-indexer/diffuser que ce qui a bougé
  --fail-on break|warn|never (défaut: break) seuil qui décide du code de sortie ≠ 0
  --severity-threshold info|warn|break   (défaut: warn) seuil d'affichage
  --format json|text|hook    (défaut: json)  "hook" = JSON attendu par Claude Code (Partie 15)
  --max-findings <int>       (défaut: 50) + truncated/total/cursor au-delà
  --coverage-detail none|summary|full    (défaut: summary)
  --quiet-when-clean <bool>  (défaut: true)  silence total si aucune régression (UX hook)
```

**Codes de sortie** (le contrat avec l'automatisation) :

- `0` — aucune régression au-dessus de `--fail-on`. *(rien à signaler)*
- `3` — régressions `break` détectées. *(à renvoyer à l'agent)*
- `4` — uniquement des `warn` (si `--fail-on warn`).
- `2` — erreur d'outil (parse impossible, baseline introuvable…), à distinguer d'une régression.

### 9.3 Format de sortie (au même niveau que les commandes du V1)

```json
{
  "baseline": "git:HEAD",
  "compared": "working-tree",
  "derived_change_set": [
    {
      "symbol": "ProjectA::email.gs::sendEmailReport",
      "delta": "return.field_removed",
      "detail": "champ 'messageId' retiré du retour",
      "confidence": "high"
    }
  ],
  "breaks": [
    {
      "severity": "break",
      "consumer": "frontend/dashboard.html:98",
      "consumer_kind": "client_call.success_handler",
      "reason": "le successHandler 'onSendOk' lit result.messageId → deviendra undefined",
      "fix_hint": "retirer la lecture de result.messageId côté client, ou conserver le champ dans le retour serveur",
      "caused_by": "ProjectA::email.gs::sendEmailReport / return.field_removed"
    }
  ],
  "warns": [
    {
      "severity": "warn",
      "consumer": "src/triggers/weekly.gs:18",
      "consumer_kind": "internal_caller",
      "reason": "appelant ignore le retour — pas d'impact direct, à confirmer"
    }
  ],
  "safe": [
    { "consumer": "ProjectB (lib RemoteLib)", "note": "n'utilise pas le champ retiré" }
  ],
  "coverage": {
    "resolved_pct": 92,
    "confidence": "high",
    "unresolved": [
      {
        "what": "1 call site via dispatch dynamique",
        "where": "src/router.gs:88",
        "reason": "appel de la forme handlers[name](payload) — cible non résoluble statiquement",
        "suggestion": "vérifier manuellement que 'handlers' ne route pas vers sendEmailReport"
      }
    ],
    "external_boundaries": ["librairie 'CommonUtils' (projet externe non indexé)"]
  },
  "verdict": "BREAK",
  "summary": "1 régression bloquante (dashboard.html:98). 1 avertissement. Couverture 92 %."
}
```

Le champ `verdict` (`CLEAN` / `WARN` / `BREAK`) + le `summary` en une phrase sont conçus pour être lus *en tête* par l'agent (rappel V1 §1.3 : l'info la plus importante en premier). Le `derived_change_set` est ce qui rend l'outil honnête sur *ce qu'il a compris du changement* — l'agent peut le contredire s'il sait que le delta est intentionnel et déjà répercuté.

---

## Partie 10 — Le moteur de *shapes* : comment l'outil « comprend » l'arité d'une liste sans rien exécuter

C'est la pièce technique qui rend possible ton exemple — *« la dimension d'une liste change ; est-ce que ça casse un `arr[3]` ailleurs ? »* — et il faut être franc sur ce qu'elle peut et ne peut pas faire.

### 10.1 Pourquoi les requêtes tree-sitter seules ne suffisent pas

Les captures `.scm` du Volume 1 (§4.5) repèrent des **formes syntaxiques** : « j'ai vu un `google.script.run` », « j'ai vu un `ScriptApp.newTrigger` ». Elles ne produisent pas de **faits sur les valeurs** : « ce retour est un triplet », « ce consommateur en dépile quatre ». Pour ça, il faut une couche au-dessus de l'AST : un **flot de données léger / interprétation abstraite**.

### 10.2 Le principe : propager des *shapes abstraites* le long des chaînes def-use

On n'exécute rien. On propage, le long des relations « définition → usage », des **descripteurs de forme** volontairement grossiers :

- **Tableau** : `Array<arity: 3, elem: …>` (arité connue) ou `Array<arity: unknown>` (issu d'un `.filter()`, d'une longueur dynamique…).
- **Objet** : `Object<fields: {success, messageId}>` (ensemble de clés connu) ou `Object<fields: open>` (clés calculées → on bascule en *open*, et on le **signale dans `coverage`**).
- **Tuple déstructuré** : `[a, b, c]` a une arité de 3, contrat aussi vérifiable qu'une signature.
- **Primitive / Date / null** : suivis pour la sérialisabilité et la nullabilité.

C'est, au fond, la **version principielle du `inferred_contract`** du Volume 1 (§4.2) : plus de travail que des captures, mais c'est la différence entre *voir un appel* et *comprendre un contrat*.

### 10.3 Ce que le moteur traque concrètement

- **Arité de tableau** entre production et consommation : un littéral `[a, b, c]` retourné, confronté à un `[x, y, z, w] = …` (déstructuration à 4) ou un `row[3]` chez le consommateur → `array.arity_changed` → `break`.
- **Accès par index sur tableaux 2D** (`getValues()` → `row[2]`) : voir Partie 11.1, c'est le patron GAS phare.
- **Ensemble de champs d'objet** : ce que le `successHandler` lit (`result.success`, `result.messageId`) vs ce que le retour produit. Champ lu mais plus produit → `break`.
- **Nullabilité** : apparition d'un chemin renvoyant `null`/`undefined` là où le consommateur déréférence sans garde.
- **Sérialisabilité** au franchissement de `google.script.run` (Partie 11.5).

### 10.4 La frontière d'honnêteté (à inscrire dans `coverage`, pas à cacher)

C'est la même exigence que la « enveloppe de couverture » du Volume 1 (§ principe 9), appliquée au moteur de shapes. Il faut poser la limite franchement :

- **Régressions *structurelles* → automatisables et fiables.** Arité, présence/absence de champ, type, sérialisabilité, nullabilité simple. C'est le domaine où GAS-Lens peut dire « cassé » avec une `confidence: high`.
- **Régressions *sémantiques* → jamais décidables statiquement.** Le champ existe toujours, mais la valeur a changé de *sens* (des millisecondes devenues des secondes ; un statut `"ok"` devenu `"success"` ; une logique métier inversée). **Aucun analyseur statique, ni `tsc`, ni l'exécution, ne les attrape** — seuls des tests de comportement ou le raisonnement de l'agent le peuvent.

→ Chaque finding porte une `confidence` (`high` / `medium` / `low`), et tout ce que le moteur n'a pas su résoudre (dispatch dynamique, clés calculées, shape *open*) part **explicitement** dans `coverage.unresolved` avec localisation et raison. Un agent qui reçoit « voici 92 %, et voici les 8 % que je n'ai pas pu trancher, pour ces raisons » peut décider d'aller vérifier *uniquement* ces 8 % — au lieu de tout re-greper. C'est, très exactement, le gain de temps visé.

---

## Partie 11 — Les patrons GAS de première classe (le cœur métier que les outils génériques ratent)

Le Volume 1 modélise déjà bien `google.script.run`, `doGet/doPost`, les scriptlets et les triggers. Ce Volume 2 **promeut au rang de contrats de première classe** cinq patrons GAS supplémentaires, qui sont la source réelle des régressions silencieuses en web app GAS et que quasiment aucun outil générique ne couvre.

### 11.1 Tableaux 2D `getValues()` / `setValues()` + accès par index de colonne — *le bug GAS n°1*

`getDataRange().getValues()` renvoie un **tableau 2D** ; le code consomme ensuite les colonnes **par index numérique** (`row[0]`, `row[2]`…). Conséquences :

- Réordonner ou insérer une colonne (dans la feuille, ou dans un mapping `headers`) **casse silencieusement** tous les `row[N]` en aval — aucune erreur, juste des données décalées.
- `setValues()` exige une shape 2D **cohérente** (même nombre de colonnes sur toutes les lignes) ; produire une ligne d'arité différente lève une erreur d'exécution.

→ GAS-Lens traque l'**arité de colonne** d'un tableau 2D depuis sa source (`getValues`, ou un littéral) jusqu'à ses accès indexés, et émet `array.column_order_changed` / `array.arity_changed`. C'est probablement le **scénario anti-régression le plus rentable** de tout l'outil.

### 11.2 La déstructuration comme contrat d'arité

`const [nom, email, role] = getUserRow();` déclare un **contrat d'arité** (3) aussi vérifiable qu'une signature de fonction. Si `getUserRow()` se met à renvoyer 2 éléments (ou 4), c'est une régression statiquement détectable. À modéliser comme un contrat à part entière, côté producteur **et** consommateur.

### 11.3 `template.data` ↔ `<?= data.x ?>` — le contrat serveur→template, *symétrique* au `successHandler`

Le pattern templated (`createTemplateFromFile('Index')`, affectation `template.data = {...}`, puis `.evaluate()`) crée un **contrat de shape** entre ce que le serveur attache au template et ce que le HTML lit dans les scriptlets (`<?= data.userName ?>`, `<? for (var x of data.items) ?>`). C'est **exactement symétrique** au contrat `successHandler` (où le client lit ce que le serveur retourne), et le Volume 1 n'en faisait pas un contrat de premier rang. Retirer un champ de `template.data` casse le rendu **au moment de l'`evaluate()` côté serveur** — un grep naïf le rate, le moteur de shapes l'attrape (`template.binding_changed`).

### 11.4 Clés string de `PropertiesService` / `CacheService` — l'état global adressé par chaîne

`PropertiesService.getScriptProperties().getProperty('API_KEY')` lit un état global **par une chaîne**. Renommer la clé à l'écriture sans la renommer à *toutes* les lectures (souvent dans d'autres fichiers, voire d'autres sous-repos) est une régression inter-fichiers que **seul un suivi de ces strings** attrape — au même titre que le suivi des noms de triggers (`ScriptApp.newTrigger('X')`) déjà prévu au V1. GAS-Lens indexe ces clés comme un mini-espace de noms et émet `property_key.renamed` / `property_key.orphan_read` (lecture d'une clé que plus personne n'écrit).

### 11.5 La frontière de sérialisation `google.script.run` — un bug latent détectable

La recherche confirme les règles exactes : ne franchissent le pont client↔serveur que les **primitives** (number, boolean, string, null) et les **objets/tableaux composés** de primitives, objets et tableaux ; un élément `<form>` est légal **en paramètre** (et doit être l'unique paramètre) mais **pas en retour** ; pas de fonctions, pas d'éléments DOM, pas d'objets construits avec `new`. Deux faits à encoder :

- Un retour serveur devenu **non sérialisable** (il contient désormais une `Date` enveloppée, une instance `new MaClasse()`, une fonction…) est un **bug latent** : `serializable.broke`. L'outil peut le signaler dans le contrat *avant* que ça pète à l'exécution.
- Les mutations côté serveur d'un objet **reçu** ne se répercutent pas côté client (passage par valeur à travers le pont). Utile à signaler quand un handler semble s'attendre à voir une mutation.

> Détail mineur à connaître mais à ne pas sur-investir : `google.script.run` autorise **10 appels concurrents** ; au-delà, les suivants sont mis en file. Rarement un problème en pratique. Pertinent tout au plus comme `info` si l'outil détecte un fan-out massif.

---

## Partie 12 — Pourquoi pas d'exécution locale (et le bon chemin pour la vérif réelle *optionnelle*)

La tentation est de « faire tourner les fonctions en blanc en local » pour observer leurs retours réels. **C'est un piège pour un garde-fou**, pour des raisons concrètes confirmées par la recherche.

### 12.1 Le runtime est soudé à Google

`SpreadsheetApp`, `GmailApp`, `UrlFetchApp`, `PropertiesService`, l'objet `e` de `doGet`, `HtmlService`, `google.script.run`… **rien de tout ça n'existe hors des serveurs Google.** Deux options, mauvaises toutes les deux :

- **Mocker toute la surface API** : énorme à maintenir, et surtout les mocks renvoient les shapes que *toi* tu décides — donc tu n'apprends **rien de plus** que par analyse statique. Tu ne fais que ré-encoder tes hypothèses, avec plus d'effort.
- **Exécuter chez Google via `clasp run`** : confirmé, `clasp run` s'exécute **dans le cloud Google, pas sur la machine locale**. C'est lent, ça exige une vraie authentification OAuth, l'activation de l'API Apps Script — et surtout **avec de vrais effets de bord** : un garde-fou qui envoie réellement des emails, écrit dans des Sheets ou consomme du quota à *chaque vérification* est inutilisable au fil de l'eau.

Et le seul gain réel de l'exécution — résoudre le **dispatch purement dynamique** — est exactement la **minorité de cas** que `coverage` propose déjà de signaler honnêtement. On paierait très cher pour gratter une marge que l'outil sait déjà déclarer comme « non résolu ».

### 12.2 Ce que tu veux n'est pas de l'exécution — c'est un modèle de *shapes* (Partie 10)

Le besoin réel derrière « faire tourner en blanc », c'est *connaître la forme des valeurs qui circulent*. Ça s'obtient **sans exécution**, par le moteur de shapes + `tsc` (Parties 8 et 10). C'est plus rapide, déterministe, sans effet de bord, et ça tourne à chaque édition.

### 12.3 Le bon chemin pour la vérif réelle, si on en veut un jour : *émettre* des tests, pas exécuter

La forme correcte n'est pas que GAS-Lens exécute, mais qu'il **génère des tests de contrat** lançables à la demande, côté Google, dans un projet *dédié / sandbox* (jamais en prod) :

- `gaslens emit-contract-tests <function>` produit un harnais (style GAS unit-test) qui appelle la fonction et **asserte sa shape de retour** (les champs que les consommateurs lisent).
- On le lance ponctuellement via `clasp run` sur un déploiement de test, **séparé** des données réelles (cf. la pratique standard : projets dev/staging/prod distincts).
- Résultat : **garde-fou statique toujours actif** (le hook, gratuit, sans effet de bord) d'un côté ; **vérification comportementale réelle, optionnelle et explicite**, de l'autre — la seule capable d'attraper les régressions *sémantiques* (Partie 10.4) que rien de statique ne voit.

---

## Partie 13 — Pièges de correction (à graver dans le moteur)

Des points subtils qui, mal traités, rendraient l'outil silencieusement faux — donc dangereux pour un agent qui lui fait confiance.

### 13.1 L'incrémental doit re-résoudre les *arêtes*, pas seulement re-parser les fichiers (amende V1 §4.3)

Comme **toutes les fonctions `.gs` de niveau supérieur d'un projet partagent un espace de noms global** (V1 §3.1), ajouter `function foo()` dans `fileB.gs` change la **résolution** d'un appel `foo()` situé dans `fileA.gs` — alors que `fileA.gs` n'a pas été touché. Un incrémental naïf « re-parse seulement les fichiers modifiés » manquerait cette nouvelle arête. **Règle** : après re-parsing des fichiers modifiés, **ré-résoudre toutes les arêtes du graphe touchant les symboles ajoutés / supprimés / renommés** dans le projet (et les projets qui l'importent comme librairie). Le re-parsing est local ; la re-résolution est à l'échelle du projet.

### 13.2 IDs stables + détection de renommage façon git

Le `Project::file::fn` du Volume 1 est stable quand les lignes bougent (tant mieux pour `diff`), **sauf au renommage** : renommer `fileA.gs` ou la fonction change l'ID, et un `diff` naïf verrait « ancienne supprimée + nouvelle ajoutée » au lieu de « renommée ». Il faut une **détection de renommage par similarité de corps** (hash/empreinte du corps, façon `git --find-renames`) pour que `return.field_renamed`, `signature.fingerprint_changed`, etc., soient correctement attribués. D'où le champ `body_fingerprint` ajouté au modèle (Partie 14).

### 13.3 `withUserObject` décale les arguments du handler

`withUserObject(ctx)` passe `ctx` en **2ᵉ argument** des handlers : la signature réelle d'un `successHandler` est `(retourServeur, userObject)` et celle d'un `failureHandler` est `(error, userObject)`. **Ne pas confondre le 2ᵉ argument avec le contrat de retour serveur** lors de l'inférence — sinon l'outil croit à tort que le `userObject` fait partie de la shape de retour. À encoder explicitement dans la lecture de la chaîne `google.script.run`.

### 13.4 Les scriptlets restent un angle mort des outils naïfs (rappel)

Un appel serveur peut vivre dans un `<?= getUserName() ?>` ou un `<?!= include('partial') ?>` ; c'est un *call site* qu'un grep ou un linter JS classique rate. Le pipeline HTML (tree-sitter-html + injection JS dans les scriptlets, V1 §4.1/§4.5) reste donc indispensable au mode `check` : sinon `check` afficherait `CLEAN` alors qu'un rendu de template est cassé.

### 13.5 Côté client = non typé : c'est la justification permanente de l'outil

Le JS dans les `.html` n'est pas couvert par `tsc` (sauf via le `.d.ts` émis, Partie 8.4) et n'a pas de système de modules vis-à-vis du serveur. Tant que cette couture existe, `tsc` seul ne suffit jamais, et GAS-Lens a une raison d'être qui ne se périme pas.

---

## Partie 14 — Amendements au modèle de données (nouveaux champs)

Le modèle par fonction du Volume 1 (§4.2) est conservé et **enrichi** des champs suivants (montrés ici isolément ; ils s'ajoutent au record existant) :

```json
{
  "body_fingerprint": "sha256:… (pour la détection de renommage, Partie 13.2)",
  "baseline_ref": "git:HEAD (état de référence indexé pour diff)",

  "return_shape_model": {
    "kind": "object",
    "fields": { "success": "boolean", "messageId": "string" },
    "open": false,                       // true si clés calculées → coverage.unresolved
    "nullable_paths": [],                // chemins de retour null/undefined détectés
    "serializable": true                 // false = ne franchit pas google.script.run
  },

  "destructuring_contracts": [
    { "at": "src/users.gs:40", "pattern": "[nom, email, role]", "arity": 3,
      "bound_to": "getUserRow" }
  ],

  "array2d_access": [
    { "source": "getDataRange().getValues()", "at": "src/sheet.gs:12",
      "column_indices_read": [0, 2, 5], "max_index": 5 }
  ],

  "template_bindings": [
    { "template_file": "Index.html", "assigned_at": "src/render.gs:8",
      "data_fields_set": ["userName", "items"],
      "data_fields_read_in_scriptlets": ["userName", "items", "title"] }
    // 'title' lu mais non défini → finding potentiel
  ],

  "property_keys": [
    { "key": "API_KEY", "op": "read",  "at": "src/config.gs:5", "store": "script" },
    { "key": "API_KEY", "op": "write", "at": "src/setup.gs:22", "store": "script" }
  ]
}
```

Ces champs sont précisément ce que `diff`/`check` compare entre deux états pour **dériver** le change set (Partie 9.1) et ce que le moteur de shapes (Partie 10) alimente.

---

## Partie 15 — L'intégration agent : hooks, codes de sortie, et le « contrat de confiance »

C'est ici que l'analyse statique devient un garde-fou **qui s'exécute tout seul**, sans que l'agent ait à y penser — la réponse directe à ton « de manière automatique, sans que l'IA réfléchisse pour ça ».

### 15.1 Le mécanisme : les hooks `PostToolUse` de Claude Code

Claude Code expose des **hooks** déclenchés par les événements du cycle de vie. Le pertinent ici est **`PostToolUse`** : il se déclenche **après** qu'un outil d'édition (`Write` / `Edit` / `MultiEdit`) a réussi. Faits confirmés à exploiter :

- Le hook reçoit sur **stdin** un JSON décrivant l'événement : `tool_name`, `tool_input.file_path` (le fichier qui vient d'être édité), `tool_response`, `cwd`, etc.
- Le hook peut **renvoyer une décision à Claude** : en écrivant sur **stdout** un JSON `{"decision":"block","reason":"…"}` (avec `suppressOutput:true` pour ne pas noyer le terminal), Claude **lit le `reason` et le traite comme un signal pour réviser**. Équivalent via **code de sortie 2** + message sur **stderr**, qui est renvoyé à Claude comme feedback. *(Un `PostToolUse` ne peut pas annuler l'édition déjà faite — mais il fait *exactement* ce qu'on veut : remettre la régression sous les yeux de l'agent pour qu'il corrige immédiatement.)*

**Le câblage est donc** : un hook `PostToolUse`, filtré (`matcher`) sur les éditions de `.gs`/`.html`, qui lance `gaslens check` sur le fichier touché ; si `check` renvoie un verdict `BREAK`, le hook ré-émet la régression vers Claude. Pour rendre ça trivial, GAS-Lens fournit un sous-commande dédiée :

```
gaslens hook --event post-tool-use
  # lit le JSON PostToolUse sur stdin, en extrait file_path,
  # lance un `check --changed-only` ciblé, et émet sur stdout
  # le JSON attendu par Claude Code (decision/reason) si verdict = BREAK ;
  # silencieux (exit 0, pas de stdout) si CLEAN.
```

### 15.2 Variantes selon le moment

- **`PostToolUse` (recommandé par défaut)** : feedback immédiat après chaque édition. L'agent corrige dans la foulée, dans la même session de raisonnement.
- **Pre-commit hook git** (`gaslens check --baseline git:HEAD --fail-on break`) : filet de sécurité indépendant de l'agent, pour les éditions humaines aussi.
- **`gaslens watch`** : mode démon qui ré-indexe à la volée (utile en CI légère ou en session longue, pour amortir le coût d'indexation).

**Contrainte non négociable (rappel V1 §1.1 + retour d'expérience hooks)** : *garder le hook rapide*. Il tourne **à chaque** édition ; un hook lent ajoute sa latence à chaque tour. D'où l'importance de l'incrémental ciblé (`--changed-only`) et de `--quiet-when-clean` : 90 % du temps, le hook doit être silencieux et quasi instantané.

### 15.3 Le « contrat de confiance » — *ce que l'agent n'a plus besoin de vérifier*

C'est le point qui réalise ta phrase d'objectif. Une fois `gaslens check` câblé en hook, on peut dire explicitement à l'agent **ce sur quoi il peut s'appuyer** (et donc arrêter de re-vérifier à la main) **et ce qu'il doit encore évaluer lui-même** :

**✅ Couvert automatiquement par `gaslens check` — ne pas re-greper manuellement :**

- les *call sites* internes d'une fonction modifiée (qui l'appelle, avec quels arguments) ;
- les appels client→serveur via `google.script.run` et les **champs lus par les `successHandler`** ;
- les **scriptlets** de templates (`<?= fn() ?>`) — call sites qu'un grep raterait ;
- les liens **par chaîne** : triggers (`ScriptApp.newTrigger('X')`), préfixes de librairie inter-sous-repos (`Lib.fn()`), clés `PropertiesService`/`CacheService` ;
- l'**arité des tableaux 2D** (`getValues()` → `row[N]`) et des **déstructurations** ;
- les **contrats `template.data` ↔ scriptlets** ;
- la **sérialisabilité** des retours franchissant `google.script.run` ;
- les **entry points** (`doGet`/`doPost`) et triggers traités comme racines (pas de faux « code mort »).

**⚠️ Toujours à la charge de l'agent (le statique ne peut pas) :**

- les régressions **sémantiques** : le champ existe encore mais sa *valeur*/son *sens* a changé (unités, statuts, logique métier) — cf. Partie 10.4 ;
- tout ce que `check` liste dans **`coverage.unresolved`** : dispatch dynamique (`handlers[name]()`), clés d'objet calculées, `eval`, frontières vers des **librairies externes non indexées** ou des services Google (`GmailApp`, etc.) ;
- la pertinence **fonctionnelle** du changement (est-ce le bon comportement métier ?).

Autrement dit : l'agent peut **faire confiance à un verdict `CLEAN` avec couverture élevée** sur les classes ✅, et concentrer son raisonnement sur ⚠️ — au lieu d'auditer tout le repo. C'est *là* qu'est l'économie de temps (et de tokens : pas de lecture exhaustive de fichiers, cf. V1 §1.2).

---

## Partie 16 — Le bloc CLAUDE.md prêt à coller (racine + sous-repo)

Conventions confirmées à respecter : le `CLAUDE.md` **à la racine** est chargé au lancement (Claude remonte l'arborescence et charge chaque `CLAUDE.md` rencontré) ; les `CLAUDE.md` **de sous-répertoires se chargent paresseusement**, seulement quand Claude touche des fichiers de ce dossier. **Garder ces fichiers concis** (au-delà de ~200 lignes, l'adhérence baisse et le contexte se charge). Les commentaires HTML `<!-- … -->` d'un `CLAUDE.md` sont *retirés* avant injection : pratiques pour des notes de mainteneur qui ne coûtent pas de contexte.

### 16.1 À la racine du repo (multi sous-repos) — `./CLAUDE.md`

```markdown
## Outil d'analyse GAS — gaslens (anti-régression)

Ce repo multi-projets Google Apps Script est indexé par `gaslens`. Un hook
`PostToolUse` lance `gaslens check` après chaque édition de `.gs`/`.html` et te
renvoie les régressions. Tu peux donc t'appuyer dessus.

AVANT de modifier une fonction serveur, lance :
  `gaslens inspect <fonction> --detail-level standard`
→ tu obtiens ses call sites, ses expositions, son contrat de retour inféré
  (y compris les champs lus par les successHandler côté client).

APRÈS édition, `gaslens check` tourne automatiquement. S'il renvoie un verdict
BREAK, corrige selon les `fix_hint` avant de continuer.

CE QUE gaslens VÉRIFIE DÉJÀ (ne le re-grep pas à la main) :
- call sites internes ; appels `google.script.run` + champs lus par successHandler ;
- scriptlets de templates `<?= fn() ?>` ; triggers `ScriptApp.newTrigger('X')` ;
- préfixes de librairie inter-projets `Lib.fn()` ; clés PropertiesService/CacheService ;
- arité des tableaux 2D `getValues()` (`row[N]`) et des déstructurations ;
- contrats `template.data` ↔ scriptlets ; sérialisabilité des retours `google.script.run`.

CE QUE TU DOIS ENCORE ÉVALUER TOI-MÊME (gaslens ne peut pas) :
- régressions sémantiques (même champ, sens changé : unités, statuts, logique métier) ;
- tout ce qui est listé dans `coverage.unresolved` (dispatch dynamique, clés calculées,
  librairies externes non indexées, services Google) ;
- la pertinence métier du changement.

Si `gaslens check` renvoie une couverture < 100 %, vérifie UNIQUEMENT les points
listés dans `coverage.unresolved` — pas tout le repo.
```

### 16.2 Dans chaque sous-repo / projet — `./<projet>/CLAUDE.md`

```markdown
## Projet <NomProjet> (GAS)

Préfixe de librairie exposé aux autres projets : `<LibName>`
(les appels `<LibName>.fn()` depuis les autres sous-repos sont résolus par gaslens).

Entry points web de ce projet : doGet (sert <Index.html>) / doPost (API JSON).
Fonctions privées : suffixe `_` (non appelables par google.script.run).

Avant de toucher une fonction exposée comme librairie, garde en tête que
des projets EXTERNES non indexés peuvent l'appeler : `gaslens check` le signalera
en `coverage.external_boundaries`. Traite ces cas avec prudence.
```

### 16.3 La config du hook — `./.claude/settings.json`

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "gaslens hook --event post-tool-use"
          }
        ]
      }
    ]
  }
}
```

`gaslens hook` lit le JSON `PostToolUse` sur stdin, ne fait rien si le fichier édité
n'est pas du `.gs`/`.html`, lance un `check --changed-only` ciblé sinon, et n'émet une
décision `block` (avec `reason`) que si le verdict est `BREAK`. Silencieux et rapide le reste du temps.

---

## Partie 17 — Roadmap révisée (Volume 1 + Volume 2)

Réordonnancement de la roadmap du V1 (§6) pour intégrer la vérification. Les étapes notées **[V2]** sont nouvelles.

1. **Scanner minimal** : tree-sitter sur `.gs`, définitions + call sites internes + positions. JSON. *(socle)*
2. **`inspect` standard** : `called_by` / `calls_out` + `detail_level`.
3. **Patrons GAS de base** : `google.script.run` (+ `withUserObject`, §13.3), scriptlets HTML, `doGet/doPost`, triggers.
4. **Contrat inféré** depuis les `successHandler` et la consommation des params. *(différenciateur)*
5. **[V2] Moteur de shapes** (Partie 10) : arité tableaux/tuples, ensembles de champs, nullabilité, sérialisabilité. *(prérequis du diff sémantique)*
6. **[V2] Patrons GAS de première classe** (Partie 11) : tableaux 2D `getValues()`, déstructuration, `template.data`, clés `PropertiesService`.
7. **`impact`** (V1) : graphe inverse + confrontation au contrat, depuis une intention décrite. *(planification)*
8. **[V2] `diff` + `check`** (Partie 9) : dérivation automatique du change set entre deux états + codes de sortie. *(la feature 75 %)*
9. **[V2] Détection de renommage** (§13.2) + **incrémental correct re-résolvant les arêtes** (§13.1).
10. **`coverage` transversale** (V1) + erreurs pédagogiques.
11. **Multi-repos** (V1) : résolution des préfixes de librairie via manifestes — *socle indispensable pour que `check` voie les consommateurs inter-sous-repos.*
12. **[V2] Intégration `tsc`** : reconnaître les projets typés, **`gaslens emit-dts`** (Partie 8.4), indexer la source et non l'artefact de build (§8.1).
13. **[V2] `gaslens hook` + recettes CLAUDE.md / settings.json** (Parties 15–16). *(ce qui rend tout « automatique »)*
14. **[V2] (optionnel) `emit-contract-tests`** (§12.3) pour la vérif comportementale réelle à la demande.
15. **Éval + auto-optimisation** des descriptions d'outils (V1 §5). Mesure reine : taux de régressions `break` évitées *parce que* le hook les a renvoyées.

---

### Sources complémentaires (vérifiées pour ce Volume 2)

- **Google for Developers — Apps Script** : *HTML Service: Communicate with Server Functions* et *Class google.script.run* (restrictions exactes de types des paramètres/retours, élément `<form>` légal en paramètre seulement, fonctions privées `_` invisibles au client, 10 appels concurrents, non-répercussion des mutations d'objets reçus) ; *Use the command-line interface with clasp* (projets dev/staging/prod distincts).
- **google/clasp (dépôt officiel)** : `clasp` **ne transpile plus** le TypeScript — utiliser un bundler (Rollup, esbuild, webpack) en amont du push ; `clasp run` s'exécute **dans le cloud Google**, pas en local.
- **Claude Code — Hooks** (docs officielles + guides à jour) : `PostToolUse` reçoit le JSON d'événement sur stdin (`tool_name`, `tool_input.file_path`, `tool_response`) ; renvoi de feedback à l'agent via `{"decision":"block","reason":…}` sur stdout ou via code de sortie 2 + stderr ; impératif de garder les hooks rapides.
- **Claude Code — Memory / CLAUDE.md** (docs officielles) : `CLAUDE.md` racine chargé au lancement (remontée d'arborescence), sous-répertoires chargés paresseusement à l'interaction ; viser la concision (< ~200 lignes) ; commentaires HTML retirés avant injection.
- **Volume 1** (`gas-lens-conception.md`) pour tout le reste : philosophie « outil pour agent », modèle GAS (entry points, scriptlets, triggers, librairies), principes AI-friendly, pipeline tree-sitter, enveloppe `coverage`, métriques d'évaluation.
