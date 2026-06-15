import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { ProjectManifest } from './types.js';

export interface ManifestInfo {
  projectName: string;
  libraryPrefixes: string[];
  manifest: ProjectManifest;
}

interface RawLibrary {
  userSymbol?: string;
  libraryId?: string;
  version?: string;
  developmentMode?: boolean;
}

interface RawAdvancedService {
  userSymbol?: string;
  serviceId?: string;
  version?: string;
}

interface RawManifest {
  runtimeVersion?: string;
  oauthScopes?: string[];
  urlFetchWhitelist?: string[];
  webapp?: { executeAs?: string; access?: string };
  dependencies?: {
    libraries?: RawLibrary[];
    enabledAdvancedServices?: RawAdvancedService[];
  };
}

export async function readManifest(projectRoot: string): Promise<ManifestInfo> {
  const manifestPath = join(projectRoot, 'appsscript.json');
  const projectName = basename(projectRoot);
  const empty: ProjectManifest = emptyManifest();
  if (!existsSync(manifestPath)) {
    return { projectName, libraryPrefixes: [], manifest: empty };
  }
  try {
    const text = await readFile(manifestPath, 'utf8');
    const raw = JSON.parse(text) as RawManifest;
    const manifest = parseManifest(raw);
    return {
      projectName,
      libraryPrefixes: manifest.libraries.map((l) => l.user_symbol),
      manifest,
    };
  } catch {
    return { projectName, libraryPrefixes: [], manifest: empty };
  }
}

function parseManifest(raw: RawManifest): ProjectManifest {
  const libs = (raw.dependencies?.libraries ?? [])
    .filter(
      (l): l is RawLibrary & { userSymbol: string } =>
        typeof l.userSymbol === 'string' && l.userSymbol.length > 0,
    )
    .map((l) => ({
      user_symbol: l.userSymbol,
      library_id: typeof l.libraryId === 'string' ? l.libraryId : '',
      version: typeof l.version === 'string' ? l.version : '',
      development_mode:
        typeof l.developmentMode === 'boolean' ? l.developmentMode : null,
    }));
  const adv = (raw.dependencies?.enabledAdvancedServices ?? [])
    .filter(
      (s): s is RawAdvancedService & { userSymbol: string } =>
        typeof s.userSymbol === 'string' && s.userSymbol.length > 0,
    )
    .map((s) => ({
      user_symbol: s.userSymbol,
      service_id: typeof s.serviceId === 'string' ? s.serviceId : '',
      version: typeof s.version === 'string' ? s.version : '',
    }));
  return {
    runtime_version:
      typeof raw.runtimeVersion === 'string' ? raw.runtimeVersion : null,
    oauth_scopes: Array.isArray(raw.oauthScopes)
      ? raw.oauthScopes.filter((s) => typeof s === 'string')
      : [],
    url_fetch_whitelist: Array.isArray(raw.urlFetchWhitelist)
      ? raw.urlFetchWhitelist.filter((s) => typeof s === 'string')
      : [],
    webapp: raw.webapp
      ? {
          execute_as:
            typeof raw.webapp.executeAs === 'string'
              ? raw.webapp.executeAs
              : null,
          access:
            typeof raw.webapp.access === 'string' ? raw.webapp.access : null,
        }
      : null,
    libraries: libs,
    enabled_advanced_services: adv,
    present: true,
  };
}

function emptyManifest(): ProjectManifest {
  return {
    runtime_version: null,
    oauth_scopes: [],
    url_fetch_whitelist: [],
    webapp: null,
    libraries: [],
    enabled_advanced_services: [],
    present: false,
  };
}
