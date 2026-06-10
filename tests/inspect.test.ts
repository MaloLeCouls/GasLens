import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { scanProject } from '../src/scanner.js';
import { inspect, type InspectOptions } from '../src/inspect.js';
import type { ProjectIndex } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, 'fixtures/sample-project');

let idx: ProjectIndex;

const baseOpts: InspectOptions = {
  detailLevel: 'standard',
  include: [],
  maxCallers: 25,
  coverageDetail: 'summary',
  fuzzy: false,
};

beforeAll(async () => {
  idx = await scanProject({ root: FIXTURE });
});

describe('inspect — résolution', () => {
  it('renvoie kind=found quand la fonction existe', () => {
    const r = inspect(idx, 'sendEmailReport', baseOpts);
    expect(r.kind).toBe('found');
  });

  it('renvoie not_found avec message pédagogique si introuvable', () => {
    const r = inspect(idx, 'sendEmaiReport', baseOpts);
    expect(r.kind).toBe('not_found');
    if (r.kind === 'not_found') {
      expect(r.suggestions).toEqual([]);
      expect(r.message).toContain('--fuzzy');
    }
  });

  it('fuzzy : suggère le nom proche en cas de typo', () => {
    const r = inspect(idx, 'sendEmaiReport', { ...baseOpts, fuzzy: true });
    expect(r.kind).toBe('not_found');
    if (r.kind === 'not_found') {
      expect(r.suggestions).toContain('sendEmailReport');
    }
  });

  it('fuzzy : aucune suggestion si rien de proche', () => {
    const r = inspect(idx, 'totallyDifferentName', { ...baseOpts, fuzzy: true });
    if (r.kind === 'not_found') {
      expect(r.suggestions).toEqual([]);
    }
  });
});

describe('inspect — detail-level', () => {
  it('summary : signature + exposures seulement, pas de callers/callees', () => {
    const r = inspect(idx, 'sendEmailReport', {
      ...baseOpts,
      detailLevel: 'summary',
    });
    if (r.kind !== 'found') throw new Error('expected found');
    const p = r.payload;
    expect(p.signature).toContain('sendEmailReport');
    expect(p.exposures).toBeDefined();
    expect(p.callers).toBeUndefined();
    expect(p.callees).toBeUndefined();
    expect(p.definition).toBeUndefined();
  });

  it('standard : definition + callers + callees + exposures', () => {
    const r = inspect(idx, 'sendEmailReport', baseOpts);
    if (r.kind !== 'found') throw new Error('expected found');
    const p = r.payload;
    expect(p.definition).toBeDefined();
    expect(p.callers).toBeDefined();
    expect(p.callees).toBeDefined();
    expect(p.exposures).toBeDefined();
    expect(p.contract).toBeUndefined();
  });

  it('full : ajoute contract et coverage', () => {
    const r = inspect(idx, 'sendEmailReport', {
      ...baseOpts,
      detailLevel: 'full',
    });
    if (r.kind !== 'found') throw new Error('expected found');
    const p = r.payload;
    expect(p.contract).toBeDefined();
    expect(p.coverage).toBeDefined();
  });
});

describe('inspect — include sélectif (façon GraphQL)', () => {
  it('include=callers limite la sortie aux callers (override le detail-level)', () => {
    const r = inspect(idx, 'sendEmailReport', {
      ...baseOpts,
      include: ['callers'],
    });
    if (r.kind !== 'found') throw new Error('expected found');
    const p = r.payload;
    expect(p.callers).toBeDefined();
    expect(p.callees).toBeUndefined();
    expect(p.exposures).toBeUndefined();
    expect(p.definition).toBeUndefined();
  });

  it("include=all renvoie tout", () => {
    const r = inspect(idx, 'sendEmailReport', {
      ...baseOpts,
      detailLevel: 'summary',
      include: ['all'],
    });
    if (r.kind !== 'found') throw new Error('expected found');
    const p = r.payload;
    expect(p.definition).toBeDefined();
    expect(p.callers).toBeDefined();
    expect(p.callees).toBeDefined();
    expect(p.exposures).toBeDefined();
    expect(p.contract).toBeDefined();
    expect(p.coverage).toBeDefined();
  });
});

describe('inspect — signature et contract', () => {
  it('rend la signature avec les types JSDoc', () => {
    const r = inspect(idx, 'sendEmailReport', baseOpts);
    if (r.kind !== 'found') throw new Error('expected found');
    expect(r.payload.signature).toBe(
      'sendEmailReport(reportData: Object, recipients: string[]) -> {success: boolean, messageId: string}',
    );
  });

  it("marque source=mixed quand JSDoc ET inférence par handler sont présents", () => {
    // sendEmailReport a un JSDoc complet ET est appelée via google.script.run
    // avec un successHandler nommé qui lit result.success/result.messageId.
    const r = inspect(idx, 'sendEmailReport', {
      ...baseOpts,
      detailLevel: 'full',
    });
    if (r.kind !== 'found') throw new Error('expected found');
    expect(r.payload.contract!.source).toBe('mixed');
  });

  it("marque source=unknown sans JSDoc (formatReport)", () => {
    const r = inspect(idx, 'formatReport', {
      ...baseOpts,
      detailLevel: 'full',
    });
    if (r.kind !== 'found') throw new Error('expected found');
    expect(r.payload.contract!.source).toBe('unknown');
  });
});

describe('inspect — pagination (max-callers)', () => {
  it('tronque à max-callers et émet truncated', () => {
    const r = inspect(idx, 'sendEmailReport', { ...baseOpts, maxCallers: 1 });
    if (r.kind !== 'found') throw new Error('expected found');
    expect(r.payload.callers!.shown).toBe(1);
    expect(r.payload.callers!.total).toBe(2);
    expect(r.payload.truncated).toEqual({
      callers_truncated: true,
      callers_total: 2,
      callers_shown: 1,
    });
  });

  it("n'émet pas truncated si tout tient", () => {
    const r = inspect(idx, 'sendEmailReport', baseOpts);
    if (r.kind !== 'found') throw new Error('expected found');
    expect(r.payload.truncated).toBeUndefined();
  });
});

describe('inspect — coverage', () => {
  it('coverage=none la supprime', () => {
    const r = inspect(idx, 'sendEmailReport', {
      ...baseOpts,
      detailLevel: 'full',
      coverageDetail: 'none',
    });
    if (r.kind !== 'found') throw new Error('expected found');
    expect(r.payload.coverage).toBeUndefined();
  });

  it('coverage=summary la résume en une note', () => {
    const r = inspect(idx, 'sendEmailReport', {
      ...baseOpts,
      detailLevel: 'full',
      coverageDetail: 'summary',
    });
    if (r.kind !== 'found') throw new Error('expected found');
    const c = r.payload.coverage!;
    expect('note' in c).toBe(true);
  });
});
