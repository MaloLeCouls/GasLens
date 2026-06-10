/**
 * Envoie un rapport par email.
 * @param {Object} reportData données du rapport
 * @param {string[]} recipients destinataires
 * @returns {{success: boolean, messageId: string}}
 */
function sendEmailReport(reportData, recipients) {
  const body = formatReport(reportData);
  recipients.forEach(function (r) {
    GmailApp.sendEmail(r, 'Rapport', body);
  });
  const id = generateId_();
  return { success: true, messageId: id };
}

function formatReport(data) {
  return 'Rapport: ' + JSON.stringify(data);
}

function generateId_() {
  return Utilities.getUuid();
}
