function getApiKey_() {
  return PropertiesService.getScriptProperties().getProperty('API_KEY');
}

function setApiKey_(key) {
  PropertiesService.getScriptProperties().setProperty('API_KEY', key);
}

function setupConfig() {
  PropertiesService.getScriptProperties().setProperty('LAST_RUN', new Date().toISOString());
  // Note: 'LAST_RUN' est écrit ici mais jamais relu — clé "write-only" / candidate à suppression.
}

function readUserPref_(name) {
  return PropertiesService.getUserProperties().getProperty(name);
}

function cacheLookup_(k) {
  return CacheService.getScriptCache().get(k);
}
