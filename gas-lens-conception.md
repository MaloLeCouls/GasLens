# GAS-Lens — Document de conception

**Un outil CLI d'analyse de code Google Apps Script, conçu *d'abord* pour être consommé par un agent IA.**

Ce document croise deux recherches : (1) comment fonctionnent les LLM/agents et ce qui rend un outil « AI-friendly au niveau max », et (2) comment fonctionne réellement une web app Google Apps Script (GAS). Il en tire une conception concrète.

> Objectif produit annoncé : ~25 % d'économie de tokens, et surtout ~75 % de modifications sans régression dès le premier coup, parce que l'agent connaît *toutes* les implications avant de toucher au code.

---

## Partie 0 — Le bon cadrage mental

L'erreur classique serait de construire un « linter » ou un « grep amélioré ». Ce n'est pas ça.

Anthropic formule très bien la distinction dans son article *Writing effective tools for agents* : un appel de fonction classique est un **contrat entre systèmes déterministes** (`getWeather("NYC")` renvoie toujours la même chose de la même façon). Un *outil pour agent* est un **contrat entre un système déterministe (ton code) et un système non-déterministe (l'agent)**. L'agent peut appeler l'outil, répondre de mémoire, poser une question d'abord, ou se tromper de paramètre.

Conséquence directe sur la conception : on n'optimise pas pour « exposer toutes les fonctionnalités », on optimise pour **maximiser la surface sur laquelle l'agent réussit sa tâche**. Le bon réflexe, selon Anthropic : peu d'outils, à fort impact, qui correspondent à des workflows réels — pas un wrapper 1:1 par endpoint.

Pour ton cas, la tâche réelle de l'agent est presque toujours l'une de ces trois :

1. **« Je veux modifier la fonction X — qu'est-ce que je dois savoir avant ? »**
2. **« Si je change X de cette façon, qu'est-ce que ça casse ? »**
3. **« Où est le code qui fait Y ? »** (navigation/découverte)

Tout le design découle de ces trois intentions.

---

## Partie 1 — Comment fonctionnent les LLM/agents (les contraintes qui dictent le design)

Tu as dit ne pas bien connaître le fonctionnement de l'IA agentique. Voici l'essentiel, filtré pour ce qui impacte directement l'outil.

### 1.1 Le contexte est un budget d'attention fini et précieux

Un agent ne « lit » pas un repo comme un humain qui scanne. Tout ce qu'il regarde entre dans une **fenêtre de contexte** limitée. Anthropic le résume ainsi : le défi n'est plus de rédiger le prompt parfait, mais de *curer* ce qui entre dans le budget d'attention limité du modèle à chaque étape — il faut traiter le contexte comme une ressource finie et précieuse.

Le coût se paie **trois fois** :

- le **schéma de l'outil** (nom + description + paramètres) est chargé en contexte même si l'outil n'est jamais appelé ;
- l'**input** que l'agent fournit ;
- l'**output** que l'outil renvoie.

Un serveur avec 20 outils peut ajouter 2 000–4 000 tokens à *chaque* requête rien qu'avec les schémas. D'où une règle : peu d'outils, descriptions denses, sorties filtrées.

### 1.2 La recherche « force brute » est l'anti-pattern n°1

L'analogie d'Anthropic : chercher un contact en lisant l'annuaire page par page depuis le début. Un logiciel classique fait ça très bien (mémoire abondante et bon marché). Un agent qui reçoit *toute* la liste et doit la lire token par token gaspille son contexte sur du bruit.

→ **Le bon outil saute directement à la bonne page.** Pour toi : ne jamais renvoyer « tout le repo ». Renvoyer une réponse ciblée, ou une réponse large mais *structurée et filtrable*, sur laquelle l'agent affine.

### 1.3 Limitations concrètes à compenser

| Limitation du LLM | Ce que l'outil doit faire pour compenser |
|---|---|
| Pas de mémoire entre les appels | Chaque réponse doit être auto-suffisante (contenir les positions, le contexte, pas juste un ID). |
| Hallucine sur les identifiants cryptiques (UUID, hash) | Privilégier des noms sémantiques, des IDs lisibles, des chemins relatifs clairs. |
| Mauvais avec l'information « perdue au milieu » d'un gros bloc | Mettre l'info la plus importante en tête de réponse ; structurer (champs nommés). |
| Ne peut pas *exécuter* le code pour savoir ce qu'il fait | L'outil fait l'analyse statique à sa place et renvoie des faits, pas des suppositions. |
| Peut se tromper de paramètre / mal lire une erreur | Messages d'erreur pédagogiques qui disent *comment corriger*, pas juste un code. |

### 1.4 Forces du LLM sur lesquelles s'appuyer

- Excellent pour **filtrer/raisonner sur du structuré** : donne-lui du JSON propre, il navigue.
- Excellent avec le **langage naturel** : un champ `inferred_contract.description` en clair vaut mieux qu'un type abstrait.
- Sait **chaîner plusieurs appels** : mieux vaut plusieurs petites recherches ciblées qu'une grosse. On peut explicitement l'encourager à ça dans la doc de l'outil.

### 1.5 Le point que *tu* as bien identifié : l'honnêteté sur l'incertitude

Tu veux qu'en cas de « je ne sais pas / 10 % inaccessible », l'outil le dise, avec un niveau de détail paramétrable. **C'est exactement la bonne intuition** et c'est sous-estimé dans la plupart des outils. Un agent qui reçoit une réponse silencieusement incomplète va construire une modification sur du sable. Un agent qui reçoit « voici 90 %, et voici précisément les 10 % que je n'ai pas pu résoudre statiquement, pour ces raisons » peut décider d'aller vérifier lui-même.

On formalise ça plus bas sous le nom **d'enveloppe de couverture** (`coverage`).

---

## Partie 2 — Principes d'un outil « AI-friendly au niveau max »

Synthèse directement actionnable, tirée surtout de l'article d'ingénierie d'Anthropic, complétée par les retours d'expérience de l'équipe Chrome DevTools (qui a réduit massivement la conso de tokens de son agent en passant de JSON brut à un format spécialisé + récupération à la demande) et de plusieurs guides MCP.

### Principe 1 — Peu d'outils, à fort impact

Plutôt que `list_functions`, `get_function`, `list_callers`, `list_files`…, on consolide autour des intentions réelles. Anthropic donne exactement ce conseil : au lieu de `get_customer_by_id` + `list_transactions` + `list_notes`, faire un `get_customer_context` qui compile tout. Pour toi → un `inspect` riche plutôt que dix micro-getters.

### Principe 2 — Namespacing clair

Préfixer par domaine : `gaslens_inspect`, `gaslens_impact`, `gaslens_search`. Évite la confusion quand l'agent a aussi 30 autres outils branchés.

### Principe 3 — Renvoyer du contexte à haut signal

Anthropic insiste : éviter les identifiants techniques bas niveau (`uuid`, `mime_type`, `256px_url`), privilégier ce qui informe l'action (`name`, `file`, `line`, `return_shape`). Résoudre les IDs cryptiques en langage interprétable améliore mesurablement la précision et réduit les hallucinations.

### Principe 4 — Verbosité contrôlée par paramètre (`response_format`)

C'est la réponse directe à ton souhait « parcourir large OU chirurgical ». Anthropic recommande un enum `concise | detailed` (comme GraphQL où tu choisis tes champs). On l'étend pour ton cas :

```
detail_level: "summary" | "standard" | "full" | "graph"
```

- `summary` → juste signature + 1 ligne de contrat + nombre de call sites. Ultra peu de tokens, pour « parcourir ».
- `standard` → + tous les call sites avec position et arguments.
- `full` → + contrat inféré complet, handlers, expositions interface, JSDoc.
- `graph` → la sous-section du graphe de dépendances (entrants/sortants) sous forme exploitable.

### Principe 5 — Efficacité tokens par défaut

Pagination, filtrage, troncature, plages, avec **des valeurs par défaut raisonnables**. Claude Code, par exemple, plafonne les réponses d'outil à 25 000 tokens par défaut. Pour toi : si une fonction a 200 call sites, on en renvoie 20 + un `truncated: true` + `total: 200` + comment paginer.

### Principe 6 — Erreurs pédagogiques

Pas `Error 422`. Plutôt : `« La fonction 'sendEmailReport' est introuvable. 3 fonctions au nom proche existent : sendEmail, sendReport, sendWeeklyEmail. Relance avec --fuzzy pour une recherche approximative. »` Anthropic note que des erreurs « prompt-engineerées » réorientent l'agent vers un bon comportement.

### Principe 7 — Descriptions d'outils rédigées comme pour un nouvel arrivant

Expliciter le jargon, les formats attendus, les relations entre ressources. Nommer les paramètres sans ambiguïté (`function_id` plutôt que `name` si c'est un identifiant qualifié). Anthropic rapporte que de petites précisions sur les descriptions d'outils ont donné des gains spectaculaires (état de l'art sur SWE-bench Verified après affinage des descriptions).

### Principe 8 — Beaucoup de paramètres, tous documentés

Tu l'as demandé et c'est juste *à condition* que chaque paramètre soit décrit, typé strictement, avec une valeur par défaut et un exemple. On pense « API pour LLM » : l'agent ne devine pas, il lit le schéma.

### Principe 9 — L'enveloppe de couverture (ta feature « je ne sais pas »)

Chaque réponse embarque un objet `coverage` :

```json
"coverage": {
  "resolved_pct": 90,
  "confidence": "high",
  "unresolved": [
    {
      "what": "1 call site via dispatch dynamique",
      "where": "src/router.gs:88",
      "reason": "appel de la forme handlers[name](payload) — la cible ne peut pas être résolue statiquement",
      "suggestion": "vérifier manuellement le contenu de l'objet 'handlers'"
    }
  ],
  "external_boundaries": ["appel vers la librairie 'CommonUtils' (projet externe non indexé)"]
}
```

Un paramètre `coverage_detail: "none" | "summary" | "full"` contrôle son verbiage.

---

## Partie 3 — Comment fonctionne réellement une web app GAS (le domaine à modéliser)

Voici le modèle que l'outil doit comprendre. Tu as dit ne pas avoir une maîtrise parfaite de GAS — cette partie sert aussi de référence.

### 3.1 Structure d'un projet

Un projet GAS = un ensemble de fichiers `.gs` (code serveur, JavaScript moteur V8) + des fichiers `.html` (interface ET/OU partials inclus côté serveur) + un manifeste `appsscript.json` (scopes, runtime, dépendances de librairies, config web app). En multi-repos, on a typiquement plusieurs de ces projets, certains se référençant via **librairies**.

> Particularité majeure : **toutes les fonctions `.gs` de niveau supérieur d'un projet partagent un même espace de noms global.** Il n'y a pas d'`import` entre fichiers `.gs` du même projet — `fileA.gs` voit directement les fonctions de `fileB.gs`. C'est central pour ton graphe d'appels : la résolution d'un appel ne dépend pas du fichier, mais du projet (+ librairies).

### 3.2 Les points d'entrée (entry points)

L'analyse statique doit traiter ces noms comme des **racines** du graphe (appelés par la plateforme, jamais « morts ») :

- **`doGet(e)`** — exécuté sur requête HTTP GET vers l'URL de la web app. Doit retourner un `HtmlOutput` (HtmlService) ou un `TextOutput` (ContentService).
- **`doPost(e)`** — idem pour POST.
- Le paramètre **`e`** (event object) contient les paramètres de requête : `e.parameter` (clé→première valeur), `e.parameters` (clé→tableau), `e.queryString`, `e.postData`, `e.pathInfo`. C'est l'« input » de la web app côté serveur.
- Le déploiement a un mode d'**exécution** : « exécuter en tant que moi » vs « en tant que l'utilisateur », et un périmètre d'accès. Ça change les permissions effectives (utile à signaler dans le contrat, pas critique pour le graphe).

### 3.3 Les deux services de sortie

- **HtmlService** : sert une UI. Soit `createHtmlOutput(string)`, soit `createHtmlOutputFromFile('Index')`, soit **templated** `createTemplateFromFile('Index').evaluate()`.
- **ContentService** : sert du texte/JSON brut (`createTextOutput(...).setMimeType(...)`) — typique des web apps « API ».

### 3.4 HTML templated et scriptlets (le pont serveur → HTML au rendu)

Quand on utilise `createTemplateFromFile(...).evaluate()`, le HTML peut contenir des **scriptlets** exécutés *côté serveur au moment du rendu* :

- `<? ... ?>` — scriptlet logique (boucles, conditions), n'imprime rien.
- `<?= ... ?>` — imprime la valeur **en l'échappant** (sécurité).
- `<?!= ... ?>` — imprime **sans échapper** (force-print, ex. pour injecter du HTML d'un partial).
- Pattern d'inclusion répandu : une fonction serveur `include(filename)` qui retourne `HtmlService.createHtmlOutputFromFile(filename).getContent()`, appelée via `<?!= include('styles') ?>`.
- On passe des données au template par affectation de propriétés avant `evaluate()` : `template.data = {...}`.

→ **L'outil doit parser les `.html` à la recherche de scriptlets**, car un appel de fonction serveur peut y vivre (`<?= getUserName() ?>`), et c'est un call site qu'un grep naïf raterait.

### 3.5 `google.script.run` — le pont client → serveur (le cœur de ta valeur ajoutée)

C'est l'API JavaScript **côté client** (dans le HTML servi) qui appelle de façon **asynchrone** les fonctions serveur `.gs`. Mécanique à modéliser précisément :

```js
google.script.run
  .withSuccessHandler(onSuccess)   // callback si succès ; reçoit la valeur de retour serveur en 1er arg
  .withFailureHandler(onError)     // callback si exception serveur ; reçoit l'objet Error
  .withUserObject(ctx)             // objet client repassé en 2e arg aux handlers (jamais envoyé au serveur)
  .maFonctionServeur(arg1, arg2);  // exécute la fonction serveur de ce nom
```

Faits importants pour l'analyse :

- **C'est asynchrone** : aucune valeur de retour directe. Le retour serveur arrive *uniquement* dans le `successHandler`. → **Le `successHandler` est la source de vérité sur la *shape* attendue du retour serveur.** C'est LE signal pour ton `inferred_contract`.
- On peut **chaîner et réutiliser** un « runner » avec plusieurs handlers (cf. doc Google : un `myRunner` avec deux `withSuccessHandler` différents).
- **Fonctions privées** : toute fonction serveur dont le nom finit par `_` (underscore) est **invisible au client** — `google.script.run` ne peut pas l'appeler et son nom n'est jamais envoyé au navigateur. → L'outil doit marquer ces fonctions comme « non exposables à l'interface » : utile pour distinguer surface publique vs interne.
- **`google.script.run` ne voit pas** les fonctions de librairies, ni les fonctions non déclarées au niveau supérieur. → contrainte de résolution à encoder.
- **Restrictions de types** sur les arguments et les valeurs de retour : seuls passent les primitives (number, boolean, string, null), les objets/tableaux composés de ces primitives, les `Date`, et (client→serveur) les éléments `<form>`. Pas de fonctions, pas d'éléments DOM, pas d'objets construits avec `new`. → Un retour serveur « non sérialisable » est un *bug latent* que l'outil peut détecter et signaler dans le contrat.
- Côté Docs/Sheets/Forms (dialogs/sidebars), il existe aussi `google.script.host` (fermer une boîte, etc.) — à reconnaître mais secondaire pour une web app pure.

### 3.6 Les triggers (autres racines du graphe)

- **Triggers simples** : fonctions à nom réservé exécutées automatiquement sans autorisation, avec périmètre limité — `onOpen(e)`, `onEdit(e)`, `onSelectionChange(e)`, `onInstall(e)`, et `doGet`/`doPost`.
- **Triggers installables** : créés par code (`ScriptApp.newTrigger('maFonction').timeBased()...create()` ou `...forSpreadsheet(...).onEdit().create()`) ou via l'UI. Peuvent appeler des services nécessitant autorisation.

→ L'outil doit : (a) traiter ces noms réservés comme racines, et (b) détecter les `ScriptApp.newTrigger('X')` comme exposition de `X` en tant que trigger (le nom de la fonction est une **chaîne**, pas une référence — donc à parser comme un call site « par nom »).

### 3.7 Multi-repos / librairies

Une fonction d'un projet A peut être appelée depuis un projet B via le **préfixe de librairie** défini dans le manifeste de B (`LibName.maFonction()`). Pour ton « map multi-repos », c'est le mécanisme clé à résoudre : indexer chaque projet, puis relier les appels `LibName.fn()` aux définitions du projet correspondant à `LibName`.

### 3.8 Synthèse : la « surface d'exposition » d'une fonction

C'est la taxonomie que ton outil doit produire pour chaque fonction. Une fonction donnée peut être :

| Type d'exposition | Détecté via | Implication pour une modif |
|---|---|---|
| Entry point web | nom = `doGet`/`doPost` | changer la signature casse le routage HTTP |
| Appelée depuis le client | `google.script.run.fn(...)` dans un `.html` | le `successHandler` définit le contrat de retour |
| Scriptlet de template | `<?= fn() ?>` dans un `.html` templated | le rendu serveur en dépend |
| Trigger (simple) | nom réservé | exécution auto par la plateforme |
| Trigger (installable) | `ScriptApp.newTrigger('fn')` | idem, lien par chaîne |
| Exposée comme librairie | publique + projet déployé en lib | des projets externes peuvent l'appeler (couverture partielle !) |
| Interne / privée | suffixe `_`, ou appelée seulement en interne | modif à risque local uniquement |
| Potentiellement morte | aucune des ci-dessus | candidate à suppression (avec prudence : dispatch dynamique) |

---

## Partie 4 — La conception de GAS-Lens

### 4.1 Pipeline

```
                ┌─────────────┐
  repos GAS ──► │   scan      │  parse .gs + .html (tree-sitter)
   (.gs/.html)  │  (indexer)  │  extrait défs, appels, scriptlets,
                └──────┬──────┘  google.script.run, triggers, manifeste
                       │
                       ▼
                ┌─────────────┐
                │   index     │  graphe persisté (SQLite recommandé,
                │  (le store) │  ou JSON pour démarrer) + contrats inférés
                └──────┬──────┘
                       │
        ┌──────────────┼───────────────┐
        ▼              ▼                ▼
   gaslens inspect  gaslens impact  gaslens search
   (tout savoir)    (qu'est-ce      (où est le code
                     que ça casse)   qui fait Y)
```

Pourquoi **tree-sitter** est le bon choix ici, confirmé par la recherche : grammaire JS/TS mature, parsing tolérant aux erreurs, **positions exactes** (ligne/colonne/offset) sur chaque nœud, et un **langage de requête S-expression** (`.scm`) qui permet d'exprimer « capture toutes les `call_expression` dont le membre est `google.script.run...` » de façon déclarative et maintenable, plutôt qu'avec des regex fragiles. Le binding `tree-sitter` + `tree-sitter-javascript` s'installe via npm et expose l'AST avec `startPosition`/`endPosition` par nœud. Le HTML se parse avec `tree-sitter-html` + injection JS dans les `<script>` et détection des scriptlets `<? ?>`.

### 4.2 Le modèle de données par fonction (ce qu'on indexe)

```json
{
  "id": "ProjectA::email.gs::sendEmailReport",
  "name": "sendEmailReport",
  "project": "ProjectA",
  "definition": {
    "file": "src/notifications/email.gs",
    "line": 42, "col": 0,
    "end_line": 71,
    "params": [
      { "name": "reportData", "jsdoc_type": "Object", "desc": "données du rapport" },
      { "name": "recipients", "jsdoc_type": "string[]", "desc": null }
    ],
    "returns": { "jsdoc_type": "{success:boolean, messageId:string}", "desc": "résultat d'envoi" },
    "visibility": "public",          // "public" | "private" (suffixe _)
    "serializable_return": true      // false = retour non transmissible via google.script.run
  },
  "exposures": [
    { "type": "client_call", "file": "frontend/dashboard.html", "line": 94 },
    { "type": "installable_trigger", "file": "src/triggers/setup.gs", "line": 12 }
  ],
  "calls_out": ["formatReport", "GmailApp.sendEmail", "CommonUtils.log"],
  "called_by": [
    {
      "file": "src/triggers/weekly.gs", "line": 18,
      "caller": "runWeeklyReport",
      "arguments": ["weeklyData", "ADMIN_EMAILS"],
      "return_used_as": "assigned:result"
    },
    {
      "file": "frontend/dashboard.html", "line": 94,
      "caller": "<client:onClickSend>",
      "via": "google.script.run",
      "success_handler": { "name": "onSendOk", "line": 97,
        "reads": ["result.success", "result.messageId"] },
      "failure_handler": { "name": "onSendErr", "line": 101 }
    }
  ],
  "inferred_contract": {
    "return_shape": {
      "success": "boolean — lu en dashboard.html:97",
      "messageId": "string — loggé en dashboard.html:98"
    },
    "param_constraints": {
      "recipients": "itéré (.forEach) en email.gs:55 → attendu array"
    },
    "source": "inferred_from_usage"   // vs "from_jsdoc"
  },
  "coverage": { "...": "voir Partie 2 / principe 9" }
}
```

Point fort : `inferred_contract` **infère le contrat implicite à partir des usages** (ce que le `successHandler` lit, comment les params sont consommés), même sans JSDoc. C'est ça qui permet à l'agent de modifier sans régression : il voit que `result.messageId` est lu côté client, donc il sait qu'il ne doit pas le retirer du retour.

### 4.3 Les commandes (l'interface pour l'agent)

Trois commandes, namespacées, chacune avec beaucoup de paramètres documentés.

#### `gaslens scan`
Construit/rafraîchit l'index. Idéalement incrémental (re-parse seulement les fichiers modifiés).

```
gaslens scan <chemin...>
  --output <path>            (défaut: .gaslens/index.db)
  --include-html <bool>      (défaut: true) parser scriptlets + google.script.run
  --resolve-libraries <bool> (défaut: true) relier les appels LibName.fn() entre projets
  --incremental <bool>       (défaut: true)
```

#### `gaslens inspect` — répond à « qu'est-ce que je dois savoir avant de modifier X »
La commande centrale. Renvoie large et filtrable, ou chirurgical.

```
gaslens inspect <function>
  --detail-level summary|standard|full|graph   (défaut: standard)
  --include callers,callees,contract,exposures,coverage   (sélection de champs, façon GraphQL)
  --max-callers <int>        (défaut: 25 ; au-delà → truncated:true + total + curseur)
  --cursor <token>           (pagination)
  --format json|ndjson|text  (défaut: json)
  --coverage-detail none|summary|full   (défaut: summary)
  --fuzzy <bool>             (défaut: false) recherche approximative si nom introuvable
```

#### `gaslens impact` — répond à « si je change X comme ça, qu'est-ce que ça casse » (ta feature anti-régression)
La feature qui vise les 75 % sans régression. On décrit le changement envisagé, l'outil parcourt le **graphe inverse** et confronte chaque call site / handler au contrat.

```
gaslens impact <function>
  --change remove-param:recipients
         | rename-param:old=new
         | change-return-shape:'-messageId'
         | rename:newName
         | change-signature:'(a, b) -> (a, b, c)'
  --severity-threshold info|warn|break   (défaut: warn ; filtre la sortie)
  --detail-level summary|standard|full
```

Sortie type :

```json
{
  "function": "sendEmailReport",
  "proposed_change": "change-return-shape: remove 'messageId'",
  "breaks": [
    { "severity": "break", "file": "frontend/dashboard.html", "line": 98,
      "reason": "le successHandler 'onSendOk' lit result.messageId — deviendrait undefined",
      "fix_hint": "retirer la lecture de messageId, ou conserver le champ" }
  ],
  "warns": [
    { "severity": "warn", "file": "src/triggers/weekly.gs", "line": 18,
      "reason": "appelant ignore le retour — pas d'impact direct mais à confirmer" }
  ],
  "safe": [],
  "coverage": {
    "resolved_pct": 90,
    "unresolved": [{ "where": "src/router.gs:88", "reason": "dispatch dynamique handlers[name]()" }]
  }
}
```

#### `gaslens search` — répond à « où est le code qui fait Y »
Découverte. Renvoie des résultats compacts (façon « concise »), l'agent affine ensuite avec `inspect`.

```
gaslens search <query>
  --kind function|callsite|client-call|trigger|entrypoint|any   (défaut: any)
  --project <name>
  --limit <int>   (défaut: 20)
  --format json|ndjson
```

### 4.4 Conventions de sortie (transversales)

- **Toujours du JSON structuré par défaut**, champs nommés explicites, info importante en tête.
- **Chemins relatifs au repo + ligne/colonne** partout (l'agent peut aller éditer directement — ta demande de « position renseignée »).
- **IDs sémantiques** (`Project::file::fn`), pas de hash opaque.
- **Pagination/troncature** avec `truncated`, `total`, `cursor`.
- **`coverage`** sur chaque réponse.
- **Erreurs pédagogiques** (suggestions de noms proches, drapeau `--fuzzy`).
- **`detail_level` + sélection de champs** pour le curseur « large ↔ chirurgical ».

### 4.5 Les patterns GAS spécifiques à extraire (requêtes tree-sitter)

C'est là qu'un outil générique échoue et que le tien gagne. Exemples de captures (`.scm`) à écrire :

- Définitions : `function_declaration`, `function` assignée à une `variable_declarator`, méthodes d'objet, et arrow functions de niveau supérieur.
- JSDoc : commentaire `comment` précédant immédiatement une définition → parser `@param`, `@returns`.
- `google.script.run` : `call_expression` dont l'objet est une chaîne de `member_expression` enracinée sur `google.script.run`, en capturant le dernier `property_identifier` (= nom serveur) et les `withSuccessHandler`/`withFailureHandler` de la chaîne.
- Scriptlets HTML : nœuds de template `<?= ... ?>` / `<? ... ?>` → ré-parser le contenu en JS (injection) pour y trouver des `call_expression`.
- Triggers installables : `call_expression` `ScriptApp.newTrigger(<string>)` → capturer l'argument chaîne.
- Appels de librairie : `member_expression` `Prefix.fn(...)` où `Prefix` correspond à une lib du manifeste.

### 4.6 Limites à assumer ouvertement (et à reporter via `coverage`)

L'analyse est **statique**. Elle ne résout pas, par nature :

- le **dispatch dynamique** (`handlers[name]()`, `this[m]()`) ;
- les objets de retour **construits dynamiquement** (clés calculées) ;
- les appels via `eval`/chaînes ;
- les frontières vers des **librairies externes non indexées** ou des services Google (`GmailApp`, etc.).

→ Tous ces cas ne sont pas des bugs de l'outil : ils sont **listés explicitement dans `coverage.unresolved`** avec localisation et raison. C'est précisément ton exigence « en cas de je-ne-sais-pas, on le dit, avec niveau de détail en paramètre ». En GAS, ces cas restent minoritaires car le code y est généralement explicite — mais l'honnêteté de l'outil est ce qui le rend fiable pour un agent.

---

## Partie 5 — Comment mesurer que ça marche (et atteindre tes 25 % / 75 %)

Anthropic recommande fortement de **piloter par l'évaluation** : générer des dizaines de tâches réalistes, faire tourner un agent avec/sans l'outil, mesurer. Concrètement pour toi :

- **Économie de tokens** : sur un jeu de tâches « modifie la fonction X », comparer les tokens consommés *avec* `gaslens inspect` vs *sans* (l'agent qui lit les fichiers à la main). Le levier principal, confirmé par toutes les sources : **filtrer à la source** (ne renvoyer que les champs utiles) est l'optimisation à plus fort effet de levier.
- **Sans régression du premier coup** : jeu de tâches où une modif naïve casse un `successHandler` ou un call site. Mesurer le taux où l'agent évite la casse *parce que* `gaslens impact` l'a prévenu. C'est ta métrique reine — bien plus importante que les tokens, et tu as raison de le dire : un modèle fort économise les tokens de toute façon, mais il ne peut pas *deviner* un contrat implicite qu'on ne lui montre pas.
- Suivre aussi : nombre d'appels d'outil par tâche, erreurs d'outil (paramètres invalides → signal pour améliorer descriptions/exemples).

Et l'astuce méta d'Anthropic : une fois un prototype debout, **colle les transcripts d'un agent qui l'utilise dans Claude Code et demande-lui d'améliorer tes descriptions d'outils et tes schémas**. Le modèle est excellent pour repérer ce qui le bloque.

---

## Partie 6 — Roadmap de build suggérée

1. **Scanner minimal** : tree-sitter sur `.gs`, extraire définitions + call sites internes + positions. Sortie JSON. *(valide le socle)*
2. **`inspect` standard** avec `called_by`/`calls_out` + `detail_level`.
3. **Patterns GAS** : `google.script.run`, scriptlets HTML, `doGet/doPost`, triggers.
4. **Contrat inféré** depuis les `successHandler` et la consommation des params. *(le différenciateur)*
5. **`impact`** : graphe inverse + confrontation au contrat. *(la feature 75 %)*
6. **`coverage`** transversale + erreurs pédagogiques.
7. **Multi-repos** : résolution des préfixes de librairie via manifestes.
8. **Éval + auto-optimisation** des descriptions d'outils.

---

### Sources principales
- Anthropic — *Writing effective tools for agents* et *Effective context engineering for AI agents* (principes outils/contexte, response_format, token efficiency, erreurs pédagogiques, éval).
- Google for Developers — doc Apps Script : *Web Apps* (doGet/doPost, event object, déploiement), *HTML Service: Communicate with Server Functions* et *Class google.script.run* (handlers, fonctions privées `_`, restrictions de types), *Content Service*.
- Tree-sitter — doc du *Query Language* / CLI et binding `tree-sitter-javascript` (positions, captures S-expression).
- Retours d'expérience token-efficiency : Chrome DevTools (format spécialisé + récupération à la demande), guides MCP (filtrer à la source).
