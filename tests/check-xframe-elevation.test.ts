/**
 * Élévation automatique de `webapp.xframe_missing` (G2 ↔ G4) : quand le projet
 * courant est déclaré embarqué dans un Google Site (`site_embeds` du manifeste
 * maître), le pipeline `check` élève le finding de info → warn (on SAIT alors
 * que l'absence d'ALLOWALL casse l'embed). Hors embed déclaré : reste info,
 * filtré par le seuil `warn` → absent du rapport check.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanProject } from '../src/scanner.js';
import { runCheck, resolveEmbeddedInSite } from '../src/check.js';

const DOGET_NO_ALLOWALL = `function doGet() { return HtmlService.createHtmlOutput('<b>hi</b>'); }`;

async function makeWorkspace(siteEmbeds: string[] | null): Promise<{ root: string; prodDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'gaslens-xframe-'));
  const app: Record<string, unknown> = {
    name: 'dash',
    projects: { prod: { script_id: 'DASH_PROD', clasp_path: 'apps/dash/prod' } },
  };
  if (siteEmbeds) app.site_embeds = siteEmbeds;
  await writeFile(
    join(root, 'gaslens.workspace.json'),
    JSON.stringify({
      version: 1,
      name: 'parc',
      apps: [app],
      environments: { dev: { resources: {} }, prod: { resources: {} } },
    }),
    'utf8',
  );
  const prodDir = join(root, 'apps', 'dash', 'prod');
  await mkdir(prodDir, { recursive: true });
  await writeFile(join(prodDir, 'appsscript.json'), '{"runtimeVersion":"V8"}', 'utf8');
  await writeFile(join(prodDir, 'Code.gs'), DOGET_NO_ALLOWALL, 'utf8');
  return { root, prodDir };
}

describe('check — élévation xframe automatique (G2↔G4)', () => {
  it('resolveEmbeddedInSite=true quand l\'app du projet déclare site_embeds', async () => {
    const { root, prodDir } = await makeWorkspace(['https://sites.google.com/view/x']);
    try {
      expect(await resolveEmbeddedInSite(prodDir)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('WARN xframe dans le rapport check quand site_embeds est déclaré', async () => {
    const { root, prodDir } = await makeWorkspace(['https://sites.google.com/view/x']);
    try {
      const baseline = await scanProject({ root: prodDir });
      const { report } = await runCheck({ baseline, currentRoot: prodDir });
      const f = report.warns.find((x) => x.consumer_kind === 'webapp.xframe_missing');
      expect(f).toBeDefined();
      expect(f?.severity).toBe('warn');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('PAS de xframe dans le rapport check sans site_embeds (reste info, filtré)', async () => {
    const { root, prodDir } = await makeWorkspace(null);
    try {
      const baseline = await scanProject({ root: prodDir });
      const { report } = await runCheck({ baseline, currentRoot: prodDir });
      const all = [...report.breaks, ...report.warns];
      expect(all.some((x) => x.consumer_kind === 'webapp.xframe_missing')).toBe(false);
      expect(await resolveEmbeddedInSite(prodDir)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
