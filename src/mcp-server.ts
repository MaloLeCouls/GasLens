import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { scanWorkspace } from './scanner.js';
import { inspect as inspectFn } from './inspect.js';
import { impact as impactFn, parseChangeSpec } from './impact.js';
import { diffIndexes } from './diff.js';
import {
  enrichWithManifestFindings,
  enrichWithApiFindings,
  enrichWithLintRuntimeFindings,
  enrichWithLintWebappFindings,
} from './check.js';
import { buildMap } from './map.js';
import type { ProjectIndex, WorkspaceIndex } from './types.js';

/**
 * MCP server pour gaslens (V3 §24).
 *
 * Doctrine : peu d'outils à fort impact (V1 Principe 1). On expose 4 outils
 * consolidés qui couvrent 95 % du flux agent — pas dix micro-getters.
 *   - gaslens_map     : table des matières d'un projet/workspace
 *   - gaslens_inspect : tout sur une fonction
 *   - gaslens_impact  : régressions d'une mutation décrite
 *   - gaslens_check   : verdict complet (diff + manifest + api + lint)
 *
 * Chaque outil :
 *   - prend `project_root` (chemin absolu vers la racine du projet ou workspace) ;
 *   - re-scanne le projet à chaque appel (cache hors scope V1) ;
 *   - renvoie un JSON structuré et compact (token-efficient).
 *
 * Transport stdio — démarré par bin/gaslens-mcp.js.
 */
export function createGaslensMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: 'gaslens',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.registerTool(
    'gaslens_map',
    {
      title: 'Carte du projet GAS',
      description:
        "Table des matières ultra-compacte d'un projet ou workspace Google Apps " +
        "Script : entry points web (doGet/doPost), triggers, fonctions exposées " +
        "au client via google.script.run, librairies consommées/exposées, " +
        "templates scriptlet. Idéal pour l'amorçage de session — utiliser AVANT " +
        "d'explorer les fichiers manuellement.",
      inputSchema: {
        project_root: z
          .string()
          .describe("Chemin absolu vers la racine du projet (ou du workspace multi-projets)"),
      },
    },
    async ({ project_root }) => {
      const idx = await scanWorkspace({ root: resolve(project_root) });
      const report = buildMap(idx);
      return jsonResult(report);
    },
  );

  server.registerTool(
    'gaslens_inspect',
    {
      title: 'Inspection détaillée d\'une fonction GAS',
      description:
        "Renvoie ce qu'il faut savoir sur une fonction avant de la modifier : " +
        "signature, expositions (doGet/triggers/google.script.run/scriptlets), " +
        "callers, callees, contrat de retour inféré (y compris les champs lus " +
        "côté client via successHandler), coverage. Utiliser AVANT d'éditer une " +
        "fonction serveur.",
      inputSchema: {
        project_root: z.string().describe("Chemin absolu vers la racine du projet"),
        function_name: z.string().describe("Nom de la fonction à inspecter"),
        detail_level: z
          .enum(['summary', 'standard', 'full', 'graph'])
          .default('standard')
          .describe("Niveau de détail. 'summary' minimal, 'full' tout, 'standard' un bon défaut"),
        fuzzy: z
          .boolean()
          .default(true)
          .describe("Si la fonction est introuvable, proposer les noms proches"),
      },
    },
    async ({ project_root, function_name, detail_level, fuzzy }) => {
      const idx = await scanWorkspace({ root: resolve(project_root) });
      const project = pickProject(idx, function_name);
      const result = inspectFn(project, function_name, {
        detailLevel: detail_level,
        include: [],
        maxCallers: 25,
        coverageDetail: 'summary',
        fuzzy: fuzzy ?? true,
      });
      if (result.kind === 'not_found') {
        return jsonResult({
          error: 'not_found',
          name: result.name,
          suggestions: result.suggestions,
          message: result.message,
        });
      }
      return jsonResult(result.payload);
    },
  );

  server.registerTool(
    'gaslens_impact',
    {
      title: "Analyse d'impact d'une mutation envisagée",
      description:
        "Décrit le changement envisagé sur une fonction et liste les régressions " +
        "potentielles confrontées aux callers, expositions, et contrat inféré. " +
        "Utiliser AVANT d'écrire la modif pour vérifier qu'elle n'est pas cassante.",
      inputSchema: {
        project_root: z.string().describe("Chemin absolu vers la racine du projet"),
        function_name: z.string().describe("Nom de la fonction concernée"),
        change: z
          .string()
          .describe(
            "Description du changement (DSL gaslens). Formats : " +
              "'change-return-shape:-msgId,+ok' | 'remove-param:name' | " +
              "'rename:newName' | 'rename-param:old=new'",
          ),
        severity_threshold: z
          .enum(['info', 'warn', 'break'])
          .default('warn')
          .describe("Seuil de sévérité des findings remontés"),
      },
    },
    async ({ project_root, function_name, change, severity_threshold }) => {
      const idx = await scanWorkspace({ root: resolve(project_root) });
      const project = pickProject(idx, function_name);
      const spec = parseChangeSpec(change);
      const r = impactFn(project, function_name, spec, {
        severity_threshold: severity_threshold ?? 'warn',
      });
      if (r.kind === 'not_found') {
        return jsonResult({ error: 'not_found', message: r.message });
      }
      return jsonResult(r.report);
    },
  );

  server.registerTool(
    'gaslens_check',
    {
      title: 'Vérification complète post-édition',
      description:
        "Re-scanne le projet, compare à un index baseline, et enrichit avec : " +
        "manifest (libs/scopes/services avancés/whitelist), validate-api " +
        "(méthodes hallucinées + arity + deprecated), lint-runtime (quota/lock/" +
        "trigger), lint-webapp (mixed_content/link_target/form_submit). " +
        "Verdict CLEAN | WARN | BREAK. Utiliser APRÈS édition.",
      inputSchema: {
        project_root: z.string().describe("Chemin absolu vers la racine du projet"),
        baseline_path: z
          .string()
          .optional()
          .describe(
            "Chemin vers l'index baseline. Défaut : <project_root>/.gaslens/baseline.json",
          ),
        severity_threshold: z
          .enum(['info', 'warn', 'break'])
          .default('warn')
          .describe("Seuil de sévérité des findings remontés"),
      },
    },
    async ({ project_root, baseline_path, severity_threshold }) => {
      const root = resolve(project_root);
      const baselineFile =
        baseline_path ?? join(root, '.gaslens', 'baseline.json');
      if (!existsSync(baselineFile)) {
        return jsonResult({
          error: 'no_baseline',
          message:
            `Aucun baseline à ${baselineFile}. Lance d'abord 'gaslens scan ${root} -o ${baselineFile}' ` +
            `pour le créer (depuis la CLI ou via un appel séparé).`,
        });
      }
      const baseline = JSON.parse(
        await readFile(baselineFile, 'utf8'),
      ) as ProjectIndex;
      const currentWs = await scanWorkspace({ root });
      const current = pickProjectByName(currentWs, baseline.project);
      const threshold = severity_threshold ?? 'warn';
      const base = diffIndexes(baseline, current, {
        baselineLabel: baselineFile,
        currentLabel: 'working-tree',
        severity_threshold: threshold,
      });
      const m = enrichWithManifestFindings(base, current, threshold);
      const a = enrichWithApiFindings(m, current, threshold);
      const r = enrichWithLintRuntimeFindings(a, current, threshold);
      const enriched = enrichWithLintWebappFindings(r, current, threshold);
      return jsonResult(enriched);
    },
  );

  return server;
}

function pickProject(
  idx: WorkspaceIndex | ProjectIndex,
  functionName: string,
): ProjectIndex {
  if (idx.kind !== 'workspace') return idx;
  const candidates = idx.projects.filter((p) =>
    p.functions.some((f) => f.name === functionName),
  );
  if (candidates.length === 1) return candidates[0]!;
  // Ambigu ou absent → renvoyer le premier projet ; les fonctions feront
  // remonter 'not_found' avec un message clair.
  return idx.projects[0]!;
}

function pickProjectByName(
  idx: WorkspaceIndex | ProjectIndex,
  name: string,
): ProjectIndex {
  if (idx.kind !== 'workspace') return idx;
  const p = idx.projects.find((p) => p.project === name);
  if (p) return p;
  return idx.projects[0]!;
}

function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(value),
      },
    ],
  };
}

/**
 * Démarre le serveur MCP sur stdio. Bloque jusqu'à fermeture de la connexion.
 */
export async function runGaslensMcpServer(): Promise<void> {
  const server = createGaslensMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void dirname; // bibliothèque conservée pour usages futurs
