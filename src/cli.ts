import { Command } from 'commander';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
  GASLENS_SKILL_MD,
  SETUP_GUIDE,
  claudeMdSubrepo,
} from './init.js';
import { emitDts } from './emit-dts.js';
import { emitContractTests } from './emit-contract-tests.js';
import { loadEvalDataset, runEval, renderEvalReportText } from './eval.js';
import { buildMap, renderMapText } from './map.js';
import { analyzeManifest, renderManifestText } from './manifest-analysis.js';
import { validateApi, renderApiValidationText } from './validate-api.js';
import { lintRuntime, renderLintRuntimeText } from './lint-runtime.js';
import { lintWebapp, renderLintWebappText } from './lint-webapp.js';
import {
  analyzeLiveLibraries,
  renderResolveLiveText,
} from './resolve-live.js';
import { analyzeProdTruth, renderProdTruthText } from './prod-truth.js';
import { warnIfStale } from './stale-check.js';
import type { ProjectIndex, WorkspaceIndex } from './types.js';

/** JSON output : pretty (indent 2) ou compact selon --compact. */
function jsonOut(value: unknown, compact: boolean): string {
  return compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
}

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
    .option('--bench', "Imprime le breakdown des timings sur stderr", false)
    .option(
      '--incremental [baseline]',
      "Mode incrémental — si aucune source n'a changé depuis le baseline, " +
        'retourne le baseline. Défaut : <root>/.gaslens/baseline.json',
    )
    .action(async (path: string, opts: ScanOpts) => {
      try {
        const root = resolve(path);
        let incrementalBaseline: ProjectIndex | WorkspaceIndex | undefined;
        if (opts.incremental !== undefined) {
          const baselinePath = resolve(
            typeof opts.incremental === 'string'
              ? opts.incremental
              : join(root, '.gaslens', 'baseline.json'),
          );
          if (existsSync(baselinePath)) {
            try {
              incrementalBaseline = JSON.parse(
                await readFile(baselinePath, 'utf8'),
              ) as ProjectIndex | WorkspaceIndex;
            } catch (err) {
              process.stderr.write(
                `gaslens scan: --incremental baseline illisible (${(err as Error).message}). Scan complet.\n`,
              );
            }
          } else if (typeof opts.incremental === 'string') {
            process.stderr.write(
              `gaslens scan: --incremental baseline introuvable à ${baselinePath}. Scan complet.\n`,
            );
          }
        }
        const idx = await scanWorkspace({
          root,
          incrementalBaseline,
          onIncrementalHit: opts.bench
            ? (info) =>
                process.stderr.write(
                  `gaslens scan: incremental fast-path (${info.reason}, ${info.files_count} files unchanged)\n`,
                )
            : undefined,
          onBench: opts.bench
            ? (b) => {
                process.stderr.write(
                  `gaslens scan bench: total=${b.total_ms}ms ` +
                    `(read=${b.read_files_ms}ms parse+extract=${b.parse_and_extract_ms}ms ` +
                    `rest=${b.rest_ms}ms ; ${b.files_count} files, ${b.functions_count} fns)\n`,
                );
              }
            : undefined,
        });

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
    .option('--compact', 'JSON sans indentation (économie tokens pour agent IA)', false)
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
      await warnIfStale(raw, idxPath);
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
        process.stdout.write(jsonOut(report, opts.compact) + '\n');
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
    .option('--compact', 'JSON sans indentation (économie tokens pour agent IA)', false)
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
      await warnIfStale(raw, idxPath);
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
        process.stdout.write(jsonOut({ verdict, projects: reports }, opts.compact) + '\n');
      }
      if (verdict === 'BREAK') process.exit(3);
      if (verdict === 'WARN') process.exit(4);
      process.exit(0);
    });

  program
    .command('validate-api')
    .description(
      "Valide les chaînes d'appels aux services GAS contre un registre curé " +
        "(V3 §21.2) : attrape les méthodes hallucinées (`getValuesAll` au lieu " +
        "de `getValues`) avec suggestions. Honnête sur les types non suivis.",
    )
    .option('--index-path <path>', 'Chemin vers index.json', './.gaslens/index.json')
    .option('--project <name>', "Cibler un seul projet d'un index workspace")
    .option('--format <fmt>', 'json | text', 'json')
    .option('--compact', 'JSON sans indentation (économie tokens pour agent IA)', false)
    .action(async (opts: ValidateApiCliOpts) => {
      const idxPath = resolve(opts.indexPath);
      if (!existsSync(idxPath)) {
        process.stderr.write(
          `gaslens validate-api: index introuvable à ${idxPath}. Lance 'gaslens scan'.\n`,
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
          `gaslens validate-api: index illisible — ${(err as Error).message}.\n`,
        );
        process.exit(2);
      }
      await warnIfStale(raw, idxPath);
      const targets = pickManifestTargets(raw, opts.project);
      if (targets.length === 0) {
        process.stderr.write(
          `gaslens validate-api: --project '${opts.project ?? ''}' introuvable.\n`,
        );
        process.exit(2);
      }
      const reports = targets.map((p) => validateApi(p));
      const verdict = reports.some((r) => r.verdict === 'BREAK')
        ? 'BREAK'
        : reports.some((r) => r.verdict === 'WARN')
          ? 'WARN'
          : 'CLEAN';
      if (opts.format === 'text') {
        for (const r of reports) {
          process.stdout.write(renderApiValidationText(r) + '\n');
        }
      } else {
        process.stdout.write(jsonOut({ verdict, projects: reports }, opts.compact) + '\n');
      }
      if (verdict === 'BREAK') process.exit(3);
      if (verdict === 'WARN') process.exit(4);
      process.exit(0);
    });

  program
    .command('lint-runtime')
    .description(
      "Lint heuristique GAS-aware (V3 §21.3) : quota.value_in_loop, " +
        "urlfetch.in_loop, lock.no_finally, trigger.orphan. " +
        "Sortie en WARN/INFO uniquement — jamais BREAK (le `break` reste " +
        "réservé aux régressions structurelles).",
    )
    .option('--index-path <path>', 'Chemin vers index.json', './.gaslens/index.json')
    .option('--project <name>', "Cibler un seul projet d'un index workspace")
    .option('--format <fmt>', 'json | text', 'json')
    .option('--compact', 'JSON sans indentation (économie tokens pour agent IA)', false)
    .action(async (opts: LintRuntimeCliOpts) => {
      const idxPath = resolve(opts.indexPath);
      if (!existsSync(idxPath)) {
        process.stderr.write(
          `gaslens lint-runtime: index introuvable à ${idxPath}. Lance 'gaslens scan'.\n`,
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
          `gaslens lint-runtime: index illisible — ${(err as Error).message}.\n`,
        );
        process.exit(2);
      }
      await warnIfStale(raw, idxPath);
      const targets = pickManifestTargets(raw, opts.project);
      if (targets.length === 0) {
        process.stderr.write(
          `gaslens lint-runtime: --project '${opts.project ?? ''}' introuvable.\n`,
        );
        process.exit(2);
      }
      const reports = targets.map((p) => lintRuntime(p));
      const verdict = reports.some((r) => r.verdict === 'BREAK')
        ? 'BREAK'
        : reports.some((r) => r.verdict === 'WARN')
          ? 'WARN'
          : 'CLEAN';
      if (opts.format === 'text') {
        for (const r of reports) {
          process.stdout.write(renderLintRuntimeText(r) + '\n');
        }
      } else {
        process.stdout.write(jsonOut({ verdict, projects: reports }, opts.compact) + '\n');
      }
      if (verdict === 'BREAK') process.exit(3);
      if (verdict === 'WARN') process.exit(4);
      process.exit(0);
    });

  program
    .command('lint-webapp')
    .description(
      "Lint des HTML servis par la web app GAS (V3 §21.4) : mixed_content " +
        "(http:// dans HTTPS sandbox), link_target (<a> sans target=\"_top\"), " +
        "form_submit (<form> sans preventDefault). Bugs qui ne se voient " +
        "qu'après déploiement — WARN, confidence medium/high.",
    )
    .option('--index-path <path>', 'Chemin vers index.json', './.gaslens/index.json')
    .option('--project <name>', "Cibler un seul projet d'un index workspace")
    .option('--format <fmt>', 'json | text', 'json')
    .option('--compact', 'JSON sans indentation (économie tokens pour agent IA)', false)
    .action(async (opts: LintWebappCliOpts) => {
      const idxPath = resolve(opts.indexPath);
      if (!existsSync(idxPath)) {
        process.stderr.write(
          `gaslens lint-webapp: index introuvable à ${idxPath}. Lance 'gaslens scan'.\n`,
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
          `gaslens lint-webapp: index illisible — ${(err as Error).message}.\n`,
        );
        process.exit(2);
      }
      await warnIfStale(raw, idxPath);
      const targets = pickManifestTargets(raw, opts.project);
      if (targets.length === 0) {
        process.stderr.write(
          `gaslens lint-webapp: --project '${opts.project ?? ''}' introuvable.\n`,
        );
        process.exit(2);
      }
      const reports = targets.map((p) => lintWebapp(p));
      const verdict = reports.some((r) => r.verdict === 'BREAK')
        ? 'BREAK'
        : reports.some((r) => r.verdict === 'WARN')
          ? 'WARN'
          : 'CLEAN';
      if (opts.format === 'text') {
        for (const r of reports) {
          process.stdout.write(renderLintWebappText(r) + '\n');
        }
      } else {
        process.stdout.write(jsonOut({ verdict, projects: reports }, opts.compact) + '\n');
      }
      if (verdict === 'BREAK') process.exit(3);
      if (verdict === 'WARN') process.exit(4);
      process.exit(0);
    });

  program
    .command('resolve-live')
    .description(
      "Inventaire honnête des dépendances de librairies (V3 §22.1) : croise " +
        "manifest.libraries × workspace × receiver_usage et classe chaque lib " +
        "en local / external_unfetched / external_resolved / external_unresolvable " +
        "/ declared_unused. Optionnel, hors hook chaud. Par défaut : audit local " +
        "+ cache disque (les libs déjà cachées sont servies sans réseau). Avec " +
        "--use-apps-script-api : récupère la source via projects.getContent " +
        "(ADC requis ; phase 2). --enrich-output produit un WorkspaceIndex enrichi " +
        "intégrant les libs récupérées comme projets (phase 3).",
    )
    .option('--index-path <path>', 'Chemin vers index.json', './.gaslens/index.json')
    .option('--project <name>', "Filtrer le rapport sur un projet du workspace")
    .option(
      '--use-apps-script-api',
      "Active le fetcher Apps Script API (ADC requis : `gcloud auth application-default login`). " +
        "Strictement hors hook chaud — V3 §22.1 phase 2.",
      false,
    )
    .option(
      '--cache-dir <path>',
      "Racine du cache disque des sources de libs. Défaut : <dossier-index>/lib-cache.",
    )
    .option('--no-cache', "Désactive le cache disque (lecture ET écriture).")
    .option(
      '--refresh',
      "Force le re-fetch et écrase les entrées du cache disque.",
      false,
    )
    .option(
      '--enrich-output <path>',
      "Écrit un WorkspaceIndex enrichi des libs récupérées (V3 §22.1 phase 3).",
    )
    .option('--format <fmt>', 'json | text', 'json')
    .option('--compact', 'JSON sans indentation (économie tokens pour agent IA)', false)
    .action(async (opts: ResolveLiveCliOpts) => {
      const idxPath = resolve(opts.indexPath);
      if (!existsSync(idxPath)) {
        process.stderr.write(
          `gaslens resolve-live: index introuvable à ${idxPath}. Lance 'gaslens scan'.\n`,
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
          `gaslens resolve-live: index illisible — ${(err as Error).message}.\n`,
        );
        process.exit(2);
      }
      await warnIfStale(raw, idxPath);
      // Branchement du fetcher : NoopFetcher par défaut, AppsScriptApiFetcher
      // si --use-apps-script-api. Import dynamique pour ne pas charger
      // google-auth-library tant qu'on ne l'utilise pas.
      let innerFetcher: import('./resolve-live.js').LibraryFetcher | null = null;
      if (opts.useAppsScriptApi) {
        try {
          const mod = await import('./fetchers/apps-script-api.js');
          innerFetcher = await mod.createAppsScriptApiFetcher();
        } catch (err) {
          process.stderr.write(
            `gaslens resolve-live: impossible d'initialiser le fetcher Apps Script API — ` +
              `${(err as Error).message}\n`,
          );
          process.exit(2);
        }
      }
      // Cache disque : activé par défaut. Wrap le fetcher inner (ou agit seul
      // en lecture si pas de --use-apps-script-api). Cohérent avec la doctrine
      // V3 §22 : "audit local" sert d'abord ce qui est déjà connu.
      const cacheDir = resolve(
        opts.cacheDir ?? join(dirname(idxPath), 'lib-cache'),
      );
      let fetcher: import('./resolve-live.js').LibraryFetcher | undefined;
      if (opts.cache === false) {
        fetcher = innerFetcher ?? undefined;
      } else {
        const { createDiskCachedFetcher } = await import(
          './fetchers/lib-cache.js'
        );
        fetcher = createDiskCachedFetcher(innerFetcher, {
          cacheDir,
          refresh: opts.refresh,
        });
      }
      // On passe l'index entier à l'analyseur (le workspace est nécessaire
      // pour détecter le statut `local`). Le filtre --project se fait après.
      const report = await analyzeLiveLibraries(raw, fetcher);

      // Enrichissement workspace si demandé (V3 §22.1 phase 3).
      let enriched_output_path: string | undefined;
      if (opts.enrichOutput) {
        if (!report.fetched_sources || report.fetched_sources.length === 0) {
          process.stderr.write(
            `gaslens resolve-live: --enrich-output ignoré — aucune librairie récupérée ` +
              `(fetcher noop, cache vide, ou toutes les libs sont 'local' / 'declared_unused').\n`,
          );
        } else if (opts.cache === false) {
          process.stderr.write(
            `gaslens resolve-live: --enrich-output requiert le cache disque ` +
              `(sans cache, les sources fetchées ne sont pas matérialisées).\n`,
          );
          process.exit(2);
        } else {
          const { enrichWorkspaceWithLibraries } = await import(
            './enrich-workspace.js'
          );
          const enriched = await enrichWorkspaceWithLibraries(raw, {
            cacheDir,
            fetched_sources: report.fetched_sources,
          });
          const outPath = resolve(opts.enrichOutput);
          await mkdir(dirname(outPath), { recursive: true });
          await writeFile(
            outPath,
            jsonOut(enriched, opts.compact) + '\n',
            'utf8',
          );
          enriched_output_path = outPath;
          process.stderr.write(
            `gaslens resolve-live: workspace enrichi (${enriched.projects.length} projets, ` +
              `${enriched.cross_project_edges.length} edges) → ${outPath}\n`,
          );
        }
      }

      const libraries = opts.project
        ? report.libraries.filter((l) => l.project === opts.project)
        : report.libraries;
      if (opts.project && libraries.length === 0) {
        process.stderr.write(
          `gaslens resolve-live: --project '${opts.project}' n'a aucune librairie déclarée.\n`,
        );
      }
      const filtered = {
        ...report,
        libraries,
        ...(enriched_output_path ? { enriched_output_path } : {}),
      };
      if (opts.format === 'text') {
        process.stdout.write(renderResolveLiveText(filtered) + '\n');
      } else {
        process.stdout.write(jsonOut(filtered, opts.compact) + '\n');
      }
      process.exit(0);
    });

  program
    .command('prod-truth')
    .description(
      "Annote les fonctions avec la vérité d'exécution (V3 §22.2) : croise " +
        "les expositions statiques avec les métriques prod (executions, error_rate) " +
        "pour distinguer confirmed_dead / dispatched_dynamic / cold_exposed / errored / live. " +
        "Consultatif, jamais bloquant. Par défaut, MetricsProvider no-op → tout en `unknown` " +
        "(la commande sert alors d'inventaire de la surface à enrichir).",
    )
    .option('--index-path <path>', 'Chemin vers index.json', './.gaslens/index.json')
    .option('--project <name>', "Filtrer le rapport sur un projet du workspace")
    .option('--window-days <n>', "Fenêtre d'agrégation (jours)", '30')
    .option(
      '--error-rate-threshold <p>',
      "Seuil 0..1 au-dessus duquel 'errored' est levé",
      '0.05',
    )
    .option('--format <fmt>', 'json | text', 'json')
    .option('--compact', 'JSON sans indentation (économie tokens pour agent IA)', false)
    .action(async (opts: ProdTruthCliOpts) => {
      const idxPath = resolve(opts.indexPath);
      if (!existsSync(idxPath)) {
        process.stderr.write(
          `gaslens prod-truth: index introuvable à ${idxPath}. Lance 'gaslens scan'.\n`,
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
          `gaslens prod-truth: index illisible — ${(err as Error).message}.\n`,
        );
        process.exit(2);
      }
      await warnIfStale(raw, idxPath);
      const window_days = parsePositiveInt(opts.windowDays, '--window-days');
      const error_rate_threshold = parseUnitFloat(
        opts.errorRateThreshold,
        '--error-rate-threshold',
      );
      const report = await analyzeProdTruth(raw, undefined, {
        window_days,
        error_rate_threshold,
      });
      const entries = opts.project
        ? report.entries.filter((e) => e.project === opts.project)
        : report.entries;
      if (opts.project && entries.length === 0) {
        process.stderr.write(
          `gaslens prod-truth: --project '${opts.project}' n'a aucune fonction indexée.\n`,
        );
      }
      const filtered = { ...report, entries };
      if (opts.format === 'text') {
        process.stdout.write(renderProdTruthText(filtered) + '\n');
      } else {
        process.stdout.write(jsonOut(filtered, opts.compact) + '\n');
      }
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
    .option('--compact', 'JSON sans indentation (économie tokens pour agent IA)', false)
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
      let rawIndex: ProjectIndex | WorkspaceIndex;
      try {
        rawIndex = JSON.parse(await readFile(idxPath, 'utf8')) as
          | ProjectIndex
          | WorkspaceIndex;
        const picked = pickProjectFromIndex(rawIndex, functionName, opts.project);
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
      await warnIfStale(rawIndex, idxPath);

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
            jsonOut(
              {
                error: 'not_found',
                name: result.name,
                suggestions: result.suggestions,
                message: result.message,
              },
              opts.compact,
            ) + '\n',
          );
        }
        process.exit(1);
      }

      if (opts.format === 'text') {
        process.stdout.write(renderTextPayload(result.payload) + '\n');
      } else {
        process.stdout.write(jsonOut(result.payload, opts.compact) + '\n');
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
    .option('--compact', 'JSON sans indentation (économie tokens pour agent IA)', false)
    .action(async (functionName: string, opts: ImpactCliOpts) => {
      const idxPath = resolve(opts.indexPath);
      if (!existsSync(idxPath)) {
        process.stderr.write(
          `gaslens impact: index introuvable à ${idxPath}. Lance d'abord 'gaslens scan'.\n`,
        );
        process.exit(2);
      }
      let index: ProjectIndex;
      let rawImpact: ProjectIndex | WorkspaceIndex;
      try {
        rawImpact = JSON.parse(await readFile(idxPath, 'utf8')) as
          | ProjectIndex
          | WorkspaceIndex;
        const picked = pickProjectFromIndex(rawImpact, functionName, opts.project);
        if (picked.kind === 'error') {
          process.stderr.write(`gaslens impact: ${picked.message}\n`);
          process.exit(picked.code);
        }
        index = picked.project;
      } catch (err) {
        process.stderr.write(`gaslens impact: index illisible — ${(err as Error).message}.\n`);
        process.exit(2);
      }
      await warnIfStale(rawImpact, idxPath);
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
        process.stdout.write(jsonOut(r.report, opts.compact) + '\n');
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
    .option('--compact', 'JSON sans indentation (économie tokens pour agent IA)', false)
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
        process.stdout.write(jsonOut(report, opts.compact) + '\n');
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
    .option('--compact', 'JSON sans indentation (économie tokens pour agent IA)', false)
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
          process.stdout.write(jsonOut(report, opts.compact) + '\n');
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
    .command('commands')
    .description(
      "Liste compacte (~150 tokens) de toutes les commandes. Idéal pour " +
        "qu'un agent IA découvre la surface de l'outil avant de l'utiliser.",
    )
    .option('--format <fmt>', 'json | text', 'json')
    .action((opts: CommandsCliOpts) => {
      if (opts.format === 'text') {
        const lines = COMMANDS_OVERVIEW.map((c) => `${c.name.padEnd(22)} ${c.tldr}`);
        process.stdout.write(lines.join('\n') + '\n');
      } else {
        process.stdout.write(JSON.stringify(COMMANDS_OVERVIEW) + '\n');
      }
    });

  program
    .command('init')
    .description(
      "Imprime (ou écrit avec --write) les recettes prêtes à coller : " +
        "CLAUDE.md racine, .claude/settings.json (hook PostToolUse), SKILL.md " +
        "Claude Code, guide pas-à-pas. V2 §16, V3 §24.",
    )
    .option('--section <name>', "Sélectionne une section : guide | claude-md | settings-json | skill | subrepo:<name>", 'guide')
    .option('--write', "Écrit le contenu dans le bon fichier au lieu de l'imprimer (jamais d'écrasement, --force pour outrepasser)", false)
    .option('--force', "Avec --write : autorise l'écrasement d'un fichier existant", false)
    .option('--root <path>', "Racine du repo pour --write. Défaut : cwd", '.')
    .action(async (opts: InitCliOpts) => {
      const s = opts.section;
      let payload: string;
      let writePath: string | null = null;
      if (s === 'guide') {
        payload = SETUP_GUIDE;
      } else if (s === 'claude-md') {
        payload = CLAUDE_MD_ROOT;
        writePath = 'CLAUDE.md';
      } else if (s === 'settings-json') {
        payload = CLAUDE_SETTINGS_JSON;
        writePath = '.claude/settings.json';
      } else if (s === 'skill') {
        payload = GASLENS_SKILL_MD;
        writePath = '.claude/skills/gaslens/SKILL.md';
      } else if (s.startsWith('subrepo:')) {
        const name = s.slice('subrepo:'.length).trim() || '<NomProjet>';
        payload = claudeMdSubrepo(name);
        writePath = `${name}/CLAUDE.md`;
      } else {
        process.stderr.write(
          `gaslens init: --section inconnue ('${s}'). Attendu : guide | claude-md | settings-json | skill | subrepo:<nom>.\n`,
        );
        process.exit(2);
      }

      if (!opts.write) {
        process.stdout.write(payload);
        return;
      }
      if (!writePath) {
        process.stderr.write(
          `gaslens init: --write n'est pas applicable à la section '${s}' (pas de fichier cible).\n`,
        );
        process.exit(2);
      }
      const full = resolve(opts.root, writePath);
      if (existsSync(full) && !opts.force) {
        process.stderr.write(
          `gaslens init: ${full} existe déjà. Relance avec --force pour écraser.\n`,
        );
        process.exit(2);
      }
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, payload, 'utf8');
      process.stderr.write(`gaslens init: → ${full}\n`);
    });

  await program.parseAsync(argv);
}

interface HookCliOpts {
  event: string;
}

interface InitCliOpts {
  section: string;
  write: boolean;
  force: boolean;
  root: string;
}

interface CommandsCliOpts {
  format: string;
}

interface CommandOverviewEntry {
  name: string;
  tldr: string;
  reads_index: boolean;
  emits_findings: boolean;
}

const COMMANDS_OVERVIEW: CommandOverviewEntry[] = [
  { name: 'scan <root>', tldr: "construit l'index ; --incremental [baseline] pour le fast-path", reads_index: false, emits_findings: false },
  { name: 'map', tldr: 'aperçu compact projet/workspace (~300 tokens)', reads_index: true, emits_findings: false },
  { name: 'inspect <fn>', tldr: 'signature/callers/contrat/coverage par fonction', reads_index: true, emits_findings: false },
  { name: 'impact <fn> --change', tldr: 'régressions potentielles d\'une mutation décrite', reads_index: true, emits_findings: true },
  { name: 'diff', tldr: 'compare deux index (--from/--to)', reads_index: true, emits_findings: true },
  { name: 'check --baseline', tldr: 'diff + manifest + API + lint runtime + lint webapp', reads_index: true, emits_findings: true },
  { name: 'manifest', tldr: 'code ↔ appsscript.json (libs/scopes/services/whitelist)', reads_index: true, emits_findings: true },
  { name: 'validate-api', tldr: 'méthodes GAS hallucinées + arity manquante', reads_index: true, emits_findings: true },
  { name: 'lint-runtime', tldr: 'quota/lock/trigger anti-patterns (warn/info)', reads_index: true, emits_findings: true },
  { name: 'lint-webapp', tldr: 'mixed_content / link_target / form_submit (warn)', reads_index: true, emits_findings: true },
  { name: 'resolve-live', tldr: 'inventaire libs + cache disque + enrich-workspace (--enrich-output) ; hors hook chaud', reads_index: true, emits_findings: false },
  { name: 'prod-truth', tldr: 'croise expositions × métriques prod (confirmed_dead / dispatched_dynamic / errored) ; hors hook chaud', reads_index: true, emits_findings: false },
  { name: 'emit-dts', tldr: '.d.ts pour google.script.run côté client', reads_index: true, emits_findings: false },
  { name: 'emit-contract-tests', tldr: 'harnais .gs de test de contrat (sandbox)', reads_index: true, emits_findings: false },
  { name: 'hook --event', tldr: 'implémentation du hook PostToolUse Claude Code', reads_index: false, emits_findings: true },
  { name: 'init', tldr: 'recettes CLAUDE.md / settings.json / SKILL.md', reads_index: false, emits_findings: false },
  { name: 'eval', tldr: 'rejoue le dataset de référence', reads_index: false, emits_findings: false },
  { name: 'commands', tldr: 'cette liste', reads_index: false, emits_findings: false },
];

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
  compact: boolean;
}

interface CheckCliOpts {
  baseline: string;
  failOn: string;
  severityThreshold: string;
  format: string;
  quietWhenClean: boolean;
  compact: boolean;
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
  compact: boolean;
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
  bench: boolean;
  /** undefined si --incremental absent ; true si présent sans path ; string si path donné. */
  incremental?: boolean | string;
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
  compact: boolean;
}

interface MapCliOpts {
  indexPath: string;
  project?: string;
  format: string;
  compact: boolean;
}

interface ManifestCliOpts {
  indexPath: string;
  project?: string;
  severityThreshold: string;
  format: string;
  compact: boolean;
}

interface ValidateApiCliOpts {
  indexPath: string;
  project?: string;
  format: string;
  compact: boolean;
}

interface LintRuntimeCliOpts {
  indexPath: string;
  project?: string;
  format: string;
  compact: boolean;
}

interface LintWebappCliOpts {
  indexPath: string;
  project?: string;
  format: string;
  compact: boolean;
}

interface ResolveLiveCliOpts {
  indexPath: string;
  project?: string;
  useAppsScriptApi: boolean;
  cacheDir?: string;
  /** commander injecte `false` quand --no-cache est posé ; `true` (défaut) sinon. */
  cache: boolean;
  refresh: boolean;
  enrichOutput?: string;
  format: string;
  compact: boolean;
}

interface ProdTruthCliOpts {
  indexPath: string;
  project?: string;
  windowDays: string;
  errorRateThreshold: string;
  format: string;
  compact: boolean;
}

function parsePositiveInt(v: string, flag: string): number {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${flag} doit être un entier > 0 (reçu '${v}')`);
  }
  return n;
}

function parseUnitFloat(v: string, flag: string): number {
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`${flag} doit être dans [0, 1] (reçu '${v}')`);
  }
  return n;
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
