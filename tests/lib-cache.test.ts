import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDiskCachedFetcher,
  libCachePath,
} from '../src/fetchers/lib-cache.js';
import type {
  LibraryFetcher,
  LibrarySource,
} from '../src/resolve-live.js';

function tracker(): {
  fetcher: LibraryFetcher;
  calls: Array<{ scriptId: string; version: string | null }>;
} {
  const calls: Array<{ scriptId: string; version: string | null }> = [];
  const fetcher: LibraryFetcher = {
    async fetch(scriptId, version) {
      calls.push({ scriptId, version });
      return {
        files: [
          { name: 'appsscript', source: '{}', type: 'JSON' },
          {
            name: 'Lib',
            source: `function api(){ return ${calls.length}; }`,
            type: 'SERVER_JS',
          },
          { name: 'index', source: '<html></html>', type: 'HTML' },
        ],
        meta: { scriptId },
      } satisfies LibrarySource;
    },
  };
  return { fetcher, calls };
}

describe('lib-cache — écriture + relecture', () => {
  it('écrit la source en cache puis la sert depuis le cache (2e fetch = 0 appel inner)', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'gaslens-libcache-'));
    try {
      const { fetcher, calls } = tracker();
      const cached = createDiskCachedFetcher(fetcher, { cacheDir });
      const a = await cached.fetch('sid-1', '3');
      const b = await cached.fetch('sid-1', '3');
      expect(calls).toHaveLength(1);
      expect(a?.files).toHaveLength(3);
      expect(b?.files).toHaveLength(3);
      // L'ordre des fichiers est stable après relecture (tri par name).
      const names = b!.files.map((f) => f.name).sort();
      expect(names).toEqual(['Lib', 'appsscript', 'index']);
      // Le contenu est identique.
      const libA = a!.files.find((f) => f.name === 'Lib');
      const libB = b!.files.find((f) => f.name === 'Lib');
      expect(libA?.source).toBe(libB?.source);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("matérialise les fichiers sous <cacheDir>/<scriptId>/<version>/ avec les bonnes extensions", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'gaslens-libcache-'));
    try {
      const { fetcher } = tracker();
      const cached = createDiskCachedFetcher(fetcher, { cacheDir });
      await cached.fetch('sid-abc', '12');
      const dir = libCachePath(cacheDir, 'sid-abc', '12');
      await expect(stat(join(dir, 'appsscript.json'))).resolves.toBeDefined();
      await expect(stat(join(dir, 'Lib.gs'))).resolves.toBeDefined();
      await expect(stat(join(dir, 'index.html'))).resolves.toBeDefined();
      // Méta présente.
      const meta = JSON.parse(
        await readFile(join(dir, '__gaslens_meta.json'), 'utf8'),
      );
      expect(meta.scriptId).toBe('sid-abc');
      expect(meta.version).toBe('12');
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("version 'HEAD' (non numérique) tombe dans le dossier 'HEAD'", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'gaslens-libcache-'));
    try {
      const { fetcher } = tracker();
      const cached = createDiskCachedFetcher(fetcher, { cacheDir });
      await cached.fetch('sid-x', null);
      await expect(
        stat(libCachePath(cacheDir, 'sid-x', null)),
      ).resolves.toBeDefined();
      await expect(
        stat(libCachePath(cacheDir, 'sid-x', 'HEAD')),
      ).resolves.toBeDefined();
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it('--refresh : force le re-fetch et écrase le cache', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'gaslens-libcache-'));
    try {
      const { fetcher, calls } = tracker();
      const cached = createDiskCachedFetcher(fetcher, { cacheDir });
      await cached.fetch('sid-r', '1');
      expect(calls).toHaveLength(1);
      // Sans refresh → 0 nouvel appel.
      await cached.fetch('sid-r', '1');
      expect(calls).toHaveLength(1);
      // Avec refresh sur une nouvelle instance → re-fetch.
      const refreshed = createDiskCachedFetcher(fetcher, {
        cacheDir,
        refresh: true,
      });
      await refreshed.fetch('sid-r', '1');
      expect(calls).toHaveLength(2);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it('sans inner fetcher : lit le cache existant, renvoie null sinon', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'gaslens-libcache-'));
    try {
      const { fetcher } = tracker();
      // Pré-remplit le cache.
      const writer = createDiskCachedFetcher(fetcher, { cacheDir });
      await writer.fetch('sid-pre', '5');
      // Reader sans inner.
      const reader = createDiskCachedFetcher(null, { cacheDir });
      const hit = await reader.fetch('sid-pre', '5');
      expect(hit).not.toBeNull();
      const miss = await reader.fetch('sid-not-cached', '5');
      expect(miss).toBeNull();
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it('readOnly: true : sert le cache mais n écrit rien', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'gaslens-libcache-'));
    try {
      const { fetcher, calls } = tracker();
      const ro = createDiskCachedFetcher(fetcher, { cacheDir, readOnly: true });
      const src = await ro.fetch('sid-ro', '1');
      expect(src).not.toBeNull();
      expect(calls).toHaveLength(1);
      // Le dossier ne doit PAS contenir de meta.json.
      const dir = libCachePath(cacheDir, 'sid-ro', '1');
      await expect(
        stat(join(dir, '__gaslens_meta.json')),
      ).rejects.toBeDefined();
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it('onAccess signale les hits / miss', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'gaslens-libcache-'));
    try {
      const { fetcher } = tracker();
      const events: Array<{ scriptId: string; version: string; outcome: string }> = [];
      const cached = createDiskCachedFetcher(fetcher, {
        cacheDir,
        onAccess: (info) => events.push(info),
      });
      await cached.fetch('sid-trace', '1');
      await cached.fetch('sid-trace', '1');
      expect(events.map((e) => e.outcome)).toEqual(['miss_fetched', 'hit']);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("le cache disque est ré-utilisable d'un process à l'autre (relecture mtime indépendante)", async () => {
    // On simule la persistence en pré-écrivant manuellement la structure cache.
    const cacheDir = await mkdtemp(join(tmpdir(), 'gaslens-libcache-'));
    try {
      const dir = libCachePath(cacheDir, 'sid-manual', '7');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'appsscript.json'), '{}', 'utf8');
      await writeFile(join(dir, 'Foo.gs'), 'function foo(){}', 'utf8');
      await writeFile(
        join(dir, '__gaslens_meta.json'),
        JSON.stringify({ scriptId: 'sid-manual', version: '7', meta: {} }),
        'utf8',
      );
      const reader = createDiskCachedFetcher(null, { cacheDir });
      const src = await reader.fetch('sid-manual', '7');
      expect(src).not.toBeNull();
      expect(src!.files.some((f) => f.name === 'Foo')).toBe(true);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});
