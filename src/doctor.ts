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

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, delimiter } from 'node:path';
import {
  loadWorkspaceManifest,
  type WorkspaceManifest,
  type LoadWorkspaceManifestResult,
} from './workspace-manifest.js';

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
  /** Override de lecture de fichier (test) ; renvoie null si illisible. */
  readText?: (path: string) => string | null;
  /** Override du home (test). */
  home?: string;
  /** Override des variables d'environnement pertinentes (test). */
  env?: Record<string, string | undefined>;
}

const MIN_NODE_MAJOR = 22;

export async function runDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  const which = opts.which ?? whichSync;
  const fileExists = opts.fileExists ?? existsSync;
  const readText = opts.readText ?? defaultReadText;
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
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

  // 4bis. ADC (Application Default Credentials) — requis par les commandes
  // opt-in qui parlent à l'API Apps Script (resolve-live/prod-truth/deploy-aware).
  checks.push(checkAdc(fileExists, home, env));

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

  // 6. plugin gaslens réellement déclaré (pas juste le fichier présent).
  checks.push(checkPluginEnabled(opts.cwd, fileExists, readText));

  // 7. manifeste maître + index présents (socle d'analyse).
  const loaded = await loadWorkspaceManifest(opts.cwd);
  checks.push(checkWorkspaceManifest(loaded));
  checks.push(checkIndex(opts.cwd, fileExists));

  // 8. Vérifications par app (seulement si le manifeste maître décrit un parc).
  if (loaded.manifest && loaded.manifest.apps.length > 0) {
    checks.push(checkLibraryDeclared(loaded.manifest));
    checks.push(checkClaspConfig(opts.cwd, loaded.manifest, fileExists, readText));
    checks.push(checkBaselines(opts.cwd, loaded.manifest, fileExists));
  }

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

function checkPluginEnabled(
  cwd: string,
  fileExists: (p: string) => boolean,
  readText: (p: string) => string | null,
): DoctorCheck {
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
  // Vérifie que le plugin est réellement DÉCLARÉ, pas juste que le fichier existe.
  const raw = readText(settingsPath);
  let enabled: unknown;
  try {
    enabled = raw ? (JSON.parse(raw) as { enabledPlugins?: unknown }).enabledPlugins : undefined;
  } catch {
    return mk('plugin-enabled', 'plugin gaslens activé', 'warn', '.claude/settings.json illisible (JSON invalide)', 'corriger le JSON');
  }
  const declared =
    Array.isArray(enabled) && enabled.some((e) => typeof e === 'string' && e.includes('gaslens'));
  if (!declared) {
    return mk(
      'plugin-enabled',
      'plugin gaslens activé',
      'warn',
      '.claude/settings.json présent mais ne déclare pas le plugin gaslens dans enabledPlugins',
      'ajouter "gaslens@gaslens" à enabledPlugins (ou relancer gaslens workspace init)',
    );
  }
  return mk('plugin-enabled', 'plugin gaslens activé', 'ok', 'déclaré dans .claude/settings.json');
}

function checkWorkspaceManifest(loaded: LoadWorkspaceManifestResult): DoctorCheck {
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

function checkAdc(
  fileExists: (p: string) => boolean,
  home: string,
  env: Record<string, string | undefined>,
): DoctorCheck {
  const explicit = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (explicit && fileExists(explicit)) {
    return mk('adc', 'Application Default Credentials', 'ok', 'GOOGLE_APPLICATION_CREDENTIALS défini');
  }
  const wellKnown =
    process.platform === 'win32'
      ? join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'gcloud', 'application_default_credentials.json')
      : join(home, '.config', 'gcloud', 'application_default_credentials.json');
  if (fileExists(wellKnown)) {
    return mk('adc', 'Application Default Credentials', 'ok', 'ADC présent (gcloud)');
  }
  return mk(
    'adc',
    'Application Default Credentials',
    'info',
    'ADC absent — requis seulement par resolve-live / prod-truth / deploy-aware (API Apps Script)',
    'gcloud auth application-default login',
  );
}

/**
 * Bibliothèque mère déclarée (F-correctif B). Le pivot du modèle 2-axes V4 d'un
 * parc multi-webapp est la `library` unique (script_id + prod_version figée). Si
 * une app **expose** un `library_prefix` (donc le parc a un fournisseur de lib)
 * mais que le manifeste ne déclare pas `library`, l'axe CODE
 * (`env.library_version_mismatch`) reste **dormant** — c'est exactement ce qu'un
 * agent oublie d'élicitéer. On le signale (warn) avec le fix_hint vers
 * `onboard-app`. Faux positif quasi nul : on ne réveille que si un provider existe.
 */
function checkLibraryDeclared(manifest: WorkspaceManifest): DoctorCheck {
  const providers = manifest.apps
    .map((a) => a.library_prefix)
    .filter((p): p is string => Boolean(p));
  if (providers.length === 0) {
    return mk(
      'library',
      'bibliothèque mère déclarée',
      'info',
      "aucune app n'expose de library_prefix — pas de bibliothèque partagée attendue",
    );
  }
  if (!manifest.library) {
    return mk(
      'library',
      'bibliothèque mère déclarée',
      'warn',
      `des apps exposent un library_prefix (${providers.join(', ')}) mais le manifeste ne déclare pas ` +
        `\`library\` (script_id + prod_version) — l'axe env.library_version_mismatch est DORMANT`,
      "déclarer library.{script_id, prod_version} dans gaslens.workspace.json (demander à l'utilisateur le scriptId de la lib partagée + sa version prod figée ; cf. skill onboard-app)",
    );
  }
  return mk(
    'library',
    'bibliothèque mère déclarée',
    'ok',
    `library déclarée (prod figée v${manifest.library.prod_version})`,
  );
}

/** Cohérence `.clasp.json` ↔ `script_id` du manifeste, par projet (E3). */
function checkClaspConfig(
  cwd: string,
  manifest: WorkspaceManifest,
  fileExists: (p: string) => boolean,
  readText: (p: string) => string | null,
): DoctorCheck {
  const mismatches: string[] = [];
  let missing = 0;
  let checked = 0;
  for (const app of manifest.apps) {
    for (const [envName, ref] of Object.entries(app.projects)) {
      if (!ref?.clasp_path) continue;
      checked++;
      const claspPath = join(cwd, ref.clasp_path, '.clasp.json');
      if (!fileExists(claspPath)) {
        missing++;
        continue;
      }
      const raw = readText(claspPath);
      let scriptId: string | undefined;
      try {
        scriptId = raw ? (JSON.parse(raw) as { scriptId?: string }).scriptId : undefined;
      } catch {
        scriptId = undefined;
      }
      if (scriptId && ref.script_id && scriptId !== ref.script_id) {
        mismatches.push(`${app.name}/${envName}`);
      }
    }
  }
  if (checked === 0) {
    return mk('clasp-config', '.clasp.json ↔ manifeste', 'info', 'aucun projet avec clasp_path');
  }
  if (mismatches.length > 0) {
    return mk(
      'clasp-config',
      '.clasp.json ↔ manifeste',
      'warn',
      `scriptId divergent entre .clasp.json et le manifeste (${mismatches.join(', ')}) — clasp push/deploy viserait le MAUVAIS projet`,
      'aligner le scriptId de .clasp.json sur script_id du manifeste (ou inversement)',
    );
  }
  if (missing > 0) {
    return mk(
      'clasp-config',
      '.clasp.json ↔ manifeste',
      'info',
      `${missing} projet(s) pas encore cloné(s) (pas de .clasp.json)`,
      'clasp clone <scriptId> dans chaque dossier de projet',
    );
  }
  return mk('clasp-config', '.clasp.json ↔ manifeste', 'ok', `${checked} projet(s) cohérent(s)`);
}

/** Baseline présente dans chaque projet cloné (sinon le hook reste muet, E3). */
function checkBaselines(
  cwd: string,
  manifest: WorkspaceManifest,
  fileExists: (p: string) => boolean,
): DoctorCheck {
  const missing: string[] = [];
  for (const app of manifest.apps) {
    for (const [envName, ref] of Object.entries(app.projects)) {
      if (!ref?.clasp_path) continue;
      const dir = join(cwd, ref.clasp_path);
      if (!fileExists(join(dir, 'appsscript.json'))) continue; // pas (encore) cloné
      const hasBaseline =
        fileExists(join(dir, '.gaslens', 'baseline.json')) ||
        fileExists(join(dir, '.gaslens', 'index.json'));
      if (!hasBaseline) missing.push(`${app.name}/${envName}`);
    }
  }
  if (missing.length === 0) {
    return mk('baselines', 'baseline par projet', 'ok', 'tous les projets clonés ont une baseline');
  }
  return mk(
    'baselines',
    'baseline par projet',
    'info',
    `${missing.length} projet(s) cloné(s) sans baseline (${missing.join(', ')}) — le hook PostToolUse restera SILENCIEUX pour eux`,
    'gaslens scan <dossier-projet> -o <dossier>/.gaslens/baseline.json',
  );
}

function defaultReadText(p: string): string | null {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
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
