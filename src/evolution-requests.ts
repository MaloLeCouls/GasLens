/**
 * `gaslens request` (LOT G0) — le **canal d'auto-évolution** de GasLens.
 *
 * Idée (demande utilisateur) : quand l'agent rencontre un **manque récurrent**
 * (une analyse qu'il refait à la main, un garde-fou absent, une commande qu'il
 * aimerait), il le **logue** au lieu de le subir en silence. Les demandes sont
 * **dédupliquées par texte normalisé** et un **compteur d'occurrences** monte à
 * chaque répétition → la fréquence devient le signal de priorisation. L'outil
 * se façonne ainsi sur l'usage et la prod réels.
 *
 * Distinct du backlog `inbox/triaged/archive` (qui sert aux demandes *sur les
 * webapps*) : ici on parle d'évolutions **de GasLens lui-même**.
 *
 * 100 % local, sans réseau. Stocké en JSONL agrégé dans
 * `<workspace>/.gaslens/evolution-requests.jsonl` (commité, voyage avec le repo).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findWorkspaceRoot } from './env-validate.js';

export const EVOLUTION_REQUESTS_FILE = 'evolution-requests.jsonl';

export const REQUEST_KINDS = ['check', 'command', 'perf', 'guardrail', 'doc', 'other'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

export interface EvolutionRequest {
  /** Hash stable du besoin normalisé — clé de déduplication. */
  id: string;
  need: string;
  kind: RequestKind;
  context: string | null;
  suggest: string | null;
  /** Nombre de fois où ce besoin a été signalé — le signal de priorisation. */
  occurrences: number;
  first_seen: string;
  last_seen: string;
}

export interface AddRequestInput {
  need: string;
  kind?: string;
  context?: string;
  suggest?: string;
}

export interface AddRequestResult {
  created: boolean;
  entry: EvolutionRequest;
  total: number;
}

/** Dossier de stockage : remonte au workspace si possible, sinon `dir`. */
export function requestsStorePath(dir: string): string {
  const root = findWorkspaceRoot(dir) ?? dir;
  return join(root, '.gaslens', EVOLUTION_REQUESTS_FILE);
}

/** Clé de dédup : minuscule, diacritiques retirés, ponctuation/espaces normalisés. */
function normalizeNeed(need: string): string {
  return need
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Hash déterministe (djb2 → base36) — pas de Date/random, rejouable. */
function hashId(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ s.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

function coerceKind(kind: string | undefined): RequestKind {
  return (REQUEST_KINDS as readonly string[]).includes(kind ?? '')
    ? (kind as RequestKind)
    : 'other';
}

async function readRequests(path: string): Promise<EvolutionRequest[]> {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const out: EvolutionRequest[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t) as EvolutionRequest;
      if (e && typeof e.id === 'string' && typeof e.need === 'string') out.push(e);
    } catch {
      // ligne corrompue ignorée (honnêteté : on ne perd pas tout le fichier)
    }
  }
  return out;
}

function sortRequests(entries: EvolutionRequest[]): EvolutionRequest[] {
  return [...entries].sort(
    (a, b) => b.occurrences - a.occurrences || (a.last_seen < b.last_seen ? 1 : -1),
  );
}

async function writeRequests(path: string, entries: EvolutionRequest[]): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  const body = sortRequests(entries)
    .map((e) => JSON.stringify(e))
    .join('\n');
  await writeFile(path, body + (body ? '\n' : ''), 'utf8');
}

/**
 * Ajoute (ou incrémente) une demande d'évolution. `now` est injecté (le CLI
 * passe `new Date().toISOString()`) pour rester pur/testable.
 */
export async function addEvolutionRequest(
  dir: string,
  input: AddRequestInput,
  now: string,
): Promise<AddRequestResult> {
  const path = requestsStorePath(dir);
  const entries = await readRequests(path);
  const id = hashId(normalizeNeed(input.need));
  const existing = entries.find((e) => e.id === id);
  let entry: EvolutionRequest;
  let created: boolean;
  if (existing) {
    existing.occurrences += 1;
    existing.last_seen = now;
    if (input.context) existing.context = input.context;
    if (input.suggest) existing.suggest = input.suggest;
    entry = existing;
    created = false;
  } else {
    entry = {
      id,
      need: input.need.trim(),
      kind: coerceKind(input.kind),
      context: input.context?.trim() || null,
      suggest: input.suggest?.trim() || null,
      occurrences: 1,
      first_seen: now,
      last_seen: now,
    };
    entries.push(entry);
    created = true;
  }
  await writeRequests(path, entries);
  return { created, entry, total: entries.length };
}

export async function listEvolutionRequests(dir: string): Promise<EvolutionRequest[]> {
  return sortRequests(await readRequests(requestsStorePath(dir)));
}

export function renderRequestsText(entries: EvolutionRequest[]): string {
  if (entries.length === 0) {
    return "Aucune demande d'évolution enregistrée. L'agent en ajoute via `gaslens request add`.";
  }
  const lines = [`${entries.length} demande(s) d'évolution (triées par fréquence) :`];
  for (const e of entries) {
    lines.push(`  ×${e.occurrences}  [${e.kind}]  ${e.need}`);
    if (e.suggest) lines.push(`        ↳ suggestion : ${e.suggest}`);
    if (e.context) lines.push(`        ↳ contexte : ${e.context}`);
  }
  return lines.join('\n');
}
