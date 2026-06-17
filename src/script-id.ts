import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectIndex, WorkspaceIndex } from './types.js';

/**
 * Lit le `scriptId` d'un projet GAS depuis `<root>/.clasp.json` — le fichier
 * stocké par le client officiel Google `clasp` après un `clasp clone` ou
 * `clasp create`. C'est la source de vérité la plus naturelle pour brancher
 * une commande optionnelle qui parle à l'API Apps Script (V3 §22).
 *
 * Renvoie `null` si le fichier n'existe pas, n'est pas un JSON valide, ou
 * n'a pas de champ `scriptId` exploitable.
 */
export async function resolveScriptIdFromClasp(
  root: string,
): Promise<string | null> {
  const p = join(root, '.clasp.json');
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(await readFile(p, 'utf8')) as { scriptId?: unknown };
    return typeof raw.scriptId === 'string' && raw.scriptId.length > 0
      ? raw.scriptId
      : null;
  } catch {
    return null;
  }
}

/**
 * Construit la map `projet → scriptId` pour un index, en combinant deux sources :
 *   1. Overrides explicites (typiquement `--script-id` / `--script-id-map`
 *      côté CLI). Priorité absolue.
 *   2. `.clasp.json` à la racine de chaque projet, fallback automatique.
 *
 * Les projets sans scriptId connu sont absents de la map — le provider en
 * aval verra `scriptId: null` et dégradera honnêtement en `unknown` pour
 * leurs fonctions.
 */
export async function buildScriptIdMap(
  idx: ProjectIndex | WorkspaceIndex,
  overrides: Record<string, string> = {},
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const projects = idx.kind === 'workspace' ? idx.projects : [idx];
  for (const p of projects) {
    const ov = overrides[p.project];
    if (ov && ov.length > 0) {
      out.set(p.project, ov);
      continue;
    }
    const fromClasp = await resolveScriptIdFromClasp(p.root);
    if (fromClasp) out.set(p.project, fromClasp);
  }
  return out;
}
