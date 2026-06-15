/**
 * Mapping service GAS → scope(s) OAuth requis (V3 §21.1).
 *
 * Doctrine : ce mapping est *informatif*. L'auto-détection Google joue
 * dans 95 % des cas ; on n'émet `scope.missing` QUE si `oauthScopes` est
 * **explicitement** déclaré dans le manifeste (l'auto-détection est alors
 * désactivée). Sévérité : `warn` (confidence: medium), jamais `break` —
 * le mapping reste partiel par construction.
 *
 * Source : doc Google Apps Script « OAuth Scopes for Services ».
 * On retient le scope « principal » de chaque service ; un service peut
 * avoir des variantes (ex: `spreadsheets.currentonly`), traitées comme
 * alternatives acceptables.
 */

export interface ScopeRequirement {
  /** Scope canonique (le plus large) ; au moins UN équivalent doit être déclaré. */
  primary: string;
  /** Alternatives acceptables (sous-ensembles plus restrictifs). */
  alternatives: string[];
}

export const SERVICE_SCOPE_REQUIREMENTS: Record<string, ScopeRequirement> = {
  GmailApp: {
    primary: 'https://mail.google.com/',
    alternatives: [
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.readonly',
    ],
  },
  MailApp: {
    primary: 'https://www.googleapis.com/auth/script.send_mail',
    alternatives: ['https://mail.google.com/'],
  },
  DriveApp: {
    primary: 'https://www.googleapis.com/auth/drive',
    alternatives: [
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
  },
  SpreadsheetApp: {
    primary: 'https://www.googleapis.com/auth/spreadsheets',
    alternatives: ['https://www.googleapis.com/auth/spreadsheets.currentonly'],
  },
  DocumentApp: {
    primary: 'https://www.googleapis.com/auth/documents',
    alternatives: ['https://www.googleapis.com/auth/documents.currentonly'],
  },
  FormApp: {
    primary: 'https://www.googleapis.com/auth/forms',
    alternatives: ['https://www.googleapis.com/auth/forms.currentonly'],
  },
  SlidesApp: {
    primary: 'https://www.googleapis.com/auth/presentations',
    alternatives: ['https://www.googleapis.com/auth/presentations.currentonly'],
  },
  CalendarApp: {
    primary: 'https://www.googleapis.com/auth/calendar',
    alternatives: ['https://www.googleapis.com/auth/calendar.readonly'],
  },
  ContactsApp: {
    primary: 'https://www.googleapis.com/auth/contacts',
    alternatives: ['https://www.googleapis.com/auth/contacts.readonly'],
  },
  UrlFetchApp: {
    primary: 'https://www.googleapis.com/auth/script.external_request',
    alternatives: [],
  },
  ScriptApp: {
    primary: 'https://www.googleapis.com/auth/script.scriptapp',
    alternatives: [],
  },
  Session: {
    primary: 'https://www.googleapis.com/auth/userinfo.email',
    alternatives: ['https://www.googleapis.com/auth/userinfo.profile'],
  },
};

/**
 * Services qui ne requièrent AUCUN scope OAuth — utiles pour signaler
 * un `scope.unused` proprement (on ne suspectera pas ces services).
 */
export const SERVICES_WITHOUT_SCOPE = new Set<string>([
  'PropertiesService',
  'CacheService',
  'LockService',
  'Utilities',
  'Logger',
  'HtmlService',
  'ContentService',
  'XmlService',
  'console',
]);

export function scopesAcceptedFor(service: string): string[] {
  const req = SERVICE_SCOPE_REQUIREMENTS[service];
  if (!req) return [];
  return [req.primary, ...req.alternatives];
}

/** Vrai si l'un des scopes acceptés pour `service` figure dans `declared`. */
export function isScopeSatisfied(service: string, declared: Set<string>): boolean {
  const accepted = scopesAcceptedFor(service);
  if (accepted.length === 0) return true; // service sans exigence connue
  return accepted.some((s) => declared.has(s));
}

/**
 * Inverse : pour un scope déclaré, quels services pourraient justifier sa présence ?
 * Utilisé par `scope.unused` pour formuler une explication.
 */
export function servicesThatCouldJustify(scope: string): string[] {
  const out: string[] = [];
  for (const [svc, req] of Object.entries(SERVICE_SCOPE_REQUIREMENTS)) {
    if (req.primary === scope || req.alternatives.includes(scope)) {
      out.push(svc);
    }
  }
  return out;
}
