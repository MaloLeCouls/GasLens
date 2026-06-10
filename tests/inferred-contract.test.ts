import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { scanProject } from '../src/scanner.js';
import { inspect, type InspectOptions } from '../src/inspect.js';
import type { FunctionRecord, ProjectIndex } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, 'fixtures/sample-project');

let idx: ProjectIndex;
const byName = new Map<string, FunctionRecord>();

beforeAll(async () => {
  idx = await scanProject({ root: FIXTURE });
  for (const fn of idx.functions) byName.set(fn.name, fn);
});

describe('inferred contract — return shape depuis successHandler', () => {
  it('attache un inferred_contract à sendEmailReport', () => {
    const rec = byName.get('sendEmailReport')!;
    expect(rec.inferred_contract).not.toBeNull();
  });

  it('détecte les champs lus par onSendOk (success, messageId)', () => {
    const rec = byName.get('sendEmailReport')!;
    const rs = rec.inferred_contract!.return_shape!;
    expect(rs.field_names.sort()).toEqual(['messageId', 'success']);
    expect(rs.source).toBe('success_handler_consumption');
  });

  it("renseigne la position de chaque champ lu (file + line)", () => {
    const rec = byName.get('sendEmailReport')!;
    const rs = rec.inferred_contract!.return_shape!;
    const messageRead = rs.fields_read.find((f) => f.field === 'messageId')!;
    expect(messageRead.file).toBe('dashboard.html');
    expect(messageRead.line).toBe(17);
    expect(messageRead.handler).toBe('onSendOk');
  });

  it("n'invente pas de failure_signal quand failureHandler ne lit pas err.X (juste console.error(err))", () => {
    const rec = byName.get('sendEmailReport')!;
    expect(rec.inferred_contract!.failure_signal).toBeNull();
  });

  it("ne pollue pas les autres fonctions (qui n'ont pas de client_call)", () => {
    const formatRec = byName.get('formatReport')!;
    expect(formatRec.inferred_contract).toBeNull();
    const listRec = byName.get('listItems')!;
    expect(listRec.inferred_contract).toBeNull();
  });

  it('inspect --detail-level=full expose le contrat inféré', () => {
    const opts: InspectOptions = {
      detailLevel: 'full',
      include: [],
      maxCallers: 25,
      coverageDetail: 'summary',
      fuzzy: false,
    };
    const r = inspect(idx, 'sendEmailReport', opts);
    if (r.kind !== 'found') throw new Error('expected found');
    expect(r.payload.contract!.inferred).not.toBeNull();
    expect(
      r.payload.contract!.inferred!.return_shape!.field_names.slice().sort(),
    ).toEqual(['messageId', 'success']);
  });

  it('contract.source vaut "mixed" quand on a JSDoc + inférence', () => {
    const opts: InspectOptions = {
      detailLevel: 'full',
      include: [],
      maxCallers: 25,
      coverageDetail: 'summary',
      fuzzy: false,
    };
    const r = inspect(idx, 'sendEmailReport', opts);
    if (r.kind !== 'found') throw new Error('expected found');
    expect(r.payload.contract!.source).toBe('mixed');
  });
});
