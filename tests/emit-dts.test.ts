import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { scanProject } from '../src/scanner.js';
import { emitDts } from '../src/emit-dts.js';
import type { ProjectIndex } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, 'fixtures/sample-project');

let idx: ProjectIndex;
let dts: string;

beforeAll(async () => {
  idx = await scanProject({ root: FIXTURE });
  dts = emitDts(idx, { include_all_public: true });
});

describe('emit-dts — header + structure', () => {
  it("inclut le nom du projet dans l'en-tête", () => {
    expect(dts).toContain('sample-project');
  });

  it("est un script ambient (pas un module ES)", () => {
    expect(dts).not.toMatch(/^export\s/m);
    expect(dts).not.toContain('export {};');
    expect(dts).toContain('declare const google');
  });

  it("déclare GoogleScriptRunner avec les 3 with*Handler", () => {
    expect(dts).toContain('withSuccessHandler');
    expect(dts).toContain('withFailureHandler');
    expect(dts).toContain('withUserObject');
  });
});

describe('emit-dts — fonctions exposées', () => {
  it('inclut sendEmailReport avec ses params typés', () => {
    expect(dts).toMatch(/sendEmailReport\(reportData: object, recipients: string\[\]\): void;/);
  });

  it("inclut les autres fonctions publiques (doGet, runWeeklyReport...)", () => {
    expect(dts).toMatch(/doGet\(/);
    expect(dts).toMatch(/runWeeklyReport\(/);
    expect(dts).toMatch(/listItems\(\): void;/);
  });

  it("exclut les fonctions privées (suffixe _)", () => {
    expect(dts).not.toMatch(/\bgenerateId_\s*\(/);
    expect(dts).not.toMatch(/\bgetUserName_\s*\(/);
    expect(dts).not.toMatch(/\binstallWeeklyTrigger_\s*\(/);
  });

  it("--exposed-only=true filtre aux fonctions ayant une exposure client_call/scriptlet", () => {
    const dtsExposed = emitDts(idx, { include_all_public: false });
    // sendEmailReport a un client_call → présent
    expect(dtsExposed).toMatch(/sendEmailReport\(/);
    // include a un scriptlet → présent
    expect(dtsExposed).toMatch(/include\(/);
    // doGet est entry_point_web mais pas exposed-to-client → absent
    expect(dtsExposed).not.toMatch(/\bdoGet\s*\(/);
  });
});

describe('emit-dts — return shapes', () => {
  it("génère SendEmailReportResult avec success et messageId", () => {
    expect(dts).toContain('interface SendEmailReportResult');
    expect(dts).toMatch(/success: boolean;/);
    expect(dts).toMatch(/messageId: \w+;/);
  });

  it("ne génère pas d'interface Result pour les fonctions sans shape connue", () => {
    expect(dts).not.toContain('interface DoGetResult');
    expect(dts).not.toContain('interface ListItemsResult');
  });

  it("référence l'interface depuis le commentaire de la méthode", () => {
    expect(dts).toMatch(/Retour: SendEmailReportResult.*\n\s+sendEmailReport/);
  });
});

describe('emit-dts — workspace', () => {
  it("émet correctement pour un projet d'un workspace (CommonUtils)", async () => {
    const wsRoot = resolve(here, 'fixtures/sample-workspace');
    const { scanWorkspace } = await import('../src/scanner.js');
    const ws = await scanWorkspace({ root: wsRoot });
    if (ws.kind !== 'workspace') throw new Error('expected workspace');
    const commonUtils = ws.projects.find((p) => p.project === 'CommonUtils')!;
    const dts2 = emitDts(commonUtils);
    expect(dts2).toContain('CommonUtils');
    expect(dts2).toMatch(/log\(msg: string\): void;/);
    expect(dts2).toMatch(/formatDate\(d: Date\): void;/);
    expect(dts2).not.toMatch(/privateHelper_\s*\(/);
  });
});
