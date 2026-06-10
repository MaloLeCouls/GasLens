import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile, copyFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { runHook, findProjectRoot, pickBaseline } from '../src/hook.js';
import { scanProject } from '../src/scanner.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, 'fixtures/sample-project');

async function copyTree(src: string, dst: string): Promise<void> {
  await mkdir(dst, { recursive: true });
  for (const e of await readdir(src, { withFileTypes: true })) {
    const s = join(src, e.name);
    const d = join(dst, e.name);
    if (e.isDirectory()) await copyTree(s, d);
    else await copyFile(s, d);
  }
}

describe('hook — orchestration', () => {
  it('skipped si stdin n\'est pas du JSON', async () => {
    const o = await runHook({ stdinJson: 'not json' });
    expect(o.kind).toBe('skipped');
  });

  it("skipped si tool_input.file_path absent", async () => {
    const o = await runHook({
      stdinJson: JSON.stringify({ tool_name: 'Edit', tool_input: {} }),
    });
    expect(o.kind).toBe('skipped');
  });

  it("skipped si fichier non-GAS (.js, .ts, .md, etc.)", async () => {
    const o = await runHook({
      stdinJson: JSON.stringify({
        tool_name: 'Edit',
        tool_input: { file_path: '/tmp/some/file.ts' },
      }),
    });
    expect(o.kind).toBe('skipped');
    if (o.kind === 'skipped') expect(o.reason).toContain('non-GAS');
  });
});

describe('findProjectRoot', () => {
  it("trouve la racine via appsscript.json en remontant depuis un .gs", () => {
    const filePath = join(FIXTURE, 'email.gs');
    const root = findProjectRoot(filePath, FIXTURE);
    expect(root).toBe(FIXTURE);
  });

  it("renvoie null si rien trouvé jusqu'à la racine du disque", () => {
    const root = findProjectRoot('/nonexistent/deeply/nested/file.gs', '/');
    // Sur Windows ou Linux, dépend de la racine — on accepte string OU null
    // tant que ce n'est pas le dossier fictif.
    expect(root === null || (root && !root.includes('nonexistent'))).toBe(true);
  });
});

describe('pickBaseline', () => {
  it("priorise baseline.json sur index.json", async () => {
    // dans le fixture, .gaslens/index.json existe ; on ajoute temporairement
    // un baseline.json et on vérifie qu'il est préféré.
    const idxDir = join(FIXTURE, '.gaslens');
    await mkdir(idxDir, { recursive: true });
    const baselinePath = join(idxDir, 'baseline.json');
    await writeFile(baselinePath, '{}');
    const picked = pickBaseline(FIXTURE);
    expect(picked).toBe(baselinePath);
    await rm(baselinePath);
  });

  it("tombe sur index.json si pas de baseline.json", async () => {
    // S'assurer qu'il n'y a pas de baseline.json
    const baselinePath = join(FIXTURE, '.gaslens', 'baseline.json');
    try { await rm(baselinePath); } catch {}
    // Doit avoir un index.json existant (du scan précédent dans la session)
    const idx = await scanProject({ root: FIXTURE });
    await mkdir(join(FIXTURE, '.gaslens'), { recursive: true });
    await writeFile(join(FIXTURE, '.gaslens', 'index.json'), JSON.stringify(idx));
    const picked = pickBaseline(FIXTURE);
    expect(picked).toBe(join(FIXTURE, '.gaslens', 'index.json'));
  });
});

describe('hook — intégration sur copie temporaire', () => {
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'gaslens-hook-'));
    await copyTree(FIXTURE, tmpRoot);
    // Scan baseline
    const baseline = await scanProject({ root: tmpRoot });
    await mkdir(join(tmpRoot, '.gaslens'), { recursive: true });
    await writeFile(
      join(tmpRoot, '.gaslens', 'baseline.json'),
      JSON.stringify(baseline),
    );
  });

  afterAll(async () => {
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
  });

  it('CLEAN quand le fichier n\'a pas changé depuis la baseline', async () => {
    const payload = JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: join(tmpRoot, 'email.gs') },
    });
    const o = await runHook({ stdinJson: payload });
    expect(o.kind).toBe('clean');
  });

  it('BLOCK avec hookPayload JSON quand on retire messageId du retour', async () => {
    // Modifie email.gs pour retirer messageId du JSDoc et du return.
    const newSrc = `/**
 * Envoie un rapport par email.
 * @param {Object} reportData
 * @param {string[]} recipients
 * @returns {{success: boolean}}
 */
function sendEmailReport(reportData, recipients) {
  const body = formatReport(reportData);
  recipients.forEach(function (r) { GmailApp.sendEmail(r, 'Rapport', body); });
  return { success: true };
}
function formatReport(data) { return 'Rapport: ' + JSON.stringify(data); }
function generateId_() { return Utilities.getUuid(); }
`;
    await writeFile(join(tmpRoot, 'email.gs'), newSrc);

    const payload = JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: join(tmpRoot, 'email.gs') },
    });
    const o = await runHook({ stdinJson: payload });
    expect(o.kind).toBe('block');
    if (o.kind === 'block') {
      const parsed = JSON.parse(o.hookPayload) as {
        decision: string;
        reason: string;
        suppressOutput: boolean;
      };
      expect(parsed.decision).toBe('block');
      expect(parsed.suppressOutput).toBe(true);
      expect(parsed.reason).toContain('messageId');
      expect(parsed.reason).toContain('dashboard.html');
      expect(o.report.verdict).toBe('BREAK');
    }
  });
});
