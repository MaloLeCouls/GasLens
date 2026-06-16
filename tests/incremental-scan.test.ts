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

  it('quitte le fast-path quand une source a été modifiée (mtime > scanned_at)', async () => {
    const root = await makeProject({
      'appsscript.json': '{}',
      'main.gs': `function go() { return 1; }`,
    });
    try {
      const baseline = await scanProject({ root });
      // Avance la mtime du fichier après le scan.
      const future = new Date(Date.parse(baseline.scanned_at) + 60_000);
      await utimes(join(root, 'main.gs'), future, future);

      let fastHit = false;
      const incr = await scanProject({
        root,
        incrementalBaseline: baseline,
        onIncrementalHit: (info) => {
          if (info.reason === 'no_change_since_baseline') fastHit = true;
        },
      });
      // Fast-path PAS pris (puisqu'une source a une mtime ≥ scanned_at) ;
      // le chemin partial_per_file peut, lui, être pris (et c'est correct).
      expect(fastHit).toBe(false);
      expect(incr.functions.length).toBe(baseline.functions.length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ne reprend pas le fast-path quand un fichier est ajouté", async () => {
    const root = await makeProject({
      'appsscript.json': '{}',
      'main.gs': `function go() { return 1; }`,
    });
    try {
      const baseline = await scanProject({ root });
      await writeFile(join(root, 'helper.gs'), 'function helper() { return 2; }', 'utf8');
      let fastHit = false;
      const incr = await scanProject({
        root,
        incrementalBaseline: baseline,
        onIncrementalHit: (info) => {
          if (info.reason === 'no_change_since_baseline') fastHit = true;
        },
      });
      expect(fastHit).toBe(false);
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

describe('incremental scan — true per-file path', () => {
  it("emprunte le chemin partial quand un seul .gs change", async () => {
    const root = await makeProject({
      'appsscript.json': '{}',
      'a.gs': `function alpha() { return beta(); }`,
      'b.gs': `function beta() { return 1; } function gamma() { return 2; }`,
    });
    try {
      const baseline = await scanProject({ root });
      // Modifie b.gs : renomme gamma → delta.
      await writeFile(
        join(root, 'b.gs'),
        `function beta() { return 1; } function delta() { return 2; }`,
        'utf8',
      );
      let hitReason: string | null = null;
      let cached: number | null = null;
      const incr = await scanProject({
        root,
        incrementalBaseline: baseline,
        onIncrementalHit: (info) => {
          hitReason = info.reason;
          cached = info.cached_files_count ?? null;
        },
      });
      expect(hitReason).toBe('partial_per_file');
      expect(cached).toBe(1); // a.gs inchangé
      const names = incr.functions.map((f) => f.name).sort();
      expect(names).toEqual(['alpha', 'beta', 'delta']);
      // alpha.called_by reste inchangé (cached) ; beta.called_by reflète alpha.
      const beta = incr.functions.find((f) => f.name === 'beta')!;
      expect(beta.called_by.some((c) => c.caller === 'alpha')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reconstruit called_by correctement quand un caller (file inchangé) référence une fn renommée", async () => {
    const root = await makeProject({
      'appsscript.json': '{}',
      'a.gs': `function alpha() { return target(); }`,
      'b.gs': `function target() { return 1; }`,
    });
    try {
      const baseline = await scanProject({ root });
      const baselineTarget = baseline.functions.find((f) => f.name === 'target')!;
      expect(baselineTarget.called_by.length).toBe(1);
      // Renomme target → autre. a.gs reste inchangé (référence target qui n'existe plus).
      await writeFile(
        join(root, 'b.gs'),
        `function autre() { return 1; }`,
        'utf8',
      );
      const incr = await scanProject({
        root,
        incrementalBaseline: baseline,
      });
      const names = incr.functions.map((f) => f.name).sort();
      expect(names).toEqual(['alpha', 'autre']);
      // 'target' n'existe plus → l'outbound_call de alpha pointe vers un
      // nom inexistant. rebuildCalledByFromOutboundCalls ignore les targets
      // introuvables ; 'autre' n'est PAS appelé.
      const autre = incr.functions.find((f) => f.name === 'autre')!;
      expect(autre.called_by.length).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("emprunte le partial path quand un .html a changé : contribs HTML mises à jour", async () => {
    const root = await makeProject({
      'appsscript.json': '{}',
      'main.gs': `function doGet() { return HtmlService.createTemplateFromFile('idx').evaluate(); }
function go() { return 1; }`,
      'idx.html': `<html><body><script>google.script.run.go()</script></body></html>`,
    });
    try {
      const baseline = await scanProject({ root });
      // Avant édition : 'go' a une exposure client_call, 'doGet' n'en a pas.
      const baselineGo = baseline.functions.find((f) => f.name === 'go')!;
      expect(baselineGo.exposures.some((e) => e.type === 'client_call')).toBe(
        true,
      );
      // Modifie le HTML : la cible client_call passe de 'go' à 'doGet'.
      await writeFile(
        join(root, 'idx.html'),
        `<html><body><script>google.script.run.doGet()</script></body></html>`,
        'utf8',
      );
      let hitReason: string | null = null;
      const incr = await scanProject({
        root,
        incrementalBaseline: baseline,
        onIncrementalHit: (info) => {
          hitReason = info.reason;
        },
      });
      // Le chemin partial EST emprunté (HTML changes supportés depuis V3 §21).
      expect(hitReason).toBe('partial_per_file');
      // Nouvelle cible client_call : doGet doit en porter une, go ne plus.
      const doGet = incr.functions.find((f) => f.name === 'doGet')!;
      const go = incr.functions.find((f) => f.name === 'go')!;
      expect(doGet.exposures.some((e) => e.type === 'client_call')).toBe(true);
      expect(go.exposures.some((e) => e.type === 'client_call')).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("équivalence partial vs full quand un .html change (correctness)", async () => {
    const root = await makeProject({
      'appsscript.json': '{}',
      'main.gs': `function doGet() { return HtmlService.createTemplateFromFile('idx').evaluate(); }
function alpha() { return { id: 1, name: 'a' }; }
function beta() { return { ok: true }; }`,
      'idx.html': `<html><body><script>
        google.script.run.withSuccessHandler(function(r){console.log(r.id);}).alpha();
      </script></body></html>`,
    });
    try {
      const baseline = await scanProject({ root });
      // Modifie le HTML — la cible client_call et le handler changent.
      await writeFile(
        join(root, 'idx.html'),
        `<html><body><script>
          google.script.run.withSuccessHandler(function(r){console.log(r.ok);}).beta();
        </script></body></html>`,
        'utf8',
      );
      const incr = await scanProject({ root, incrementalBaseline: baseline });
      // Comparaison à un full scan « propre » (sans baseline).
      const full = await scanProject({ root });
      const byKey = (a: { type: string; file: string }, b: { type: string; file: string }) =>
        (a.type + a.file).localeCompare(b.type + b.file);
      const pickShape = (fns: typeof full.functions, name: string) => {
        const f = fns.find((x) => x.name === name);
        if (!f) return null;
        return {
          exposures: f.exposures.map((e) => ({ type: e.type, file: e.file })).sort(byKey),
          return_fields:
            f.inferred_contract?.return_shape?.field_names.slice().sort() ?? null,
        };
      };
      for (const n of ['alpha', 'beta', 'doGet']) {
        expect(pickShape(incr.functions, n)).toEqual(pickShape(full.functions, n));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retombe en full scan si appsscript.json a changé", async () => {
    const root = await makeProject({
      'appsscript.json': '{}',
      'main.gs': `function go() { return 1; }`,
    });
    try {
      const baseline = await scanProject({ root });
      await writeFile(
        join(root, 'appsscript.json'),
        '{"runtimeVersion":"V8"}',
        'utf8',
      );
      let hitReason: string | null = null;
      await scanProject({
        root,
        incrementalBaseline: baseline,
        onIncrementalHit: (info) => {
          hitReason = info.reason;
        },
      });
      expect(hitReason).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("équivalence fonctionnelle : incremental output ≈ full scan output", async () => {
    const root = await makeProject({
      'appsscript.json': '{}',
      'a.gs': `function alpha() { return beta() + 1; }`,
      'b.gs': `function beta() { return gamma(); }`,
      'c.gs': `function gamma() { return 42; }`,
    });
    try {
      const baseline = await scanProject({ root });
      // Modifie c.gs sans changer le contrat (ajoute du whitespace ineffectif).
      await writeFile(
        join(root, 'c.gs'),
        `function gamma() { return 43; }`,
        'utf8',
      );
      const fullScan = await scanProject({ root });
      const incremental = await scanProject({
        root,
        incrementalBaseline: baseline,
      });
      // Égalité par compte de records et par exposures/called_by.
      expect(incremental.functions.length).toBe(fullScan.functions.length);
      for (const incrFn of incremental.functions) {
        const fullFn = fullScan.functions.find((f) => f.name === incrFn.name)!;
        expect(incrFn.called_by.length).toBe(fullFn.called_by.length);
        expect(incrFn.outbound_calls.length).toBe(fullFn.outbound_calls.length);
        expect(incrFn.exposures.length).toBe(fullFn.exposures.length);
      }
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
