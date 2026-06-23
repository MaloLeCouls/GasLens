/**
 * F3 — Bench à l'échelle réelle.
 *
 * Génère un parc synthétique représentatif (par défaut 5 apps × 2 envs × 20
 * fichiers) puis mesure les coûts qui comptent pour le hook chaud :
 *   - full scan d'un workspace complet ;
 *   - scan incrémental d'un projet : fast-path (aucun changement) et partial
 *     (1 fichier édité) — ce dernier est le coût réel d'une édition d'agent ;
 *   - `env validate` à l'échelle workspace ET scopé à un projet (mode hook —
 *     il relit les sources, d'où l'intérêt de mesurer son coût par édition) ;
 *   - `workspace overview` (orientation parc).
 *
 * 100 % local, sans réseau. Lance : `npm run bench:scale` (ou
 * `node scripts/bench-scale.mjs --apps 8 --files 40`).
 *
 * Décide si l'extracteur d'index (F5b) devient prioritaire : si le coût par
 * édition d'`env validate` domine le partial scan, c'est le signal.
 */
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { scanWorkspace, scanProject } from '../dist/scanner.js';
import { runEnvValidate } from '../dist/env-validate.js';
import { buildParcOverview } from '../dist/parc-overview.js';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}

const APPS = arg('apps', 5);
const ENVS = ['dev', 'prod'];
const FILES = arg('files', 20);
const FNS_PER_FILE = arg('fns', 4);

const LIB_ID = 'LIB_' + 'X'.repeat(36);
const SHEET = (env) => `SHEET_${env.toUpperCase()}_` + env.repeat(8).slice(0, 36);

function appName(i) {
  return `app${i}`;
}

/** Génère le contenu d'un .gs : quelques fonctions, appels cross-file, GAS, doc. */
function gsFile(app, env, fileIdx) {
  const lines = [];
  for (let f = 0; f < FNS_PER_FILE; f++) {
    const name = `fn_${fileIdx}_${f}`;
    const callee = f > 0 ? `fn_${fileIdx}_${f - 1}` : `fn_${(fileIdx + 1) % FILES}_0`;
    lines.push('/**');
    lines.push(` * Traite l'étape ${f} du fichier ${fileIdx}.`);
    lines.push(` * @param {number} n  index`);
    lines.push(' */');
    lines.push(`function ${name}(n) {`);
    lines.push(`  var ss = SpreadsheetApp.getActiveSpreadsheet();`);
    lines.push(`  var v = ${callee}(n + 1);`);
    if (f % 3 === 0) {
      lines.push(`  return { id: n, value: v, label: 'x' };`);
    } else {
      lines.push(`  return v + n;`);
    }
    lines.push('}');
    lines.push('');
  }
  // Un fichier par projet hardcode l'id de SA ressource (donne du grain à env validate).
  if (fileIdx === 0) {
    lines.push(`function open_${env}() { return SpreadsheetApp.openById('${SHEET(env)}'); }`);
  }
  return lines.join('\n');
}

function manifest(env) {
  return JSON.stringify({
    runtimeVersion: 'V8',
    dependencies: {
      libraries: [
        {
          userSymbol: 'Core',
          libraryId: LIB_ID,
          version: env === 'prod' ? '12' : '0',
          developmentMode: env !== 'prod',
        },
      ],
    },
  });
}

function workspaceManifest() {
  const apps = [];
  for (let i = 0; i < APPS; i++) {
    const name = appName(i);
    apps.push({
      name,
      library_prefix: 'Core',
      projects: {
        dev: { script_id: `${name}_DEV`, clasp_path: `apps/${name}/dev` },
        prod: { script_id: `${name}_PROD`, clasp_path: `apps/${name}/prod` },
      },
    });
  }
  return JSON.stringify(
    {
      version: 1,
      name: 'bench-parc',
      apps,
      library: { user_symbol: 'Core', script_id: LIB_ID, prod_version: 12 },
      environments: {
        dev: { resources: { mainSheet: SHEET('dev') } },
        prod: { resources: { mainSheet: SHEET('prod') } },
      },
    },
    null,
    2,
  );
}

async function buildParc() {
  const root = await mkdtemp(join(tmpdir(), 'gaslens-bench-'));
  await writeFile(join(root, 'gaslens.workspace.json'), workspaceManifest(), 'utf8');
  for (let i = 0; i < APPS; i++) {
    const name = appName(i);
    for (const env of ENVS) {
      const dir = join(root, 'apps', name, env);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'appsscript.json'), manifest(env), 'utf8');
      for (let fi = 0; fi < FILES; fi++) {
        await writeFile(join(dir, `file${fi}.gs`), gsFile(name, env, fi), 'utf8');
      }
    }
  }
  return root;
}

async function time(label, fn, runs = 1) {
  // Warm-up (JIT, fs cache) puis médiane de `runs` exécutions.
  await fn();
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const med = samples[Math.floor(samples.length / 2)];
  return { label, ms: med };
}

function row(r) {
  return `  ${r.label.padEnd(48)} ${r.ms.toFixed(1).padStart(8)} ms`;
}

async function main() {
  const projectCount = APPS * ENVS.length;
  const fileCount = projectCount * FILES;
  process.stdout.write(
    `\nParc synthétique : ${APPS} apps × ${ENVS.length} envs × ${FILES} fichiers ` +
      `(${projectCount} projets, ${fileCount} .gs, ~${fileCount * FNS_PER_FILE} fonctions)\n\n`,
  );
  const root = await buildParc();
  try {
    const oneProject = join(root, 'apps', appName(0), 'dev');
    const editedFile = join(oneProject, 'file1.gs');
    const editedContent = gsFile(appName(0), 'dev', 1) + '\nfunction extra() { return 1; }\n';

    // Baseline (1 projet) pour les scans incrémentaux.
    const baseline = await scanProject({ root: oneProject });

    const fastFn = () => scanProject({ root: oneProject, incrementalBaseline: baseline });
    const partialFn = async () => {
      await writeFile(editedFile, editedContent, 'utf8');
      await scanProject({ root: oneProject, incrementalBaseline: baseline });
      await writeFile(editedFile, gsFile(appName(0), 'dev', 1), 'utf8'); // restore
    };
    const envHookFn = () => runEnvValidate({ root: oneProject });

    const results = [];
    results.push(await time('full scan — workspace entier', () => scanWorkspace({ root })));
    results.push(await time('full scan — 1 projet', () => scanProject({ root: oneProject })));
    results.push(await time('incrémental fast-path — 1 projet (aucun changement)', fastFn, 5));
    results.push(await time('incrémental partial — 1 projet (1 fichier édité)', partialFn, 5));
    results.push(await time('env validate — workspace entier', () => runEnvValidate({ root })));
    results.push(await time('env validate — scopé 1 projet (mode hook, par édition)', envHookFn, 5));
    results.push(await time('workspace overview (scan + env + doc)', () => buildParcOverview({ root })));

    process.stdout.write(results.map(row).join('\n') + '\n\n');

    const partial = results.find((r) => r.label.startsWith('incrémental partial'));
    const envHook = results.find((r) => r.label.startsWith('env validate — scopé'));
    if (partial && envHook) {
      const ratio = envHook.ms / partial.ms;
      process.stdout.write(
        `Coût par édition (hook) ≈ partial scan ${partial.ms.toFixed(1)} ms + ` +
          `env validate ${envHook.ms.toFixed(1)} ms.\n` +
          `Ratio env/partial = ${ratio.toFixed(1)}× — ` +
          (ratio > 2
            ? `env validate domine : prioriser un extracteur d'index (F5b).\n`
            : `coûts comparables : pas de signal fort pour F5b.\n`),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(String(err?.stack ?? err) + '\n');
  process.exit(1);
});
