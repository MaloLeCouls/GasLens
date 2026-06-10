function doGet(e) {
  CommonUtils.log('doGet appelé');
  const today = CommonUtils.formatDate(new Date());
  return HtmlService.createHtmlOutput('<p>OK ' + today + '</p>');
}

function runBatch() {
  CommonUtils.log('runBatch démarré');
  const ts = CommonUtils.formatDate(new Date());
  Logger.log('Batch lancé à ' + ts);
}

function unknownProjectCall_() {
  // Référence à un préfixe inconnu : doit rester en coverage externe.
  ExtLib.something();
}
