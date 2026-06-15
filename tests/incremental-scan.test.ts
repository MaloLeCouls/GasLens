import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanProject, rebuildCalledByFromOutboundCalls } from '../src/scanner.js';
import type { FunctionRecord } from '../src/types.js';

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gaslens-incr-'));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content, 'utf8');
  }
  return root;
}

describe('incremental scan — fast-path', () => {
  it("emprunte le fast-path quand aucune source n'a changé depuis le baseline", async () => {
    const root = await makeProject({
      'appsscript.json': '{}',
      'main.gs': `function go() { return helper(); } function helper() { return 1; }`,
    });
    try {
      const baseline = await scanProject({ root });
      let hit = false;
      const incr = await scanProject({
        root,
        incrementalBaseline: baseline,
        onIncrementalHit: () => {
          hit = true;
        },
      });
      expect(hit).toBe(true);
      // Le scanned_at change (rafraîchi) mais le contenu fonctionnel reste identique.
      expect(incr.functions.length).toBe(baseline.functions.length);
      expect(incr.scanned_at).not.toBe(baseline.scanned_at);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('tombe en full scan quand une source a été modifiée (mtime > scanned_at)', async () => {
    const root = await makeProject({
      'appsscript.json': '{}',
      'main.gs': `function go() { return 1; }`,
    });
    try {
      const baseline = await scanProject({ root });
      // Avance la mtime du fichier après le scan.
      const future = new Date(Date.parse(baseline.scanned_at) + 60_000);
      await utimes(join(root, 'main.gs'), future, future);

      let hit = false;
      const incr = await scanProject({
        root,
        incrementalBaseline: baseline,
        onIncrementalHit: () => {
          hit = true;
        },
      });
      expect(hit).toBe(false);
      expect(incr.functions.length).toBe(baseline.functions.length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("tombe en full scan quand un fichier est ajouté", async () => {
    const root = await makeProject({
      'appsscript.json': '{}',
      'main.gs': `function go() { return 1; }`,
    });
    try {
      const baseline = await scanProject({ root });
      await writeFile(join(root, 'helper.gs'), 'function helper() { return 2; }', 'utf8');
      let hit = false;
      const incr = await scanProject({
        root,
        incrementalBaseline: baseline,
        onIncrementalHit: () => {
          hit = true;
        },
      });
      expect(hit).toBe(false);
      expect(incr.functions.length).toBeGreaterThan(baseline.functions.length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("le fast-path préserve la coverage et les exposures", async () => {
    const root = await makeProject({
      'appsscript.json': '{"webapp": {"access": "ANYONE"}}',
      'main.gs': `function doGet() { return 1; } function go() { return doGet(); }`,
    });
    try {
      const baseline = await scanProject({ root });
      const incr = await scanProject({ root, incrementalBaseline: baseline });
      const fn = incr.functions.find((f) => f.name === 'doGet')!;
      expect(fn.exposures.some((e) => e.type === 'entry_point_web')).toBe(true);
      expect(fn.called_by.length).toBe(1);
      expect(incr.coverage_summary.resolved_pct).toBe(baseline.coverage_summary.resolved_pct);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('rebuildCalledByFromOutboundCalls', () => {
  it("reconstruit called_by à partir d'outbound_calls (sans cross-project)", async () => {
    const root = await makeProject({
      'appsscript.json': '{}',
      'main.gs': `function a() { return b(); } function b() { return c(); } function c() { return 1; }`,
    });
    try {
      const idx = await scanProject({ root });
      const records = new Map<string, FunctionRecord>(
        idx.functions.map((f) => [f.name, f]),
      );
      // Snapshot des called_by avant.
      const before = new Map(
        idx.functions.map((f) => [f.name, f.called_by.length]),
      );
      // Reset destructif pour vérifier la reconstruction.
      for (const rec of records.values()) {
        rec.called_by = [];
      }
      rebuildCalledByFromOutboundCalls(records);
      for (const [name, count] of before) {
        expect(records.get(name)!.called_by.length).toBe(count);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
