/**
 * Dispatch dynamique : la cible dépend de la chaîne `name`.
 * Le scanner ne peut pas résoudre statiquement quelle fonction est appelée.
 */
function dispatchAction(name, payload) {
  const handlers = {
    start: function (p) { return { ok: true, kind: 'started' }; },
    stop: function (p) { return { ok: true, kind: 'stopped' }; },
  };
  return handlers[name](payload);
}

/**
 * Fonction qui peut renvoyer null dans une branche d'erreur — la couverture
 * statique doit marquer ce chemin.
 */
function lookupUser_(email) {
  if (!email) return null;
  return { email: email, found: true };
}

/**
 * Retour non-sérialisable : `new MyClass()` n'est pas transmissible via
 * google.script.run (V2 §11.5).
 */
function MyClass() {
  this.id = 1;
}
function buildEntity() {
  return new MyClass();
}

/** Retour avec clé calculée — la shape ne peut pas être fermée statiquement. */
function buildDynamicMap(k, v) {
  return { static: 1, [k]: v };
}
