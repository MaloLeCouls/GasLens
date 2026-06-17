import type { ProjectIndex, WorkspaceIndex } from './types.js';

/**
 * Conscience des déploiements (V3 §22.3). Cette commande dit à l'agent
 * **quelle version est servie en production** et par quels entry points, pour
 * qu'il sache que toucher `doGet` quand un déploiement web app est live est
 * critique et immédiat — alors que le même `doGet` en HEAD/dev peut être
 * modifié plus librement.
 *
 * Strictement consultatif, jamais bloquant. Doctrine V3 §22 — ne s'invite
 * jamais dans `check`/`hook`.
 */

/** Type d'entry point retourné par `projects.deployments.list`. */
export type EntryPointType =
  | 'WEB_APP'
  | 'EXECUTION_API'
  | 'ADD_ON'
  | 'UNKNOWN';

export interface EntryPoint {
  type: EntryPointType;
  /** Pour `WEB_APP` : URL exec/dev. Sinon null. */
  url: string | null;
  /** Pour `WEB_APP` : `USER_DEPLOYING` | `USER_ACCESSING` | null. */
  execute_as: string | null;
  /** Pour `WEB_APP` : `MYSELF` | `DOMAIN` | `ANYONE` | `ANYONE_ANONYMOUS` | null. */
  access: string | null;
  /** Pour `ADD_ON` : type d'add-on (`EDITOR_AUDIT`, `GMAIL`, etc.). */
  addon_type: string | null;
}

export interface Deployment {
  deployment_id: string;
  /** `null` = déploiement HEAD/dev (sans versionNumber attaché). */
  version_number: number | null;
  description: string | null;
  update_time: string | null;
  entry_points: EntryPoint[];
}

export interface VersionInfo {
  version_number: number;
  description: string | null;
  create_time: string | null;
}

/**
 * Provider abstrait pour récupérer déploiements et versions. Strictement
 * optionnel, hors hook chaud. Le default `NoopDeploymentsProvider` renvoie
 * `[]` — la commande devient un inventaire statique honnête (et l'agent voit
 * `unknown` partout, ce qui est juste).
 */
export interface DeploymentsProvider {
  listDeployments(scriptId: string): Promise<Deployment[]>;
  listVersions(scriptId: string): Promise<VersionInfo[]>;
}

export const NoopDeploymentsProvider: DeploymentsProvider = {
  async listDeployments() {
    return [];
  },
  async listVersions() {
    return [];
  },
};

/**
 * Statut de déploiement croisé statique × prod pour une fonction. Les
 * priorités quand plusieurs s'appliquent : `live_web_app` > `live_addon` >
 * `live_api` > `head_only` > `unknown` (la sévérité décroît).
 *
 * - `live_web_app` : la fonction est un entry point (`doGet`/`doPost`) ET
 *   le projet a au moins un déploiement web app avec versionNumber non null.
 *   Toucher cette fonction casse la web app servie EN CE MOMENT.
 * - `live_addon` : la fonction est un trigger add-on (`onOpen`/`onInstall`/…)
 *   ET un déploiement add-on est actif.
 * - `live_api` : un déploiement Execution API est actif et la fonction est
 *   publique (toutes les fonctions publiques sont potentiellement appelables
 *   via `scripts.run`).
 * - `head_only` : la fonction existe mais n'est ni entry point d'un
 *   déploiement live, ni couverte par un déploiement API ; HEAD/dev uniquement.
 * - `unknown` : provider non actif ou scriptId non résolu.
 */
export type DeploymentStatus =
  | 'live_web_app'
  | 'live_addon'
  | 'live_api'
  | 'head_only'
  | 'unknown';

export interface FunctionDeploymentAnnotation {
  project: string;
  function_name: string;
  deployment_status: DeploymentStatus;
  /** deploymentId(s) qui exposent ou peuvent appeler cette fonction. */
  served_by_deployments: string[];
  /** `entry_point` côté statique (doGet, doPost, onOpen…) si pertinent. */
  static_entry_point: string | null;
  /** Note courte ciblée à l'agent. */
  note: string;
}

export interface ProjectDeploymentSummary {
  project: string;
  script_id: string | null;
  /** Liste brute des déploiements (vide si pas de scriptId / provider noop). */
  deployments: Deployment[];
  /** Versions historiques (utile pour repérer une dérive). */
  versions: VersionInfo[];
  /**
   * Numéro de version le plus récemment publié (= `max(versions.versionNumber)`).
   * Si une dérive est détectée (un déploiement live pointe sur une version
   * antérieure), `version_drift` la liste.
   */
  latest_version_number: number | null;
  version_drift: Array<{
    deployment_id: string;
    served_version: number | null;
    latest_version: number;
    description: string;
  }>;
  /** Erreur provider (403, 404…) si la lecture a échoué pour ce projet. */
  fetch_error: string | null;
}

export interface DeployAwareReport {
  scanned_at: string;
  scope: 'project' | 'workspace';
  summary: {
    total_projects: number;
    projects_with_live_web_app: number;
    projects_with_live_api: number;
    projects_with_live_addon: number;
    projects_head_only: number;
    projects_unknown: number;
    functions_live_web_app: number;
    functions_live_api: number;
    functions_live_addon: number;
  };
  projects: ProjectDeploymentSummary[];
  function_annotations: FunctionDeploymentAnnotation[];
  /** Conseils actionnables (prêts à coller dans une session agent). */
  advice: string[];
}

export interface AnalyzeDeployAwareOpts {
  /**
   * Map projet → scriptId. Sans entrée pour un projet → on saute le provider
   * et marque tout en `unknown` pour ce projet.
   */
  script_id_by_project?: Map<string, string>;
}

const ADDON_TRIGGER_NAMES = new Set([
  'onOpen',
  'onInstall',
  'onEdit',
  'onSelectionChange',
  'onFormSubmit',
  'onChange',
  'doHomepage',
]);

const WEB_APP_ENTRY_POINTS = new Set(['doGet', 'doPost']);

export async function analyzeDeployments(
  idx: ProjectIndex | WorkspaceIndex,
  provider: DeploymentsProvider = NoopDeploymentsProvider,
  opts: AnalyzeDeployAwareOpts = {},
): Promise<DeployAwareReport> {
  const projects: ProjectIndex[] =
    idx.kind === 'workspace' ? idx.projects : [idx];
  const projectSummaries: ProjectDeploymentSummary[] = [];
  const annotations: FunctionDeploymentAnnotation[] = [];
  for (const p of projects) {
    const scriptId = opts.script_id_by_project?.get(p.project) ?? null;
    const summary = await loadProjectSummary(provider, p, scriptId);
    projectSummaries.push(summary);
    for (const fn of p.functions) {
      annotations.push(annotateFunction(p, fn.name, summary));
    }
  }

  const summary = buildSummary(projectSummaries, annotations);
  return {
    scanned_at: new Date().toISOString(),
    scope: idx.kind === 'workspace' ? 'workspace' : 'project',
    summary,
    projects: projectSummaries,
    function_annotations: annotations,
    advice: buildAdvice(projectSummaries, annotations, summary),
  };
}

async function loadProjectSummary(
  provider: DeploymentsProvider,
  p: ProjectIndex,
  scriptId: string | null,
): Promise<ProjectDeploymentSummary> {
  if (!scriptId) {
    return emptySummary(p.project, null, null);
  }
  let deployments: Deployment[] = [];
  let versions: VersionInfo[] = [];
  let fetch_error: string | null = null;
  try {
    deployments = await provider.listDeployments(scriptId);
  } catch (e) {
    fetch_error = e instanceof Error ? e.message : String(e);
  }
  if (fetch_error === null) {
    try {
      versions = await provider.listVersions(scriptId);
    } catch (e) {
      // Pas fatal : on garde les déploiements, on note l'erreur versions.
      fetch_error = e instanceof Error ? e.message : String(e);
    }
  }
  const latestVersion = versions.reduce<number | null>(
    (max, v) => (max === null || v.version_number > max ? v.version_number : max),
    null,
  );
  const drift: ProjectDeploymentSummary['version_drift'] = [];
  if (latestVersion !== null) {
    for (const d of deployments) {
      if (
        d.version_number !== null &&
        d.version_number < latestVersion &&
        d.entry_points.length > 0
      ) {
        drift.push({
          deployment_id: d.deployment_id,
          served_version: d.version_number,
          latest_version: latestVersion,
          description: d.description ?? '',
        });
      }
    }
  }
  return {
    project: p.project,
    script_id: scriptId,
    deployments,
    versions,
    latest_version_number: latestVersion,
    version_drift: drift,
    fetch_error,
  };
}

function emptySummary(
  project: string,
  scriptId: string | null,
  fetch_error: string | null,
): ProjectDeploymentSummary {
  return {
    project,
    script_id: scriptId,
    deployments: [],
    versions: [],
    latest_version_number: null,
    version_drift: [],
    fetch_error,
  };
}

function annotateFunction(
  p: ProjectIndex,
  fnName: string,
  summary: ProjectDeploymentSummary,
): FunctionDeploymentAnnotation {
  if (summary.script_id === null) {
    return {
      project: p.project,
      function_name: fnName,
      deployment_status: 'unknown',
      served_by_deployments: [],
      static_entry_point: detectStaticEntryPoint(fnName),
      note: 'scriptId inconnu — déploiement non analysé (renseigner --script-id ou .clasp.json).',
    };
  }
  if (summary.fetch_error) {
    return {
      project: p.project,
      function_name: fnName,
      deployment_status: 'unknown',
      served_by_deployments: [],
      static_entry_point: detectStaticEntryPoint(fnName),
      note: `provider en erreur (${summary.fetch_error}) — déploiement non analysé.`,
    };
  }
  // Trie les déploiements live par type (web app, addon, api).
  const liveWebAppDeployments = summary.deployments.filter((d) =>
    d.entry_points.some((e) => e.type === 'WEB_APP'),
  );
  const liveAddonDeployments = summary.deployments.filter((d) =>
    d.entry_points.some((e) => e.type === 'ADD_ON'),
  );
  const liveApiDeployments = summary.deployments.filter((d) =>
    d.entry_points.some((e) => e.type === 'EXECUTION_API'),
  );

  const staticEp = detectStaticEntryPoint(fnName);

  // Priorité décroissante : web_app > addon > api > head_only.
  if (WEB_APP_ENTRY_POINTS.has(fnName) && liveWebAppDeployments.length > 0) {
    return {
      project: p.project,
      function_name: fnName,
      deployment_status: 'live_web_app',
      served_by_deployments: liveWebAppDeployments.map((d) => d.deployment_id),
      static_entry_point: staticEp,
      note:
        `entry point web app servi par ${liveWebAppDeployments.length} déploiement(s) actif(s) — ` +
        `casser sa signature ou son contrat casse la web app EN CE MOMENT.`,
    };
  }
  if (ADDON_TRIGGER_NAMES.has(fnName) && liveAddonDeployments.length > 0) {
    return {
      project: p.project,
      function_name: fnName,
      deployment_status: 'live_addon',
      served_by_deployments: liveAddonDeployments.map((d) => d.deployment_id),
      static_entry_point: staticEp,
      note:
        `trigger add-on (${fnName}) actif — modifications visibles immédiatement par les utilisateurs.`,
    };
  }
  if (liveApiDeployments.length > 0) {
    const fn = p.functions.find((f) => f.name === fnName);
    if (fn && fn.definition.visibility === 'public') {
      return {
        project: p.project,
        function_name: fnName,
        deployment_status: 'live_api',
        served_by_deployments: liveApiDeployments.map((d) => d.deployment_id),
        static_entry_point: staticEp,
        note:
          `fonction publique potentiellement appelable via Execution API (scripts.run) — ` +
          `un client externe peut dépendre de sa signature.`,
      };
    }
  }
  return {
    project: p.project,
    function_name: fnName,
    deployment_status: 'head_only',
    served_by_deployments: [],
    static_entry_point: staticEp,
    note: 'HEAD/dev uniquement — modifications sans impact immédiat en prod.',
  };
}

function detectStaticEntryPoint(name: string): string | null {
  if (WEB_APP_ENTRY_POINTS.has(name)) return name;
  if (ADDON_TRIGGER_NAMES.has(name)) return name;
  return null;
}

function buildSummary(
  projects: ProjectDeploymentSummary[],
  annotations: FunctionDeploymentAnnotation[],
): DeployAwareReport['summary'] {
  const projects_with_live_web_app = projects.filter((p) =>
    p.deployments.some((d) => d.entry_points.some((e) => e.type === 'WEB_APP')),
  ).length;
  const projects_with_live_api = projects.filter((p) =>
    p.deployments.some((d) =>
      d.entry_points.some((e) => e.type === 'EXECUTION_API'),
    ),
  ).length;
  const projects_with_live_addon = projects.filter((p) =>
    p.deployments.some((d) => d.entry_points.some((e) => e.type === 'ADD_ON')),
  ).length;
  const projects_unknown = projects.filter(
    (p) => p.script_id === null || p.fetch_error !== null,
  ).length;
  const projects_head_only =
    projects.length -
    projects_unknown -
    Math.max(
      projects_with_live_web_app,
      projects_with_live_api,
      projects_with_live_addon,
    );
  return {
    total_projects: projects.length,
    projects_with_live_web_app,
    projects_with_live_api,
    projects_with_live_addon,
    projects_head_only: Math.max(0, projects_head_only),
    projects_unknown,
    functions_live_web_app: annotations.filter(
      (a) => a.deployment_status === 'live_web_app',
    ).length,
    functions_live_api: annotations.filter(
      (a) => a.deployment_status === 'live_api',
    ).length,
    functions_live_addon: annotations.filter(
      (a) => a.deployment_status === 'live_addon',
    ).length,
  };
}

function buildAdvice(
  projects: ProjectDeploymentSummary[],
  annotations: FunctionDeploymentAnnotation[],
  summary: DeployAwareReport['summary'],
): string[] {
  const out: string[] = [];
  if (summary.projects_unknown === summary.total_projects && summary.total_projects > 0) {
    out.push(
      'aucun déploiement remonté — brancher un DeploymentsProvider (Apps Script API `projects.deployments`, V3 §22.3, hors hook chaud) pour activer la conscience des déploiements.',
    );
    return out;
  }
  if (summary.functions_live_web_app > 0) {
    const names = annotations
      .filter((a) => a.deployment_status === 'live_web_app')
      .map((a) => `${a.project}::${a.function_name}`);
    out.push(
      `${summary.functions_live_web_app} fonction(s) servent une web app live : ${names.join(', ')}. ` +
        `Toute modification de signature/contrat est critique et immédiate.`,
    );
  }
  if (summary.functions_live_addon > 0) {
    const names = annotations
      .filter((a) => a.deployment_status === 'live_addon')
      .map((a) => `${a.project}::${a.function_name}`);
    out.push(
      `${summary.functions_live_addon} trigger(s) add-on actif(s) : ${names.join(', ')}. ` +
        `Les modifications sont visibles immédiatement par les utilisateurs de l'add-on.`,
    );
  }
  if (summary.functions_live_api > 0) {
    out.push(
      `${summary.functions_live_api} fonction(s) publique(s) potentiellement appelable(s) via Execution API. ` +
        `Préserver les signatures pour ne pas casser les clients externes.`,
    );
  }
  for (const p of projects) {
    if (p.version_drift.length > 0) {
      const items = p.version_drift
        .slice(0, 3)
        .map(
          (d) =>
            `${d.deployment_id} sert v${d.served_version} (latest=v${d.latest_version})`,
        );
      out.push(
        `[${p.project}] version drift : ${items.join('; ')}${p.version_drift.length > 3 ? '…' : ''}. ` +
          `Le déploiement live n'est pas à jour — l'agent peut éditer en HEAD sans impact immédiat sur la prod.`,
      );
    }
  }
  return out;
}

export function renderDeployAwareText(report: DeployAwareReport): string {
  const s = report.summary;
  const lines: string[] = [];
  lines.push(
    `deploy-aware  scope=${report.scope}  ` +
      `projects=${s.total_projects}  ` +
      `live_web_app=${s.projects_with_live_web_app}  live_api=${s.projects_with_live_api}  ` +
      `live_addon=${s.projects_with_live_addon}  head_only=${s.projects_head_only}  ` +
      `unknown=${s.projects_unknown}`,
  );
  for (const p of report.projects) {
    const tag = p.fetch_error
      ? `ERROR ${p.fetch_error}`
      : p.script_id === null
        ? 'scriptId inconnu'
        : `${p.deployments.length} deploy / ${p.versions.length} version(s)`;
    lines.push(`  [${p.project}]  ${tag}`);
    for (const d of p.deployments) {
      const types = d.entry_points
        .map((e) => (e.type === 'WEB_APP' && e.access ? `WEB_APP(${e.access})` : e.type))
        .join('+');
      const ver = d.version_number === null ? 'HEAD' : `v${d.version_number}`;
      lines.push(
        `        - ${d.deployment_id}  ${ver}  ${types}` +
          (d.description ? `  "${d.description}"` : ''),
      );
    }
    for (const dr of p.version_drift) {
      lines.push(
        `        ⚠ drift : ${dr.deployment_id} sert v${dr.served_version}, latest=v${dr.latest_version}`,
      );
    }
  }
  const interesting = report.function_annotations.filter(
    (a) =>
      a.deployment_status !== 'head_only' && a.deployment_status !== 'unknown',
  );
  if (interesting.length > 0) {
    lines.push('  fonctions live :');
    for (const a of interesting) {
      lines.push(
        `    [${a.project}]  ${a.deployment_status.padEnd(14)}  ${a.function_name}`,
      );
      lines.push(`        ${a.note}`);
    }
  }
  for (const a of report.advice) {
    lines.push(`  → ${a}`);
  }
  return lines.join('\n');
}
