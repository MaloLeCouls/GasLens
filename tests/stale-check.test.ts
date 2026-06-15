import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanProject } from '../src/scanner.js';
import { checkIndexStaleness } from '../src/stale-check.js';

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gaslens-stale-'));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content, 'utf8');
  }
  return root;
}

describe('stale-check', () => {
  it("is_stale=false quand l'index est plus récent que toutes les sources", async () => {
    const root = await makeProject({
      'appsscript.json': '{}',
      'main.gs': `function go() { return 1; }`,
    });
    try {
      const idx = await scanProject({ root });
      const r = await checkIndexStaleness(idx);
      expect(r.is_stale).toBe(false);
      expect(r.inspected_roots).toEqual([root]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is_stale=true quand un .gs est modifié après le scan", async () => {
    const root = await makeProject({
      'appsscript.json': '{}',
      'main.gs': `function go() { return 1; }`,
    });
    try {
      const idx = await scanProject({ root });
      // Avance la mtime de main.gs d'1 minute après le scan.
      const future = new Date(Date.parse(idx.scanned_at) + 60_000);
      await utimes(join(root, 'main.gs'), future, future);
      const r = await checkIndexStaleness(idx);
      expect(r.is_stale).toBe(true);
      expect(r.newest_source?.path).toContain('main.gs');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is_stale=true aussi quand appsscript.json est modifié", async () => {
    const root = await makeProject({
      'appsscript.json': '{"runtimeVersion":"V8"}',
      'main.gs': `function go() { return 1; }`,
    });
    try {
      const idx = await scanProject({ root });
      const future = new Date(Date.parse(idx.scanned_at) + 60_000);
      await utimes(join(root, 'appsscript.json'), future, future);
      const r = await checkIndexStaleness(idx);
      expect(r.is_stale).toBe(true);
      expect(r.newest_source?.path).toContain('appsscript.json');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignore les répertoires node_modules / dist / .git", async () => {
    const root = await makeProject({
      'appsscript.json': '{}',
      'main.gs': `function go() { return 1; }`,
      'node_modules/foo/main.gs': `function bar() {}`, // intentionnellement ignoré
    });
    try {
      const idx = await scanProject({ root });
      const future = new Date(Date.parse(idx.scanned_at) + 60_000);
      await utimes(join(root, 'node_modules/foo/main.gs'), future, future);
      const r = await checkIndexStaleness(idx);
      // L'index reste considéré fresh : node_modules est exclu.
      expect(r.is_stale).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
