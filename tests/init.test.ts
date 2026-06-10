import { describe, it, expect } from 'vitest';
import {
  CLAUDE_MD_ROOT,
  CLAUDE_SETTINGS_JSON,
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
});
