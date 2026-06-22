/**
 * Le **manifeste maître** `gaslens.workspace.json` (V4 §26–29).
 *
 * C'est la SOURCE DE VÉRITÉ unique du parc : quelles apps existent, leurs deux
 * projets `dev`/`prod` (modèle « hard » d'isolation des données), la
 * bibliothèque mère unique (politique de version HEAD↔figée) et les ressources
 * (Sheets/Forms/dossiers) propres à chaque environnement.
 *
 * GasLens le **lit** (pour `env validate`, etc.) ; il est **écrit** par les
 * skills de provisioning/onboarding (jamais analysé/inféré). Distinct du
 * `WorkspaceIndex` de `types.ts`, qui est l'index *généré* par `scan`.
 *
 * Les deux axes d'environnement (V4 §29) qu'il matérialise :
 *   - CODE      : la bibliothèque (HEAD en dev, version figée en prod) + le
 *                 couple de projets dev/prod de chaque webapp ;
 *   - RESSOURCES: `environments.<env>.resources` (nom logique → id de ressource).
 */

import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const WORKSPACE_MANIFEST_FILENAME = 'gaslens.workspace.json';

/** Référence à un projet Apps Script concret (un script_id = un projet). */
export const ProjectRefSchema = z.object({
  script_id: z.string().min(1),
  /** Chemin (relatif au workspace) du dossier clasp de ce projet. */
  clasp_path: z.string().optional(),
  /** deployment ID stable (prod surtout — promote = republier sur le même). */
  deployment_id: z.string().optional(),
});
export type ProjectRef = z.infer<typeof ProjectRefSchema>;

/**
 * Une webapp = deux projets (dev/prod) pour isoler les données (Script
 * Properties scopées au projet). Les deux sont optionnels pour tolérer un
 * onboarding progressif, mais `env validate` attend les deux pour un parc sûr.
 */
export const AppSchema = z.object({
  name: z.string().min(1),
  /** Préfixe d'exposition si cette app est consommée comme librairie. */
  library_prefix: z.string().optional(),
  projects: z
    .object({
      dev: ProjectRefSchema.optional(),
      prod: ProjectRefSchema.optional(),
    })
    .default({}),
});
export type App = z.infer<typeof AppSchema>;

/**
 * La bibliothèque mère **unique** (V4 §26). Un seul script_id partagé ; la
 * politique de version distingue les environnements : dev→HEAD (instable),
 * prod→version figée (entier). C'est l'axe CODE de l'isolation.
 */
export const LibrarySchema = z.object({
  name: z.string().optional(),
  /** userSymbol attendu dans les `dependencies.libraries[].userSymbol` consommateurs. */
  user_symbol: z.string().optional(),
  script_id: z.string().min(1),
  /** dev consomme toujours la HEAD (mode développement). */
  dev_version: z.literal('HEAD').default('HEAD'),
  /** prod consomme une version figée (numéro de version de bibliothèque). */
  prod_version: z.number().int().positive(),
});
export type Library = z.infer<typeof LibrarySchema>;

/** Un environnement = sa carte de ressources (nom logique → id concret). */
export const EnvironmentSchema = z.object({
  resources: z.record(z.string(), z.string()).default({}),
});
export type Environment = z.infer<typeof EnvironmentSchema>;

export const WorkspaceManifestSchema = z.object({
  /** Version de schéma du manifeste maître (pour migrations futures). */
  version: z.number().int().positive().default(1),
  name: z.string().optional(),
  apps: z.array(AppSchema).default([]),
  library: LibrarySchema.optional(),
  /** Carte des environnements ; clés conventionnelles : `dev`, `prod`. */
  environments: z.record(z.string(), EnvironmentSchema).default({}),
});
export type WorkspaceManifest = z.infer<typeof WorkspaceManifestSchema>;

export interface LoadWorkspaceManifestResult {
  /** Le fichier existe-t-il à `root` ? */
  found: boolean;
  /** Chemin tenté (qu'il existe ou non). */
  path: string;
  /** Le manifeste validé, ou null si absent/invalide. */
  manifest: WorkspaceManifest | null;
  /** Erreurs de parsing/validation (vide si OK ou absent). */
  errors: string[];
}

/**
 * Charge et valide `gaslens.workspace.json` depuis `root`. Ne jette jamais :
 * un manifeste absent ou invalide est un état exploitable (renvoyé via
 * `found`/`errors`) — c'est la doctrine d'honnêteté (V1 §1.5).
 */
export async function loadWorkspaceManifest(
  root: string,
): Promise<LoadWorkspaceManifestResult> {
  const path = join(root, WORKSPACE_MANIFEST_FILENAME);
  if (!existsSync(path)) {
    return { found: false, path, manifest: null, errors: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    return {
      found: true,
      path,
      manifest: null,
      errors: [`JSON invalide : ${(err as Error).message}`],
    };
  }
  return parseWorkspaceManifest(raw, path);
}

/** Variante synchrone-pure (déjà-en-mémoire) — utile aux tests et au CLI. */
export function parseWorkspaceManifest(
  raw: unknown,
  path = WORKSPACE_MANIFEST_FILENAME,
): LoadWorkspaceManifestResult {
  const parsed = WorkspaceManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      found: true,
      path,
      manifest: null,
      errors: parsed.error.issues.map(
        (i) => `${i.path.join('.') || '(racine)'} : ${i.message}`,
      ),
    };
  }
  return { found: true, path, manifest: parsed.data, errors: [] };
}

/** Liste des noms d'environnements déclarés (ordre d'insertion conservé). */
export function environmentNames(m: WorkspaceManifest): string[] {
  return Object.keys(m.environments);
}

export interface ResourceOwner {
  env: string;
  logical: string;
}

/**
 * Index inversé id-de-ressource → propriétaires (env + nom logique). Le socle
 * du finding-roi `env.cross_env_leak` : si un id appartenant à `dev` apparaît
 * en dur dans un projet `prod` (ou l'inverse), on tient une fuite.
 *
 * Un même id peut légitimement appartenir à plusieurs envs (ressource
 * partagée) ; on garde donc une liste, pas une valeur unique.
 */
export function resourceOwnerIndex(
  m: WorkspaceManifest,
): Map<string, ResourceOwner[]> {
  const index = new Map<string, ResourceOwner[]>();
  for (const [env, def] of Object.entries(m.environments)) {
    for (const [logical, id] of Object.entries(def.resources)) {
      if (!id) continue;
      const slot = index.get(id) ?? [];
      slot.push({ env, logical });
      index.set(id, slot);
    }
  }
  return index;
}

/**
 * Union des noms logiques de ressources déclarés à travers tous les
 * environnements — pour `env.undeclared_resource` (une clé lue dans le code
 * mais déclarée dans aucun env).
 */
export function declaredLogicalNames(m: WorkspaceManifest): Set<string> {
  const names = new Set<string>();
  for (const def of Object.values(m.environments)) {
    for (const logical of Object.keys(def.resources)) names.add(logical);
  }
  return names;
}

/** Squelette de manifeste maître émis par `workspace init` (B2). */
export function emptyWorkspaceManifest(name: string): WorkspaceManifest {
  return {
    version: 1,
    name,
    apps: [],
    environments: { dev: { resources: {} }, prod: { resources: {} } },
  };
}
