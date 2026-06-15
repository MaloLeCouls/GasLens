import { Command } from 'commander';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { scanProject, scanWorkspace } from './scanner.js';
import {
  inspect,
  type CoverageDetail,
  type DetailLevel,
  type IncludeField,
  type InspectOptions,
} from './inspect.js';
import { impact, parseChangeSpec } from './impact.js';
import { diffIndexes } from './diff.js';
import { runCheck, exitCodeFor } from './check.js';
import { runHook } from './hook.js';
import {
  CLAUDE_MD_ROOT,
  CLAUDE_SETTINGS_JSON,
  SETUP_GUIDE,
  claudeMdSubrepo,
} from './init.js';
import { emitDts } from './emit-dts.js';
import { emitContractTests } from './emit-contract-tests.js';
import { loadEvalDataset, runEval, renderEvalReportText } from './eval.js';
import { buildMap, renderMapText } from './map.js';
import { analyzeManifest, renderManifestText } from './manifest-analysis.js';
import type { ProjectIndex, WorkspaceIndex } from './types.js';

export async function main(argv: string[] = process.argv): Promise<void> {
  const program = new Command();

  program
    .name('gaslens')
    .description(
      "Outil CLI d'analyse de code Google Apps Script, pensé pour un agent IA. " +
        'Indexe un projet GAS et expose des commandes ciblées de consultation et vérification.',
    )
    .version('0.0.1');

  program
    .command('scan')
    .description(
      "Construit l'index d'un projet GAS (définitions, call sites, expositions). " +
        'Sortie : JSON conforme au modèle du V1 §4.2.',
    )
    .argument('<path>', 'Chemin vers la racine du projet (contenant idéalement appsscript.json)')
    .option(
      '-o, --output <path>',
      "Fichier de sortie JSON. Par défaut : <path>/.gaslens/index.json",
    )
    .option('--stdout', "Écrit l'index sur stdout au lieu d'un fichier")
    .option(
      '--format <fmt>',
      'Format de sortie : json | ndjson (ndjson = un record fonction par ligne)',
      'json',
    )
    .action(async (path: string, opts: ScanOpts) => {
      try {
        const root = resolve(path);
        const idx = await scanWorkspace({ root });

        if (opts.stdout) {
          if (opts.format === 'ndjson' && idx.kind === 'project') {
            for (const fn of idx.functions) {
              process.stdout.write(JSON.stringify(fn) + '\n');
            }
          } else {
            process.stdout.write(JSON.stringify(idx, null, 2) + '\n');
          }
          return;
        }

        const outputPath = resolve(
          opts.output ?? `${root}/.gaslens/index.json`,
        );
        await mkdir(dirname(outputPath), { recursive: true });
        if (opts.format === 'ndjson' && idx.kind === 'project') {
          const lines = idx.functions.map((f) => JSON.stringify(f)).join('\n');
          await writeFile(outputPath, lines + '\n', 'utf8');
        } else {
          await writeFile(outputPath, JSON.stringify(idx, null, 2), 'utf8');
        }

        if (idx.kind === 'workspace') {
          const projCount = idx.projects.length;
          const fnCount = idx.projects.reduce((n, p) => n + p.functions.length, 0);
          const fileCount = idx.projects.reduce((n, p) => n + p.files.length, 0);
          process.stderr.write(
            `gaslens scan: workspace de ${projCount} projet(s), ` +
              `${fnCount} fonction(s) sur ${fileCount} fichier(s), ` +
              `${idx.cross_project_edges.length} edge(s) cross-project résolue(s).\n` +
              `→ ${outputPath}\n`,
          );
        } else {
          const fnCount = idx.functions.length;
          const fileCount = idx.files.length;
          const unresolvedCount = idx.unresolved_calls.length;
          const exposuresCount = idx.functions.reduce(
            (n, f) => n + f.exposures.length,
            0,
          );
          process.stderr.write(
            `gaslens scan: ${fnCount} fonction(s) sur ${fileCount} fichier(s), ` +
              `${exposuresCount} exposition(s), ${unresolvedCount} appel(s) non résolu(s).\n` +
              `→ ${outputPath}\n`,
          );
        }
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT') {
          process.stderr.write(
            `gaslens scan: chemin introuvable « ${path} ». ` +
              `Vérifie que le dossier existe et qu'il contient des fichiers .gs.\n`,
          );
        } else {
          process.stderr.write(`gaslens scan: erreur — ${e.message ?? err}\n`);
        }
        process.exit(2);
      }
    });

  program
    .command('map')
    .description(
      "Table des matières ultra-compacte d'un projet ou workspace (V3 §21.5) : " +
        'entry points web, triggers, fonctions exposées au client, librairies ' +
        "consommées/exposées, templates scriptlet. Pensé pour l'amorçage de session.",
    )
    .option('--index-path <path>', 'Chemin vers index.json', './.gaslens/index.json')
    .option('--project <name>', "Cibler un seul projet d'un index workspace")
    .option('--format <fmt>', 'json | text', 'json')
    .action(async (opts: MapCliOpts) => {
      const idxPath = resolve(opts.indexPath);
      if (!existsSync(idxPath)) {
        process.stderr.write(
          `gaslens map: index introuvable à ${idxPath}. ` +
            `Lance d'abord 'gaslens scan <chemin>' pour le construire, ` +
            `ou passe --index-path vers un index existant.\n`,
        );
        process.exit(2);
      }
      let raw: ProjectIndex | WorkspaceIndex;
      try {
        raw = JSON.parse(await readFile(idxPath, 'utf8')) as
          | ProjectIndex
          | WorkspaceIndex;
      } catch (err) {
        process.stderr.write(
          `gaslens map: index illisible (${(err as Error).message}). ` +
            `Re-génère-le avec 'gaslens scan'.\n`,
        );
        process.exit(2);
      }
      if (opts.project) {
        if (raw.kind !== 'workspace') {
          process.stderr.write(
            `gaslens map: --project '${opts.project}' précisé mais l'index n'est pas un workspace.\n`,
          );
          process.exit(2);
        }
        const target = raw.projects.find((p) => p.project === opts.project);
        if (!target) {
          process.stderr.write(
            `gaslens map: --project '${opts.project}' introuvable. Projets : ` +
              raw.projects.map((p) => p.project).join(', ') +
              '\n',
          );
          process.exit(2);
        }
        raw = target;
      }
      const report = buildMap(raw);
      if (opts.format === 'text') {
        process.stdout.write(renderMapText(report) + '\n');
      } else {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      }
    });

  program
    .command('manifest')
    .description(
      "Croise appsscript.json avec le code indexé (V3 §21.1) : librairies " +
        "déclarées vs utilisées, services avancés manquants/superflus. Émet " +
        "des findings exploitables par 'check' (consumer_kind manifest.*).",
    )
    .option('--index-path <path>', 'Chemin vers index.json', './.gaslens/index.json')
    .option('--project <name>', "Cibler un seul projet d'un index workspace")
    .option(
      '--severity-threshold <level>',
      'info | warn | break — seuil des entrées remontées',
      'info',
    )
    .option('--format <fmt>', 'json | text', 'json')
    .action(async (opts: ManifestCliOpts) => {
      const idxPath = resolve(opts.indexPath);
      if (!existsSync(idxPath)) {
        process.stderr.write(
          `gaslens manifest: index introuvable à ${idxPath}. Lance d'abord 'gaslens scan'.\n`,
        );
        process.exit(2);
      }
      let raw: ProjectIndex | WorkspaceIndex;
      try {
        raw = JSON.parse(await readFile(idxPath, 'utf8')) as
          | ProjectIndex
          | WorkspaceIndex;
      } catch (err) {
        process.stderr.write(
          `gaslens manifest: index illisible — ${(err as Error).message}.\n`,
        );
        process.exit(2);
      }
      const targets: ProjectIndex[] = pickManifestTargets(raw, opts.project);
      if (targets.length === 0) {
        process.stderr.write(
          `gaslens manifest: --project '${opts.project ?? ''}' introuvable.\n`,
        );
        process.exit(2);
      }
      const threshold = parseManifestThreshold(opts.severityThreshold);
      const reports = targets.map((p) => {
        const r = analyzeManifest(p);
        return {
          ...r,
          entries: r.entries.filter((e) => severityRank(e.severity) >= threshold),
        };
      });
      const verdict = reports.some((r) => r.verdict === 'BREAK')
        ? 'BREAK'
        : reports.some((r) => r.verdict === 'WARN')
          ? 'WARN'
          : 'CLEAN';
      if (opts.format === 'text') {
        for (const r of reports) {
          process.stdout.write(renderManifestText(r) + '\n');
        }
      } else {
        process.stdout.write(JSON.stringify({ verdict, projects: reports }, null, 2) + '\n');
      }
      if (verdict === 'BREAK') process.exit(3);
      if (verdict === 'WARN') process.exit(4);
      process.exit(0);
    });

  program
    .command('inspect')
    .description(
      "Renvoie ce qu'il faut savoir sur une fonction avant de la modifier : " +
        'signature, expositions, callers, callees, contrat inféré, coverage. ' +
        'Lecture de l\'index produit par `gaslens scan`.',
    )
    .argument('<function>', 'Nom de la fonction (ex. `sendEmailReport`)')
    .option(
      '-d, --detail-level <level>',
      'summary | standard | full | graph (cf. V1 §4.3)',
      'standard',
    )
    .option(
      '-i, --include <fields>',
      "Sélection façon GraphQL (csv) : callers,callees,contract,exposures,coverage,definition,all",
      '',
    )
    .option(
      '--max-callers <n>',
      'Plafond du nombre de callers émis (au-delà : truncated + total)',
      '25',
    )
    .option(
      '--coverage-detail <level>',
      'none | summary | full',
      'summary',
    )
    .option('--fuzzy', "Propose des noms proches si la fonction est introuvable", false)
    .option('--index-path <path>', 'Chemin vers index.json', './.gaslens/index.json')
    .option('--project <name>', "Cibler un projet précis dans un index workspace")
    .option('--format <fmt>', 'json | text', 'json')
    .action(async (functionName: string, opts: InspectCliOpts) => {
      const idxPath = resolve(opts.indexPath);
      if (!existsSync(idxPath)) {
        process.stderr.write(
          `gaslens inspect: index introuvable à ${idxPath}. ` +
            `Lance d'abord 'gaslens scan <chemin du projet>' pour le construire, ` +
            `ou passe --index-path vers un index existant.\n`,
        );
        process.exit(2);
      }
      let index: ProjectIndex;
      try {
        const raw = JSON.parse(await readFile(idxPath, 'utf8')) as
          | ProjectIndex
          | WorkspaceIndex;
        const picked = pickProjectFromIndex(raw, functionName, opts.project);
        if (picked.kind === 'error') {
          process.stderr.write(`gaslens inspect: ${picked.message}\n`);
          process.exit(picked.code);
        }
        index = picked.project;
      } catch (err) {
        process.stderr.write(
          `gaslens inspect: index illisible (${(err as Error).message}). ` +
            `Re-génère-le avec 'gaslens scan'.\n`,
        );
        process.exit(2);
      }

      const inspectOpts: InspectOptions = {
        detailLevel: parseDetailLevel(opts.detailLevel),
        include: parseInclude(opts.include),
        maxCallers: opts.maxCallers === '0' ? null : Number.parseInt(opts.maxCallers, 10),
        coverageDetail: parseCoverageDetail(opts.coverageDetail),
        fuzzy: Boolean(opts.fuzzy),
      };
      const result = inspect(index, functionName, inspectOpts);

      if (result.kind === 'not_found') {
        if (opts.format === 'text') {
          process.stderr.write(result.message + '\n');
        } else {
          process.stdout.write(
            JSON.stringify(
              {
                error: 'not_found',
                name: result.name,
                suggestions: result.suggestions,
                message: result.message,
              },
              null,
              2,
            ) + '\n',
          );
        }
        process.exit(1);
      }

      if (opts.format === 'text') {
        process.stdout.write(renderTextPayload(result.payload) + '\n');
      } else {
        process.stdout.write(JSON.stringify(result.payload, null, 2) + '\n');
      }
    });

  program
    .command('impact')
    .description(
      'Décrit le changement envisagé sur une fonction et liste les régressions ' +
        'potentielles confrontées aux callers, exposures et contrat inféré (V1 §4.3).',
    )
    .argument('<function>', 'Nom de la fonction concernée')
    .requiredOption(
      '-c, --change <spec>',
      "Description du changement. Formats : 'change-return-shape:-msgId,+ok' | " +
        "'remove-param:name' | 'rename:newName' | 'rename-param:old=new'.",
    )
    .option(
      '--severity-threshold <level>',
      'info | warn | break — seuil des findings émis',
      'warn',
    )
    .option('--index-path <path>', 'Chemin vers index.json', './.gaslens/index.json')
    .option('--project <name>', "Cibler un projet précis dans un index workspace")
    .option('--format <fmt>', 'json | text', 'json')
    .action(async (functionName: string, opts: ImpactCliOpts) => {
      const idxPath = resolve(opts.indexPath);
      if (!existsSync(idxPath)) {
        process.stderr.write(
          `gaslens impact: index introuvable à ${idxPath}. Lance d'abord 'gaslens scan'.\n`,
        );
        process.exit(2);
      }
      let index: ProjectIndex;
      try {
        const raw = JSON.parse(await readFile(idxPath, 'utf8')) as
          | ProjectIndex
          | WorkspaceIndex;
        const picked = pickProjectFromIndex(raw, functionName, opts.project);
        if (picked.kind === 'error') {
          process.stderr.write(`gaslens impact: ${picked.message}\n`);
          process.exit(picked.code);
        }
        index = picked.project;
      } catch (err) {
        process.stderr.write(`gaslens impact: index illisible — ${(err as Error).message}.\n`);
        process.exit(2);
      }
      let change;
      try {
        change = parseChangeSpec(opts.change);
      } catch (err) {
        process.stderr.write(`gaslens impact: ${(err as Error).message}\n`);
        process.exit(2);
      }
      const r = impact(index, functionName, change, {
        severity_threshold: opts.severityThreshold as 'info' | 'warn' | 'break',
      });
      if (r.kind === 'not_found') {
        process.stderr.write(r.message + '\n');
        process.exit(1);
      }
      if (opts.format === 'text') {
        process.stdout.write(renderImpactText(r.report) + '\n');
      } else {
        process.stdout.write(JSON.stringify(r.report, null, 2) + '\n');
      }
      // Exit codes alignés avec check (V2 §9.2) : 0=CLEAN, 3=BREAK, 4=WARN.
      if (r.report.verdict === 'BREAK') process.exit(3);
      if (r.report.verdict === 'WARN') process.exit(4);
      process.exit(0);
    });

  program
    .command('diff')
    .description(
      "Compare deux index (baseline / current), dérive le change set sémantique, " +
        'et liste les régressions consommateur (V2 §9).',
    )
    .requiredOption('--from <path>', 'Index baseline (.json)')
    .option('--to <path>', 'Index current. Défaut : ./.gaslens/index.json', './.gaslens/index.json')
    .option(
      '--severity-threshold <level>',
      'info | warn | break — seuil des findings émis',
      'warn',
    )
    .option('--format <fmt>', 'json | text', 'json')
    .action(async (opts: DiffCliOpts) => {
      const fromPath = resolve(opts.from);
      const toPath = resolve(opts.to);
      if (!existsSync(fromPath)) {
        process.stderr.write(`gaslens diff: baseline introuvable à ${fromPath}.\n`);
        process.exit(2);
      }
      if (!existsSync(toPath)) {
        process.stderr.write(
          `gaslens diff: current introuvable à ${toPath}. Lance 'gaslens scan' d'abord, ou passe --to.\n`,
        );
        process.exit(2);
      }
      let baseline: ProjectIndex;
      let current: ProjectIndex;
      try {
        baseline = JSON.parse(await readFile(fromPath, 'utf8')) as ProjectIndex;
        current = JSON.parse(await readFile(toPath, 'utf8')) as ProjectIndex;
      } catch (err) {
        process.stderr.write(`gaslens diff: index illisible — ${(err as Error).message}.\n`);
        process.exit(2);
      }
      const report = diffIndexes(baseline, current, {
        baselineLabel: opts.from,
        currentLabel: opts.to,
        severity_threshold: opts.severityThreshold as 'info' | 'warn' | 'break',
      });
      if (opts.format === 'text') {
        process.stdout.write(renderDiffText(report) + '\n');
      } else {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      }
      if (report.verdict === 'BREAK') process.exit(3);
      if (report.verdict === 'WARN') process.exit(4);
      process.exit(0);
    });

  program
    .command('check')
    .description(
      "Garde-fou anti-régression (V2 §9.2) : ré-indexe le projet courant, le compare à un index baseline, " +
        'et sort un verdict + exit code exploitable par un hook PostToolUse.',
    )
    .argument('[root]', 'Racine du projet à scanner. Défaut : cwd', '.')
    .requiredOption('--baseline <path>', 'Chemin vers index.json baseline')
    .option(
      '--fail-on <level>',
      'break | warn | never — seuil qui fait passer exit code à ≠ 0',
      'break',
    )
    .option(
      '--severity-threshold <level>',
      'info | warn | break — seuil des findings émis',
      'warn',
    )
    .option('--format <fmt>', 'json | text | hook', 'json')
    .option('--quiet-when-clean', "Silencieux (pas de stdout) si verdict=CLEAN", false)
    .action(async (root: string, opts: CheckCliOpts) => {
      const baselinePath = resolve(opts.baseline);
      if (!existsSync(baselinePath)) {
        process.stderr.write(`gaslens check: baseline introuvable à ${baselinePath}.\n`);
        process.exit(2);
      }
      let baseline: ProjectIndex;
      try {
        baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as ProjectIndex;
      } catch (err) {
        process.stderr.write(`gaslens check: baseline illisible — ${(err as Error).message}.\n`);
        process.exit(2);
      }
      try {
        const { report } = await runCheck({
          baseline,
          currentRoot: resolve(root),
          baselineLabel: opts.baseline,
          currentLabel: 'working-tree',
          severity_threshold: opts.severityThreshold as 'info' | 'warn' | 'break',
          fail_on: opts.failOn as 'break' | 'warn' | 'never',
        });
        const exit_code = exitCodeFor(report.verdict, opts.failOn as 'break' | 'warn' | 'never');
        if (report.verdict === 'CLEAN' && opts.quietWhenClean) {
          process.exit(exit_code);
        }
        if (opts.format === 'text') {
          process.stdout.write(renderDiffText(report) + '\n');
        } else if (opts.format === 'hook') {
          process.stdout.write(renderHookOutput(report) + '\n');
        } else {
          process.stdout.write(JSON.stringify(report, null, 2) + '\n');
        }
        process.exit(exit_code);
      } catch (err) {
        process.stderr.write(`gaslens check: erreur — ${(err as Error).message}.\n`);
        process.exit(2);
      }
    });

  program
    .command('hook')
    .description(
      "Implémentation du hook PostToolUse Claude Code (V2 §15). Lit le payload " +
        "JSON sur stdin, détecte le projet GAS depuis tool_input.file_path, " +
        "lance scan + check contre .gaslens/baseline.json, et écrit sur stdout " +
        "un JSON `{decision:'block', reason}` si la modif casse un consommateur.",
    )
    .requiredOption('--event <name>', 'Type d\'événement hook (seul `post-tool-use` est supporté)')
    .action(async (opts: HookCliOpts) => {
      if (opts.event !== 'post-tool-use') {
        process.stderr.write(
          `gaslens hook: --event '${opts.event}' inconnu. Supporté : post-tool-use.\n`,
        );
        process.exit(0);
      }
      const stdinJson = await readAllStdin();
      const outcome = await runHook({ stdinJson });
      switch (outcome.kind) {
        case 'skipped':
          // Silencieux pour ne pas polluer la session. On loggue en debug si besoin.
          process.exit(0);
          break;
        case 'clean':
          process.exit(0);
          break;
        case 'block':
          process.stdout.write(outcome.hookPayload);
          process.exit(0);
          break;
      }
    });

  program
    .command('emit-dts')
    .description(
      "Génère un fichier .d.ts pour `google.script.run` côté client (V2 §8.4). " +
        "Permet à tsc de vérifier la couture serveur→client : noms de fonctions, " +
        "signatures, et shape de retour passée aux successHandler.",
    )
    .option('--index-path <path>', 'Chemin vers index.json', './.gaslens/index.json')
    .option('--project <name>', "Cibler un projet précis dans un index workspace")
    .option('-o, --output <path>', "Fichier .d.ts de sortie ; sinon stdout")
    .option('--exposed-only', "Seulement les fonctions effectivement appelées par un client (par défaut : toutes les publiques)", false)
    .action(async (opts: EmitDtsCliOpts) => {
      const idxPath = resolve(opts.indexPath);
      if (!existsSync(idxPath)) {
        process.stderr.write(
          `gaslens emit-dts: index introuvable à ${idxPath}. Lance 'gaslens scan'.\n`,
        );
        process.exit(2);
      }
      let project: ProjectIndex;
      try {
        const raw = JSON.parse(await readFile(idxPath, 'utf8')) as
          | ProjectIndex
          | WorkspaceIndex;
        if (raw.kind === 'workspace') {
          const target = opts.project
            ? raw.projects.find((p) => p.project === opts.project)
            : raw.projects[0];
          if (!target) {
            process.stderr.write(
              `gaslens emit-dts: --project '${opts.project}' introuvable. Projets : ` +
                raw.projects.map((p) => p.project).join(', ') +
                '\n',
            );
            process.exit(2);
          }
          if (!opts.project && raw.projects.length > 1) {
            process.stderr.write(
              `gaslens emit-dts: workspace avec ${raw.projects.length} projets ; précise --project <nom> ` +
                `(défaut : '${target.project}' utilisé).\n`,
            );
          }
          project = target;
        } else {
          project = raw;
        }
      } catch (err) {
        process.stderr.write(
          `gaslens emit-dts: index illisible — ${(err as Error).message}.\n`,
        );
        process.exit(2);
      }
      const dts = emitDts(project, { include_all_public: !opts.exposedOnly });
      if (opts.output) {
        const outPath = resolve(opts.output);
        await mkdir(dirname(outPath), { recursive: true });
        await writeFile(outPath, dts, 'utf8');
        process.stderr.write(`gaslens emit-dts: → ${outPath}\n`);
      } else {
        process.stdout.write(dts);
      }
    });

  program
    .command('emit-contract-tests')
    .description(
      "Génère un harnais .gs (V2 §12.3) qui assert la shape de retour de chaque " +
        "fonction publique avec un contrat connu. À déployer dans un projet GAS " +
        "SANDBOX uniquement (effet de bord réel : emails, écritures, OAuth).",
    )
    .option('--index-path <path>', 'Chemin vers index.json', './.gaslens/index.json')
    .option('--project <name>', "Cibler un projet précis dans un index workspace")
    .option('-o, --output <path>', "Fichier .gs de sortie ; sinon stdout")
    .option('--include-all', "Inclut toutes les fonctions publiques (par défaut : seulement celles avec inferred_contract.return_shape)", false)
    .action(async (opts: EmitContractTestsCliOpts) => {
      const idxPath = resolve(opts.indexPath);
      if (!existsSync(idxPath)) {
        process.stderr.write(
          `gaslens emit-contract-tests: index introuvable à ${idxPath}. Lance 'gaslens scan'.\n`,
        );
        process.exit(2);
      }
      let project: ProjectIndex;
      try {
        const raw = JSON.parse(await readFile(idxPath, 'utf8')) as
          | ProjectIndex
          | WorkspaceIndex;
        if (raw.kind === 'workspace') {
          const target = opts.project
            ? raw.projects.find((p) => p.project === opts.project)
            : raw.projects[0];
          if (!target) {
            process.stderr.write(
              `gaslens emit-contract-tests: --project '${opts.project}' introuvable. Projets : ` +
                raw.projects.map((p) => p.project).join(', ') +
                '\n',
            );
            process.exit(2);
          }
          project = target;
        } else {
          project = raw;
        }
      } catch (err) {
        process.stderr.write(
          `gaslens emit-contract-tests: index illisible — ${(err as Error).message}.\n`,
        );
        process.exit(2);
      }
      const out = emitContractTests(project, {
        include_all_public: opts.includeAll,
      });
      if (opts.output) {
        const outPath = resolve(opts.output);
        await mkdir(dirname(outPath), { recursive: true });
        await writeFile(outPath, out, 'utf8');
        process.stderr.write(`gaslens emit-contract-tests: → ${outPath}\n`);
      } else {
        process.stdout.write(out);
      }
    });

  program
    .command('eval')
    .description(
      "Lance un dataset de tâches d'évaluation : pour chaque tâche, copie le " +
        "fixture, applique la mutation décrite, lance scan + check, et compare " +
        "le verdict + les breaks aux attentes (V1 §5, V2 §17 étape 15).",
    )
    .argument('[dataset-dir]', "Dossier contenant les .json de tâches", './eval/tasks')
    .option('--base-dir <path>', "Racine résolue pour les chemins 'fixture' des tâches", '.')
    .option('--format <fmt>', 'json | text', 'text')
    .option('--fail-threshold <pct>', "Pourcentage minimum à atteindre pour exit 0 (défaut: 100)", '100')
    .action(async (datasetDir: string, opts: EvalCliOpts) => {
      const dir = resolve(datasetDir);
      const baseDir = resolve(opts.baseDir);
      let tasks;
      try {
        tasks = await loadEvalDataset(dir);
      } catch (err) {
        process.stderr.write(`gaslens eval: ${(err as Error).message}\n`);
        process.exit(2);
      }
      if (tasks.length === 0) {
        process.stderr.write(`gaslens eval: aucun .json de tâche trouvé dans ${dir}\n`);
        process.exit(2);
      }
      const report = await runEval(tasks, baseDir);
      if (opts.format === 'json') {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      } else {
        process.stdout.write(renderEvalReportText(report) + '\n');
      }
      const threshold = Number.parseFloat(opts.failThreshold) / 100;
      if (report.detection_rate < threshold) process.exit(1);
      process.exit(0);
    });

  program
    .command('init')
    .description(
      "Imprime les blocs prêts à coller pour câbler le hook PostToolUse " +
        "(CLAUDE.md racine + .claude/settings.json + guide pas-à-pas). V2 §16.",
    )
    .option('--section <name>', "Sélectionne une section : guide | claude-md | settings-json | subrepo:<name>", 'guide')
    .action(async (opts: InitCliOpts) => {
      const s = opts.section;
      if (s === 'guide') {
        process.stdout.write(SETUP_GUIDE);
        return;
      }
      if (s === 'claude-md') {
        process.stdout.write(CLAUDE_MD_ROOT);
        return;
      }
      if (s === 'settings-json') {
        process.stdout.write(CLAUDE_SETTINGS_JSON);
        return;
      }
      if (s.startsWith('subrepo:')) {
        const name = s.slice('subrepo:'.length).trim() || '<NomProjet>';
        process.stdout.write(claudeMdSubrepo(name));
        return;
      }
      process.stderr.write(
        `gaslens init: --section inconnue ('${s}'). Attendu : guide | claude-md | settings-json | subrepo:<nom>.\n`,
      );
      process.exit(2);
    });

  await program.parseAsync(argv);
}

interface HookCliOpts {
  event: string;
}

interface InitCliOpts {
  section: string;
}

async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

interface EmitDtsCliOpts {
  indexPath: string;
  project?: string;
  output?: string;
  exposedOnly: boolean;
}

interface EvalCliOpts {
  baseDir: string;
  format: string;
  failThreshold: string;
}

interface EmitContractTestsCliOpts {
  indexPath: string;
  project?: string;
  output?: string;
  includeAll: boolean;
}

interface DiffCliOpts {
  from: string;
  to: string;
  severityThreshold: string;
  format: string;
}

interface CheckCliOpts {
  baseline: string;
  failOn: string;
  severityThreshold: string;
  format: string;
  quietWhenClean: boolean;
}

function renderDiffText(r: {
  verdict: string;
  summary: string;
  baseline_label: string;
  current_label: string;
  derived_change_set: Array<{ delta: string; detail: string }>;
  breaks: Array<{ consumer: { file: string; line: number }; reason: string; fix_hint?: string }>;
  warns: Array<{ consumer: { file: string; line: number }; reason: string }>;
}): string {
  const lines: string[] = [];
  lines.push(`${r.verdict}  ${r.baseline_label} → ${r.current_label}`);
  lines.push(r.summary);
  if (r.derived_change_set.length) {
    lines.push('change set:');
    for (const c of r.derived_change_set) lines.push(`  - ${c.delta} : ${c.detail}`);
  }
  for (const b of r.breaks) {
    lines.push(`  BREAK  ${b.consumer.file}:${b.consumer.line}  ${b.reason}`);
    if (b.fix_hint) lines.push(`         fix: ${b.fix_hint}`);
  }
  for (const w of r.warns) {
    lines.push(`  WARN   ${w.consumer.file}:${w.consumer.line}  ${w.reason}`);
  }
  return lines.join('\n');
}

function renderHookOutput(r: {
  verdict: string;
  summary: string;
  breaks: Array<{ consumer: { file: string; line: number }; reason: string; fix_hint?: string }>;
}): string {
  if (r.verdict !== 'BREAK') return '';
  const lines: string[] = [
    `[gaslens] ${r.summary}`,
    ...r.breaks.map(
      (b) => `  - ${b.consumer.file}:${b.consumer.line} — ${b.reason}` +
        (b.fix_hint ? ` (fix: ${b.fix_hint})` : ''),
    ),
  ];
  const reason = lines.join('\n');
  return JSON.stringify({
    decision: 'block',
    reason,
    suppressOutput: true,
  });
}

interface ImpactCliOpts {
  change: string;
  severityThreshold: string;
  indexPath: string;
  project?: string;
  format: string;
}

function renderImpactText(r: {
  symbol: string;
  proposed_change: string;
  verdict: string;
  summary: string;
  breaks: Array<{ severity: string; consumer: { file: string; line: number }; reason: string; fix_hint?: string }>;
  warns: Array<{ severity: string; consumer: { file: string; line: number }; reason: string; fix_hint?: string }>;
}): string {
  const lines: string[] = [];
  lines.push(`${r.verdict}  ${r.symbol}  [${r.proposed_change}]`);
  lines.push(r.summary);
  for (const b of r.breaks) {
    lines.push(`  BREAK  ${b.consumer.file}:${b.consumer.line}  ${b.reason}`);
    if (b.fix_hint) lines.push(`         fix: ${b.fix_hint}`);
  }
  for (const w of r.warns) {
    lines.push(`  WARN   ${w.consumer.file}:${w.consumer.line}  ${w.reason}`);
  }
  return lines.join('\n');
}

interface ScanOpts {
  output?: string;
  stdout?: boolean;
  format: 'json' | 'ndjson';
}

interface InspectCliOpts {
  detailLevel: string;
  include: string;
  maxCallers: string;
  coverageDetail: string;
  fuzzy: boolean;
  indexPath: string;
  project?: string;
  format: string;
}

interface MapCliOpts {
  indexPath: string;
  project?: string;
  format: string;
}

interface ManifestCliOpts {
  indexPath: string;
  project?: string;
  severityThreshold: string;
  format: string;
}

function pickManifestTargets(
  raw: ProjectIndex | WorkspaceIndex,
  projectFilter: string | undefined,
): ProjectIndex[] {
  if (raw.kind !== 'workspace') {
    if (projectFilter && raw.project !== projectFilter) return [];
    return [raw];
  }
  if (projectFilter) {
    const found = raw.projects.find((p) => p.project === projectFilter);
    return found ? [found] : [];
  }
  return raw.projects;
}

function parseManifestThreshold(v: string): number {
  if (v === 'info') return 0;
  if (v === 'warn') return 1;
  if (v === 'break') return 2;
  throw new Error(`--severity-threshold doit être info|warn|break (reçu '${v}')`);
}

function severityRank(s: 'info' | 'warn' | 'break'): number {
  if (s === 'info') return 0;
  if (s === 'warn') return 1;
  return 2;
}

type PickResult =
  | { kind: 'ok'; project: ProjectIndex }
  | { kind: 'error'; message: string; code: number };

function pickProjectFromIndex(
  raw: ProjectIndex | WorkspaceIndex,
  fnName: string,
  projectFilter?: string,
): PickResult {
  if (raw.kind !== 'workspace') {
    return { kind: 'ok', project: raw };
  }
  const workspace = raw;
  if (projectFilter) {
    const p = workspace.projects.find((p) => p.project === projectFilter);
    if (!p) {
      return {
        kind: 'error',
        code: 2,
        message:
          `--project '${projectFilter}' introuvable. Projets : ` +
          workspace.projects.map((p) => p.project).join(', '),
      };
    }
    return { kind: 'ok', project: p };
  }
  const candidates = workspace.projects.filter((p) =>
    p.functions.some((f) => f.name === fnName),
  );
  if (candidates.length === 0) {
    // Renvoie le premier projet ; inspect émettra son not_found classique.
    return { kind: 'ok', project: workspace.projects[0]! };
  }
  if (candidates.length === 1) {
    return { kind: 'ok', project: candidates[0]! };
  }
  return {
    kind: 'error',
    code: 1,
    message:
      `'${fnName}' existe dans plusieurs projets : ${candidates
        .map((p) => p.project)
        .join(', ')}. Précise avec --project <nom>.`,
  };
}

function parseDetailLevel(v: string): DetailLevel {
  if (v === 'summary' || v === 'standard' || v === 'full' || v === 'graph') return v;
  throw new Error(
    `--detail-level doit être summary|standard|full|graph (reçu : '${v}')`,
  );
}

function parseInclude(v: string): IncludeField[] {
  if (!v.trim()) return [];
  const tokens = v.split(',').map((s) => s.trim()).filter(Boolean);
  const valid = new Set<IncludeField>([
    'callers',
    'callees',
    'contract',
    'exposures',
    'coverage',
    'definition',
    'patterns',
    'all',
  ]);
  for (const t of tokens) {
    if (!valid.has(t as IncludeField)) {
      throw new Error(
        `--include : champ inconnu '${t}' (attendus : ${[...valid].join(', ')})`,
      );
    }
  }
  return tokens as IncludeField[];
}

function parseCoverageDetail(v: string): CoverageDetail {
  if (v === 'none' || v === 'summary' || v === 'full') return v;
  throw new Error(`--coverage-detail doit être none|summary|full (reçu : '${v}')`);
}

function renderTextPayload(p: ReturnType<typeof inspect> extends infer R
  ? R extends { kind: 'found'; payload: infer P } ? P : never
  : never): string {
  const lines: string[] = [];
  lines.push(`${p.signature}   [${p.id}]`);
  if (p.exposures && p.exposures.length > 0) {
    lines.push(`expositions:`);
    for (const e of p.exposures) {
      const handler =
        e.success_handler ? ` ok=${e.success_handler.name}` : '';
      const fail = e.failure_handler ? ` err=${e.failure_handler.name}` : '';
      lines.push(`  - ${e.type} @ ${e.file}:${e.line}${handler}${fail}${e.detail ? ` (${e.detail})` : ''}`);
    }
  }
  if (p.callers) {
    lines.push(`callers (${p.callers.shown}/${p.callers.total}):`);
    for (const c of p.callers.items) {
      const file = c.caller_project ? `${c.caller_project}/${c.file}` : c.file;
      lines.push(`  - ${c.caller} @ ${file}:${c.line}  args=[${c.arguments_text.join(', ')}]  ${c.return_used_as ?? ''}`);
    }
  }
  if (p.callees && p.callees.length > 0) {
    lines.push(`calls_out: ${p.callees.join(', ')}`);
  }
  if (p.contract) {
    lines.push(`contract: params=${JSON.stringify(p.contract.params)}  returns=${JSON.stringify(p.contract.returns)}  source=${p.contract.source}`);
  }
  if (p.coverage) {
    lines.push(`coverage: ${JSON.stringify(p.coverage)}`);
  }
  return lines.join('\n');
}
