function doGet(e) {
  const tpl = HtmlService.createTemplateFromFile('dashboard');
  tpl.data = { userName: getUserName_(), items: listItems() };
  return tpl.evaluate();
}

function doPost(e) {
  const payload = JSON.parse(e.postData.contents);
  const result = sendEmailReport(payload.data, payload.recipients);
  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function runWeeklyReport() {
  const weeklyData = listItems();
  const result = sendEmailReport(weeklyData, ['admin@example.com']);
  return result;
}

function installWeeklyTrigger_() {
  ScriptApp.newTrigger('runWeeklyReport')
    .timeBased()
    .everyWeeks(1)
    .create();
}
