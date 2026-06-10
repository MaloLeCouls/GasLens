import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { scanProject } from '../src/scanner.js';
import type { FunctionRecord, ProjectIndex } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, 'fixtures/sample-project');

let idx: ProjectIndex;
const byName = new Map<string, FunctionRecord>();

beforeAll(async () => {
  idx = await scanProject({ root: FIXTURE });
  for (const fn of idx.functions) byName.set(fn.name, fn);
});

describe('patron — destructuring contracts (V2 §11.2)', () => {
  it('détecte [email, role, ts] = getCurrentUser_() avec arity=3 et bound_to', () => {
    const rec = byName.get('logCurrentUser')!;
    const d = rec.patterns.destructuring_contracts;
    expect(d).toHaveLength(1);
    expect(d[0]!).toMatchObject({
      pattern: '[email, role, ts]',
      arity: 3,
      bound_to: 'getCurrentUser_',
    });
    expect(d[0]!.at.file).toBe('users.gs');
  });

  it("renseigne bound_to=null quand le RHS n'est pas un appel à un bare identifier", () => {
    const rec = byName.get('summarizeRow_')!;
    const d = rec.patterns.destructuring_contracts;
    expect(d).toHaveLength(1);
    expect(d[0]!.bound_to).toBeNull();
    expect(d[0]!.arity).toBe(2);
  });
});

describe('patron — PropertiesService / CacheService (V2 §11.4)', () => {
  it('détecte read sur PropertiesService.getScriptProperties().getProperty(K)', () => {
    const rec = byName.get('getApiKey_')!;
    expect(rec.patterns.property_keys).toEqual([
      expect.objectContaining({
        key: 'API_KEY',
        op: 'read',
        store: 'script',
      }),
    ]);
  });

  it('détecte write sur setProperty', () => {
    const rec = byName.get('setApiKey_')!;
    expect(rec.patterns.property_keys[0]).toMatchObject({
      key: 'API_KEY',
      op: 'write',
      store: 'script',
    });
  });

  it('store=user pour getUserProperties', () => {
    const rec = byName.get('readUserPref_')!;
    expect(rec.patterns.property_keys[0]!.store).toBe('user');
  });

  it("key=null quand l'argument n'est pas un string literal (clé dynamique)", () => {
    const rec = byName.get('readUserPref_')!;
    expect(rec.patterns.property_keys[0]!.key).toBeNull();
    expect(rec.patterns.property_keys[0]!.key_text).toBe('name');
  });

  it('CacheService.getScriptCache().get(K) reconnu comme cache_script/read', () => {
    const rec = byName.get('cacheLookup_')!;
    expect(rec.patterns.property_keys[0]).toMatchObject({
      op: 'read',
      store: 'cache_script',
    });
  });
});

describe('property_keys — index projet', () => {
  it("agrège API_KEY en R+W (status='ok')", () => {
    const k = idx.property_keys.find((p) => p.key === 'API_KEY')!;
    expect(k).toBeDefined();
    expect(k.reads).toHaveLength(1);
    expect(k.writes).toHaveLength(1);
    expect(k.status).toBe('ok');
    expect(k.reads[0]!.function).toBe('getApiKey_');
    expect(k.writes[0]!.function).toBe('setApiKey_');
  });

  it("signale LAST_RUN comme write_only (clé orpheline en lecture, V2 §11.4)", () => {
    const k = idx.property_keys.find((p) => p.key === 'LAST_RUN')!;
    expect(k).toBeDefined();
    expect(k.status).toBe('write_only');
    expect(k.reads).toHaveLength(0);
    expect(k.writes).toHaveLength(1);
  });

  it("n'agrège pas les clés dynamiques (key=null)", () => {
    expect(idx.property_keys.find((p) => p.key === null)).toBeUndefined();
  });
});

describe('patron — tableaux 2D getValues() (V2 §11.1, bug GAS n°1)', () => {
  it('détecte rows = X.getValues() puis rows.map(row => row[N])', () => {
    const rec = byName.get('listItems')!;
    const arr = rec.patterns.array2d_access;
    expect(arr).toHaveLength(1);
    expect(arr[0]!.variable).toBe('rows');
    expect(arr[0]!.source).toContain('getValues()');
    expect(arr[0]!.via).toEqual(['map']);
  });

  it('agrège les column_indices_read et calcule max_index', () => {
    const rec = byName.get('listItems')!;
    const a = rec.patterns.array2d_access[0]!;
    expect(a.column_indices_read).toEqual([0, 2]);
    expect(a.max_index).toBe(2);
  });

  it("n'invente pas d'array2d_access pour les fonctions qui ne touchent pas getValues", () => {
    const rec = byName.get('sendEmailReport')!;
    expect(rec.patterns.array2d_access).toEqual([]);
  });
});

describe('patron — template.data ↔ scriptlets (V2 §11.3)', () => {
  it('détecte tpl.data = {...} dans doGet et le lie à dashboard.html', () => {
    const rec = byName.get('doGet')!;
    const tb = rec.patterns.template_bindings;
    expect(tb).toHaveLength(1);
    expect(tb[0]!).toMatchObject({
      template_file: 'dashboard.html',
      template_var: 'tpl',
    });
    expect(tb[0]!.data_fields_set.sort()).toEqual(['items', 'userName']);
  });

  it('alimente data_fields_read_in_scriptlets depuis le HTML (data.userName, data.items)', () => {
    const tb = byName.get('doGet')!.patterns.template_bindings[0]!;
    expect(tb.data_fields_read_in_scriptlets.sort()).toEqual([
      'items',
      'userName',
    ]);
    expect(tb.unread_data_fields).toEqual([]);
    expect(tb.read_but_not_set).toEqual([]);
  });
});
