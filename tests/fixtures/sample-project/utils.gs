function listItems() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  const rows = sheet.getDataRange().getValues();
  return rows.map(function (row) {
    return { name: row[0], qty: row[2] };
  });
}

function getUserName_() {
  return Session.getActiveUser().getEmail();
}

const include = function (filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
};
