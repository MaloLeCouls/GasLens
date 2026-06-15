import type {
  CrossProjectEdge,
  Exposure,
  FunctionRecord,
  PendingLibraryCall,
  ProjectIndex,
  WorkspaceIndex,
} from './types.js';

export interface EntryPointRef {
  function: string;
  kind: string;
  file: string;
  line: number;
}

export interface TriggerRef {
  function: string;
  kind: 'simple_trigger' | 'installable_trigger';
  file: string;
  line: number;
  detail: string | null;
}

export interface ClientExposedRef {
  function: string;
  call_sites: number;
  file: string;
  line: number;
}

export interface TemplateRef {
  template_file: string;
  bound_by: string[];
  fields_set: number;
  unread: number;
  read_but_not_set: number;
}

export interface LibraryConsumedRef {
  prefix: string;
  call_sites: number;
  resolved_in_workspace: boolean;
  resolved_callee_project: string | null;
}

export interface LibraryExposedRef {
  consumed_by_project: string;
  call_sites: number;
}

export interface ProjectMap {
  project: string;
  totals: {
    files: number;
    functions: number;
    public_functions: number;
    private_functions: number;
  };
  entry_points: EntryPointRef[];
  triggers: TriggerRef[];
  exposed_to_client: ClientExposedRef[];
  scriptlet_templates: TemplateRef[];
  libraries_consumed: LibraryConsumedRef[];
  /** Présent uniquement en mode workspace : qui consomme ce projet comme librairie. */
  libraries_exposed?: LibraryExposedRef[];
  coverage: {
    resolved_pct: number;
    confidence: 'high' | 'medium' | 'low';
    unresolved_count: number;
  };
}

export interface MapReport {
  kind: 'project_map' | 'workspace_map';
  generated_at: string;
  workspace_root?: string;
  cross_project_edges_count?: number;
  projects: ProjectMap[];
}

/**
 * Projette un ProjectIndex ou un WorkspaceIndex en une « table des matières »
 * compacte (V3 §21.5). Aucune donnée nouvelle : c'est une vue dérivée de l'index
 * pensée pour l'amorçage de session d'un agent.
 */
export function buildMap(index: ProjectIndex | WorkspaceIndex): MapReport {
  const generated_at = new Date().toISOString();
  if (index.kind === 'workspace') {
    const projects = index.projects.map((p) =>
      buildProjectMap(p, index.cross_project_edges),
    );
    return {
      kind: 'workspace_map',
      generated_at,
      workspace_root: index.workspace_root,
      cross_project_edges_count: index.cross_project_edges.length,
      projects,
    };
  }
  return {
    kind: 'project_map',
    generated_at,
    projects: [buildProjectMap(index, [])],
  };
}

function buildProjectMap(
  project: ProjectIndex,
  cross_project_edges: CrossProjectEdge[],
): ProjectMap {
  const entry_points: EntryPointRef[] = [];
  const triggers: TriggerRef[] = [];
  const exposed_to_client: ClientExposedRef[] = [];
  const templateAcc = new Map<
    string,
    { bound_by: Set<string>; fields_set: number; unread: number; read_but_not_set: number }
  >();

  let public_functions = 0;
  let private_functions = 0;

  for (const fn of project.functions) {
    if (fn.definition.visibility === 'public') public_functions += 1;
    else private_functions += 1;

    let client_call_sites = 0;
    for (const ex of fn.exposures) {
      switch (ex.type) {
        case 'entry_point_web':
          entry_points.push({
            function: fn.name,
            kind: ex.detail ?? fn.name,
            file: ex.file,
            line: ex.line,
          });
          break;
        case 'simple_trigger':
        case 'installable_trigger':
          triggers.push({
            function: fn.name,
            kind: ex.type,
            file: ex.file,
            line: ex.line,
            detail: ex.detail ?? null,
          });
          break;
        case 'client_call':
          client_call_sites += 1;
          break;
      }
    }
    if (client_call_sites > 0) {
      exposed_to_client.push({
        function: fn.name,
        call_sites: client_call_sites,
        file: fn.definition.file,
        line: fn.definition.line,
      });
    }
    for (const tb of fn.patterns.template_bindings) {
      const slot = templateAcc.get(tb.template_file) ?? {
        bound_by: new Set<string>(),
        fields_set: 0,
        unread: 0,
        read_but_not_set: 0,
      };
      slot.bound_by.add(fn.name);
      slot.fields_set += tb.data_fields_set.length;
      slot.unread += tb.unread_data_fields.length;
      slot.read_but_not_set += tb.read_but_not_set.length;
      templateAcc.set(tb.template_file, slot);
    }
  }

  entry_points.sort(stableExposureSort);
  triggers.sort(stableExposureSort);
  exposed_to_client.sort((a, b) => a.function.localeCompare(b.function));

  const scriptlet_templates: TemplateRef[] = [...templateAcc.entries()]
    .map(([template_file, slot]) => ({
      template_file,
      bound_by: [...slot.bound_by].sort(),
      fields_set: slot.fields_set,
      unread: slot.unread,
      read_but_not_set: slot.read_but_not_set,
    }))
    .sort((a, b) => a.template_file.localeCompare(b.template_file));

  const libraries_consumed = aggregateConsumedLibraries(
    project.pending_library_calls,
    project.project,
    cross_project_edges,
  );

  const libraries_exposed = computeLibrariesExposed(project.project, cross_project_edges);

  const projectMap: ProjectMap = {
    project: project.project,
    totals: {
      files: project.files.length,
      functions: project.functions.length,
      public_functions,
      private_functions,
    },
    entry_points,
    triggers,
    exposed_to_client,
    scriptlet_templates,
    libraries_consumed,
    coverage: {
      resolved_pct: project.coverage_summary.resolved_pct,
      confidence: project.coverage_summary.confidence,
      unresolved_count: project.coverage_summary.total_unresolved,
    },
  };
  if (libraries_exposed.length > 0) {
    projectMap.libraries_exposed = libraries_exposed;
  }
  return projectMap;
}

function aggregateConsumedLibraries(
  pending: PendingLibraryCall[],
  selfProject: string,
  edges: CrossProjectEdge[],
): LibraryConsumedRef[] {
  const acc = new Map<string, { call_sites: number }>();
  for (const c of pending) {
    const slot = acc.get(c.library_prefix) ?? { call_sites: 0 };
    slot.call_sites += 1;
    acc.set(c.library_prefix, slot);
  }
  const resolvedByPrefix = new Map<string, string>();
  for (const e of edges) {
    if (e.caller_project === selfProject) {
      resolvedByPrefix.set(e.library_prefix, e.callee_project);
    }
  }
  return [...acc.entries()]
    .map(([prefix, { call_sites }]) => {
      const callee = resolvedByPrefix.get(prefix);
      return {
        prefix,
        call_sites,
        resolved_in_workspace: callee !== undefined,
        resolved_callee_project: callee ?? null,
      };
    })
    .sort((a, b) => a.prefix.localeCompare(b.prefix));
}

function computeLibrariesExposed(
  selfProject: string,
  edges: CrossProjectEdge[],
): LibraryExposedRef[] {
  const acc = new Map<string, number>();
  for (const e of edges) {
    if (e.callee_project !== selfProject) continue;
    acc.set(e.caller_project, (acc.get(e.caller_project) ?? 0) + 1);
  }
  return [...acc.entries()]
    .map(([consumed_by_project, call_sites]) => ({ consumed_by_project, call_sites }))
    .sort((a, b) => a.consumed_by_project.localeCompare(b.consumed_by_project));
}

function stableExposureSort(
  a: { file: string; line: number },
  b: { file: string; line: number },
): number {
  if (a.file !== b.file) return a.file.localeCompare(b.file);
  return a.line - b.line;
}

/**
 * Rend une vue *texte* dense — pensée pour l'amorçage de session (V3 §21.5).
 * Une ligne par projet quand possible ; sinon en-tête + sections nommées et
 * compactes. Vise ~300 tokens pour un projet de taille typique.
 */
export function renderMapText(report: MapReport): string {
  const lines: string[] = [];
  if (report.kind === 'workspace_map') {
    lines.push(
      `workspace  projects=${report.projects.length}  cross_project_edges=${report.cross_project_edges_count ?? 0}`,
    );
  }
  for (const p of report.projects) {
    lines.push('');
    lines.push(
      `[${p.project}]  files=${p.totals.files}  fns=${p.totals.functions} (pub=${p.totals.public_functions}/priv=${p.totals.private_functions})  cov=${p.coverage.resolved_pct}%/${p.coverage.confidence}${p.coverage.unresolved_count ? ` (${p.coverage.unresolved_count} unresolved)` : ''}`,
    );
    if (p.entry_points.length) {
      lines.push(
        `  entry: ${p.entry_points.map((e) => `${e.kind} ${e.function}@${e.file}:${e.line}`).join(', ')}`,
      );
    }
    if (p.triggers.length) {
      lines.push(
        `  triggers: ${p.triggers
          .map((t) => `${t.function} (${t.kind}${t.detail ? ` ← ${t.detail}` : ''})`)
          .join(', ')}`,
      );
    }
    if (p.exposed_to_client.length) {
      lines.push(
        `  client: ${p.exposed_to_client
          .map((c) => `${c.function}@${c.file}:${c.line}${c.call_sites > 1 ? ` ×${c.call_sites}` : ''}`)
          .join(', ')}`,
      );
    }
    if (p.scriptlet_templates.length) {
      lines.push(
        `  templates: ${p.scriptlet_templates
          .map((t) => `${t.template_file} ← ${t.bound_by.join('|')}${t.unread || t.read_but_not_set ? ` (gaps: unread=${t.unread} missing=${t.read_but_not_set})` : ''}`)
          .join(', ')}`,
      );
    }
    if (p.libraries_consumed.length) {
      lines.push(
        `  consumes: ${p.libraries_consumed
          .map(
            (l) =>
              `${l.prefix}${l.resolved_callee_project ? `→${l.resolved_callee_project}` : '(external)'} ×${l.call_sites}`,
          )
          .join(', ')}`,
      );
    }
    if (p.libraries_exposed && p.libraries_exposed.length) {
      lines.push(
        `  exposes: ${p.libraries_exposed
          .map((l) => `${l.consumed_by_project} ×${l.call_sites}`)
          .join(', ')}`,
      );
    }
  }
  return lines.join('\n');
}

// Le type est exporté volontairement séparément pour faciliter les futures
// extensions (filtres CLI sur les sections incluses).
export type { Exposure, FunctionRecord };
