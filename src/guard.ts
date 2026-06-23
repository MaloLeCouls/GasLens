/**
 * `gaslens guard --event pre-tool-use` (LOT G3) — le **garde-fou déterministe**.
 *
 * Les consignes du CLAUDE.md ne sont suivies qu'~70 % du temps ; un hook
 * s'applique à 100 % (état de l'art §7.4). Ce garde-fou intercepte un
 * `clasp push`/`deploy`/`create-deployment` ciblant un projet **prod** et le
 * BLOQUE si `gaslens env validate` sur ce projet est en BREAK (fuite inter-env,
 * lib non figée…). Publier une régression structurelle en prod devient
 * impossible sans la corriger d'abord.
 *
 * Honnête : ne bloque QUE quand il est sûr (commande clasp de publication +
 * cible prod résolue + env BREAK). Tout doute → laisse passer (exit 0).
 */

import { resolve, join, isAbsolute } from 'node:path';
import {
  findWorkspaceRoot,
  runEnvValidate,
} from './env-validate.js';
import {
  loadWorkspaceManifest,
  type ProjectRef,
  type WorkspaceManifest,
} from './workspace-manifest.js';
import type { Finding } from './findings.js';

export interface GuardOptions {
  /** JSON brut reçu sur stdin par le hook PreToolUse. */
  stdinJson: string;
  /** cwd de repli (test) ; sinon payload.cwd puis process.cwd(). */
  cwd?: string;
}

export type GuardOutcome =
  | { kind: 'allow'; reason: string }
  | { kind: 'block'; reason: string; hookPayload: string };

interface PreToolUsePayload {
  tool_name?: string;
  tool_input?: { command?: string };
  cwd?: string;
}

/** Commande clasp qui PUBLIE du code (vs lecture/clone). */
export function isClaspPublish(command: string): boolean {
  return /\bclasp\s+(?:[^\n]*\s)?(push|deploy|create-deployment)\b/.test(command);
}

/** Résout le dossier projet ciblé : flag clasp `-P`/`--project`, sinon `cd`, sinon cwd. */
export function resolveTargetDir(command: string, cwd: string): string {
  const proj = /(?:--project|-P)\s+(["']?)([^"'\s&;|]+)\1/.exec(command);
  if (proj?.[2]) return isAbsolute(proj[2]) ? proj[2] : resolve(cwd, proj[2]);
  const cd = /\bcd\s+(["']?)([^"'\s&;|]+)\1/.exec(command);
  if (cd?.[2]) return isAbsolute(cd[2]) ? cd[2] : resolve(cwd, cd[2]);
  return resolve(cwd);
}

export async function runGuard(opts: GuardOptions): Promise<GuardOutcome> {
  let payload: PreToolUsePayload;
  try {
    payload = JSON.parse(opts.stdinJson) as PreToolUsePayload;
  } catch {
    return { kind: 'allow', reason: 'stdin: JSON invalide — guard neutre' };
  }
  const command = payload.tool_input?.command;
  if (typeof command !== 'string' || !command.trim()) {
    return { kind: 'allow', reason: 'pas de commande shell — rien à garder' };
  }
  if (!isClaspPublish(command)) {
    return { kind: 'allow', reason: 'commande non-publiante (pas un clasp push/deploy)' };
  }

  const cwd = payload.cwd ?? opts.cwd ?? process.cwd();
  const targetDir = resolveTargetDir(command, cwd);
  const wsRoot = findWorkspaceRoot(targetDir);
  if (!wsRoot) {
    return { kind: 'allow', reason: 'hors workspace gaslens (pas de manifeste maître)' };
  }
  const loaded = await loadWorkspaceManifest(wsRoot);
  if (!loaded.manifest) {
    return { kind: 'allow', reason: 'manifeste maître absent/invalide — guard neutre' };
  }

  const prod = matchProdProject(loaded.manifest, wsRoot, targetDir);
  if (!prod) {
    return { kind: 'allow', reason: 'cible non identifiée comme projet prod — guard neutre' };
  }

  const env = await runEnvValidate({ root: prod.dir });
  if (env.verdict !== 'BREAK') {
    return {
      kind: 'allow',
      reason: `publication prod '${prod.app}' autorisée (env validate: ${env.verdict})`,
    };
  }

  const reason = renderGuardReason(prod.app, env.findings);
  const hookPayload = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
    // Forme historique tolérée par Claude Code (compat).
    decision: 'block',
    reason,
  });
  return { kind: 'block', reason, hookPayload };
}

/** Le dossier ciblé correspond-il à un projet `prod` déclaré au manifeste ? */
export function matchProdProject(
  master: WorkspaceManifest,
  wsRoot: string,
  targetDir: string,
): { app: string; dir: string } | null {
  const target = resolve(targetDir);
  for (const app of master.apps) {
    const prod = app.projects.prod as ProjectRef | undefined;
    if (!prod?.clasp_path) continue;
    const dir = resolve(join(wsRoot, prod.clasp_path));
    if (dir === target || target === dir || isInside(target, dir) || isInside(dir, target)) {
      return { app: app.name, dir };
    }
  }
  return null;
}

function isInside(child: string, parent: string): boolean {
  const rel = resolve(child).slice(resolve(parent).length);
  return resolve(child).startsWith(resolve(parent)) && (rel === '' || rel.startsWith('\\') || rel.startsWith('/'));
}

function renderGuardReason(app: string, findings: Finding[]): string {
  const breaks = findings.filter((f) => f.severity === 'break');
  const lines = [
    `[gaslens guard] BLOQUÉ : publication vers le projet PROD '${app}' alors que ` +
      `gaslens env validate est en BREAK (${breaks.length} régression(s) bloquante(s)).`,
  ];
  for (const b of breaks.slice(0, 8)) {
    lines.push(
      `  BREAK ${b.consumer.file}:${b.consumer.line} — ${b.reason}` +
        (b.fix_hint ? ` (fix: ${b.fix_hint})` : ''),
    );
  }
  lines.push('Corrige ces points (ou lance `gaslens env validate`) avant de pousser en prod.');
  return lines.join('\n');
}
