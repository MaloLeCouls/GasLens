import type { LibraryFetcher, LibrarySource } from '../resolve-live.js';

/**
 * Scope OAuth requis pour lire le contenu d'un projet Apps Script via l'API.
 * `script.projects.readonly` couvre `projects.getContent`. Référence :
 * https://developers.google.com/apps-script/api/concepts/scopes
 */
const APPS_SCRIPT_READONLY_SCOPE =
  'https://www.googleapis.com/auth/script.projects.readonly';

export interface AppsScriptApiFetcherOpts {
  /** Override de l'endpoint (tests, proxy, environnement de dev). */
  baseUrl?: string;
  /** Désactive le cache mémoire (utile pour tests / re-fetch forcé). */
  disableCache?: boolean;
  /**
   * Injection d'un fournisseur d'access token (tests sans Google).
   * Si fourni, court-circuite `google-auth-library` — aucun import dynamique
   * n'est tenté. Pratique pour les tests d'intégration et pour les contextes
   * d'auth alternatifs (ex: un service mesh qui propage déjà un token).
   */
  getAccessToken?: () => Promise<string>;
}

/**
 * Implémentation du `LibraryFetcher` (V3 §22.1 phase 2) qui appelle l'API
 * Apps Script `projects.getContent` pour récupérer la source d'une lib GAS
 * à partir de son `scriptId` (= `library_id` du manifeste consommateur).
 *
 * Doctrine V3 §22 : strictement opt-in, hors hook chaud. Cette fonction
 * n'est jamais appelée par `check` / `hook` ; seul `resolve-live
 * --use-apps-script-api` la déclenche.
 *
 * Erreurs gérées honnêtement :
 *  - 403 / 404 → null (script container-bound, scope manquant ou inexistant ;
 *    la doctrine V1 préfère « externe non récupérable » à une erreur fatale).
 *  - Autres codes → throw, qui sera rattrapé par `analyzeLiveLibraries` et
 *    range la lib en `external_unresolvable` avec `fetch_error`.
 *
 * Cache mémoire keyé par `${scriptId}#${version|HEAD}`. La phase 3 (future
 * session) ajoutera un cache disque + invalidation.
 */
export async function createAppsScriptApiFetcher(
  opts: AppsScriptApiFetcherOpts = {},
): Promise<LibraryFetcher> {
  const baseUrl = opts.baseUrl ?? 'https://script.googleapis.com/v1';
  const cache = new Map<string, LibrarySource>();
  const getToken =
    opts.getAccessToken ?? (await buildAdcTokenProvider());

  return {
    async fetch(scriptId, version) {
      const cacheKey = `${scriptId}#${version ?? 'HEAD'}`;
      if (!opts.disableCache && cache.has(cacheKey)) {
        return cache.get(cacheKey) ?? null;
      }
      const url = new URL(`${baseUrl}/projects/${scriptId}/content`);
      if (version && /^\d+$/.test(version)) {
        url.searchParams.set('versionNumber', version);
      }
      const token = await getToken();
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 403 || res.status === 404) {
        return null;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(
          `Apps Script API : HTTP ${res.status} sur ${url.pathname} — ${body.slice(0, 200)}`,
        );
      }
      const data = (await res.json()) as RawContentResponse;
      const source = mapResponseToLibrarySource(data);
      if (!opts.disableCache) cache.set(cacheKey, source);
      return source;
    },
  };
}

/**
 * Construit un fournisseur de token via ADC (`google-auth-library.GoogleAuth`).
 * L'import est **dynamique** : la dépendance est déclarée comme
 * `optionalDependencies` dans package.json, et n'est jamais chargée tant
 * que le path `--use-apps-script-api` n'est pas pris.
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
        "`npm install google-auth-library` (V3 §22.1 phase 2). " +
        "Cause: " +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  const auth = new GoogleAuth({ scopes: [APPS_SCRIPT_READONLY_SCOPE] });
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

interface RawContentResponse {
  scriptId?: string;
  files?: Array<{
    name?: string;
    source?: string;
    type?: string;
  }>;
}

interface AuthClassCtor {
  new (opts: { scopes?: string[] }): {
    getClient(): Promise<{
      getAccessToken(): Promise<{ token?: string | null }>;
    }>;
  };
}

/**
 * Mappe la réponse `projects.getContent` (forme Google) vers la forme
 * canonique `LibrarySource` consommée par GAS-Lens. Exposé pour les tests.
 */
export function mapResponseToLibrarySource(
  raw: RawContentResponse,
): LibrarySource {
  const files = (raw.files ?? [])
    .filter(
      (f) => typeof f.name === 'string' && typeof f.source === 'string',
    )
    .map((f) => {
      const type: 'SERVER_JS' | 'HTML' | 'JSON' =
        f.type === 'HTML'
          ? 'HTML'
          : f.type === 'JSON'
            ? 'JSON'
            : 'SERVER_JS';
      return { name: f.name as string, source: f.source as string, type };
    });
  const meta: Record<string, string | number> = {};
  if (raw.scriptId) meta.scriptId = raw.scriptId;
  return { files, meta };
}
