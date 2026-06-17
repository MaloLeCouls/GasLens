import { describe, it, expect } from 'vitest';
import {
  CLAUDE_MD_ROOT,
  CLAUDE_SETTINGS_JSON,
  GASLENS_SKILL_MD,
  SETUP_GUIDE,
  claudeMdSubrepo,
} from '../src/init.js';

describe('init — recettes V2 §16', () => {
  it("CLAUDE.md racine mentionne le hook PostToolUse + le contrat de confiance", () => {
    expect(CLAUDE_MD_ROOT).toContain('PostToolUse');
    expect(CLAUDE_MD_ROOT).toContain('gaslens inspect');
    expect(CLAUDE_MD_ROOT).toContain("CE QUE gaslens VÉRIFIE DÉJÀ");
    expect(CLAUDE_MD_ROOT).toContain("CE QUE TU DOIS ENCORE ÉVALUER TOI-MÊME");
  });

  it("settings.json contient le matcher Write|Edit|MultiEdit et la commande gaslens hook", () => {
    expect(CLAUDE_SETTINGS_JSON).toContain('"PostToolUse"');
    expect(CLAUDE_SETTINGS_JSON).toContain('Write|Edit|MultiEdit');
    expect(CLAUDE_SETTINGS_JSON).toContain('gaslens hook --event post-tool-use');
    // Sanity : c'est du JSON valide.
    const parsed = JSON.parse(CLAUDE_SETTINGS_JSON);
    expect(parsed.hooks.PostToolUse[0].matcher).toBe('Write|Edit|MultiEdit');
  });

  it("subrepo template prend un nom de projet", () => {
    const out = claudeMdSubrepo('ProjectA', 'CommonUtils');
    expect(out).toContain('ProjectA');
    expect(out).toContain('CommonUtils');
    expect(out).toContain('google.script.run');
  });

  it("guide inclut les 3 blocs", () => {
    expect(SETUP_GUIDE).toContain('gaslens scan');
    expect(SETUP_GUIDE).toContain(CLAUDE_MD_ROOT.split('\n')[0]!);
    expect(SETUP_GUIDE).toContain('PostToolUse');
  });

  it("Skill Claude Code expose le frontmatter `name`/`description` et le workflow", () => {
    expect(GASLENS_SKILL_MD.startsWith('---\n')).toBe(true);
    expect(GASLENS_SKILL_MD).toContain('name: gaslens');
    expect(GASLENS_SKILL_MD).toMatch(/description:\s/);
    // Quand utiliser → setup → workflow par tâche → commandes → discipline.
    expect(GASLENS_SKILL_MD).toContain('Quand utiliser cette skill');
    expect(GASLENS_SKILL_MD).toContain('Setup');
    expect(GASLENS_SKILL_MD).toContain('Workflow par tâche');
    expect(GASLENS_SKILL_MD).toContain('--compact');
    expect(GASLENS_SKILL_MD).toContain("Exit codes");
    expect(GASLENS_SKILL_MD).toContain("coverage.unresolved");
  });

  it("Skill liste les 14 commandes principales (au moins celles attendues)", () => {
    for (const cmd of [
      'scan',
      'map',
      'inspect',
      'impact',
      'diff',
      'check',
      'manifest',
      'validate-api',
      'lint-runtime',
      'lint-webapp',
      'emit-dts',
      'emit-contract-tests',
      'commands',
      'init',
      'eval',
    ]) {
      expect(GASLENS_SKILL_MD).toContain(cmd);
    }
  });

  it("Skill expose les capacités hors hook chaud V3 §22 (resolve-live / prod-truth / deploy-aware)", () => {
    expect(GASLENS_SKILL_MD).toContain('resolve-live');
    expect(GASLENS_SKILL_MD).toContain('prod-truth');
    expect(GASLENS_SKILL_MD).toContain('deploy-aware');
    // Doit être clair que ces commandes sont opt-in.
    expect(GASLENS_SKILL_MD).toMatch(/hors hook chaud|opt-in|jamais automatiquement/i);
    // Et la résolution scriptId via .clasp.json doit être mentionnée pour
    // l'agent qui ne saurait pas où trouver les overrides.
    expect(GASLENS_SKILL_MD).toContain('.clasp.json');
  });

  it("Skill mentionne --runner gas-fakes (V3 §23) pour les tests de contrat locaux", () => {
    expect(GASLENS_SKILL_MD).toContain('gas-fakes');
  });
});
