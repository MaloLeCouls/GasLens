import type { Finding, Verdict } from './findings.js';
import { aggregateVerdict } from './findings.js';
import type { HtmlWebappFileSignals, ProjectIndex } from './types.js';

export type WebappRuleKind =
  | 'webapp.mixed_content'
  | 'webapp.link_target'
  | 'webapp.form_submit'
  | 'webapp.xframe_missing';

export interface LintWebappEntry {
  kind: WebappRuleKind;
  severity: 'warn' | 'info';
  confidence: 'high' | 'medium';
  file: string;
  line: number;
  reason: string;
  fix_hint: string;
}

export interface LintWebappOptions {
  /**
   * Noms d'apps/projets dont la web app est déclarée **embarquée dans un Google
   * Site** (registre G4). Pour ces projets, `webapp.xframe_missing` est élevé de
   * `info` à `warn` (on SAIT alors que l'absence d'ALLOWALL casse l'embed).
   */
  embeddedInSite?: boolean;
}

export interface LintWebappReport {
  project: string;
  verdict: Verdict;
  summary: string;
  entries: LintWebappEntry[];
  findings: Finding[];
}

/**
 * Lint des .html servis par la web app (V3 §21.4). Famille A — bugs qui
 * ne se voient ni à l'édition, ni à `tsc`, ni en émulation locale
 * (gas-fakes serve n'applique pas les restrictions iframe). Toujours
 * WARN, jamais BREAK.
 */
export function lintWebapp(index: ProjectIndex, opts: LintWebappOptions = {}): LintWebappReport {
  const entries: LintWebappEntry[] = [];

  for (const file of index.html_webapp_signals) {
    entries.push(...mixedContentEntries(file));
    entries.push(...linkTargetEntries(file));
    entries.push(...formSubmitEntries(file));
  }
  // xframe en dernier : ne déplace pas l'ordre des findings .html existants.
  entries.push(...xframeEntries(index, opts));

  const findings = entries.map((e) => toFinding(e, index.project));
  const verdict = aggregateVerdict(
    findings.filter((f) => f.severity === 'break'),
    findings.filter((f) => f.severity === 'warn'),
  );
  return {
    project: index.project,
    verdict,
    summary: buildSummary(entries),
    entries,
    findings,
  };
}

function mixedContentEntries(file: HtmlWebappFileSignals): LintWebappEntry[] {
  const out: LintWebappEntry[] = [];
  for (const ref of file.mixed_content_refs) {
    out.push({
      kind: 'webapp.mixed_content',
      severity: 'warn',
      confidence: 'high',
      file: file.file,
      line: ref.line,
      reason:
        `<${ref.tag} ${ref.attr}="${ref.url}"> charge une ressource en http:// — ` +
        `bloquée par le sandbox HTTPS de la web app GAS (mixed content).`,
      fix_hint:
        `passer l'URL en https://, ou héberger la ressource ailleurs (Drive, CDN HTTPS, ` +
        `ou intégrer directement dans le HTML servi)`,
    });
  }
  for (const fetchRef of file.script_http_fetches) {
    out.push({
      kind: 'webapp.mixed_content',
      severity: 'warn',
      confidence: 'high',
      file: file.file,
      line: fetchRef.line,
      reason:
        `appel JS côté client vers '${fetchRef.url}' — bloqué par le sandbox HTTPS ` +
        `(mixed content). Côté serveur, utiliser UrlFetchApp pour les requêtes externes.`,
      fix_hint:
        `passer l'URL en https://, ou déporter l'appel côté serveur via google.script.run → UrlFetchApp.fetch`,
    });
  }
  return out;
}

function linkTargetEntries(file: HtmlWebappFileSignals): LintWebappEntry[] {
  if (file.has_base_target_top) return [];
  return file.links_without_target.map((l) => ({
    kind: 'webapp.link_target' as const,
    severity: 'warn' as const,
    confidence: 'medium' as const,
    file: file.file,
    line: l.line,
    reason:
      `<a href="${l.href}"> sans attribut target dans une web app GAS — ` +
      `le clic essaiera de naviguer DANS l'iframe sandbox et sera bloqué.`,
    fix_hint:
      `ajouter target="_top" (navigation dans la fenêtre parente) ou target="_blank" ` +
      `(nouvel onglet), ou déclarer <base target="_top"> dans le <head> pour la page entière`,
  }));
}

function formSubmitEntries(file: HtmlWebappFileSignals): LintWebappEntry[] {
  return file.forms_without_preventDefault.map((f) => ({
    kind: 'webapp.form_submit' as const,
    severity: 'warn' as const,
    confidence: 'medium' as const,
    file: file.file,
    line: f.line,
    reason:
      `<form> avec un bouton submit mais sans onsubmit (ou onsubmit sans preventDefault/return false) — ` +
      `la soumission native tentera de naviguer hors du sandbox iframe et sera bloquée.`,
    fix_hint:
      `ajouter onsubmit="event.preventDefault(); ...; return false" et router via ` +
      `google.script.run vers une fonction serveur ; ou faire le submit en JS sur un click handler`,
  }));
}

/**
 * `webapp.xframe_missing` (G2) — un doGet/doPost qui renvoie du HTML sans
 * `setXFrameOptionsMode(ALLOWALL)` ne s'affichera pas embarqué dans un Google
 * Site (« Refused to frame »). On ne peut pas savoir statiquement si la web app
 * EST embarquée → sévérité **info** par défaut (consultatif, ne gate pas) ;
 * élevée à **warn** si le registre déclare l'embed (`opts.embeddedInSite`).
 */
function xframeEntries(index: ProjectIndex, opts: LintWebappOptions): LintWebappEntry[] {
  const out: LintWebappEntry[] = [];
  const severity: 'warn' | 'info' = opts.embeddedInSite ? 'warn' : 'info';
  for (const fn of index.functions) {
    const wh = fn.webapp_html;
    if (!wh || !wh.returns_html) continue;
    if (!fn.exposures.some((e) => e.type === 'entry_point_web')) continue;
    if (wh.xframe_mode === 'ALLOWALL') continue;
    const never = wh.xframe_mode === null;
    out.push({
      kind: 'webapp.xframe_missing',
      severity,
      confidence: 'medium',
      file: fn.definition.file,
      line: fn.definition.line,
      reason:
        `'${fn.name}' renvoie du HTML (HtmlService) ` +
        (never
          ? `sans appeler setXFrameOptionsMode(...)`
          : `avec setXFrameOptionsMode(${wh.xframe_mode}) (≠ ALLOWALL)`) +
        ` — embarqué dans un Google Site, l'iframe sera refusée (« Refused to frame »)` +
        (severity === 'info' ? ` [info : seulement bloquant si la web app est embarquée dans un Site]` : ''),
      fix_hint:
        `retourner HtmlService.create...().setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL) ` +
        `pour autoriser l'affichage en iframe (requis par l'embed Google Sites)`,
    });
  }
  return out;
}

function toFinding(entry: LintWebappEntry, project: string): Finding {
  return {
    severity: entry.severity,
    symbol: `${project}::webapp::${entry.kind}::${entry.file}`,
    consumer: { file: entry.file, line: entry.line },
    consumer_kind: entry.kind,
    reason: entry.reason,
    fix_hint: entry.fix_hint,
    confidence: entry.confidence,
  };
}

function buildSummary(entries: LintWebappEntry[]): string {
  if (entries.length === 0) return 'Aucun pattern web app suspect détecté.';
  const by_kind = new Map<WebappRuleKind, number>();
  for (const e of entries) by_kind.set(e.kind, (by_kind.get(e.kind) ?? 0) + 1);
  const parts = [...by_kind.entries()].map(([k, n]) => `${k}=${n}`);
  return `Lint web app : ${parts.join(', ')}.`;
}

export function renderLintWebappText(report: LintWebappReport): string {
  const lines: string[] = [];
  lines.push(`[${report.project}]  ${report.verdict}  ${report.summary}`);
  for (const e of report.entries) {
    lines.push(
      `  ${e.severity.toUpperCase()}  ${e.kind}  @ ${e.file}:${e.line}  (confidence: ${e.confidence})`,
    );
    lines.push(`        reason: ${e.reason}`);
    lines.push(`        fix:    ${e.fix_hint}`);
  }
  return lines.join('\n');
}
