import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanProject } from '../src/scanner.js';
import {
  analyzeProdTruth,
  renderProdTruthText,
  NoopMetricsProvider,
  type MetricsProvider,
  type FunctionMetrics,
} from '../src/prod-truth.js';

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gaslens-pt-'));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content, 'utf8');
  }
  return root;
}

const MANIFEST = JSON.stringify({ runtimeVersion: 'V8' });

function metricsFor(map: Record<string, Partial<FunctionMetrics>>): MetricsProvider {
  return {
    async getMetrics({ function_names, window_days = 30 }) {
      return function_names
        .filter((n) => n in map)
        .map((n) => ({
          function_name: n,
          executions_count: null,
          unique_users: null,
          error_count: null,
          error_rate: null,
          last_execution_at: null,
          window_days,
          ...map[n],
        }));
    },
  };
}

describe('prod-truth — provider no-op', () => {
  it('range tout en unknown et émet le conseil de brancher un provider', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': `function go() { return 1; } function aux() { return 2; }`,
    });
    try {
      const idx = await scanProject({ root });
      const report = await analyzeProdTruth(idx, NoopMetricsProvider);
      expect(report.summary.unknown).toBe(report.summary.total);
      expect(report.summary.total).toBeGreaterThanOrEqual(2);
      expect(report.advice[0]).toMatch(/brancher un MetricsProvider/);
      expect(renderProdTruthText(report)).toContain('unknown=' + report.summary.total);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('prod-truth — classification croisée', () => {
  it("confirmed_dead : pas d'exposition statique + 0 exécution", async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': `function orphan() { return 1; }`,
    });
    try {
      const idx = await scanProject({ root });
      const provider = metricsFor({ orphan: { executions_count: 0 } });
      const report = await analyzeProdTruth(idx, provider);
      const e = report.entries.find((x) => x.function_name === 'orphan')!;
      expect(e.cross_status).toBe('confirmed_dead');
      expect(e.heat).toBe('cold');
      expect(report.advice.some((a) => a.includes('confirmed_dead'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("dispatched_dynamic : pas d'exposition statique mais exécutions observées", async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': `function maybeOrphan() { return 1; }`,
    });
    try {
      const idx = await scanProject({ root });
      const provider = metricsFor({
        maybeOrphan: { executions_count: 240, window_days: 30 },
      });
      const report = await analyzeProdTruth(idx, provider);
      const e = report.entries.find((x) => x.function_name === 'maybeOrphan')!;
      expect(e.cross_status).toBe('dispatched_dynamic');
      expect(e.heat).toBe('hot');
      expect(report.advice.some((a) => a.includes('NE PAS supprimer'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('errored : taux >= seuil', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': `function doGet() { return 1; }`,
    });
    try {
      const idx = await scanProject({ root });
      const provider = metricsFor({
        doGet: { executions_count: 1000, error_count: 80, error_rate: 0.08 },
      });
      const report = await analyzeProdTruth(idx, provider, {
        error_rate_threshold: 0.05,
      });
      const e = report.entries.find((x) => x.function_name === 'doGet')!;
      expect(e.cross_status).toBe('errored');
      expect(e.note).toContain('8.0');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('live : expositions statiques + exécutions cohérentes', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': `function doGet() { return HtmlService.createHtmlOutput('ok'); }`,
    });
    try {
      const idx = await scanProject({ root });
      const provider = metricsFor({
        doGet: { executions_count: 100, error_count: 0, error_rate: 0 },
      });
      const report = await analyzeProdTruth(idx, provider);
      const e = report.entries.find((x) => x.function_name === 'doGet')!;
      // doGet a une exposure (web app entry point) → live attendu.
      expect(e.static_exposures_count).toBeGreaterThan(0);
      expect(e.cross_status).toBe('live');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cold_exposed : exposé statiquement mais 0 exécution", async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': `function doGet() { return HtmlService.createHtmlOutput('ok'); }`,
    });
    try {
      const idx = await scanProject({ root });
      const provider = metricsFor({
        doGet: { executions_count: 0 },
      });
      const report = await analyzeProdTruth(idx, provider);
      const e = report.entries.find((x) => x.function_name === 'doGet')!;
      expect(e.cross_status).toBe('cold_exposed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('prod-truth — provider qui throw', () => {
  it('dégrade silencieusement en unknown (consultatif, jamais bloquant)', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'main.gs': `function go() { return 1; }`,
    });
    try {
      const idx = await scanProject({ root });
      const broken: MetricsProvider = {
        async getMetrics() {
          throw new Error('quota exceeded');
        },
      };
      const report = await analyzeProdTruth(idx, broken);
      expect(report.summary.unknown).toBe(report.summary.total);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
