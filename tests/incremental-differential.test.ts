/**
 * F2 — Test différentiel : `scan --incremental` ≡ full re-scan, au niveau des
 * **findings** (le chemin partial du moteur est le plus subtil ; on verrouille
 * qu'il ne dévie jamais du scan complet sur une batterie d'éditions).
 *
 * Pour chaque scénario : baseline = scan v0 → édition → on produit le rapport
 * `check` complet (diff + manifest + api + lint runtime/webapp + doc) à partir
 * (a) d'un full re-scan et (b) d'un scan incrémental piloté par la baseline.
 * Les findings normalisés + le verdict doivent être IDENTIQUES.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanProject } from '../src/scanner.js';
import { diffIndexes } from '../src/diff.js';
import {
  enrichWithManifestFindings,
  enrichWithApiFindings,
  enrichWithLintRuntimeFindings,
  enrichWithLintWebappFindings,
  enrichWithDocFindings,
} from '../src/check.js';
import type { ProjectIndex } from '../src/types.js';
import type { DiffReport } from '../src/findings.js';

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gaslens-diff-'));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content, 'utf8');
  }
  return root;
}

/** Reproduit le pipeline `check` (sync — env exclu car pas de manifeste maître). */
function reportFor(baseline: ProjectIndex, current: ProjectIndex): DiffReport {
  const base = diffIndexes(baseline, current, {
    baselineLabel: 'baseline',
    currentLabel: 'current',
    severity_threshold: 'warn',
  });
  let r = enrichWithManifestFindings(base, current, 'warn');
  r = enrichWithApiFindings(r, current, 'warn');
  r = enrichWithLintRuntimeFindings(r, current, 'warn');
  r = enrichWithLintWebappFindings(r, current, 'warn');
  r = enrichWithDocFindings(r, current, 'warn');
  return r;
}

/** Empreinte stable et triée d'un rapport (insensible à l'ordre). */
function fingerprint(r: DiffReport): { verdict: string; findings: string[] } {
  const all = [...r.breaks, ...r.warns, ...r.safe].map(
    (f) => `${f.severity}|${f.consumer_kind}|${f.consumer.file}:${f.consumer.line}|${f.reason}`,
  );
  return { verdict: r.verdict, findings: all.sort() };
}

interface Scenario {
  name: string;
  files: Record<string, string>;
  edit: Record<string, string>;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'renommage d\'une fonction appelée cross-file (break structurel)',
    files: {
      'appsscript.json': '{}',
      'a.gs': `function alpha() { return target(); }`,
      'b.gs': `function target() { return 1; } function other() { return 2; }`,
    },
    edit: { 'b.gs': `function renamed() { return 1; } function other() { return 2; }` },
  },
  {
    name: 'retour devenu non-sérialisable sur une fonction exposée client',
    files: {
      'appsscript.json': '{}',
      'main.gs': `function getData() { return { ok: true }; }`,
      // .gs inchangé → garantit que le chemin partial est exercé (pas de fallback full).
      'util.gs': `function noop() { return 0; }`,
      'idx.html': `<html><body><script>google.script.run.getData()</script></body></html>`,
    },
    edit: { 'main.gs': `function getData() { return function() {}; }` },
  },
  {
    name: 'méthode API hallucinée introduite dans un .gs modifié',
    files: {
      'appsscript.json': '{}',
      'a.gs': `function helper() { return 1; }`,
      'b.gs': `function run() { return SpreadsheetApp.getActiveSpreadsheet(); }`,
    },
    edit: { 'b.gs': `function run() { return SpreadsheetApp.getActiveSpreadsheet().notARealMethod(); }` },
  },
  {
    name: 'changement de cible scriptlet/client dans un .html (chemin partial HTML)',
    files: {
      'appsscript.json': '{}',
      'main.gs': `function doGet() { return HtmlService.createTemplateFromFile('idx').evaluate(); }
function go() { return 1; }`,
      'idx.html': `<html><body><script>google.script.run.go()</script></body></html>`,
    },
    edit: { 'idx.html': `<html><body><script>google.script.run.doGet()</script></body></html>` },
  },
  {
    name: 'dérive @param introduite (doc.param_drift)',
    files: {
      'appsscript.json': '{}',
      'a.gs': `/**\n * Envoie.\n * @param {string} recipient\n */\nfunction send(recipient) { return recipient; }`,
      'b.gs': `function noop() { return 0; }`,
    },
    edit: { 'a.gs': `/**\n * Envoie.\n * @param {string} recipient\n */\nfunction send(to) { return to; }` },
  },
  {
    name: 'quota value_in_loop introduit dans un fichier modifié (lint runtime)',
    files: {
      'appsscript.json': '{}',
      'a.gs': `function tick() { return 1; }`,
      'b.gs': `function fill() { var s = SpreadsheetApp.getActiveSheet(); return s; }`,
    },
    edit: { 'b.gs': `function fill() { var s = SpreadsheetApp.getActiveSheet(); for (var i=0;i<10;i++) { s.getRange(i,1).setValue(i); } return s; }` },
  },
];

describe('F2 — incremental ≡ full re-scan (findings différentiels)', () => {
  for (const sc of SCENARIOS) {
    it(sc.name, async () => {
      const root = await makeProject(sc.files);
      try {
        const baseline = await scanProject({ root });
        for (const [rel, content] of Object.entries(sc.edit)) {
          await writeFile(join(root, rel), content, 'utf8');
        }
        const full = await scanProject({ root });
        let hitReason: string | null = null;
        const incr = await scanProject({
          root,
          incrementalBaseline: baseline,
          onIncrementalHit: (info) => {
            hitReason = info.reason;
          },
        });
        // Le chemin incrémental a bien été emprunté (sinon le test ne prouve rien).
        expect(hitReason).not.toBeNull();

        const fpFull = fingerprint(reportFor(baseline, full));
        const fpIncr = fingerprint(reportFor(baseline, incr));
        expect(fpIncr.verdict).toBe(fpFull.verdict);
        expect(fpIncr.findings).toEqual(fpFull.findings);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
