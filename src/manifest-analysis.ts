import { GAS_BUILTIN_SERVICES } from './gas-services.js';
import type { Finding, Verdict } from './findings.js';
import { aggregateVerdict } from './findings.js';
import type { ProjectIndex, ProjectManifest, ReceiverUsage } from './types.js';

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
    | 'advanced_service.unused';
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
  const consumer_kind =
    entry.kind === 'advanced_service.missing'
      ? 'manifest.advanced_service'
      : 'manifest.library';
  return entry.call_sites.map((c) => ({
    severity: entry.severity,
    symbol: `${project}::manifest::${entry.symbol}`,
    consumer: { file: c.file, line: c.line },
    consumer_kind,
    reason: `${entry.reason} (appel '${entry.symbol}.${c.method}' depuis '${c.function}')`,
    fix_hint: entry.fix_hint,
    confidence: 'high',
  }));
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
