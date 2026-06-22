/**
 * `gaslens doctor` (V5 §34) — le checklist qui se vérifie tout seul.
 *
 * Note **deux fois** les prérequis : en clair dans le `README.md` généré, et en
 * exécutable ici (lancé par le hook SessionStart). L'utilisateur n'a pas à lire
 * un doc : au lancement, on lui dit ce qui manque, avec le `fix_hint`.
 *
 * Doctrine d'honnêteté (V1 §1.5) : ce qui n'est pas vérifiable hors-ligne (API
 * Apps Script activée, Chrome remote-debugging) est marqué `manual` — jamais
 * présenté comme « OK » ni comme « cassé ». Seuls `error`/`warn` sont
 * actionnables ; eux seuls cassent le silence de `--quiet-when-ok`.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, delimiter } from 'node:path';
import { loadWorkspaceManifest } from './workspace-manifest.js';

export type CheckStatus = 'ok' | 'error' | 'warn' | 'info' | 'manual';

export interface DoctorCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  fix_hint?: string;
}

export interface DoctorReport {
  /** Vrai si aucun check actionnable (error/warn) — pilote `--quiet-when-ok`. */
  ok: boolean;
  /** Exit code : 1 si au moins un `error`, sinon 0. */
  exit_code: number;
  checks: DoctorCheck[];
  summary: string;
}

export interface DoctorOptions {
  cwd: string;
  /** Version Node observée (injectable en test) ; défaut process.versions.node. */
  nodeVersion?: string;
  /** Override du résolveur PATH (test). */
  which?: (cmd: string) => boolean;
  /** Override du test de présence de fichier (test). */
  fileExists?: (path: string) => boolean;
  /** Override du home (test). */
  home?: string;
}

const MIN_NODE_MAJOR = 22;

export async function runDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  const which = opts.which ?? whichSync;
  const fileExists = opts.fileExists ?? existsSync;
  const home = opts.home ?? homedir();
  const checks: DoctorCheck[] = [];

  // 1. Node >= 22 (requis par chrome-devtools-mcp).
  checks.push(checkNode(opts.nodeVersion ?? process.versions.node));

  // 2. binaire `gaslens` sur le PATH (les hooks l'appellent, pas npx).
  checks.push(
    which('gaslens')
      ? mk('gaslens-bin', 'binaire gaslens sur le PATH', 'ok', 'trouvé sur le PATH')
      : mk(
          'gaslens-bin',
          'binaire gaslens sur le PATH',
          'warn',
          'gaslens introuvable sur le PATH — les hooks appellent le binaire installé, pas npx',
          'npm i -g @malolecouls/gaslens',
        ),
  );

  // 3. clasp installé + loggé (les « mains » : push/deploy).
  checks.push(
    which('clasp')
      ? mk('clasp-bin', 'clasp installé', 'ok', 'trouvé sur le PATH')
      : mk('clasp-bin', 'clasp installé', 'warn', 'clasp introuvable', 'npm i -g @google/clasp'),
  );
  checks.push(
    fileExists(join(home, '.clasprc.json'))
      ? mk('clasp-login', 'clasp connecté', 'ok', '~/.clasprc.json présent')
      : mk('clasp-login', 'clasp connecté', 'warn', '~/.clasprc.json absent — clasp non connecté', 'clasp login'),
  );

  // 4. API Apps Script — non vérifiable hors-ligne.
  checks.push(
    mk(
      'apps-script-api',
      'API Apps Script activée',
      'manual',
      'non vérifiable hors-ligne (requise par clasp)',
      'activer sur https://script.google.com/home/usersettings',
    ),
  );

  // 5. Chrome remote-debugging — non vérifiable hors-ligne de façon fiable.
  checks.push(
    mk(
      'chrome-remote-debug',
      'Chrome lançable en remote-debugging (yeux MCP)',
      'manual',
      'non vérifié (requis seulement si MCP chrome --autoConnect)',
      'lancer Chrome avec --remote-debugging-port=9222',
    ),
  );

  // 6. plugin gaslens activé (skills/hooks/commands).
  checks.push(checkPluginEnabled(opts.cwd, fileExists));

  // 7. manifeste maître + index présents (socle d'analyse).
  checks.push(await checkWorkspaceManifest(opts.cwd));
  checks.push(checkIndex(opts.cwd, fileExists));

  const hasError = checks.some((c) => c.status === 'error');
  const hasWarn = checks.some((c) => c.status === 'warn');
  return {
    ok: !hasError && !hasWarn,
    exit_code: hasError ? 1 : 0,
    checks,
    summary: buildSummary(checks),
  };
}

function checkNode(version: string): DoctorCheck {
  const major = parseInt(version.split('.')[0] ?? '0', 10);
  if (major >= MIN_NODE_MAJOR) {
    return mk('node-version', `Node ≥ ${MIN_NODE_MAJOR}`, 'ok', `Node ${version}`);
  }
  return mk(
    'node-version',
    `Node ≥ ${MIN_NODE_MAJOR}`,
    'error',
    `Node ${version} < ${MIN_NODE_MAJOR} (requis par chrome-devtools-mcp)`,
    'mettre Node à jour (ex: nvm install 22)',
  );
}

function checkPluginEnabled(cwd: string, fileExists: (p: string) => boolean): DoctorCheck {
  const settingsPath = join(cwd, '.claude', 'settings.json');
  if (!fileExists(settingsPath)) {
    return mk(
      'plugin-enabled',
      'plugin gaslens activé',
      'info',
      'pas de .claude/settings.json — workspace non câblé au plugin',
      '/plugin install gaslens@gaslens (ou gaslens workspace init)',
    );
  }
  return mk(
    'plugin-enabled',
    'plugin gaslens activé',
    'ok',
    '.claude/settings.json présent',
  );
}

async function checkWorkspaceManifest(cwd: string): Promise<DoctorCheck> {
  const loaded = await loadWorkspaceManifest(cwd);
  if (!loaded.found) {
    return mk(
      'workspace-manifest',
      'gaslens.workspace.json',
      'info',
      'pas de manifeste maître ici (hors workspace, ou projet simple)',
      'gaslens workspace init <nom> pour démarrer un workspace',
    );
  }
  if (!loaded.manifest) {
    return mk(
      'workspace-manifest',
      'gaslens.workspace.json',
      'error',
      `manifeste invalide : ${loaded.errors.join(' ; ')}`,
      'corriger la structure (cf. schéma) puis relancer doctor',
    );
  }
  return mk('workspace-manifest', 'gaslens.workspace.json', 'ok', 'présent et valide');
}

function checkIndex(cwd: string, fileExists: (p: string) => boolean): DoctorCheck {
  const candidates = [
    join(cwd, '.gaslens', 'index.json'),
    join(cwd, '.gaslens', 'baseline.json'),
  ];
  if (candidates.some((c) => fileExists(c))) {
    return mk('index', 'index gaslens', 'ok', '.gaslens/index.json (ou baseline.json) présent');
  }
  return mk('index', 'index gaslens', 'info', 'pas encore d\'index', 'gaslens scan .');
}

function mk(
  id: string,
  label: string,
  status: CheckStatus,
  detail: string,
  fix_hint?: string,
): DoctorCheck {
  return fix_hint ? { id, label, status, detail, fix_hint } : { id, label, status, detail };
}

function buildSummary(checks: DoctorCheck[]): string {
  const err = checks.filter((c) => c.status === 'error').length;
  const warn = checks.filter((c) => c.status === 'warn').length;
  const manual = checks.filter((c) => c.status === 'manual').length;
  if (err === 0 && warn === 0) {
    return `Environnement prêt (${manual} point(s) à vérifier manuellement).`;
  }
  const parts: string[] = [];
  if (err > 0) parts.push(`${err} bloquant(s)`);
  if (warn > 0) parts.push(`${warn} à régler`);
  return `À faire : ${parts.join(', ')}.`;
}

/** Résolveur `which` minimal et cross-plateforme. */
function whichSync(cmd: string): boolean {
  const PATH = process.env.PATH ?? process.env.Path ?? '';
  if (!PATH) return false;
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', '.ps1', ''] : [''];
  for (const dir of PATH.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      if (existsSync(join(dir, cmd + ext))) return true;
    }
  }
  return false;
}

export function renderDoctorText(report: DoctorReport, quietWhenOk = false): string {
  if (quietWhenOk && report.ok) return '';
  const icon: Record<CheckStatus, string> = {
    ok: '✓',
    error: '✗',
    warn: '!',
    info: 'i',
    manual: '?',
  };
  const lines: string[] = [`gaslens doctor — ${report.summary}`];
  for (const c of report.checks) {
    if (quietWhenOk && (c.status === 'ok' || c.status === 'info' || c.status === 'manual')) continue;
    lines.push(`  ${icon[c.status]} ${c.label}: ${c.detail}`);
    if (c.fix_hint && c.status !== 'ok') lines.push(`      → ${c.fix_hint}`);
  }
  return lines.join('\n');
}
