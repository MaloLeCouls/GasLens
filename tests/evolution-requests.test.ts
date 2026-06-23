import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addEvolutionRequest,
  listEvolutionRequests,
  requestsStorePath,
  renderRequestsText,
} from '../src/evolution-requests.js';

async function emptyWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gaslens-req-'));
  await writeFile(join(root, 'gaslens.workspace.json'), '{"version":1,"name":"p"}', 'utf8');
  return root;
}

const T1 = '2026-06-23T10:00:00.000Z';
const T2 = '2026-06-23T11:00:00.000Z';

describe('gaslens request (G0)', () => {
  it('enregistre un nouveau besoin (occurrences=1)', async () => {
    const root = await emptyWorkspace();
    try {
      const r = await addEvolutionRequest(root, { need: 'détecter les clés Properties orphelines', kind: 'check' }, T1);
      expect(r.created).toBe(true);
      expect(r.entry.occurrences).toBe(1);
      expect(r.entry.kind).toBe('check');
      // Écrit dans .gaslens/ du workspace (remonte au manifeste maître).
      expect(requestsStorePath(root)).toBe(join(root, '.gaslens', 'evolution-requests.jsonl'));
      const onDisk = await readFile(requestsStorePath(root), 'utf8');
      expect(onDisk).toContain('orphelines');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('déduplique par texte normalisé et incrémente le compteur', async () => {
    const root = await emptyWorkspace();
    try {
      await addEvolutionRequest(root, { need: 'Détecter les clés Properties orphelines.' }, T1);
      // Même besoin, casse/ponctuation différentes → même id, occurrences++.
      const r = await addEvolutionRequest(root, { need: 'detecter les cles properties orphelines' }, T2);
      expect(r.created).toBe(false);
      expect(r.entry.occurrences).toBe(2);
      expect(r.entry.first_seen).toBe(T1);
      expect(r.entry.last_seen).toBe(T2);
      const all = await listEvolutionRequests(root);
      expect(all).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('trie par fréquence décroissante', async () => {
    const root = await emptyWorkspace();
    try {
      await addEvolutionRequest(root, { need: 'besoin rare' }, T1);
      await addEvolutionRequest(root, { need: 'besoin fréquent' }, T1);
      await addEvolutionRequest(root, { need: 'besoin fréquent' }, T2);
      const all = await listEvolutionRequests(root);
      expect(all[0]?.need).toBe('besoin fréquent');
      expect(all[0]?.occurrences).toBe(2);
      expect(all[1]?.need).toBe('besoin rare');
      expect(renderRequestsText(all)).toContain('×2');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('kind inconnu retombe sur other ; conserve context/suggest', async () => {
    const root = await emptyWorkspace();
    try {
      const r = await addEvolutionRequest(
        root,
        { need: 'x', kind: 'n_importe_quoi', context: 'pendant un check', suggest: 'consumer_kind foo.bar' },
        T1,
      );
      expect(r.entry.kind).toBe('other');
      expect(r.entry.context).toBe('pendant un check');
      expect(r.entry.suggest).toBe('consumer_kind foo.bar');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('liste vide → message d\'invite', async () => {
    const root = await emptyWorkspace();
    try {
      expect(await listEvolutionRequests(root)).toEqual([]);
      expect(renderRequestsText([])).toContain('Aucune demande');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
