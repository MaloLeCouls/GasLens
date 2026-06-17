import type {
  Deployment,
  DeploymentsProvider,
  EntryPoint,
  EntryPointType,
  VersionInfo,
} from '../deploy-aware.js';

/**
 * Scope OAuth requis : `script.deployments.readonly` couvre
 * `projects.deployments.list` et `projects.versions.list`. Référence :
 * https://developers.google.com/apps-script/api/concepts/scopes
 */
const APPS_SCRIPT_DEPLOYMENTS_RO_SCOPE =
  'https://www.googleapis.com/auth/script.deployments.readonly';

export interface AppsScriptDeploymentsProviderOpts {
  /** Override de l'endpoint (tests, proxy, environnement de dev). */
  baseUrl?: string;
  /**
   * Injection d'un fournisseur d'access token (tests sans Google ou contextes
   * d'auth alternatifs). Si fourni, court-circuite `google-auth-library`.
   */
  getAccessToken?: () => Promise<string>;
  /** Désactive le cache mémoire (utile pour tests). */
  disableCache?: boolean;
  /**
   * Plafond de pagination. Chaque page = 50 items (max API). Pour V1, 5 pages
   * couvrent largement les cas réels (250 déploiements/versions) sans risque
   * de runaway.
   */
  max_pages?: number;
}

/**
 * Implémentation du `DeploymentsProvider` (V3 §22.3) qui lit
 * `projects.deployments.list` et `projects.versions.list` via Apps Script API.
 *
 * Doctrine V3 §22 : strictement opt-in, hors hook chaud. 403/404 → propagés
 * en throw, rattrapés en amont par `loadProjectSummary` qui marque
 * `fetch_error` sur le summary projet (frontière honnête).
 *
 * Cache mémoire par scriptId : un appel `analyzeDeployments` sur workspace
 * de N projets fait au max 2N requêtes.
 */
export async function createAppsScriptDeploymentsProvider(
  opts: AppsScriptDeploymentsProviderOpts = {},
): Promise<DeploymentsProvider> {
  const baseUrl = opts.baseUrl ?? 'https://script.googleapis.com/v1';
  const maxPages = opts.max_pages ?? 5;
  const deployCache = new Map<string, Deployment[]>();
  const versionCache = new Map<string, VersionInfo[]>();
  const getToken =
    opts.getAccessToken ?? (await buildAdcTokenProvider());

  return {
    async listDeployments(scriptId) {
      if (!opts.disableCache && deployCache.has(scriptId)) {
        return deployCache.get(scriptId)!;
      }
      const out = await paginate<RawDeployment>(
        `${baseUrl}/projects/${scriptId}/deployments`,
        'deployments',
      );
      const mapped = out.map(mapDeployment);
      if (!opts.disableCache) deployCache.set(scriptId, mapped);
      return mapped;
    },
    async listVersions(scriptId) {
      if (!opts.disableCache && versionCache.has(scriptId)) {
        return versionCache.get(scriptId)!;
      }
      const out = await paginate<RawVersion>(
        `${baseUrl}/projects/${scriptId}/versions`,
        'versions',
      );
      const mapped = out.map(mapVersion);
      if (!opts.disableCache) versionCache.set(scriptId, mapped);
      return mapped;
    },
  };

  async function paginate<T>(urlBase: string, field: string): Promise<T[]> {
    const out: T[] = [];
    let pageToken: string | undefined;
    let page = 0;
    while (page < maxPages) {
      const url = new URL(urlBase);
      url.searchParams.set('pageSize', '50');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const token = await getToken();
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(
          `Apps Script API (${field}): HTTP ${res.status} sur ${url.pathname} — ${body.slice(0, 200)}`,
        );
      }
      const data = (await res.json()) as Record<string, unknown>;
      const items = (data[field] as T[] | undefined) ?? [];
      out.push(...items);
      pageToken = data['nextPageToken'] as string | undefined;
      page += 1;
      if (!pageToken) break;
    }
    return out;
  }
}

interface RawDeployment {
  deploymentId?: string;
  deploymentConfig?: {
    versionNumber?: number;
    manifestFileName?: string;
    description?: string;
  };
  entryPoints?: RawEntryPoint[];
  updateTime?: string;
}

interface RawEntryPoint {
  entryPointType?: string;
  webApp?: {
    url?: string;
    executeAs?: string;
    access?: string;
  };
  executionApi?: {
    access?: string;
  };
  addOn?: {
    addOnType?: string;
  };
}

interface RawVersion {
  scriptId?: string;
  versionNumber?: number;
  description?: string;
  createTime?: string;
}

function mapDeployment(raw: RawDeployment): Deployment {
  return {
    deployment_id: raw.deploymentId ?? '',
    version_number:
      typeof raw.deploymentConfig?.versionNumber === 'number'
        ? raw.deploymentConfig.versionNumber
        : null,
    description: raw.deploymentConfig?.description ?? null,
    update_time: raw.updateTime ?? null,
    entry_points: (raw.entryPoints ?? []).map(mapEntryPoint),
  };
}

function mapEntryPoint(raw: RawEntryPoint): EntryPoint {
  const type = mapEntryPointType(raw.entryPointType);
  return {
    type,
    url: raw.webApp?.url ?? null,
    execute_as:
      type === 'WEB_APP' ? (raw.webApp?.executeAs ?? null) : null,
    access:
      type === 'WEB_APP'
        ? (raw.webApp?.access ?? null)
        : type === 'EXECUTION_API'
          ? (raw.executionApi?.access ?? null)
          : null,
    addon_type: type === 'ADD_ON' ? (raw.addOn?.addOnType ?? null) : null,
  };
}

function mapEntryPointType(s: string | undefined): EntryPointType {
  if (s === 'WEB_APP') return 'WEB_APP';
  if (s === 'EXECUTION_API') return 'EXECUTION_API';
  if (s === 'ADD_ON') return 'ADD_ON';
  return 'UNKNOWN';
}

function mapVersion(raw: RawVersion): VersionInfo {
  return {
    version_number: typeof raw.versionNumber === 'number' ? raw.versionNumber : 0,
    description: raw.description ?? null,
    create_time: raw.createTime ?? null,
  };
}

/**
 * Construit un fournisseur de token via ADC. Identique aux autres providers
 * V3 §22, mais avec le scope `script.deployments.readonly`. L'import est
 * dynamique : `google-auth-library` reste en `optionalDependencies` —
 * coût zéro tant que ce code path n'est pas pris.
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
        "`npm install google-auth-library` (V3 §22.3). " +
        "Cause: " +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  const auth = new GoogleAuth({ scopes: [APPS_SCRIPT_DEPLOYMENTS_RO_SCOPE] });
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
