import { GAS_BUILTIN_SERVICES } from './gas-services.js';
import {
  SERVICE_SCOPE_REQUIREMENTS,
  SERVICES_WITHOUT_SCOPE,
  isScopeSatisfied,
  scopesAcceptedFor,
  servicesThatCouldJustify,
} from './scopes.js';
import type { Finding, Verdict } from './findings.js';
import { aggregateVerdict } from './findings.js';
import type {
  ApiCallChainRecord,
  ProjectIndex,
  ProjectManifest,
  ReceiverUsage,
} from './types.js';

/**
 * Symboles utilisateurs par défaut des **services avancés Google Apps Script**.
 * Sources : doc Google « Advanced Google services » ; on liste les plus courants.
 * Tout préfixe utilisé qui matche ici doit avoir une entrée dans
 * `dependencies.enabledAdvancedServices` (sans quoi `ReferenceError` runtime).
 *
 * Note : `BigQuery` est *à la fois* un service avancé et listé dans
 * GAS_BUILTIN_SERVICES (legacy). On l'inclut quand même ici pour qu'un usage
 * sans déclaration soit signalé — c'est la version Google la plus courante.
 */
const KNOWN_ADVANCED_SERVICES = new Set<string>([
  'AdminDirectory',
  'AdminGroupsMigration',
  'AdminGroupsSettings',
  'AdminLicenseManager',
  'AdminReports',
  'AdminReseller',
  'Analytics',
  'AnalyticsReporting',
  'AppsActivity',
  'BigQuery',
  'Calendar',
  'Classroom',
  'Civicinfo',
  'Docs',
  'Drive',
  'DriveActivity',
  'DoubleClickBid',
  'DoubleClickCampaigns',
  'Fitness',
  'Forms',
  'Gmail',
  'GroupsSettings',
  'Indexing',
  'Mirror',
  'People',
  'PeopleAPI',
  'PlayDeveloperReporting',
  'ReCaptcha',
  'Search',
  'Sheets',
  'Slides',
  'StackdriverErrorReporting',
  'TagManager',
  'Tasks',
  'YouTube',
  'YouTubeAnalytics',
  'YouTubeContentID',
]);

export interface ManifestReportEntry {
  kind:
    | 'library.undeclared'
    | 'library.unused'
    | 'advanced_service.missing'
    | 'advanced_service.unused'
    | 'scope.missing'
    | 'scope.unused'
    | 'scope.over_broad'
    | 'urlfetch.not_whitelisted';
  severity: 'break' | 'warn' | 'info';
  symbol: string;
  reason: string;
  fix_hint: string;
  call_sites: Array<{ file: string; line: number; function: string; method: string }>;
}

export interface ManifestReport {
  project: string;
  verdict: Verdict;
  summary: string;
  manifest_present: boolean;
  entries: ManifestReportEntry[];
  findings: Finding[];
}

/**
 * Croise le code indexé avec `appsscript.json` (V3 §21.1).
 * Phase 1 — librairies & services avancés. Les scopes / `urlFetchWhitelist`
 * suivront (mapping service→scope plus délicat, voir CLAUDE.md).
 */
export function analyzeManifest(index: ProjectIndex): ManifestReport {
  const entries: ManifestReportEntry[] = [];
  const findings: Finding[] = [];

  const declaredLibraries = new Set(
    index.manifest.libraries.map((l) => l.user_symbol),
  );
  const declaredAdvancedServices = new Set(
    index.manifest.enabled_advanced_services.map((s) => s.user_symbol),
  );

  const callsByReceiver = groupByReceiver(index.receiver_usage);

  for (const [receiver, calls] of callsByReceiver) {
    if (declaredLibraries.has(receiver)) continue;
    if (declaredAdvancedServices.has(receiver)) continue;
    if (GAS_BUILTIN_SERVICES.has(receiver) && !KNOWN_ADVANCED_SERVICES.has(receiver)) {
      continue;
    }
    if (KNOWN_ADVANCED_SERVICES.has(receiver)) {
      const entry = buildAdvancedServiceMissing(receiver, calls);
      entries.push(entry);
      findings.push(...toFindings(entry, index.project));
      continue;
    }
    if (looksLikeUserSymbol(receiver)) {
      const entry = buildLibraryUndeclared(receiver, calls);
      entries.push(entry);
      findings.push(...toFindings(entry, index.project));
    }
  }

  for (const lib of index.manifest.libraries) {
    if (!callsByReceiver.has(lib.user_symbol)) {
      entries.push({
        kind: 'library.unused',
        severity: 'info',
        symbol: lib.user_symbol,
        reason: `librairie '${lib.user_symbol}' déclarée dans dependencies.libraries mais aucun appel ${lib.user_symbol}.* trouvé dans le code`,
        fix_hint: `retirer l'entrée du manifeste si la librairie n'est plus utilisée (libraryId='${lib.library_id}')`,
        call_sites: [],
      });
    }
  }

  for (const svc of index.manifest.enabled_advanced_services) {
    if (!callsByReceiver.has(svc.user_symbol)) {
      entries.push({
        kind: 'advanced_service.unused',
        severity: 'info',
        symbol: svc.user_symbol,
        reason: `service avancé '${svc.user_symbol}' (serviceId='${svc.service_id}') activé dans le manifeste mais aucun appel ${svc.user_symbol}.* trouvé`,
        fix_hint: `retirer l'entrée d'enabledAdvancedServices si le service n'est plus utilisé`,
        call_sites: [],
      });
    }
  }

  // Phase 2 : croisements OAuth scopes + urlFetchWhitelist.
  const scopeEntries = analyzeScopes(
    index.manifest,
    callsByReceiver,
    index.only_current_doc_files ?? [],
  );
  for (const e of scopeEntries) {
    entries.push(e);
    findings.push(...toFindings(e, index.project));
  }
  const fetchEntries = analyzeUrlFetchWhitelist(index.manifest, index.api_call_chains);
  for (const e of fetchEntries) {
    entries.push(e);
    findings.push(...toFindings(e, index.project));
  }

  const breaks = findings.filter((f) => f.severity === 'break');
  const warns = findings.filter((f) => f.severity === 'warn');
  const verdict = aggregateVerdict(breaks, warns);
  return {
    project: index.project,
    verdict,
    summary: buildSummary(entries, index.manifest),
    manifest_present: index.manifest.present,
    entries,
    findings,
  };
}

function groupByReceiver(usage: ReceiverUsage[]): Map<string, ReceiverUsage[]> {
  const acc = new Map<string, ReceiverUsage[]>();
  for (const u of usage) {
    const slot = acc.get(u.receiver) ?? [];
    slot.push(u);
    acc.set(u.receiver, slot);
  }
  return acc;
}

function buildAdvancedServiceMissing(
  receiver: string,
  calls: ReceiverUsage[],
): ManifestReportEntry {
  return {
    kind: 'advanced_service.missing',
    severity: 'break',
    symbol: receiver,
    reason:
      `le code appelle '${receiver}.*' (${calls.length} site${calls.length > 1 ? 's' : ''}) ` +
      `mais '${receiver}' n'est pas déclaré dans dependencies.enabledAdvancedServices — ` +
      `à l'exécution : ReferenceError: ${receiver} is not defined`,
    fix_hint:
      `ajouter dans appsscript.json : ` +
      `dependencies.enabledAdvancedServices += { userSymbol: '${receiver}', serviceId: '...', version: '...' } ` +
      `(et activer l'API correspondante côté GCP)`,
    call_sites: callSitesOf(calls),
  };
}

function buildLibraryUndeclared(
  receiver: string,
  calls: ReceiverUsage[],
): ManifestReportEntry {
  return {
    kind: 'library.undeclared',
    severity: 'break',
    symbol: receiver,
    reason:
      `le code appelle '${receiver}.*' (${calls.length} site${calls.length > 1 ? 's' : ''}) ` +
      `mais '${receiver}' n'est ni un service GAS connu, ni une librairie déclarée dans ` +
      `dependencies.libraries — l'autorisation échouera à l'exécution`,
    fix_hint:
      `ajouter '${receiver}' dans dependencies.libraries du manifeste, ou corriger le préfixe ` +
      `s'il s'agit d'un typo (services connus : SpreadsheetApp, GmailApp, DriveApp, etc.)`,
    call_sites: callSitesOf(calls),
  };
}

function callSitesOf(calls: ReceiverUsage[]) {
  return calls.map((c) => ({
    file: c.file,
    line: c.line,
    function: c.function,
    method: c.method,
  }));
}

function toFindings(entry: ManifestReportEntry, project: string): Finding[] {
  const consumer_kind = consumerKindFor(entry.kind);
  const confidence = entry.kind.startsWith('scope.') || entry.kind === 'urlfetch.not_whitelisted'
    ? 'medium'
    : 'high';
  if (entry.severity === 'info') return [];
  return entry.call_sites.map((c) => ({
    severity: entry.severity,
    symbol: `${project}::manifest::${entry.symbol}`,
    consumer: { file: c.file, line: c.line },
    consumer_kind,
    reason: `${entry.reason} (appel '${entry.symbol}.${c.method}' depuis '${c.function}')`,
    fix_hint: entry.fix_hint,
    confidence,
  }));
}

function consumerKindFor(
  kind: ManifestReportEntry['kind'],
):
  | 'manifest.library'
  | 'manifest.advanced_service'
  | 'manifest.scope'
  | 'manifest.urlfetch_whitelist' {
  switch (kind) {
    case 'advanced_service.missing':
    case 'advanced_service.unused':
      return 'manifest.advanced_service';
    case 'scope.missing':
    case 'scope.unused':
    case 'scope.over_broad':
      return 'manifest.scope';
    case 'urlfetch.not_whitelisted':
      return 'manifest.urlfetch_whitelist';
    default:
      return 'manifest.library';
  }
}

/**
 * Paires (scope plein → variante `.currentonly`) pour le pattern A de
 * `scope.over_broad`. Quand `@OnlyCurrentDoc` est déclaré dans le code,
 * Google restreint déjà l'accès au document container — déclarer le scope
 * plein est inutilement large.
 */
const CURRENTONLY_PAIRS: Array<{
  full: string;
  current_only: string;
  service: string;
}> = [
  {
    full: 'https://www.googleapis.com/auth/spreadsheets',
    current_only: 'https://www.googleapis.com/auth/spreadsheets.currentonly',
    service: 'SpreadsheetApp',
  },
  {
    full: 'https://www.googleapis.com/auth/documents',
    current_only: 'https://www.googleapis.com/auth/documents.currentonly',
    service: 'DocumentApp',
  },
  {
    full: 'https://www.googleapis.com/auth/forms',
    current_only: 'https://www.googleapis.com/auth/forms.currentonly',
    service: 'FormApp',
  },
  {
    full: 'https://www.googleapis.com/auth/presentations',
    current_only: 'https://www.googleapis.com/auth/presentations.currentonly',
    service: 'SlidesApp',
  },
];

/**
 * Scopes Gmail "larges" — quand le code n'utilise que MailApp (pas GmailApp),
 * `script.send_mail` suffit largement (pattern B de `scope.over_broad`).
 */
const BROAD_GMAIL_SCOPES = new Set<string>([
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
]);
const SEND_MAIL_SCOPE = 'https://www.googleapis.com/auth/script.send_mail';

function analyzeScopes(
  manifest: ProjectManifest,
  callsByReceiver: Map<string, ReceiverUsage[]>,
  onlyCurrentDocFiles: string[],
): ManifestReportEntry[] {
  // L'auto-détection Google joue tant que `oauthScopes` n'est PAS explicite.
  // On reste donc silencieux dans ce cas — c'est la doctrine d'honnêteté.
  if (manifest.oauth_scopes.length === 0) return [];
  const declared = new Set(manifest.oauth_scopes);
  const out: ManifestReportEntry[] = [];

  // scope.missing : pour chaque service utilisé exigeant un scope, vérifier
  // qu'au moins l'une des variantes acceptables est déclarée.
  const servicesNeedingScope = new Map<string, ReceiverUsage[]>();
  for (const [receiver, calls] of callsByReceiver) {
    if (!(receiver in SERVICE_SCOPE_REQUIREMENTS)) continue;
    servicesNeedingScope.set(receiver, calls);
  }
  for (const [svc, calls] of servicesNeedingScope) {
    if (isScopeSatisfied(svc, declared)) continue;
    const accepted = scopesAcceptedFor(svc);
    out.push({
      kind: 'scope.missing',
      severity: 'warn',
      symbol: svc,
      reason:
        `le code utilise '${svc}' (${calls.length} site${calls.length > 1 ? 's' : ''}) ` +
        `mais 'oauthScopes' est déclaré explicitement et aucun scope acceptable n'y figure ` +
        `(attendu l'un de : ${accepted.join(', ')})`,
      fix_hint:
        `ajouter '${accepted[0]}' aux oauthScopes du manifeste, ou retirer la liste oauthScopes ` +
        `pour réactiver l'auto-détection Google`,
      call_sites: callSitesOf(calls),
    });
  }

  // scope.unused : pour chaque scope déclaré, vérifier qu'au moins un service
  // l'aurait justifié. Si aucun ne le justifie, INFO.
  for (const scope of manifest.oauth_scopes) {
    const couldJustify = servicesThatCouldJustify(scope);
    if (couldJustify.length === 0) continue; // scope hors mapping — on s'abstient.
    const anyUsed = couldJustify.some((s) => callsByReceiver.has(s));
    if (anyUsed) continue;
    out.push({
      kind: 'scope.unused',
      severity: 'info',
      symbol: scope,
      reason: `scope '${scope}' déclaré dans oauthScopes mais aucun service exigeant ce scope n'est utilisé (${couldJustify.join(', ')})`,
      fix_hint: `retirer ce scope d'oauthScopes — un scope inutile peut compliquer le consentement utilisateur`,
      call_sites: [],
    });
  }

  // scope.over_broad — pattern A : @OnlyCurrentDoc + scope plein.
  // Conservatif : on n'émet que si la variante `.currentonly` n'est PAS déjà
  // déclarée à côté (sinon le full peut viser un autre usage légitime).
  if (onlyCurrentDocFiles.length > 0) {
    for (const { full, current_only, service } of CURRENTONLY_PAIRS) {
      if (!declared.has(full)) continue;
      if (declared.has(current_only)) continue;
      const calls = callsByReceiver.get(service) ?? [];
      out.push({
        kind: 'scope.over_broad',
        severity: 'info',
        symbol: full,
        reason:
          `'@OnlyCurrentDoc' détecté dans ${onlyCurrentDocFiles.length} fichier(s) ` +
          `(Google restreint déjà l'accès au document container) mais oauthScopes ` +
          `déclare le scope plein '${full}' au lieu de la variante '.currentonly'`,
        fix_hint: `remplacer '${full}' par '${current_only}' dans oauthScopes`,
        call_sites: callSitesOf(calls).slice(0, 3),
      });
    }
  }

  // scope.over_broad — pattern B : MailApp seul + scope Gmail large.
  // Conservatif : silencieux si GmailApp est utilisé ailleurs, ou si
  // `script.send_mail` est déjà déclaré (intention explicite restreinte).
  if (callsByReceiver.has('MailApp') && !callsByReceiver.has('GmailApp')) {
    const broad = manifest.oauth_scopes.find((s) => BROAD_GMAIL_SCOPES.has(s));
    if (broad && !declared.has(SEND_MAIL_SCOPE)) {
      const calls = callsByReceiver.get('MailApp') ?? [];
      out.push({
        kind: 'scope.over_broad',
        severity: 'info',
        symbol: broad,
        reason:
          `le code utilise uniquement MailApp (pas GmailApp) mais oauthScopes ` +
          `déclare '${broad}' — un scope Gmail large pour un usage limité à l'envoi`,
        fix_hint:
          `remplacer '${broad}' par '${SEND_MAIL_SCOPE}' dans oauthScopes ` +
          `(suffisant pour MailApp.sendEmail/sendEmailFromUser)`,
        call_sites: callSitesOf(calls).slice(0, 3),
      });
    }
  }

  return out;
}

function analyzeUrlFetchWhitelist(
  manifest: ProjectManifest,
  chains: ApiCallChainRecord[],
): ManifestReportEntry[] {
  if (manifest.url_fetch_whitelist.length === 0) return [];
  const whitelist = manifest.url_fetch_whitelist;
  const out: ManifestReportEntry[] = [];
  const offendingByUrl = new Map<
    string,
    Array<{ file: string; line: number; function: string; method: string }>
  >();

  for (const chain of chains) {
    if (chain.root !== 'UrlFetchApp') continue;
    for (const m of chain.methods) {
      if (m.name !== 'fetch' && m.name !== 'fetchAll') continue;
      const literal = extractLiteralUrl(m.arguments_text[0]);
      if (!literal) continue;
      if (matchesWhitelist(literal, whitelist)) continue;
      const slot = offendingByUrl.get(literal) ?? [];
      slot.push({
        file: chain.file,
        line: m.line,
        function: chain.function,
        method: m.name,
      });
      offendingByUrl.set(literal, slot);
    }
  }

  for (const [url, sites] of offendingByUrl) {
    out.push({
      kind: 'urlfetch.not_whitelisted',
      severity: 'warn',
      symbol: url,
      reason:
        `UrlFetchApp.fetch('${url}') vers une URL hors urlFetchWhitelist ` +
        `(${sites.length} site${sites.length > 1 ? 's' : ''}). À l'exécution : le fetch sera bloqué.`,
      fix_hint:
        `ajouter '${url}' (ou un préfixe couvrant) à urlFetchWhitelist dans appsscript.json, ` +
        `ou retirer urlFetchWhitelist du manifeste pour autoriser toutes les URLs`,
      call_sites: sites,
    });
  }
  return out;
}

function extractLiteralUrl(argText: string | undefined): string | null {
  if (!argText) return null;
  // string_literal : "'...'" ou '"..."'  ou template_string sans interpolation.
  const m = /^(?:['"`])(.*)(?:['"`])$/.exec(argText);
  if (!m) return null;
  const body = m[1] ?? '';
  if (body.includes('${') || body.includes('\\')) return null;
  return body;
}

function matchesWhitelist(url: string, whitelist: string[]): boolean {
  return whitelist.some((entry) => url.startsWith(entry));
}

function buildSummary(
  entries: ManifestReportEntry[],
  manifest: ProjectManifest,
): string {
  if (!manifest.present) {
    return "Aucun appsscript.json détecté à la racine — vérifications manifeste ignorées.";
  }
  if (entries.length === 0) {
    return `Manifeste cohérent avec le code (${manifest.libraries.length} librairie(s) déclarée(s), ${manifest.enabled_advanced_services.length} service(s) avancé(s)).`;
  }
  const counts = {
    break: entries.filter((e) => e.severity === 'break').length,
    warn: entries.filter((e) => e.severity === 'warn').length,
    info: entries.filter((e) => e.severity === 'info').length,
  };
  const parts: string[] = [];
  if (counts.break > 0) parts.push(`${counts.break} régression(s) bloquante(s)`);
  if (counts.warn > 0) parts.push(`${counts.warn} avertissement(s)`);
  if (counts.info > 0) parts.push(`${counts.info} info(s)`);
  return `Décalage manifeste/code : ${parts.join(', ')}.`;
}

/**
 * Heuristique : un receiver « ressemble » à un userSymbol de librairie ou de
 * service s'il commence par une majuscule et n'est pas un identifiant de
 * variable locale typique. On reste conservateur pour ne pas crier au loup.
 */
function looksLikeUserSymbol(name: string): boolean {
  if (!/^[A-Z]/.test(name)) return false;
  // Sciemment exclure les constructeurs JS courants qu'on pourrait croiser.
  const JS_OBJECT_RECEIVERS = new Set<string>([
    'Object',
    'Array',
    'String',
    'Number',
    'Boolean',
    'Date',
    'Math',
    'JSON',
    'RegExp',
    'Error',
    'TypeError',
    'RangeError',
    'Promise',
    'Symbol',
    'Map',
    'Set',
    'WeakMap',
    'WeakSet',
    'Reflect',
    'Proxy',
  ]);
  return !JS_OBJECT_RECEIVERS.has(name);
}

export function renderManifestText(report: ManifestReport): string {
  const lines: string[] = [];
  lines.push(`[${report.project}]  ${report.verdict}  ${report.summary}`);
  if (!report.manifest_present) return lines.join('\n');
  for (const e of report.entries) {
    const sites =
      e.call_sites.length > 0
        ? ` @ ${e.call_sites
            .slice(0, 3)
            .map((c) => `${c.file}:${c.line}`)
            .join(', ')}${e.call_sites.length > 3 ? `, +${e.call_sites.length - 3}` : ''}`
        : '';
    const sev = e.severity.toUpperCase();
    lines.push(`  ${sev}  ${e.kind}  '${e.symbol}'${sites}`);
    lines.push(`        reason: ${e.reason}`);
    lines.push(`        fix:    ${e.fix_hint}`);
  }
  return lines.join('\n');
}
