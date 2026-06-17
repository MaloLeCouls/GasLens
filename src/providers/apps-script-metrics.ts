import type {
  FunctionMetrics,
  MetricsProvider,
} from '../prod-truth.js';

/**
 * Scope OAuth requis : `script.processes` pour lire l'historique d'exécution
 * via `processes:listScriptProcesses`. Référence :
 * https://developers.google.com/apps-script/api/concepts/scopes
 */
const APPS_SCRIPT_PROCESSES_SCOPE =
  'https://www.googleapis.com/auth/script.processes';

export interface AppsScriptMetricsProviderOpts {
  /** Override de l'endpoint (tests, proxy, environnement de dev). */
  baseUrl?: string;
  /**
   * Injection d'un fournisseur d'access token (tests sans Google ou contextes
   * d'auth alternatifs). Si fourni, court-circuite `google-auth-library`.
   */
  getAccessToken?: () => Promise<string>;
  /**
   * Nombre maximum de pages `processes` à paginer. Le pageSize maximal de
   * l'API est 50, donc `max_pages=20` plafonne à ~1000 processes par appel.
   * Garde-fou anti-runaway sur les projets très actifs (l'agent ne doit pas
   * brûler une journée à paginer). Au-delà : on dégrade les compteurs avec
   * un flag `truncated` dans la note des `FunctionMetrics`.
   */
  max_pages?: number;
  /** Désactive le cache mémoire (utile pour tests). */
  disableCache?: boolean;
}

/**
 * Implémentation du `MetricsProvider` (V3 §22.2 phase 2) qui agrège
 * l'historique d'exécution d'un script via `processes:listScriptProcesses`.
 *
 * Stratégie :
 *  1. `startTime = now - window_days * 24h` ;
 *  2. paginer toutes les `processes` du `scriptId` sur cette fenêtre
 *     (un seul appel API par scriptId, pas un par fonction — la pagination
 *     dépasse vite tous les filtres possibles côté serveur) ;
 *  3. agréger côté client par `functionName` : count, error_count
 *     (FAILED | TIMED_OUT), last_execution_at, error_rate ;
 *  4. inclure les fonctions du paramètre `function_names` même sans process
 *     (`executions_count: 0`) pour permettre `confirmed_dead` côté
 *     `analyzeProdTruth`.
 *
 * Doctrine V3 §22 : strictement opt-in, hors hook chaud. Cache mémoire
 * keyé par `scriptId#window_days`.
 */
export async function createAppsScriptMetricsProvider(
  opts: AppsScriptMetricsProviderOpts = {},
): Promise<MetricsProvider> {
  const baseUrl = opts.baseUrl ?? 'https://script.googleapis.com/v1';
  const maxPages = opts.max_pages ?? 20;
  const cache = new Map<string, FunctionMetrics[]>();
  const getToken =
    opts.getAccessToken ?? (await buildAdcTokenProvider());

  return {
    async getMetrics({ scriptId, function_names, window_days }) {
      if (!scriptId) return [];
      const win = window_days ?? 30;
      const cacheKey = `${scriptId}#${win}`;
      const fromCache = opts.disableCache ? undefined : cache.get(cacheKey);
      const aggregated =
        fromCache ?? (await fetchAndAggregate(scriptId, win));
      if (!fromCache && !opts.disableCache) cache.set(cacheKey, aggregated);
      return filterToRequested(aggregated, function_names);
    },
  };

  async function fetchAndAggregate(
    scriptId: string,
    win: number,
  ): Promise<FunctionMetrics[]> {
    const startTime = new Date(
      Date.now() - win * 86_400 * 1000,
    ).toISOString();
    const counters = new Map<
      string,
      { count: number; errors: number; last: string | null }
    >();
    let pageToken: string | undefined;
    let page = 0;
    let truncated = false;
    while (page < maxPages) {
      const url = new URL(`${baseUrl}/processes:listScriptProcesses`);
      url.searchParams.set('scriptId', scriptId);
      url.searchParams.set('scriptProcessFilter.startTime', startTime);
      url.searchParams.set('pageSize', '50');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const token = await getToken();
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 403 || res.status === 404) {
        // Frontière honnête : pas de droits ou script inexistant — on laisse
        // l'agrégat partiel (souvent vide). L'agent verra `unknown` plus haut.
        return aggregatedToMetrics(counters, win, false);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(
          `Apps Script API (processes): HTTP ${res.status} sur ${url.pathname} — ${body.slice(0, 200)}`,
        );
      }
      const data = (await res.json()) as RawProcessesResponse;
      for (const p of data.processes ?? []) {
        const name = p.functionName;
        if (typeof name !== 'string' || name.length === 0) continue;
        let slot = counters.get(name);
        if (!slot) {
          slot = { count: 0, errors: 0, last: null };
          counters.set(name, slot);
        }
        slot.count += 1;
        if (p.processStatus === 'FAILED' || p.processStatus === 'TIMED_OUT') {
          slot.errors += 1;
        }
        if (typeof p.startTime === 'string') {
          if (slot.last === null || p.startTime > slot.last) {
            slot.last = p.startTime;
          }
        }
      }
      pageToken = data.nextPageToken ?? undefined;
      page += 1;
      if (!pageToken) break;
    }
    if (pageToken) {
      truncated = true;
    }
    return aggregatedToMetrics(counters, win, truncated);
  }
}

interface RawProcess {
  functionName?: string;
  processStatus?: string;
  processType?: string;
  startTime?: string;
  duration?: string;
}

interface RawProcessesResponse {
  processes?: RawProcess[];
  nextPageToken?: string;
}

function aggregatedToMetrics(
  counters: Map<string, { count: number; errors: number; last: string | null }>,
  window_days: number,
  truncated: boolean,
): FunctionMetrics[] {
  const out: FunctionMetrics[] = [];
  for (const [name, c] of counters) {
    const error_rate = c.count > 0 ? c.errors / c.count : null;
    const entry: FunctionMetrics = {
      function_name: name,
      executions_count: c.count,
      unique_users: null,
      error_count: c.errors,
      error_rate,
      last_execution_at: c.last,
      window_days,
    };
    if (truncated) entry.truncated = true;
    out.push(entry);
  }
  return out;
}

/**
 * Inclut les fonctions demandées même si elles n'apparaissent pas dans
 * l'agrégat (executions_count: 0). Cela permet à `analyzeProdTruth` de
 * lever `confirmed_dead` / `cold_exposed` selon les expositions statiques.
 * Les fonctions inconnues du caller ne sont pas remontées (bruit).
 */
function filterToRequested(
  aggregated: FunctionMetrics[],
  function_names: string[],
): FunctionMetrics[] {
  const byName = new Map(aggregated.map((m) => [m.function_name, m]));
  const wanted = new Set(function_names);
  const out: FunctionMetrics[] = [];
  for (const name of wanted) {
    const existing = byName.get(name);
    if (existing) {
      out.push(existing);
    } else {
      out.push({
        function_name: name,
        executions_count: 0,
        unique_users: null,
        error_count: 0,
        error_rate: null,
        last_execution_at: null,
        window_days: aggregated[0]?.window_days ?? null,
      });
    }
  }
  return out;
}

/**
 * Construit un fournisseur de token via ADC (`google-auth-library.GoogleAuth`).
 * Identique à `apps-script-api.ts` côté `resolve-live`, mais avec le scope
 * `script.processes`. L'import est **dynamique** : `google-auth-library` est
 * en `optionalDependencies` — coût zéro tant que ce code path n'est pas pris.
 */
async function buildAdcTokenProvider(): Promise<() => Promise<string>> {
  let GoogleAuth: AuthClassCtor;
  try {
    const mod = (await import('google-auth-library')) as {
      GoogleAuth: AuthClassCtor;
    };
    GoogleAuth = mod.GoogleAuth;
  } catch (err) {
    throw new Error(
      "google-auth-library introuvable. Installer la dépendance optionnelle : " +
        "`npm install google-auth-library` (V3 §22.2 phase 2). " +
        "Cause: " +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  const auth = new GoogleAuth({ scopes: [APPS_SCRIPT_PROCESSES_SCOPE] });
  const client = await auth.getClient();
  return async () => {
    const tk = await client.getAccessToken();
    if (!tk?.token) {
      throw new Error(
        "Apps Script API : ADC n'a retourné aucun access token. " +
          'Vérifier `gcloud auth application-default login` ou GOOGLE_APPLICATION_CREDENTIALS.',
      );
    }
    return tk.token;
  };
}

interface AuthClassCtor {
  new (opts: { scopes?: string[] }): {
    getClient(): Promise<{
      getAccessToken(): Promise<{ token?: string | null }>;
    }>;
  };
}
