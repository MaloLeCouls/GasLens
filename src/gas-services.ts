/**
 * Préfixes connus comme étant des services Google Apps Script natifs.
 * Un appel `GmailApp.sendEmail(...)` est *external_boundary*, pas un appel
 * interne du projet à résoudre.
 */
export const GAS_BUILTIN_SERVICES = new Set<string>([
  'SpreadsheetApp',
  'DocumentApp',
  'FormApp',
  'SlidesApp',
  'CalendarApp',
  'GmailApp',
  'MailApp',
  'DriveApp',
  'ContactsApp',
  'ContentService',
  'HtmlService',
  'XmlService',
  'UrlFetchApp',
  'Utilities',
  'Session',
  'ScriptApp',
  'PropertiesService',
  'CacheService',
  'LockService',
  'Logger',
  'console',
  'Browser',
  'Charts',
  'LinearOptimizationService',
  'LanguageApp',
  'Maps',
  'Jdbc',
  'BigQuery',
]);
