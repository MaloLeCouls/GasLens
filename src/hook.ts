import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { scanProject } from './scanner.js';
import { diffIndexes } from './diff.js';
import type { ProjectIndex } from './types.js';
import type { DiffReport } from './findings.js';

export interface HookOptions {
  /** JSON brut reçu sur stdin par le hook PostToolUse. */
  stdinJson: string;
  /** Permet d'injecter cwd en test ; sinon process.cwd(). */
  cwd?: string;
}

export type HookOutcome =
  | { kind: 'skipped'; reason: string }
  | { kind: 'clean'; report: DiffReport }
  | { kind: 'block'; hookPayload: string; report: DiffReport };

/**
 * Implémentation de `gaslens hook --event post-tool-use` (V2 §15).
 *
 * Sorties sur stdout exploitables par Claude Code :
 *   - rien si CLEAN ou skipped (silent, no noise)
 *   - JSON `{decision:"block", reason, suppressOutput:true}` si BREAK
 *
 * L'exit code reste TOUJOURS 0 : pour PostToolUse, Claude Code lit le verdict
 * sur stdout, pas via exit code (cf. doc Hooks).
 */
export async function runHook(opts: HookOptions): Promise<HookOutcome> {
  const cwd = opts.cwd ?? process.cwd();
  let payload: PostToolUsePayload;
  try {
    payload = JSON.parse(opts.stdinJson) as PostToolUsePayload;
  } catch {
    return {
      kind: 'skipped',
      reason: 'stdin: JSON invalide — hook ignoré',
    };
  }

  const filePath = extractFilePath(payload);
  if (!filePath) {
    return { kind: 'skipped', reason: 'tool_input.file_path absent' };
  }
  if (!isRelevantFile(filePath)) {
    return {
      kind: 'skipped',
      reason: `fichier non-GAS (${filePath}) — pas de check`,
    };
  }

  const projectRoot = findProjectRoot(filePath, cwd);
  if (!projectRoot) {
    return {
      kind: 'skipped',
      reason: `aucune racine de projet GAS trouvée en remontant depuis ${filePath} (cherche un appsscript.json ou .gaslens/)`,
    };
  }
  const baselinePath = pickBaseline(projectRoot);
  if (!baselinePath) {
    return {
      kind: 'skipped',
      reason: `pas de baseline dans ${projectRoot}/.gaslens/. Créer avec 'gaslens scan ${projectRoot} -o ${projectRoot}/.gaslens/baseline.json'`,
    };
  }

  let baseline: ProjectIndex;
  try {
    baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as ProjectIndex;
  } catch (err) {
    return {
      kind: 'skipped',
      reason: `baseline ${baselinePath} illisible — ${(err as Error).message}`,
    };
  }

  const current = await scanProject({ root: projectRoot });
  const report = diffIndexes(baseline, current, {
    baselineLabel: baselinePath,
    currentLabel: 'working-tree',
    severity_threshold: 'warn',
  });

  if (report.verdict !== 'BREAK') {
    return { kind: 'clean', report };
  }
  const hookPayload = JSON.stringify({
    decision: 'block',
    reason: renderBlockReason(report, filePath),
    suppressOutput: true,
  });
  return { kind: 'block', hookPayload, report };
}

interface PostToolUsePayload {
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    path?: string;
  };
  tool_response?: unknown;
  cwd?: string;
}

function extractFilePath(p: PostToolUsePayload): string | null {
  const path = p.tool_input?.file_path ?? p.tool_input?.path;
  return typeof path === 'string' ? path : null;
}

function isRelevantFile(filePath: string): boolean {
  return (
    filePath.endsWith('.gs') ||
    filePath.endsWith('.html') ||
    filePath.endsWith('.htm')
  );
}

export function findProjectRoot(filePath: string, fallbackCwd: string): string | null {
  let dir = dirname(resolve(filePath));
  let safety = 0;
  while (safety++ < 100) {
    if (existsSync(join(dir, 'appsscript.json'))) return dir;
    if (existsSync(join(dir, '.gaslens'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (existsSync(join(fallbackCwd, 'appsscript.json'))) return fallbackCwd;
  if (existsSync(join(fallbackCwd, '.gaslens'))) return fallbackCwd;
  return null;
}

export function pickBaseline(projectRoot: string): string | null {
  const candidates = [
    join(projectRoot, '.gaslens', 'baseline.json'),
    join(projectRoot, '.gaslens', 'index.json'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function renderBlockReason(report: DiffReport, editedFile: string): string {
  const lines: string[] = [];
  lines.push(`[gaslens] ${report.summary} (édité : ${editedFile})`);
  if (report.derived_change_set.length > 0) {
    lines.push('change set détecté :');
    for (const c of report.derived_change_set.slice(0, 5)) {
      lines.push(`  - ${c.delta} : ${c.detail}`);
    }
  }
  for (const b of report.breaks.slice(0, 10)) {
    lines.push(
      `  BREAK ${b.consumer.file}:${b.consumer.line} — ${b.reason}` +
        (b.fix_hint ? ` (fix: ${b.fix_hint})` : ''),
    );
  }
  if (report.breaks.length > 10) {
    lines.push(`  … +${report.breaks.length - 10} autres breaks`);
  }
  return lines.join('\n');
}
