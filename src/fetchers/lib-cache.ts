import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LibraryFetcher, LibrarySource } from '../resolve-live.js';

/**
 * Cache disque pour les LibrarySource récupérés par un `LibraryFetcher` (V3
 * §22.1 phase 3). Matérialise la lib sous une arborescence scannable par
 * `scanProject` directement — ce qui permet l'enrichissement du `WorkspaceIndex`
 * en aval.
 *
 * Layout : `<cacheDir>/<scriptId>/<version|HEAD>/`
 *   - chaque fichier de la lib écrit comme `<name>.<ext>` (.gs / .html / .json) ;
 *   - `__gaslens_meta.json` : métadonnées (scriptId, version, fetched_at).
 *
 * Doctrine V3 §22 — strictement opt-in, hors hook chaud. Ce module n'est jamais
 * importé par `check` ou `gaslens hook`.
 */

export interface DiskCachedFetcherOpts {
  /** Racine du cache. Typiquement `<root>/.gaslens/lib-cache`. */
  cacheDir: string;
  /**
   * Si vrai, ignore le cache en lecture et écrase l'entrée existante après un
   * fetch réussi (`--refresh`).
   */
  refresh?: boolean;
  /** Désactive l'écriture cache (lecture seule). */
  readOnly?: boolean;
  /**
   * Callback optionnel pour tracer hits/misses (utile pour le rapport
   * `resolve-live` et pour les tests).
   */
  onAccess?: (info: {
    scriptId: string;
    version: string;
    outcome: 'hit' | 'miss_fetched' | 'miss_unavailable';
  }) => void;
}

const META_FILE = '__gaslens_meta.json';

/**
 * Wrappe un fetcher avec un cache disque. Sans `inner`, le wrapper se comporte
 * comme un fetcher en lecture seule : il sert ce qui est déjà en cache et
 * renvoie `null` sinon (utile pour un audit local sans réseau).
 */
export function createDiskCachedFetcher(
  inner: LibraryFetcher | null,
  opts: DiskCachedFetcherOpts,
): LibraryFetcher {
  if (!opts.cacheDir) {
    throw new Error('createDiskCachedFetcher: cacheDir requis');
  }
  return {
    async fetch(scriptId, version) {
      const verKey = normalizeVersion(version);
      const dir = libCachePath(opts.cacheDir, scriptId, verKey);
      if (!opts.refresh && existsSync(join(dir, META_FILE))) {
        const cached = await readCacheDir(dir).catch(() => null);
        if (cached) {
          opts.onAccess?.({ scriptId, version: verKey, outcome: 'hit' });
          return cached;
        }
      }
      if (!inner) {
        opts.onAccess?.({ scriptId, version: verKey, outcome: 'miss_unavailable' });
        return null;
      }
      const src = await inner.fetch(scriptId, version);
      if (src && !opts.readOnly) {
        try {
          await writeCacheDir(dir, src, { scriptId, version: verKey });
        } catch {
          // L'écriture cache ne doit pas faire échouer le fetch.
        }
      }
      opts.onAccess?.({
        scriptId,
        version: verKey,
        outcome: src ? 'miss_fetched' : 'miss_unavailable',
      });
      return src;
    },
  };
}

/**
 * Chemin disque (sans I/O) d'une lib cachée. Exposé pour permettre à
 * `enrichWorkspaceWithLibraries` de scanner directement le dossier.
 */
export function libCachePath(
  cacheDir: string,
  scriptId: string,
  version: string | null,
): string {
  const safeId = scriptId.replace(/[^A-Za-z0-9_\-]/g, '_');
  const verKey = normalizeVersion(version);
  return join(cacheDir, safeId, verKey);
}

function normalizeVersion(v: string | null | undefined): string {
  if (v && /^\d+$/.test(v)) return v;
  return 'HEAD';
}

async function readCacheDir(dir: string): Promise<LibrarySource | null> {
  const metaPath = join(dir, META_FILE);
  if (!existsSync(metaPath)) return null;
  const metaRaw = await readFile(metaPath, 'utf8');
  const meta = JSON.parse(metaRaw) as {
    scriptId?: string;
    meta?: Record<string, string | number>;
  };
  const entries = await readdir(dir, { withFileTypes: true });
  const files: LibrarySource['files'] = [];
  for (const e of entries) {
    if (!e.isFile() || e.name === META_FILE) continue;
    const source = await readFile(join(dir, e.name), 'utf8');
    const parsed = parseCacheFilename(e.name);
    if (!parsed) continue;
    files.push({ name: parsed.name, source, type: parsed.type });
  }
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const result: LibrarySource = { files };
  if (meta.meta) result.meta = meta.meta;
  return result;
}

async function writeCacheDir(
  dir: string,
  src: LibrarySource,
  meta: { scriptId: string; version: string },
): Promise<void> {
  // On commence par purger l'entrée existante pour éviter des résidus en cas
  // de refresh (un fichier supprimé côté serveur ne doit pas survivre en cache).
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const f of src.files) {
    await writeFile(join(dir, cacheFilenameFor(f)), f.source, 'utf8');
  }
  const body = {
    scriptId: meta.scriptId,
    version: meta.version,
    fetched_at: new Date().toISOString(),
    meta: src.meta ?? {},
  };
  await writeFile(join(dir, META_FILE), JSON.stringify(body, null, 2), 'utf8');
}

function cacheFilenameFor(f: LibrarySource['files'][number]): string {
  if (f.type === 'HTML') return `${f.name}.html`;
  if (f.type === 'JSON') {
    return f.name === 'appsscript' ? 'appsscript.json' : `${f.name}.json`;
  }
  return `${f.name}.gs`;
}

function parseCacheFilename(
  filename: string,
): { name: string; type: LibrarySource['files'][number]['type'] } | null {
  if (filename === 'appsscript.json') {
    return { name: 'appsscript', type: 'JSON' };
  }
  if (filename.endsWith('.gs')) {
    return { name: filename.slice(0, -3), type: 'SERVER_JS' };
  }
  if (filename.endsWith('.html')) {
    return { name: filename.slice(0, -5), type: 'HTML' };
  }
  if (filename.endsWith('.htm')) {
    return { name: filename.slice(0, -4), type: 'HTML' };
  }
  if (filename.endsWith('.json')) {
    return { name: filename.slice(0, -5), type: 'JSON' };
  }
  return null;
}
