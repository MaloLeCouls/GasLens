import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadEvalDataset, runEval } from '../src/eval.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..');
const DATASET_DIR = resolve(REPO_ROOT, 'eval/tasks');

describe('eval — chargement du dataset', () => {
  it('charge les tâches JSON du répertoire eval/tasks', async () => {
    const tasks = await loadEvalDataset(DATASET_DIR);
    expect(tasks.length).toBeGreaterThanOrEqual(5);
    for (const t of tasks) {
      expect(t.name).toBeTruthy();
      expect(t.fixture).toBeTruthy();
      expect(t.mutations.length).toBeGreaterThanOrEqual(1);
      expect(t.expected.verdict).toMatch(/^(CLEAN|WARN|BREAK)$/);
    }
  });

  it("rejette avec un message lisible si le dataset n'existe pas", async () => {
    await expect(loadEvalDataset('/nonexistent/dataset')).rejects.toThrow(
      /dataset introuvable/,
    );
  });
});

describe('eval — exécution du dataset de référence', () => {
  it("toutes les tâches du dataset PASS (régression : si une tâche casse, c'est un bug à corriger)", async () => {
    const tasks = await loadEvalDataset(DATASET_DIR);
    const report = await runEval(tasks, REPO_ROOT);
    if (report.failed > 0) {
      const failureDetails = report.results
        .filter((r) => !r.pass)
        .map((r) => `[${r.task}]\n  ${r.failures.join('\n  ')}`)
        .join('\n');
      throw new Error(
        `${report.failed} / ${report.total} tâche(s) d'éval ont échoué :\n${failureDetails}`,
      );
    }
    expect(report.passed).toBe(report.total);
    expect(report.detection_rate).toBe(1);
  }, 30000);
});

describe('eval — métriques agrégées', () => {
  it("calcule detection_rate et avg_output_bytes", async () => {
    const tasks = await loadEvalDataset(DATASET_DIR);
    const report = await runEval(tasks, REPO_ROOT);
    expect(report.detection_rate).toBeGreaterThanOrEqual(0);
    expect(report.detection_rate).toBeLessThanOrEqual(1);
    expect(report.avg_output_bytes).toBeGreaterThan(0);
  }, 30000);
});
