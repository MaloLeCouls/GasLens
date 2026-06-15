import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectIndex, WorkspaceIndex } from './types.js';

export interface StalenessResult {
  is_stale: boolean;
  /** Fichier source le plus récent trouvé (path absolu) et son mtime. */
  newest_source?: { path: string; mtime_ms: number };
  /** scanned_at de l'index en ms. */
  index_mtime_ms: number;
  /** Roots inspectés. */
  inspected_roots: string[];
}

const SOURCE_EXT = ['.gs', '.html', '.htm'];
const MANIFEST_NAME = 'appsscript.json';

/**
 * Compare le `scanned_at` de l'index à la plus récente mtime des fichiers
 * sources sous les roots du projet/workspace. Si une source est plus récente
 * → l'index est *probablement* obsolète et il faut relancer `gaslens scan`.
 *
 * Best-effort : on n'échoue jamais sur une erreur d'I/O (file disparu, droits,
 * etc.) — on renvoie simplement `is_stale=false` faute de signal contraire.
 */
export async function checkIndexStaleness(
  index: ProjectIndex | WorkspaceIndex,
): Promise<StalenessResult> {
  const indexMs = Date.parse(index.scanned_at);
  const roots = collectRoots(index);
  let newest_source: { path: string; mtime_ms: number } | undefined;
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const found = await findNewestSource(root);
    if (!found) continue;
    if (!newest_source || found.mtime_ms > newest_source.mtime_ms) {
      newest_source = found;
    }
  }
  if (!newest_source) {
    return { is_stale: false, index_mtime_ms: indexMs, inspected_roots: roots };
  }
  return {
    is_stale: newest_source.mtime_ms > indexMs,
    newest_source,
    index_mtime_ms: indexMs,
    inspected_roots: roots,
  };
}

function collectRoots(index: ProjectIndex | WorkspaceIndex): string[] {
  if (index.kind === 'workspace') return [index.workspace_root];
  return [index.root];
}

async function findNewestSource(
  root: string,
): Promise<{ path: string; mtime_ms: number } | null> {
  let best: { path: string; mtime_ms: number } | null = null;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.') continue;
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (!isSourceFile(e.name)) continue;
      try {
        const s = await stat(full);
        if (!best || s.mtimeMs > best.mtime_ms) {
          best = { path: full, mtime_ms: s.mtimeMs };
        }
      } catch {
        // ignore
      }
    }
  }
  return best;
}

function isSourceFile(name: string): boolean {
  if (name === MANIFEST_NAME) return true;
  return SOURCE_EXT.some((ext) => name.endsWith(ext));
}

/**
 * Imprime un avertissement sur stderr si l'index est stale. Best-effort — ne
 * lève jamais. Affiche la commande exacte de re-scan.
 */
export async function warnIfStale(
  index: ProjectIndex | WorkspaceIndex,
  indexPath: string,
  options: { rescanCommand?: string } = {},
): Promise<void> {
  let result: StalenessResult;
  try {
    result = await checkIndexStaleness(index);
  } catch {
    return;
  }
  if (!result.is_stale || !result.newest_source) return;
  const root =
    index.kind === 'workspace' ? index.workspace_root : index.root;
  const cmd =
    options.rescanCommand ?? `gaslens scan ${root} -o ${indexPath}`;
  const newerBy =
    Math.round((result.newest_source.mtime_ms - result.index_mtime_ms) / 1000);
  process.stderr.write(
    `gaslens: l'index est probablement obsolète — ${result.newest_source.path} ` +
      `a été modifié ${newerBy >= 60 ? `${Math.round(newerBy / 60)} min` : `${newerBy} s`} après ` +
      `le scan (${index.scanned_at}). Re-scanne pour des résultats fiables :\n  ${cmd}\n`,
  );
}
