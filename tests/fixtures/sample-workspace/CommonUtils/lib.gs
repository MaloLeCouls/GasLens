/**
 * Loggue un message avec un préfixe standardisé.
 * @param {string} msg
 * @returns {void}
 */
function log(msg) {
  Logger.log('[CommonUtils] ' + msg);
}

/**
 * Formate une date ISO.
 * @param {Date} d
 * @returns {string}
 */
function formatDate(d) {
  return Utilities.formatDate(d, 'Europe/Paris', 'yyyy-MM-dd HH:mm:ss');
}

function privateHelper_() {
  return 'private';
}
