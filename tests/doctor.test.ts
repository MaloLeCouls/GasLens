import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor, renderDoctorText } from '../src/doctor.js';

const VALID_MASTER = JSON.stringify({
  version: 1,
  name: 'parc',
  environments: { dev: { resources: {} }, prod: { resources: {} } },
});

async function tempWith(manifest: string | null): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gaslens-doctor-'));
  if (manifest !== null) {
    await writeFile(join(root, 'gaslens.workspace.json'), manifest, 'utf8');
  }
  return root;
}

describe('doctor', () => {
  it('tout prêt → ok=true, exit 0, aucun error/warn', async () => {
    const root = await tempWith(VALID_MASTER);
    try {
      const r = await runDoctor({
        cwd: root,
        nodeVersion: '22.5.0',
        which: () => true,
        fileExists: () => true,
        home: root,
      });
      expect(r.exit_code).toBe(0);
      expect(r.ok).toBe(true);
      expect(r.checks.some((c) => c.status === 'error' || c.status === 'warn')).toBe(false);
      expect(r.checks.find((c) => c.id === 'node-version')?.status).toBe('ok');
      expect(r.checks.find((c) => c.id === 'workspace-manifest')?.status).toBe('ok');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('Node trop ancien → error + exit 1', async () => {
    const root = await tempWith(VALID_MASTER);
    try {
      const r = await runDoctor({
        cwd: root,
        nodeVersion: '20.10.0',
        which: () => true,
        fileExists: () => true,
        home: root,
      });
      expect(r.exit_code).toBe(1);
      expect(r.ok).toBe(false);
      const node = r.checks.find((c) => c.id === 'node-version');
      expect(node?.status).toBe('error');
      expect(node?.fix_hint).toContain('nvm');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('clasp non connecté → warn (ok=false) mais exit 0', async () => {
    const root = await tempWith(VALID_MASTER);
    try {
      const r = await runDoctor({
        cwd: root,
        nodeVersion: '22.0.0',
        which: () => true,
        fileExists: (p) => !p.endsWith('.clasprc.json'),
        home: root,
      });
      expect(r.exit_code).toBe(0);
      expect(r.ok).toBe(false);
      expect(r.checks.find((c) => c.id === 'clasp-login')?.status).toBe('warn');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('manifeste maître invalide → error', async () => {
    const root = await tempWith('{ pas du json');
    try {
      const r = await runDoctor({
        cwd: root,
        nodeVersion: '22.0.0',
        which: () => true,
        fileExists: () => true,
        home: root,
      });
      expect(r.checks.find((c) => c.id === 'workspace-manifest')?.status).toBe('error');
      expect(r.exit_code).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('API Apps Script + Chrome restent "manual" (jamais OK ni cassé)', async () => {
    const root = await tempWith(VALID_MASTER);
    try {
      const r = await runDoctor({
        cwd: root,
        nodeVersion: '22.0.0',
        which: () => true,
        fileExists: () => true,
        home: root,
      });
      expect(r.checks.find((c) => c.id === 'apps-script-api')?.status).toBe('manual');
      expect(r.checks.find((c) => c.id === 'chrome-remote-debug')?.status).toBe('manual');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('renderDoctorText --quiet-when-ok est vide quand tout est prêt', async () => {
    const root = await tempWith(VALID_MASTER);
    try {
      const r = await runDoctor({
        cwd: root,
        nodeVersion: '22.0.0',
        which: () => true,
        fileExists: () => true,
        home: root,
      });
      expect(renderDoctorText(r, true)).toBe('');
      expect(renderDoctorText(r, false).length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
