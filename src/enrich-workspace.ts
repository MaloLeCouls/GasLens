import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { scanProject, resolveCrossProjectLinks } from './scanner.js';
import type { FetchedLibrarySource } from './resolve-live.js';
import type {
  CrossProjectEdge,
  FunctionRecord,
  ProjectIndex,
  WorkspaceIndex,
} from './types.js';

/**
 * Phase 3 de `resolve-live` (V3 §22.1) — enrichit un `ProjectIndex` ou
 * `WorkspaceIndex` avec les libs récupérées, en les matérialisant comme des
 * projets supplémentaires nommés d'après leur `user_symbol` consommateur,
 * puis en ré-exécutant la résolution `cross_project_edges`. Le résultat est
 * un `WorkspaceIndex` exploitable par `impact`, `check`, etc.
 *
 * Doctrine V3 §22 : strictement opt-in, hors hook chaud. Cette fonction n'est
 * jamais appelée par `check`.
 */
export interface EnrichWorkspaceOptions {
  /**
   * Racine du cache disque où la source de chaque lib a été matérialisée
   * (cf. `createDiskCachedFetcher`). Requise : on scanne depuis ce dossier
   * pour produire un `ProjectIndex` pleinement indexé.
   */
  cacheDir: string;
  /**
   * Sources des libs à intégrer — typiquement issues de
   * `ResolveLiveReport.fetched_sources`.
   */
  fetched_sources: FetchedLibrarySource[];
}

/**
 * Variante matérialisable : si l'on veut enrichir SANS être passé par un
 * fetcher (par exemple en récupérant un `LibrarySource` à la main), on peut
 * d'abord écrire la source sur disque via `materializeLibraryAt`, puis
 * appeler `enrichWorkspaceWithLibraries`.
 */
export async function materializeLibraryAt(
  dir: string,
  source: {
    files: Array<{ name: string; source: string; type: 'SERVER_JS' | 'HTML' | 'JSON' }>;
  },
): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const f of source.files) {
    const filename =
      f.type === 'HTML'
        ? `${f.name}.html`
        : f.type === 'JSON'
          ? (f.name === 'appsscript' ? 'appsscript.json' : `${f.name}.json`)
          : `${f.name}.gs`;
    await mkdir(dirname(join(dir, filename)), { recursive: true });
    await writeFile(join(dir, filename), f.source, 'utf8');
  }
}

export async function enrichWorkspaceWithLibraries(
  base: ProjectIndex | WorkspaceIndex,
  options: EnrichWorkspaceOptions,
): Promise<WorkspaceIndex> {
  const ws = toWorkspace(base);
  const knownNames = new Set(ws.projects.map((p) => p.project));

  // 1. Scanner chaque lib unique (par scriptId#version) une fois — plusieurs
  //    user_symbols peuvent pointer vers la même lib.
  const scannedByKey = new Map<string, ProjectIndex>();
  for (const fs of options.fetched_sources) {
    const key = libraryKey(fs.library_id, fs.version);
    if (scannedByKey.has(key)) continue;
    const dir = join(
      options.cacheDir,
      sanitizeId(fs.library_id),
      normalizeVersion(fs.version),
    );
    if (!existsSync(dir)) {
      // La lib n'a pas été matérialisée — typiquement le fetcher était noop
      // ou l'écriture cache a échoué. On la saute (`enriched_count` plus bas
      // reflètera l'écart).
      continue;
    }
    const idx = await scanProject({ root: dir });
    scannedByKey.set(key, idx);
  }

  // 2. Pour chaque user_symbol consommateur, créer une copie renommée et
  //    l'ajouter au workspace (s'il n'y a pas déjà un projet de ce nom).
  const newProjects: ProjectIndex[] = [];
  const handled = new Set<string>();
  for (const fs of options.fetched_sources) {
    if (knownNames.has(fs.user_symbol) || handled.has(fs.user_symbol)) continue;
    const original = scannedByKey.get(libraryKey(fs.library_id, fs.version));
    if (!original) continue;
    newProjects.push(renameProject(original, fs.user_symbol));
    handled.add(fs.user_symbol);
  }

  // 3. Cloner les projets existants pour ne pas muter le workspace passé en
  //    entrée (la résolution cross-project est destructive — elle réécrit
  //    `called_by` et `exposures` cross-project).
  const clonedExisting = ws.projects.map(cloneProject);
  const allProjects = [...clonedExisting, ...newProjects];

  // 4. Re-résoudre les arêtes cross-project sur l'ensemble.
  const edges: CrossProjectEdge[] = resolveCrossProjectLinks(allProjects);

  return {
    kind: 'workspace',
    workspace_root: ws.workspace_root,
    scanned_at: new Date().toISOString(),
    projects: allProjects,
    cross_project_edges: edges,
  };
}

function libraryKey(libraryId: string, version: string): string {
  return `${libraryId}#${normalizeVersion(version)}`;
}

function normalizeVersion(v: string | null | undefined): string {
  if (v && /^\d+$/.test(v)) return v;
  return 'HEAD';
}

function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_\-]/g, '_');
}

function toWorkspace(idx: ProjectIndex | WorkspaceIndex): WorkspaceIndex {
  if (idx.kind === 'workspace') return idx;
  return {
    kind: 'workspace',
    workspace_root: idx.root,
    scanned_at: idx.scanned_at,
    projects: [idx],
    cross_project_edges: [],
  };
}

function cloneProject(p: ProjectIndex): ProjectIndex {
  return JSON.parse(JSON.stringify(p)) as ProjectIndex;
}

/**
 * Renomme un `ProjectIndex` (clone profond) : `project`, `FunctionRecord.project`
 * et préfixe d'`id` (`<oldName>::...` → `<newName>::...`). Indispensable pour
 * que la résolution cross-project trouve la lib via le `user_symbol`.
 */
export function renameProject(
  idx: ProjectIndex,
  newName: string,
): ProjectIndex {
  const cloned = cloneProject(idx);
  const oldName = cloned.project;
  cloned.project = newName;
  for (const fn of cloned.functions as FunctionRecord[]) {
    fn.project = newName;
    if (fn.id.startsWith(`${oldName}::`)) {
      fn.id = `${newName}::${fn.id.slice(oldName.length + 2)}`;
    }
  }
  return cloned;
}
