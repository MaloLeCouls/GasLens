import type {
  ProjectIndex,
  ReceiverUsage,
  WorkspaceIndex,
} from './types.js';

/**
 * Source d'une librairie récupérée via Apps Script API (`projects.getContent`).
 * Format aligné sur le payload Google : fichiers serveur (`.gs`), HTML, et
 * manifeste (`appsscript.json` ; type `JSON`).
 */
export interface LibrarySource {
  files: Array<{
    name: string;
    source: string;
    type: 'SERVER_JS' | 'HTML' | 'JSON';
  }>;
  /** Métadonnées libres (versionNumber, scriptId effectivement servi, etc.). */
  meta?: Record<string, string | number>;
}

/**
 * Récupère la source d'une librairie GAS par son `scriptId` (= `library_id`
 * du manifeste consommateur). V3 §22.1 — strictement optionnel et hors hook
 * chaud. La doctrine est : ne JAMAIS appeler ce fetcher dans `check` /
 * `gaslens hook` ; seul `resolve-live` (commande explicite) le déclenche.
 *
 * Renvoie `null` si la librairie n'est pas récupérable (container-bound,
 * scope OAuth manquant, erreur API). L'appelant traite ce cas honnêtement.
 */
export interface LibraryFetcher {
  fetch(
    scriptId: string,
    version: string | null,
  ): Promise<LibrarySource | null>;
}

/**
 * Implémentation par défaut : aucune API n'est appelée. Toute librairie
 * externe est marquée `external_unfetched` — la commande devient un
 * inventaire honnête des frontières (utile pour un agent qui doit savoir
 * où ça plafonne). Une impl Apps Script API se branchera dans une session
 * ultérieure.
 */
export const NoopFetcher: LibraryFetcher = {
  async fetch() {
    return null;
  },
};

export type LibraryStatus =
  | 'local'
  | 'external_unfetched'
  | 'external_resolved'
  | 'external_unresolvable'
  | 'declared_unused';

export interface ResolvedLibrary {
  /** Projet consommateur (= celui dont le manifeste déclare la lib). */
  project: string;
  user_symbol: string;
  /** scriptId déclaré dans le manifeste. */
  library_id: string;
  version: string;
  development_mode: boolean | null;
  status: LibraryStatus;
  calls_count: number;
  call_sites: Array<{
    file: string;
    line: number;
    method: string;
    function: string;
  }>;
  /** Renseigné si le fetcher a tenté et échoué. */
  fetch_error?: string;
}

export interface ResolveLiveReport {
  scanned_at: string;
  scope: 'project' | 'workspace';
  summary: {
    total: number;
    local: number;
    external_unfetched: number;
    external_resolved: number;
    external_unresolvable: number;
    declared_unused: number;
  };
  libraries: ResolvedLibrary[];
  /** Conseils actionnables (prêts à coller dans une session agent). */
  advice: string[];
}

/**
 * Croise `manifest.libraries` × workspace × `receiver_usage` pour produire
 * un rapport honnête sur l'état des dépendances de librairies. Pour chaque
 * `dependencies.libraries[]` :
 *  - si le workspace contient un projet de même `user_symbol` → `local` ;
 *  - sinon si aucun appel `Lib.fn()` ne référence ce symbole → `declared_unused` ;
 *  - sinon tente `fetcher.fetch(library_id, version)`. Le résultat range la
 *    lib en `external_resolved` (succès), `external_unresolvable` (rejet
 *    explicite : container-bound, scope manquant, …) ou `external_unfetched`
 *    (default fetcher = aucune API branchée).
 *
 * V1 : on s'arrête au rapport. L'indexation effective d'une lib récupérée
 * (intégration dans le WorkspaceIndex) arrivera quand on aura un fetcher
 * réel — V3 §22.1 phase 2.
 */
export async function analyzeLiveLibraries(
  idx: ProjectIndex | WorkspaceIndex,
  fetcher: LibraryFetcher = NoopFetcher,
): Promise<ResolveLiveReport> {
  const projects: ProjectIndex[] =
    idx.kind === 'workspace' ? idx.projects : [idx];

  const libraries: ResolvedLibrary[] = [];
  for (const p of projects) {
    const callsByReceiver = groupReceiverUsage(p.receiver_usage);
    for (const lib of p.manifest.libraries) {
      const calls = callsByReceiver.get(lib.user_symbol) ?? [];
      const isUsed = calls.length > 0;
      const localMatch = projects.find(
        (q) =>
          q.project !== p.project &&
          q.project.toLowerCase() === lib.user_symbol.toLowerCase(),
      );
      let status: LibraryStatus;
      let fetch_error: string | undefined;
      if (localMatch) {
        status = 'local';
      } else if (!isUsed) {
        status = 'declared_unused';
      } else {
        const result = await tryFetch(fetcher, lib.library_id, lib.version);
        if (result.source) {
          status = 'external_resolved';
        } else if (result.error) {
          status = 'external_unresolvable';
          fetch_error = result.error;
        } else {
          status = 'external_unfetched';
        }
      }
      const entry: ResolvedLibrary = {
        project: p.project,
        user_symbol: lib.user_symbol,
        library_id: lib.library_id,
        version: lib.version,
        development_mode: lib.development_mode,
        status,
        calls_count: calls.length,
        call_sites: calls.slice(0, 5).map(toSite),
      };
      if (fetch_error) entry.fetch_error = fetch_error;
      libraries.push(entry);
    }
  }

  const summary = countByStatus(libraries);
  return {
    scanned_at: new Date().toISOString(),
    scope: idx.kind === 'workspace' ? 'workspace' : 'project',
    summary,
    libraries,
    advice: buildAdvice(libraries, summary),
  };
}

async function tryFetch(
  fetcher: LibraryFetcher,
  scriptId: string,
  version: string,
): Promise<{ source: LibrarySource | null; error: string | null }> {
  try {
    const src = await fetcher.fetch(scriptId, version || null);
    return { source: src, error: null };
  } catch (e) {
    return { source: null, error: e instanceof Error ? e.message : String(e) };
  }
}

function groupReceiverUsage(
  usage: ReceiverUsage[],
): Map<string, ReceiverUsage[]> {
  const out = new Map<string, ReceiverUsage[]>();
  for (const u of usage) {
    const slot = out.get(u.receiver) ?? [];
    slot.push(u);
    out.set(u.receiver, slot);
  }
  return out;
}

function toSite(u: ReceiverUsage) {
  return {
    file: u.file,
    line: u.line,
    method: u.method,
    function: u.function,
  };
}

function countByStatus(libs: ResolvedLibrary[]): ResolveLiveReport['summary'] {
  return {
    total: libs.length,
    local: libs.filter((l) => l.status === 'local').length,
    external_unfetched: libs.filter((l) => l.status === 'external_unfetched').length,
    external_resolved: libs.filter((l) => l.status === 'external_resolved').length,
    external_unresolvable: libs.filter((l) => l.status === 'external_unresolvable').length,
    declared_unused: libs.filter((l) => l.status === 'declared_unused').length,
  };
}

function buildAdvice(
  libs: ResolvedLibrary[],
  summary: ResolveLiveReport['summary'],
): string[] {
  const out: string[] = [];
  if (summary.external_unfetched > 0) {
    const names = libs
      .filter((l) => l.status === 'external_unfetched')
      .map((l) => l.user_symbol);
    out.push(
      `${summary.external_unfetched} librairie(s) externe(s) non récupérée(s) : ${names.join(', ')}. ` +
        `Brancher un LibraryFetcher (Apps Script API, V3 §22.1) pour passer la couverture à 100 % — strictement hors hook chaud.`,
    );
  }
  if (summary.declared_unused > 0) {
    const names = libs
      .filter((l) => l.status === 'declared_unused')
      .map((l) => l.user_symbol);
    out.push(
      `${summary.declared_unused} librairie(s) déclarée(s) dans le manifeste mais jamais appelée(s) : ${names.join(', ')} — ` +
        `candidates au nettoyage (cohérent avec 'manifest library.unused').`,
    );
  }
  if (summary.external_unresolvable > 0) {
    const names = libs
      .filter((l) => l.status === 'external_unresolvable')
      .map((l) => l.user_symbol);
    out.push(
      `${summary.external_unresolvable} librairie(s) externe(s) non récupérable(s) : ${names.join(', ')} ` +
        `(typiquement container-bound, scope OAuth manquant ou erreur API). ` +
        `Limitation Google connue — déclarer dans coverage.external_boundaries.`,
    );
  }
  return out;
}

export function renderResolveLiveText(report: ResolveLiveReport): string {
  const s = report.summary;
  const lines: string[] = [];
  lines.push(
    `resolve-live  scope=${report.scope}  ` +
      `total=${s.total}  local=${s.local}  ` +
      `ext-unfetched=${s.external_unfetched}  ` +
      `ext-resolved=${s.external_resolved}  ` +
      `ext-unresolvable=${s.external_unresolvable}  ` +
      `unused=${s.declared_unused}`,
  );
  if (report.libraries.length === 0) {
    lines.push('  (aucune librairie déclarée dans les manifestes)');
  }
  for (const lib of report.libraries) {
    lines.push(
      `  [${lib.project}]  ${lib.status.padEnd(22)}  ${lib.user_symbol}` +
        `  (${lib.calls_count} appel${lib.calls_count > 1 ? 's' : ''})` +
        `  scriptId=${lib.library_id || '?'}  version=${lib.version || '?'}`,
    );
    for (const site of lib.call_sites.slice(0, 3)) {
      lines.push(
        `        @ ${site.file}:${site.line}  ${lib.user_symbol}.${site.method}  (${site.function})`,
      );
    }
    if (lib.fetch_error) {
      lines.push(`        ⚠ fetch_error: ${lib.fetch_error}`);
    }
  }
  for (const a of report.advice) {
    lines.push(`  → ${a}`);
  }
  return lines.join('\n');
}
