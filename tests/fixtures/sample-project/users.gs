/**
 * Retourne un triplet [email, role, timestamp].
 * @returns {[string, string, Date]}
 */
function getCurrentUser_() {
  return [Session.getActiveUser().getEmail(), 'user', new Date()];
}

function logCurrentUser() {
  const [email, role, ts] = getCurrentUser_();
  Logger.log(email + ' ' + role + ' ' + ts);
}

function summarizeRow_(row) {
  // déstructuration sur la valeur de retour d'une fonction sans nom — non-bound
  const [name, qty] = [row[0], row[2]];
  return name + '=' + qty;
}
