import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { scanProject } from '../src/scanner.js';
import { impact, parseChangeSpec } from '../src/impact.js';
import type { ProjectIndex } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, 'fixtures/sample-project');

let idx: ProjectIndex;
beforeAll(async () => {
  idx = await scanProject({ root: FIXTURE });
});

describe('parseChangeSpec', () => {
  it("parse change-return-shape avec - et +", () => {
    const c = parseChangeSpec('change-return-shape:-messageId,+correlation');
    expect(c.kind).toBe('change-return-shape');
    if (c.kind === 'change-return-shape') {
      expect(c.removed).toEqual(['messageId']);
      expect(c.added).toEqual(['correlation']);
    }
  });

  it('parse remove-param', () => {
    const c = parseChangeSpec('remove-param:recipients');
    expect(c).toEqual({ kind: 'remove-param', param: 'recipients' });
  });

  it("parse rename", () => {
    const c = parseChangeSpec('rename:newName');
    expect(c).toEqual({ kind: 'rename', new_name: 'newName' });
  });

  it("parse rename-param old=new", () => {
    const c = parseChangeSpec('rename-param:old=new');
    expect(c).toEqual({ kind: 'rename-param', from: 'old', to: 'new' });
  });

  it("rejette les formats inconnus avec message lisible", () => {
    expect(() => parseChangeSpec('grobblify:foo')).toThrow(/inconnu/);
    expect(() => parseChangeSpec('change-return-shape:noPrefix')).toThrow(/'-' ou '\+'/);
    expect(() => parseChangeSpec('rename-param:foo')).toThrow(/'old=new'/);
  });
});

describe('impact — change-return-shape', () => {
  it('-messageId → BREAK sur dashboard.html (handler lit result.messageId)', () => {
    const r = impact(idx, 'sendEmailReport', {
      kind: 'change-return-shape',
      removed: ['messageId'],
      added: [],
    });
    if (r.kind !== 'found') throw new Error('expected found');
    expect(r.report.verdict).toBe('BREAK');
    expect(r.report.breaks).toHaveLength(1);
    const b = r.report.breaks[0]!;
    expect(b.consumer.file).toBe('dashboard.html');
    expect(b.consumer_kind).toBe('client_call.success_handler');
    expect(b.reason).toContain('messageId');
  });

  it('-fieldInconnu → pas de break (rien ne le lit)', () => {
    const r = impact(idx, 'sendEmailReport', {
      kind: 'change-return-shape',
      removed: ['inexistantField'],
      added: [],
    });
    if (r.kind !== 'found') throw new Error('expected found');
    expect(r.report.verdict).toBe('CLEAN');
    expect(r.report.breaks).toEqual([]);
  });
});

describe('impact — rename', () => {
  it('rename:sendEmailReport → 3 BREAKs (2 callers internes + 1 client_call)', () => {
    const r = impact(idx, 'sendEmailReport', { kind: 'rename', new_name: 'foo' });
    if (r.kind !== 'found') throw new Error('expected found');
    expect(r.report.verdict).toBe('BREAK');
    const kinds = r.report.breaks.map((b) => b.consumer_kind).sort();
    expect(kinds).toEqual([
      'client_call.invocation',
      'internal_caller',
      'internal_caller',
    ]);
  });

  it('rename:runWeeklyReport → BREAK sur ScriptApp.newTrigger', () => {
    const r = impact(idx, 'runWeeklyReport', { kind: 'rename', new_name: 'foo' });
    if (r.kind !== 'found') throw new Error('expected found');
    const trig = r.report.breaks.find((b) => b.consumer_kind === 'installable_trigger');
    expect(trig).toBeDefined();
    expect(trig!.fix_hint).toContain('foo');
  });

  it('rename:doGet → BREAK sur entry_point_web', () => {
    const r = impact(idx, 'doGet', { kind: 'rename', new_name: 'handleGet' });
    if (r.kind !== 'found') throw new Error('expected found');
    const entry = r.report.breaks.find(
      (b) => b.consumer_kind === 'entry_point_web',
    );
    expect(entry).toBeDefined();
  });
});

describe('impact — remove-param', () => {
  it("remove recipients → BREAK sur les sites qui passent un 2e arg", () => {
    const r = impact(idx, 'sendEmailReport', {
      kind: 'remove-param',
      param: 'recipients',
    });
    if (r.kind !== 'found') throw new Error('expected found');
    expect(r.report.verdict).toBe('BREAK');
    expect(r.report.breaks.length).toBeGreaterThanOrEqual(2);
    expect(
      r.report.breaks.some((b) => b.consumer_kind === 'client_call.invocation'),
    ).toBe(true);
  });

  it('remove sur param inexistant → warn pédagogique', () => {
    const r = impact(idx, 'sendEmailReport', {
      kind: 'remove-param',
      param: 'inexistant',
    });
    if (r.kind !== 'found') throw new Error('expected found');
    expect(r.report.verdict).toBe('WARN');
    expect(r.report.warns[0]!.reason).toContain('inexistant');
  });
});

describe('impact — not_found', () => {
  it("renvoie not_found avec message si la fonction n'existe pas", () => {
    const r = impact(idx, 'nepatchpasca', { kind: 'rename', new_name: 'x' });
    expect(r.kind).toBe('not_found');
  });
});
