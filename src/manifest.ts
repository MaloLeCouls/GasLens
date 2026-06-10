import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';

export interface ManifestInfo {
  projectName: string;
  libraryPrefixes: string[];
}

interface RawLibrary {
  userSymbol?: string;
}

interface RawManifest {
  dependencies?: { libraries?: RawLibrary[] };
}

export async function readManifest(projectRoot: string): Promise<ManifestInfo> {
  const manifestPath = join(projectRoot, 'appsscript.json');
  const projectName = basename(projectRoot);
  if (!existsSync(manifestPath)) {
    return { projectName, libraryPrefixes: [] };
  }
  try {
    const text = await readFile(manifestPath, 'utf8');
    const raw = JSON.parse(text) as RawManifest;
    const libs = raw.dependencies?.libraries ?? [];
    const prefixes = libs
      .map((l) => l.userSymbol)
      .filter((s): s is string => typeof s === 'string' && s.length > 0);
    return { projectName, libraryPrefixes: prefixes };
  } catch {
    return { projectName, libraryPrefixes: [] };
  }
}
