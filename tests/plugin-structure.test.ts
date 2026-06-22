import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const readJson = (rel: string): any => JSON.parse(readFileSync(join(repo, rel), 'utf8'));
const readText = (rel: string): string => readFileSync(join(repo, rel), 'utf8');

const SKILLS = [
  'gas-dev-loop',
  'intake-triage',
  'onboard-app',
  'provision-env',
  'refresh-dev-data',
  'snapshot-sources',
  'promote-deploy',
];
const COMMANDS = [
  'gaslens-init-workspace',
  'gaslens-onboard-app',
  'gaslens-promote',
  'gaslens-doctor',
];

describe('plugin — .claude-plugin', () => {
  it('plugin.json est valide et nommé gaslens', () => {
    const p = readJson('.claude-plugin/plugin.json');
    expect(p.name).toBe('gaslens');
    expect(typeof p.version).toBe('string');
    expect(p.mcpServers).toBeDefined();
  });

  it('marketplace.json référence le plugin gaslens à la racine', () => {
    const m = readJson('.claude-plugin/marketplace.json');
    expect(m.name).toBe('gaslens');
    expect(Array.isArray(m.plugins)).toBe(true);
    expect(m.plugins[0].name).toBe('gaslens');
    expect(m.plugins[0].source).toBe('.');
  });
});

describe('plugin — hooks & mcp', () => {
  it('hooks.json câble PostToolUse→hook et SessionStart→doctor', () => {
    const h = readJson('hooks/hooks.json');
    const post = h.hooks.PostToolUse[0];
    expect(post.matcher).toBe('Write|Edit|MultiEdit');
    expect(post.hooks[0].command).toContain('gaslens hook');
    const start = h.hooks.SessionStart[0];
    expect(start.hooks[0].command).toContain('gaslens doctor');
    expect(start.hooks[0].command).toContain('--quiet-when-ok');
  });

  it('.mcp.json déclare chrome-devtools en --autoConnect, version épinglée', () => {
    const m = readJson('.mcp.json');
    const chrome = m.mcpServers['chrome-devtools'];
    expect(chrome.command).toBe('npx');
    expect(chrome.args).toContain('--autoConnect');
    const pkg = (chrome.args as string[]).find((a) => a.startsWith('chrome-devtools-mcp@'));
    expect(pkg).toBeDefined();
    expect(pkg).not.toBe('chrome-devtools-mcp@latest'); // épinglé (V5 §37.8)
  });
});

describe('plugin — skills', () => {
  it.each(SKILLS)('skill %s a un SKILL.md avec frontmatter name/description', (skill) => {
    const path = `skills/${skill}/SKILL.md`;
    expect(existsSync(join(repo, path))).toBe(true);
    const text = readText(path);
    expect(text.startsWith('---')).toBe(true);
    expect(new RegExp(`name:\\s*${skill}\\b`).test(text)).toBe(true);
    expect(/description:\s*\S/.test(text)).toBe(true);
  });
});

describe('plugin — slash commands', () => {
  it.each(COMMANDS)('commande %s existe avec une description', (cmd) => {
    const path = `commands/${cmd}.md`;
    expect(existsSync(join(repo, path))).toBe(true);
    const text = readText(path);
    expect(/description:\s*\S/.test(text)).toBe(true);
  });
});

describe('plugin — templates', () => {
  it('les fragments claude-md sont présents', () => {
    for (const f of ['root.md', 'app.md', 'project.md']) {
      expect(existsSync(join(repo, 'templates/claude-md', f))).toBe(true);
    }
  });
});
