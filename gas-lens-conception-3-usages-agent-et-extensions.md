# GAS-Lens — Volume 3

**Cartographie des usages agent + nouvelles capacités (statiques et via les API Google).**

Ce document est le **troisième volet**, complément direct des deux précédents :
le **Volume 1** (`gas-lens-conception.md`) pose la philosophie « outil pour agent », le modèle GAS et les commandes de consultation (`scan` / `inspect` / `search` / `impact`) ; le **Volume 2** (`gas-lens-conception-2-verification-et-agent.md`) ajoute le moteur de vérification anti-régression (`diff` / `check`), le moteur de *shapes*, et l'intégration par hooks. À ce stade le dépôt implémente déjà tout cela (`scan`, `inspect`, `impact`, `diff`, `check`, `hook`, `emit-dts`, `emit-contract-tests`, `eval`, `init`).

Ce Volume 3 répond à une question différente et plus large : **qu'est-ce qu'un agent IA fait *réellement* dans un parc GAS, où perd-il du temps et des tokens, et qu'est-ce que GAS-Lens pourrait couvrir de plus ?** Il s'appuie sur une recherche croisée — frictions documentées de l'IA agentique pour le code, spécificités et pièges réels de GAS, l'API Apps Script, l'API Drive, et l'écosystème outillage (clasp, types, `gas-fakes`).

La numérotation continue (le Volume 2 s'arrêtait à la Partie 17 ; celui-ci commence à la Partie 18). Comme le Volume 2, il **amende** les volumes précédents sur un point précis (le §12 « pas d'exécution locale » — voir Partie 23).

> **Règle d'or, conservée.** Chaque nouveauté proposée ici est jugée à l'aune de la même question que les volumes précédents : *est-ce que ça augmente la surface sur laquelle l'agent réussit sa tâche sans qu'il ait à tout re-vérifier ?* Une fonctionnalité qui n'économise ni des tokens ni des régressions, ou qui ne fait que ré-encoder ce que l'agent sait déjà, est écartée.

---

## Partie 18 — Le cadrage : ce que l'agent *fait* en GAS, et pourquoi GAS est un cas à part

### 18.1 La 4ᵉ intention manquante

Le Volume 1 (§0) recense trois intentions de l'agent : *« qu'est-ce que je dois savoir avant de modifier X »*, *« si je change X, qu'est-ce que ça casse »*, *« où est le code qui fait Y »*. La recherche en révèle une quatrième, sous-estimée parce qu'elle n'est pas une *modification* :

4. **« J'écris du code GAS *nouveau* — est-ce que ce que je produis est seulement valide dans cet environnement ? »**

Cette intention est spécifique à GAS pour une raison structurelle développée ci-dessous : l'agent n'a pas de boucle de feedback bon marché pour la valider lui-même. Les commandes actuelles (`inspect`/`impact`/`check`) servent les intentions 1-2-3 (le code *existant* et ses liens). L'intention 4 — la **correction intrinsèque du code écrit** (API GAS réelle, scopes, quotas, contraintes web app) — n'est aujourd'hui couverte par rien dans l'outil, et c'est là que se concentrent plusieurs propositions de ce volume (Partie 21).

### 18.2 Pourquoi GAS casse la boucle « lance et vois l'erreur »

L'argument classique (Simon Willison, largement repris) veut que les hallucinations dans le code soient *les erreurs les moins dangereuses* : on lance, l'interpréteur crie, on corrige — un fact-checking gratuit. **Cet argument s'effondre en GAS.** Le runtime est soudé à Google (V2 §12.1) : il n'y a pas d'interpréteur local qui dise « `SpreadsheetApp.getActiveSheet().getValuesAll()` n'existe pas ». Pour qu'une méthode hallucinée se révèle, il faut `clasp push` + un déploiement + une exécution dans le cloud Google — un cycle de plusieurs dizaines de secondes, avec authentification, et **avec effets de bord réels** (emails envoyés, lignes écrites, quota consommé).

Conséquence directe et contre-intuitive : **en GAS, même les erreurs « faciles » (méthode inexistante, mauvais nom de service) deviennent chères**, parce que le filet le plus banal — l'exécution — est absent ou coûteux. Tout ce qu'on peut rapatrier dans l'analyse *statique* (donc instantanée, locale, sans effet de bord) reprend de la valeur par rapport à un langage normal. C'est l'argument économique central de ce volume : GAS-Lens ne couvre pour l'instant que les régressions *inter-fonctions* ; il y a un gisement au moins aussi gros dans la validation *intrinsèque* du code, précisément parce que GAS prive l'agent du compilateur qui ferait ce travail ailleurs.

### 18.3 La taxonomie des « trous à tokens » (généraux, puis GAS)

La recherche sur la consommation des agents (Claude Code, Cursor, Codex) converge sur un constat : **l'agent dépense l'essentiel de son budget en *orientation*, pas en résolution.** Un retour d'expérience souvent cité décrit un agent lisant 25 fichiers pour répondre à une question portant sur 3 fonctions — non par incompétence, mais faute de table des matières : il « feuillette » tout. Les économies rapportées par les graphes de connaissance de code vont de 40 % à 95 % sur ces tâches d'orientation. On peut ranger les fuites en quatre familles :

| Trou à tokens | Mécanisme | Réponse de GAS-Lens (existante ou à créer) |
|---|---|---|
| **Orientation** | l'agent lit N fichiers pour trouver les 3 qui comptent | `search` + un **`map`** d'aperçu (à créer, §21.5) qui sert de table des matières |
| **Re-vérification manuelle** | l'agent re-grep call sites / handlers / scriptlets à chaque doute | déjà le cœur de `inspect`/`check` (le « contrat de confiance » V2 §15.3) |
| **Boucle d'erreur absente** | pas d'exécution locale → méthode hallucinée non rattrapée | **validation API GAS** (à créer, §21.2) + `gas-fakes` (§23) |
| **Bloat de schéma** | chaque outil branché coûte des tokens *même non appelé* | choix du **format de livraison** (CLI vs MCP vs Skill, §24) |

Les deux premières familles, GAS-Lens les adresse déjà. Les deux dernières sont l'objet de ce volume.

---

## Partie 19 — Cartographie des usages : les « options » décomposées

Tu demandais de découper les usages de l'agent (dev web / dev GAS / et tout le reste pertinent). Voici la décomposition en **cinq familles**, avec pour chacune ce que GAS-Lens couvre aujourd'hui (✅), ce qui manque (➕), et le risque de régression *silencieuse* propre à la famille (le critère qui justifie l'investissement).

### Famille A — Dev web : le client servi (HTML / JS dans les `.html`)

Le code client tourne dans un **iframe sandboxé** (seul `IFRAME` subsiste ; `NATIVE`/`EMULATED` sont *sunset*). Cet environnement impose des contraintes que `tsc` et les linters JS génériques ignorent totalement, et qui sont des sources réelles de bugs « ça marche en local, c'est cassé une fois déployé » :

- **CSP / contenu mixte** : tout script, CSS ou XHR « actif » doit être chargé en **HTTPS**. Un `<script src="http://…">` est silencieusement bloqué une fois servi.
- **Cibles de lien** : en mode IFRAME, un lien sans `target="_top"` (ou `_blank`) ne navigue pas comme attendu ; le `<base target="_top">` est le correctif idiomatique.
- **Soumission de formulaires** : contrairement à l'ancien mode, les `<form>` se **soumettent réellement** en IFRAME — sans `preventDefault`, le handler `onclick` est court-circuité par une navigation vers une page blanche.
- **Périmètre de `google.script.run`** : disponible *uniquement* dans le contexte de la page servie. Dans un iframe imbriqué ou une popup, il n'existe pas (il faut passer par `postMessage`).
- **`google.script.host`** : `origin`, `close()`, `setHeight/Width` (dialogs/sidebars) — secondaire pour une web app pure mais à reconnaître.

✅ Aujourd'hui : GAS-Lens parse déjà les `.html`, les scriptlets et les `google.script.run` (le pont client→serveur). C'est la moitié serveur-facing de la famille.
➕ Manque : la correction *intrinsèque du client* (mixed content, `target`, forms, contexte de `run`). → proposé en §21.4.
**Risque silencieux** : élevé. Ces bugs ne lèvent aucune exception serveur ; `check` afficherait `CLEAN` alors que l'UI est cassée à l'exécution.

### Famille B — Dev GAS serveur : le cœur métier (`.gs`)

C'est le gros du volume de code : services Google (`SpreadsheetApp`, `DriveApp`, `GmailApp`, `UrlFetchApp`…), `PropertiesService`/`CacheService`, `LockService`, triggers, et la logique. Les pièges dominants ici ne sont **pas** des bugs de logique mais des **collisions avec l'environnement d'exécution** — une source secondaire (vendeur, à prendre comme estimation indicative) avance que les collisions de quota, et non les erreurs de logique, représenteraient plus de la moitié des erreurs Apps Script en production. Les patrons à connaître :

- **Limite d'exécution ~6 minutes** par invocation (l'ancienne exception 30 min des comptes Workspace a en pratique disparu). Au-delà : `Exceeded maximum execution time`, et tout le travail non persisté est perdu.
- **Modèle stateless** : aucune mémoire entre exécutions. Les longues tâches exigent le patron **chunk + état dans `PropertiesService` + trigger de continuation** (relancer la suite via un trigger time-based en sauvegardant l'index de progression).
- **Quotas journaliers** : `UrlFetchApp` (20 000/j conso, 100 000/j Workspace), lectures/écritures Properties, « Service invoked too many times », etc.
- **Performance par batch** : `getValues()`/`setValues()` (un appel) au lieu de `getValue()`/`setValue()` en boucle (N appels au service) — l'optimisation à plus fort levier, recommandée par Google lui-même.
- **Concurrence** : `LockService` pour les sections critiques (triggers qui se chevauchent, états « dernière ligne traitée » lus en double) — avec libération **dans un `finally`**, sinon le lock reste tenu et bloque les exécutions futures.
- **Récursion de triggers** : un trigger time-based qui se recrée mais n'est jamais supprimé une fois le travail fini → il tire *indéfiniment*, consommant du quota d'exécution journalier.
- **V8 vs Rhino** : `runtimeVersion` dans le manifeste ; syntaxe moderne et appels de méthodes d'objet depuis triggers/callbacks seulement en V8.

✅ Aujourd'hui : GAS-Lens suit l'arité 2D `getValues()`, les clés Properties, les triggers par chaîne — pour la **régression**, pas pour la **correction**.
➕ Manque : un *lint de correction/quota* GAS-aware (batch en boucle, lock sans `finally`, trigger orphelin, continuation sans persistance d'état). → proposé en §21.3.
**Risque silencieux** : moyen-élevé. Ces erreurs *lèvent* parfois une exception (donc rattrapables), mais souvent en production seulement, sous charge — jamais vues par l'agent au moment d'écrire.

### Famille C — Le manifeste & les scopes (`appsscript.json`)

C'est la famille **la plus négligée** et, à mon sens, le plus beau gisement statique restant. Le manifeste est le contrat entre le code et la plateforme :

- **`oauthScopes`** : si le code appelle `GmailApp.sendEmail` mais que le scope Gmail n'est pas déclaré (et que l'auto-détection ne joue pas, p. ex. en déploiement explicite ou avec `@OnlyCurrentDoc`), l'autorisation échoue — souvent silencieusement à l'usage. Réciproquement, un scope **trop large** (p. ex. `auth/drive` complet là où `drive.file` suffirait) est un risque de sécurité et de friction d'autorisation.
- **`dependencies.enabledAdvancedServices`** : pour utiliser `Drive.Files.list()` (service avancé), il faut une entrée `{userSymbol, serviceId, version}` dans le manifeste **et** l'API activée côté GCP. Code qui appelle `Drive.…` sans l'entrée → `ReferenceError: Drive is not defined`, invisible en statique aujourd'hui.
- **`dependencies.libraries`** : `{userSymbol, libraryId, version}`. Un appel `OAuth2.getService()` dont `OAuth2` n'est pas dans `libraries` casse ; et inversement une lib déclarée mais jamais utilisée est du bruit.
- **`urlFetchWhitelist`** : si présent, restreint les URL de `UrlFetchApp` — un fetch vers un domaine hors liste échoue.
- **`@OnlyCurrentDoc` / `@NotOnlyCurrentDoc`** : annotations qui changent les scopes effectifs.
- **`webapp` (access / executeAs)** : « exécuter en tant que moi » vs « utilisateur » change les permissions effectives (déjà noté V1 §3.2, jamais exploité).

✅ Aujourd'hui : rien sur le manifeste comme objet de vérification (il est lu pour résoudre les préfixes de librairie, c'est tout).
➕ Manque : une **intelligence manifeste ↔ code** (scopes/services/libs/whitelist déclarés vs réellement utilisés, dans les deux sens). → proposé en §21.1.
**Risque silencieux** : élevé. Le décalage manifeste/code ne se voit ni à l'édition ni au `tsc` ; il se manifeste comme un échec d'autorisation à l'exécution, le pire moment.

### Famille D — Le build & le tooling (clasp / TypeScript / types)

Deux mondes (V2 §8.1) : projet « brut » et projet « source TS + bundler ». Points que la recherche confirme et qui touchent l'agent :

- **`clasp` ne transpile plus** le TS (déjà acté V2) ; le build est en amont (esbuild/Rollup/webpack). `.clasp.json` porte `rootDir`, `fileExtension`, **`filePushOrder`** (ordre de push, rare mais déterminant dans certains cas), `scriptId`, `projectId`.
- **`@types/google-apps-script`** (DefinitelyTyped) type l'intégralité des services intégrés — c'est *la* ressource pour valider les appels GAS sans exécuter (clé pour §21.2).
- **Résolution des libs cassée en local** : `LibName.fn()` lève `Cannot find name 'LibName'` sous `tsc` parce que la lib n'est pas un module npm — exactement la couture que GAS-Lens résout déjà côté graphe, et que `emit-dts` pourrait étendre aux libs.

✅ Aujourd'hui : `emit-dts` pour le pont `google.script.run`, indexation de la source et non de l'artefact.
➕ Manque (mineur, optionnel) : émettre aussi des `.d.ts` pour les **librairies inter-projets** (pas seulement `google.script.run`), pour que `tsc` voie `LibName.fn()`. → mentionné en §22.1 (lié à la résolution live).

### Famille E — L'exploitation / la prod (logs, métriques, déploiements)

Famille **entièrement absente** des volumes 1-2, et c'est normal : elle n'est pas statique. L'API Apps Script expose des faits que *seule* la prod connaît :

- **`projects.getMetrics`** : nombre d'exécutions, utilisateurs actifs, **erreurs**, filtrables par fonction / déploiement / intervalle.
- **`projects.deployments`** / **versions** : quelle version est *live*, quels *entry points* (web app, API exécutable, add-on).
- **`processes.list`** : historique d'exécution (statut, fonction, déclencheur, durée). Logs persistants via Cloud Logging.

✅ Aujourd'hui : rien (par conception — V2 §12 écarte l'exécution).
➕ Opportunité : non pas *exécuter*, mais *lire la vérité terrain* en lecture seule. → proposé en Partie 22. C'est l'extension « complètement nouvelle » que tu évoquais.

---

## Partie 20 — Synthèse intermédiaire : la matrice « qui attrape quoi »

Avant les propositions, une vue d'ensemble de la répartition du travail, qui montre *où* GAS-Lens a encore un rôle exclusif :

| Classe d'erreur | `tsc` (si typé) | Exécution / `gas-fakes` | **GAS-Lens statique** | GAS-Lens + API (§22) |
|---|---|---|---|---|
| Régression structurelle inter-fonctions (champ retiré, arité) | partiel | oui mais coûteux | **✅ cœur actuel** | — |
| Couture `google.script.run` / scriptlets / triggers par chaîne | non | non | **✅ cœur actuel** | — |
| Méthode GAS hallucinée (`getValuesAll`) | non¹ | oui (lent) | **➕ §21.2** | — |
| Scope/service/lib manquant au manifeste | non | parfois | **➕ §21.1** | — |
| Quota / 6 min / lock / trigger orphelin | non | non (ne se voit qu'en charge) | **➕ §21.3** (heuristique) | confirmable §22.2 |
| Bug web app (mixed content, target, form) | non | partiel (`gas-fakes serve`) | **➕ §21.4** | — |
| Régression *sémantique* (sens d'une valeur) | non | **oui (seul)** | non (par nature) | indices via métriques |
| Code réellement mort vs « semble mort » | non | non | heuristique | **✅ confirmé §22.2** |

¹ `tsc` ne valide les appels GAS que si `@types/google-apps-script` est référencé *et* le projet est typé — ce qui est loin d'être systématique, surtout dans les projets « bruts ». GAS-Lens peut faire cette validation **sans exiger que le projet soit typé**, ce qui est précisément l'intérêt.

La colonne « GAS-Lens statique » montre que **l'essentiel des gisements restants est intrinsèque** (une seule fonction, une seule édition) et non relationnel — donc orthogonal au cœur actuel, pas redondant.

---

## Partie 21 — Nouvelles capacités **statiques** (sans API externe, sans exécution)

Ces cinq capacités ne nécessitent ni réseau, ni auth, ni exécution. Elles restent dans le contrat du Volume 1 : instantanées, locales, sans effet de bord, donc câblables dans le hook `PostToolUse`. Pour chacune : *ce que c'est*, *l'intérêt* (en tokens et/ou régressions), et *le positionnement* vs l'existant.

### 21.1 — `gaslens manifest` : l'intelligence manifeste ↔ code

**Ce que c'est.** Une commande (et un contributeur au `check`) qui croise `appsscript.json` avec le code indexé, dans les deux sens :
- services Google utilisés dans le code → **scopes requis** vs `oauthScopes` déclarés (manquants *et* superflus) ;
- `Drive.…`, `Sheets.…`, etc. (services avancés) utilisés → vs `enabledAdvancedServices` ;
- `LibName.fn()` référencés → vs `dependencies.libraries` ;
- cibles `UrlFetchApp.fetch(url)` à URL littérale → vs `urlFetchWhitelist` ;
- cohérence `@OnlyCurrentDoc` ↔ scopes effectifs ↔ `webapp.executeAs`.

Sortie type : `scope.missing` (`GmailApp.sendEmail` à `email.gs:42` exige `auth/gmail.send`, absent du manifeste), `advanced_service.missing`, `library.undeclared`, `scope.over_broad` (info), `library.unused` (info).

**Intérêt.**
- *Régressions évitées* : le décalage manifeste/code est une des rares classes d'erreur qui (a) casse réellement en prod, (b) par un échec d'autorisation difficile à diagnostiquer, et (c) est **invisible** à `tsc` comme à un linter JS. La détecter à l'édition supprime un aller-retour « pourquoi mon `Drive.Files.list` plante » qui, en GAS, coûte un déploiement complet pour être seulement *reproduit*.
- *Tokens* : sans l'outil, un agent qui doute des scopes doit lire le manifeste, lister mentalement les services appelés dans plusieurs fichiers, et croiser à la main — exactement le « re-grep manuel » que le contrat de confiance veut supprimer. Une réponse `manifest` structurée remplace cette lecture.
- *Spécificité GAS* : 100 %. Aucun outil générique ne connaît la correspondance service→scope d'Apps Script.

**Positionnement.** Nouveau et non redondant : GAS-Lens lit déjà le manifeste pour les préfixes de librairie, mais ne le *vérifie* pas. C'est un nouveau *consumer kind* (`manifest`) dans le moteur de `check`, donc faible coût d'intégration.

### 21.2 — `gaslens validate-api` : le garde-fou anti-hallucination GAS

**Ce que c'est.** Validation statique des appels aux **services intégrés GAS** contre la surface réelle de l'API, en s'appuyant sur `@types/google-apps-script` (DefinitelyTyped) comme source de vérité — sans exiger que le projet de l'utilisateur soit typé. On capture les chaînes `member_expression` enracinées sur un service connu (`SpreadsheetApp`, `DriveApp`, `GmailApp`, `Utilities`, `PropertiesService`, …) et on vérifie que chaque méthode existe, avec la bonne arité grossière. Émet `api.unknown_method` (`SpreadsheetApp.getActiveSheet().getValuesAll()` — méthode inexistante, proche : `getValues`), `api.wrong_arity`, `api.deprecated` (p. ex. usages Rhino-only sous `runtimeVersion: V8`).

**Intérêt.**
- *Le plus gros levier « intention 4 » (§18.1)*. En langage normal, une méthode hallucinée est rattrapée gratuitement par l'interpréteur (Willison) ; **en GAS, ce filet n'existe pas localement** (§18.2). Rapatrier cette validation en statique redonne à l'agent le feedback que tous les autres écosystèmes lui offrent par défaut — sans `clasp push`, sans effet de bord, à l'édition.
- *Tokens & itérations* : supprime des cycles entiers « écrire → déployer → erreur cryptique → relire la doc → corriger ». Le coût d'un tel cycle en GAS se compte en minutes et en quota, pas en millisecondes.
- *Synergie avec `emit-dts`* : `emit-dts` aide déjà `tsc` à attraper les typos *côté client* sur les noms de fonctions serveur. `validate-api` étend ce filet au code *serveur* lui-même et aux projets *non typés* (la majorité des projets « bruts »).

**Positionnement.** Nouveau. C'est le complément serveur de `emit-dts` (qui couvre le pont client). Attention au périmètre : ne valider que les **services intégrés** (déterministes via les types) ; les méthodes de librairies tierces restent du ressort de la résolution inter-projets (§22.1), et tout ce qui n'est pas résoluble part dans `coverage` — fidèle à la doctrine d'honnêteté des volumes précédents.

### 21.3 — `gaslens lint-runtime` : le lint de correction & quota GAS-aware

**Ce que c'est.** Un ensemble de règles *heuristiques* ciblant les collisions d'environnement de la Famille B, chacune avec une `confidence` honnête :
- `quota.value_in_loop` : `getValue()`/`setValue()` (ou `appendRow`) dans une boucle → suggérer le batch `getValues`/`setValues`.
- `lock.no_finally` : `LockService` acquis sans libération dans un `finally`.
- `trigger.orphan` : `ScriptApp.newTrigger(...).timeBased()...create()` sans suppression correspondante (`deleteTrigger`) sur le chemin de fin → risque de récursion infinie.
- `longrun.no_state` : boucle sur un grand range / `UrlFetchApp` répété sans persistance d'état (`PropertiesService`) ni découpage → risque « 6 min ».
- `urlfetch.in_loop` : appels réseau séquentiels là où `UrlFetchApp.fetchAll()` existe.

**Intérêt.**
- *Régressions de prod* : ce sont précisément les erreurs qui ne se voient ni à l'édition, ni au `tsc`, ni même à un test à blanc — seulement **sous volume/charge en production**. Les signaler à l'écriture est la seule fenêtre où c'est bon marché.
- *Honnêteté assumée* : ces règles sont des heuristiques (`confidence: medium`), pas des vérités structurelles. Elles s'inscrivent donc naturellement dans le cadre `coverage`/`severity` des volumes précédents — un `warn`/`info`, jamais un `break` qui bloquerait à tort.
- *Spécificité GAS* : forte. Un ESLint générique connaît « pas d'`await` dans une boucle » ; il ignore totalement « `getValue` en boucle coûte un appel de service Sheets quota-é par itération ».

**Positionnement.** Nouveau, mais à cadrer comme **`warn`/`info` par défaut** pour ne pas diluer le signal `break` (qui doit rester réservé aux régressions structurelles certaines). Optionnel/activable, pour respecter la contrainte « hook rapide et silencieux 90 % du temps » (V2 §15.2).

### 21.4 — `gaslens lint-webapp` : le lint client / IFRAME

**Ce que c'est.** Règles ciblant la Famille A, sur les `.html` servis :
- `webapp.mixed_content` : ressource active en `http://` (script/CSS/XHR) → bloquée par le sandbox HTTPS.
- `webapp.link_target` : `<a href>` de navigation sans `target="_top"`/`_blank` et sans `<base target="_top">`.
- `webapp.form_submit` : `<form>` avec handler `onclick`/`onsubmit` mais sans `preventDefault` → navigation parasite en IFRAME.
- `webapp.run_out_of_context` : `google.script.run` utilisé dans un fragment manifestement destiné à un iframe imbriqué/popup.

**Intérêt.**
- *Classe de bug à risque maximal* (Famille A) : aucune exception serveur, `check` dirait `CLEAN`, et pourtant l'UI est cassée *une fois déployée seulement*. C'est le pire profil pour un agent qui itère sans pouvoir tester.
- *Complémentarité avec `gas-fakes serve`* (§23) : `gas-fakes serve` émule doGet/doPost localement **mais n'applique pas** les restrictions iframe de Google — donc l'émulation locale *masque* précisément ces bugs. Le lint statique les attrape là où l'exécution locale ne le peut pas.

**Positionnement.** Nouveau. Étend le pipeline HTML existant (déjà en place pour scriptlets et `google.script.run`) avec des règles ciblées — coût d'intégration faible, le parseur HTML est déjà là.

### 21.5 — `gaslens map` : la table des matières anti-orientation

**Ce que c'est.** Une commande d'aperçu *ultra-compacte* d'un projet ou du workspace, pensée comme la « table des matières » qui manque à l'agent (§18.3, trou d'orientation) : par projet, la liste des entry points, des fonctions exposées au client, des triggers, des librairies exposées/consommées, et un compte de fonctions internes — *sans corps de fonction*, juste la carte. Pensée pour être lue **une fois en tête de session** (façon `CLAUDE.md` dynamique).

**Intérêt.**
- *Le trou à tokens n°1*. C'est la réponse directe au « lire 25 fichiers pour en comprendre 3 ». Donner à l'agent une carte de 300 tokens en ouverture lui évite des dizaines de lectures exploratoires. C'est aussi ce que fait l'« overview » de Serena, mais GAS-aware (entry points, expositions client, triggers — invisibles à un LSP générique).
- *Synergie d'amorçage* : un `map` en début de session rend les `inspect` suivants plus ciblés (l'agent sait *quoi* inspecter), réduisant le nombre d'appels d'outil par tâche — une des métriques de pilotage du Volume 1 (§5).

**Positionnement.** Léger et à fort levier. Toutes les données existent déjà dans l'index ; c'est une projection « summary du summary ». Probablement le meilleur rapport effort/économie de tokens de tout ce volume.

---

## Partie 22 — Extensions via les **API Google** : le saut « vérité terrain »

Ici on franchit délibérément la frontière statique — non pas pour *exécuter* le code de l'utilisateur (toujours proscrit, V2 §12), mais pour **lire en lecture seule** des faits que seules les API Google détiennent. C'est l'extension « complètement nouvelle » que tu évoquais. Trois capacités, par ordre de valeur.

### 22.1 — `gaslens resolve-live` : résolution des frontières externes via Drive API + Apps Script API

**Ce que c'est.** Aujourd'hui, un appel `RemoteLib.fn()` vers une librairie *hors du workspace local* part dans `coverage.external_boundaries` (« projet externe non indexé »). Or le manifeste donne le `libraryId` — qui **est** le `scriptId` du projet-librairie. Avec l'API Apps Script (`projects.getContent`), on peut **récupérer la source réelle de cette librairie** (code + manifeste) par son `scriptId`, l'indexer à la volée, et **transformer une frontière non résolue en couverture pleine**. La Drive API complète en *découvrant* le parc : les scripts *standalone* sont des fichiers Drive (`application/vnd.google-apps.script`) listables/recherchables.

**Intérêt.**
- *Cœur de la promesse multi-repos* (V1 §3.7). C'est la différence entre « je vois 92 %, les 8 % sont une lib externe que je ne peux pas trancher » et « 100 % résolu, y compris la lib externe ». Pour un parc réel où le code partagé vit dans des libs versionnées, c'est *la* couture qui plafonne aujourd'hui la couverture.
- *Tokens* : l'alternative, pour l'agent, serait d'aller ouvrir manuellement le projet-librairie dans l'éditeur web et le lire — impossible sans quitter la boucle. `resolve-live` fait ce travail une fois, en cache.
- *Bonus `emit-dts`* : une fois la source de la lib connue, on peut émettre des `.d.ts` pour `LibName.fn()` et rendre `tsc` capable de la voir (Famille D, §19), fermant la dernière couture « lib inter-projet » côté typage.

**Caveats à inscrire honnêtement.**
- *Auth requise* : OAuth + API Apps Script activée. À rendre **strictement optionnelle** (le cœur reste 100 % local et hors-ligne) ; `resolve-live` est un *enrichissement* explicite, déclenché à la demande, jamais dans le hook chaud.
- *Limite container-bound* : les scripts *container-bound* (liés à un Sheet/Doc) ne sont **pas** récupérables via Drive API ni Apps Script API — limitation connue et non résolue côté Google. À déclarer franchement dans `coverage` (`external_boundaries: "lib container-bound, non récupérable par API"`) plutôt que de prétendre une couverture qu'on n'a pas. C'est cohérent avec toute la doctrine d'honnêteté de l'outil.
- *Versionnage* : `getContent` donne la version `HEAD` ; or une lib est consommée à une **version figée** (`dependencies.libraries[].version`). Récupérer la bonne version (via `versions`/`deployments`) est nécessaire pour ne pas comparer le code du consommateur à une version de lib qu'il n'utilise pas.

**Positionnement.** Extension majeure, mais additive : elle *augmente la couverture* d'une capacité existante (la résolution inter-projets) plutôt que d'introduire un paradigme nouveau. Bon premier pas vers les API.

### 22.2 — `gaslens prod-truth` : la vérité d'exécution (métriques & processus)

**Ce que c'est.** Lecture seule de `projects.getMetrics` (exécutions, utilisateurs actifs, **erreurs** par fonction/intervalle) et `processes.list` (historique d'exécution), pour annoter l'index avec des faits de **production** :
- confirmer/infirmer le **code mort** : une fonction « qui semble morte » statiquement (aucune des expositions connues) mais qui *s'exécute* en prod est appelée par un chemin que le statique ne voit pas (dispatch dynamique, trigger UI, appel externe) → **ne pas supprimer**. Inversement, une fonction sans exécution depuis des mois conforte la candidature à suppression.
- pondérer le **risque** d'une modif par la *température* de la fonction : modifier une fonction exécutée 10 000×/jour n'a pas le même enjeu qu'une exécutée 2×/an.
- signaler les fonctions **déjà en erreur** en prod (le `getMetrics` remonte les erreurs) : l'agent sait qu'il touche du code déjà fragile.

**Intérêt.**
- *Tranche la classe la plus ingrate du statique* : le « code potentiellement mort » (V1 §3.8) et le dispatch dynamique (`coverage.unresolved`). Le statique ne *peut pas* trancher ; la prod, elle, *sait* si ça tourne. C'est l'unique source qui résout honnêtement ces angles morts — sans exécuter quoi que ce soit nous-mêmes.
- *Priorisation du raisonnement de l'agent* : la « température » et le taux d'erreur disent à l'agent **où concentrer sa vigilance** — exactement la philosophie « focalise ton raisonnement sur ce qui est incertain » du contrat de confiance (V2 §15.3), mais informée par le réel.
- *Régressions sémantiques (le Graal de V2 §10.4)* : le statique ne verra jamais qu'un champ a changé de *sens*. Mais une montée du taux d'erreur d'une fonction après une édition est un *signal a posteriori* qu'aucune analyse statique ne donne. `prod-truth` est le seul pont, même indirect, vers cette classe.

**Caveats.** Mêmes que §22.1 (auth, optionnel, hors hook chaud). Les métriques sont *agrégées et différées* — utiles pour la priorisation et le tri du code mort, pas pour un verdict bloquant en temps réel.

**Positionnement.** Nouveau paradigme (lecture de la prod), mais qui **renforce** des verdicts existants (`coverage`, code mort) au lieu de les remplacer. À garder en mode « enrichissement consultatif », jamais bloquant.

### 22.3 — `gaslens deploy-aware` : conscience des déploiements

**Ce que c'est.** Lecture de `projects.deployments` / `versions` pour savoir **quelle version est servie** et par quels *entry points* (web app / API / add-on). Permet d'élever la sévérité quand l'agent modifie une fonction qui est `doGet`/`doPost` **d'un déploiement actuellement live**, ou de distinguer « HEAD/dev » de « version déployée ».

**Intérêt.**
- *Contextualise l'impact* : casser la signature de `doGet` est grave dans l'absolu (V1 §3.8) ; c'est *critique et immédiat* si ce `doGet` sert une web app en production en ce moment. La distinction change le bon niveau d'alerte.
- *Évite les fausses urgences* : à l'inverse, du code uniquement en HEAD/non déployé peut être modifié plus librement.

**Positionnement.** La moins prioritaire des trois (valeur réelle mais plus étroite). À considérer après §22.1 et §22.2.

---

## Partie 23 — Amendement au Volume 2 §12 : `gas-fakes` rouvre (proprement) la porte de l'exécution

Le Volume 2 (§12) écarte l'exécution locale avec deux arguments : (a) mocker toute la surface API est colossal et ne fait que ré-encoder ses hypothèses ; (b) `clasp run` s'exécute dans le cloud Google, lentement et avec effets de bord. **Ces deux arguments restent vrais, mais un troisième chemin a mûri depuis et mérite d'amender la conclusion.**

**`gas-fakes`** (Bruce McPherson, actif fin 2025–2026) recrée l'environnement GAS sur Node.js en **traduisant** les appels de service GAS en requêtes vers les vraies API Google (`SpreadsheetApp.create()` → appel Sheets API), avec deux modes notables : un mode **sandbox sans permissions** (via le module `vm` de Node, idéal pour du code IA non fiable) et un mode `gas-fakes serve` qui **émule doGet/doPost localement** (boucle « save & refresh » jusque-là impossible). Un écosystème s'est formé autour (extension Gemini CLI, serveurs MCP bâtis dessus).

Ce que ça change pour GAS-Lens :

- **L'argument (a) tombe partiellement** : `gas-fakes` n'est pas « tes mocks qui te renvoient tes hypothèses » — il traduit vers les *vraies* API, donc il observe des *shapes réelles*. Le besoin que V2 §12.2 reformulait comme « connaître la forme des valeurs qui circulent » a désormais une réponse exécutable et locale, à côté du moteur de shapes statique.
- **`emit-contract-tests` (V2 §12.3) gagne un runner local.** L'outil émet déjà des harnais de test de contrat ; il les destinait à `clasp run` (cloud, effets de bord). Les **rediriger vers un runner `gas-fakes`** leur donne la propriété qui manquait : attraper les **régressions sémantiques** (V2 §10.4) — celles qu'aucune analyse statique ne voit — **sans déployer ni toucher la prod**, sur un Drive de test ou en sandbox `vm`.
- **`gas-fakes serve` ne dispense pas de §21.4** : son émulation locale **n'applique pas** les restrictions iframe de Google. Donc le lint web app statique reste nécessaire *précisément* là où l'émulation est aveugle. Les deux sont complémentaires, pas concurrents.

**Doctrine révisée.** Le garde-fou **statique reste primaire** (instantané, sans effet de bord, dans le hook). Mais la « vérification comportementale réelle, optionnelle et explicite » que V2 §12.3 reléguait à `clasp run` devrait viser **`gas-fakes` en local** comme cible de premier choix, et `clasp run` (cloud) seulement quand un effet de bord réel est indispensable. Pratiquement : `gaslens emit-contract-tests --runner gas-fakes`.

> **Position concurrentielle, à garder en tête.** L'espace « IA + GAS » a deux pôles : l'**exécution** (`gas-fakes` et ses extensions Gemini/MCP) et l'**analyse statique des coutures** (GAS-Lens, seul sur ce créneau). Ils ne se recouvrent pas — l'un *exécute*, l'autre *comprend les liens sans exécuter*. La bonne stratégie n'est pas de rivaliser avec `gas-fakes` sur l'exécution, mais de **s'y brancher** pour la couche comportementale, en restant le seul à cartographier statiquement les coutures.

---

## Partie 24 — Format de livraison : CLI **et** MCP **et** Skill (le trou à tokens n°4)

Le quatrième trou à tokens (§18.3) est le **bloat de schéma** : un serveur d'outils branché coûte des tokens de schéma à *chaque* requête, même si l'outil n'est jamais appelé — un retour d'expérience documenté évoque des dizaines de milliers de tokens dormants, et des évals où plus de la moitié des outils ne sont jamais invoqués. Le format de livraison de GAS-Lens est donc une décision de design *à part entière*, pas un détail d'emballage. Trois canaux, complémentaires :

- **CLI (le socle, existant).** Reste la vérité : déterministe, scriptable, idéal pour les hooks et la CI. À conserver comme interface primaire.
- **Serveur MCP (à ajouter).** C'est le format que l'écosystème agent attend (Serena, les serveurs `gas-fakes`/tanaikech sont tous MCP) ; il rend `inspect`/`impact`/`check`/`map` appelables nativement par Claude Code, Cursor, etc., sans wrapper shell. **Mais** il paie le coût de schéma permanent — d'où l'intérêt de la doctrine « peu d'outils à fort impact » du Volume 1 (§Principe 1) : exposer 3-4 outils consolidés (`map`, `inspect`, `impact`, `check`), pas dix micro-getters.
- **Skill Claude Code (à ajouter, le plus token-efficient).** Une Skill se charge **paresseusement** : son contenu n'entre en contexte que quand la tâche la déclenche. C'est le format qui **ne coûte rien tant qu'on n'en a pas besoin** — l'inverse du bloat MCP. Une Skill « gas-lens » qui apprend à l'agent *quand* et *comment* appeler la CLI (et qui empaquette le bloc `CLAUDE.md` du V2 §16) combine le meilleur des deux : zéro coût dormant, plein pouvoir à l'usage.

**Recommandation.** Garder la CLI comme cœur ; ajouter un **wrapper MCP mince** (pour l'intégration native) **et** une **Skill** (pour le chargement paresseux et l'onboarding de l'agent). Le hook `PostToolUse` (déjà en place) reste le canal *automatique*. Cette combinaison adresse directement le double objectif « agent-friendly » + « économe en tokens » que tu poses.

---

## Partie 25 — Priorisation (ROI décroissant)

Classement par rapport *valeur ajoutée / effort*, en distinguant les gains rapides des paris plus lourds. La « valeur » est jugée d'abord en régressions évitées et tokens économisés (la métrique reine du Volume 1), l'efficacité ensuite.

**Gains rapides (données déjà dans l'index, effort faible, 100 % local) :**
1. **`map`** (§21.5) — meilleur rapport effort/tokens de tout le volume ; bouche le trou d'orientation n°1.
2. **`manifest`** (§21.1) — classe de régression réelle, invisible ailleurs, faible coût d'intégration (nouveau *consumer kind*).
3. **Skill + bloc CLAUDE.md packagé** (§24) — onboarding agent quasi gratuit, chargement paresseux.

**Cœur de valeur (l'« intention 4 », effort moyen, 100 % local) :**
4. **`validate-api`** (§21.2) — redonne à l'agent le filet « méthode hallucinée » que GAS lui retire ; gros levier d'itérations économisées. S'appuie sur `@types/google-apps-script`.
5. **`lint-webapp`** (§21.4) — attrape la classe de bug à risque maximal (UI cassée sans exception), là où même l'émulation est aveugle.
6. **`lint-runtime`** (§21.3) — en `warn`/`info`, pour les collisions quota/6 min/lock/trigger.

**Paris (effort plus lourd, auth/API, optionnels et non bloquants) :**
7. **`resolve-live`** (§22.1) — fait passer la couverture multi-repos à 100 % sur les libs externes (hors container-bound). Premier pas API, additif.
8. **`emit-contract-tests --runner gas-fakes`** (§23) — ferme le seul gap que le statique ne peut pas fermer (régressions sémantiques), en local et sans effet de bord.
9. **`prod-truth`** (§22.2) — tranche le code mort et priorise par la température réelle ; consultatif.
10. **MCP server** (§24) et **`deploy-aware`** (§22.3) — utiles, mais après le reste.

---

### Ce qui *ne change pas* (et pourquoi c'est sain)

Aucune de ces propositions ne remet en cause les deux invariants des volumes précédents, et c'est volontaire :
- **L'honnêteté de la couverture** reste centrale : chaque nouvelle capacité (heuristiques de lint, données de prod, libs container-bound non récupérables) déclare franchement ses limites dans `coverage` plutôt que de bluffer. C'est ce qui rend l'outil *fiable pour un agent*, et c'est non négociable.
- **Le statique reste primaire et local** ; tout ce qui touche au réseau, à l'auth ou à l'exécution est **optionnel, explicite, et hors du hook chaud**. Le cœur de GAS-Lens doit pouvoir tourner hors-ligne, instantanément, à chaque édition — la contrainte du Volume 2 §15.2.

---

### Sources principales (vérifiées pour ce Volume 3)

- **Ingénierie de l'agent / trous à tokens** : retours d'expérience publics sur la consommation des agents de code (orientation vs résolution, économies des graphes de connaissance de code, dégradation « lost in the middle », coût de schéma des outils branchés) ; docs Claude Code (gestion des coûts, hooks). Le point « hallucinations de code = erreurs les moins coûteuses » (Simon Willison) — et son inversion en contexte GAS faute d'exécution locale.
- **Écosystème navigation symbolique** : Serena (MCP/LSP, `find_symbol`/`find_references`, supériorité du symbolique sur l'embedding pour « tous les appelants de X ») — référence de positionnement.
- **Spécificités & pièges GAS** : Google for Developers (Best Practices, Quotas for Google Services, HTML Service Best Practices/Restrictions, SandboxMode IFRAME, Migrate to IFRAME, Logging, V8 runtime, Container-bound/Standalone, Manifest & dependencies) ; retours communautaires (limite 6 min, LockService + `finally`, récursion de triggers, batch `getValues/setValues`, collisions de quota).
- **API Apps Script** : `projects.getContent`/`updateContent`/`get`, `projects.getMetrics`, `projects.deployments`/`versions`, `processes`, `scripts.run` — surface REST `script.googleapis.com`.
- **Tooling** : `google/clasp` (`.clasp.json`, `filePushOrder`, `rootDir`, clasp ne transpile plus le TS), `@types/google-apps-script` (DefinitelyTyped), résolution cassée des libs sous `tsc`.
- **Exécution locale** : `gas-fakes` (Bruce McPherson) — émulation locale par traduction vers les API Google, mode sandbox `vm`, `gas-fakes serve` pour doGet/doPost, écosystème Gemini CLI / MCP autour. Amende le V2 §12.
- **Volumes 1 & 2** (`gas-lens-conception.md`, `gas-lens-conception-2-verification-et-agent.md`) pour tout le socle : philosophie outil-pour-agent, modèle GAS, pipeline tree-sitter, moteur de shapes, enveloppe `coverage`, hooks, contrat de confiance, roadmap.
