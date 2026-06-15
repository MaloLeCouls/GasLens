import { readdir, readFile, writeFile, mkdir, mkdtemp, rm, copyFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { scanProject, scanWorkspace } from './scanner.js';
import { diffIndexes } from './diff.js';
import {
  enrichWithManifestFindings,
  enrichWithApiFindings,
  enrichWithLintRuntimeFindings,
  enrichWithLintWebappFindings,
} from './check.js';
import type { ProjectIndex, WorkspaceIndex } from './types.js';
import type {
  DerivedDeltaKind,
  DiffReport,
  Verdict,
} from './findings.js';

/**
 * Format de tâche d'évaluation (V1 §5 / V2 §17 étape 15).
 *
 * Une tâche décrit :
 *   - un fixture (état initial du projet GAS) ;
 *   - une mutation à appliquer (équivalent à une édition d'agent) ;
 *   - les attentes : verdict, types de delta dérivés, breaks par localisation.
 *
 * Le runner :
 *   1. copie le fixture dans un tmp dir ;
 *   2. scanne → baseline ;
 *   3. applique la mutation ;
 *   4. lance check (= scan + diff) ;
 *   5. compare l'output aux attentes ;
 *   6. émet un PASS/FAIL + métriques.
 */
export interface EvalTask {
  name: string;
  description?: string;
  fixture: string;
  /** Liste de remplacements à appliquer (dans l'ordre). */
  mutations: TaskMutation[];
  expected: TaskExpected;
}

export interface TaskMutation {
  file: string;
  /** Substring exact à remplacer dans le fichier cible. */
  before_contains: string;
  /** Texte de remplacement. */
  after: string;
}

export interface TaskExpected {
  verdict: Verdict;
  /** Au moins ces deltas doivent figurer dans derived_change_set. */
  derived_kinds?: DerivedDeltaKind[];
  /** Borne basse du nombre de breaks attendus. */
  breaks_min?: number;
  /** Chaque entrée doit matcher au moins un break. */
  breaks_must_include?: Array<{
    file?: string;
    line?: number;
    reason_substring?: string;
    consumer_kind?: string;
  }>;
  /** Au plus N warns attendus (pour vérifier qu'on n'inonde pas). */
  warns_max?: number;
}

export interface EvalTaskResult {
  task: string;
  pass: boolean;
  failures: string[];
  verdict: Verdict;
  derived_kinds_seen: DerivedDeltaKind[];
  breaks_count: number;
  warns_count: number;
  output_bytes: number;
}

export interface EvalReport {
  dataset_path: string;
  total: number;
  passed: number;
  failed: number;
  detection_rate: number;
  avg_output_bytes: number;
  results: EvalTaskResult[];
}

export async function loadEvalDataset(dir: string): Promise<EvalTask[]> {
  const root = resolve(dir);
  if (!existsSync(root)) {
    throw new Error(`dataset introuvable à ${root}`);
  }
  const out: EvalTask[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const p = join(root, entry.name);
    const raw = JSON.parse(await readFile(p, 'utf8')) as EvalTask;
    out.push(raw);
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

export async function runEval(
  tasks: EvalTask[],
  baseDir: string,
): Promise<EvalReport> {
  const results: EvalTaskResult[] = [];
  for (const task of tasks) {
    results.push(await runOneTask(task, baseDir));
  }
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  const detection_rate = results.length === 0 ? 0 : passed / results.length;
  const avg_output_bytes = results.length === 0
    ? 0
    : Math.round(results.reduce((n, r) => n + r.output_bytes, 0) / results.length);
  return {
    dataset_path: baseDir,
    total: results.length,
    passed,
    failed,
    detection_rate,
    avg_output_bytes,
    results,
  };
}

async function runOneTask(
  task: EvalTask,
  baseDir: string,
): Promise<EvalTaskResult> {
  const failures: string[] = [];
  const fixturePath = resolve(baseDir, task.fixture);
  const tmpRoot = await mkdtemp(join(tmpdir(), 'gaslens-eval-'));
  try {
    await copyTree(fixturePath, tmpRoot);
    const baselineIdx = await scanAny(tmpRoot);

    // Applique les mutations dans l'ordre.
    for (const mut of task.mutations) {
      const targetPath = join(tmpRoot, mut.file);
      const source = await readFile(targetPath, 'utf8');
      if (!source.includes(mut.before_contains)) {
        failures.push(
          `mutation.before_contains introuvable dans ${mut.file} : « ${mut.before_contains.slice(0, 80)}... »`,
        );
        return {
          task: task.name,
          pass: false,
          failures,
          verdict: 'CLEAN',
          derived_kinds_seen: [],
          breaks_count: 0,
          warns_count: 0,
          output_bytes: 0,
        };
      }
      const mutated = source.replace(mut.before_contains, mut.after);
      await writeFile(targetPath, mutated, 'utf8');
    }

    const currentIdx = await scanAny(tmpRoot);
    const report = diffSingleProject(baselineIdx, currentIdx);

    // Comparaison aux attentes.
    if (report.verdict !== task.expected.verdict) {
      failures.push(`verdict attendu=${task.expected.verdict} mais obtenu=${report.verdict}`);
    }
    const deltasSeen = report.derived_change_set.map((d) => d.delta);
    for (const expectedKind of task.expected.derived_kinds ?? []) {
      if (!deltasSeen.includes(expectedKind)) {
        failures.push(`delta attendu '${expectedKind}' absent (vu : ${deltasSeen.join(', ')})`);
      }
    }
    if (
      task.expected.breaks_min !== undefined &&
      report.breaks.length < task.expected.breaks_min
    ) {
      failures.push(
        `breaks attendus ≥ ${task.expected.breaks_min}, obtenu ${report.breaks.length}`,
      );
    }
    for (const expected of task.expected.breaks_must_include ?? []) {
      const hit = report.breaks.some((b) => {
        if (expected.file && !b.consumer.file.includes(expected.file)) return false;
        if (expected.line !== undefined && b.consumer.line !== expected.line) return false;
        if (expected.reason_substring && !b.reason.includes(expected.reason_substring)) return false;
        if (expected.consumer_kind && b.consumer_kind !== expected.consumer_kind) return false;
        return true;
      });
      if (!hit) {
        failures.push(
          `aucun break ne matche ${JSON.stringify(expected)}. Vus : ${report.breaks
            .map((b) => `${b.consumer.file}:${b.consumer.line}`)
            .join(', ')}`,
        );
      }
    }
    if (
      task.expected.warns_max !== undefined &&
      report.warns.length > task.expected.warns_max
    ) {
      failures.push(
        `warns attendus ≤ ${task.expected.warns_max}, obtenu ${report.warns.length}`,
      );
    }

    const output_bytes = JSON.stringify(report).length;
    return {
      task: task.name,
      pass: failures.length === 0,
      failures,
      verdict: report.verdict,
      derived_kinds_seen: deltasSeen,
      breaks_count: report.breaks.length,
      warns_count: report.warns.length,
      output_bytes,
    };
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

async function scanAny(root: string): Promise<ProjectIndex> {
  const idx = await scanWorkspace({ root });
  if (idx.kind === 'workspace') {
    if (idx.projects.length === 1) return idx.projects[0]!;
    throw new Error(
      `eval ne supporte pas encore les workspaces multi-projets ; le fixture doit être un projet unique`,
    );
  }
  return idx;
}

function diffSingleProject(
  baseline: ProjectIndex,
  current: ProjectIndex,
): DiffReport {
  const base = diffIndexes(baseline, current, {
    baselineLabel: 'baseline',
    currentLabel: 'mutated',
    severity_threshold: 'warn',
  });
  // L'eval reflète ce que le hook (`check`) verra : on enrichit avec les
  // findings manifeste + validate-api + lint-runtime + lint-webapp de l'état courant.
  const m = enrichWithManifestFindings(base, current, 'warn');
  const a = enrichWithApiFindings(m, current, 'warn');
  const r = enrichWithLintRuntimeFindings(a, current, 'warn');
  return enrichWithLintWebappFindings(r, current, 'warn');
}

async function copyTree(src: string, dst: string): Promise<void> {
  await mkdir(dst, { recursive: true });
  for (const e of await readdir(src, { withFileTypes: true })) {
    const s = join(src, e.name);
    const d = join(dst, e.name);
    if (e.isDirectory()) await copyTree(s, d);
    else if (e.isFile()) await copyFile(s, d);
  }
}

export function renderEvalReportText(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(
    `gaslens eval (${report.dataset_path}) — ${report.passed}/${report.total} tâche(s) PASS ` +
      `(detection rate ${(report.detection_rate * 100).toFixed(0)}%, output moyen ${report.avg_output_bytes} bytes)`,
  );
  for (const r of report.results) {
    const tag = r.pass ? 'PASS' : 'FAIL';
    lines.push(
      `  [${tag}] ${r.task.padEnd(40)} verdict=${r.verdict} breaks=${r.breaks_count} warns=${r.warns_count}`,
    );
    for (const f of r.failures) {
      lines.push(`         ↳ ${f}`);
    }
  }
  return lines.join('\n');
}
