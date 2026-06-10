import type { FunctionRecord, ProjectIndex } from './types.js';
import {
  aggregateVerdict,
  summarize,
  type Finding,
  type ImpactReport,
} from './findings.js';

/**
 * DSL des changements supportés. V0 reste volontairement réduit au plus rentable.
 */
export type ChangeSpec =
  | { kind: 'change-return-shape'; removed: string[]; added: string[] }
  | { kind: 'remove-param'; param: string }
  | { kind: 'rename-param'; from: string; to: string }
  | { kind: 'rename'; new_name: string };

export interface ImpactOptions {
  /** Filtre les findings : seules sont émises celles >= ce seuil. */
  severity_threshold: 'info' | 'warn' | 'break';
}

export interface ImpactNotFound {
  kind: 'not_found';
  name: string;
  message: string;
}

export type ImpactResult = { kind: 'found'; report: ImpactReport } | ImpactNotFound;

/**
 * Parse une chaîne de la forme :
 *   - `change-return-shape:'-messageId,-id,+ok'`  (uses single quotes optionally)
 *   - `change-return-shape:-messageId`
 *   - `remove-param:recipients`
 *   - `rename-param:old=new`
 *   - `rename:newName`
 */
export function parseChangeSpec(input: string): ChangeSpec {
  const raw = input.trim().replace(/^['"]|['"]$/g, '');
  const colon = raw.indexOf(':');
  if (colon < 0) {
    throw new Error(
      `--change : format attendu 'kind:args' (ex. 'remove-param:recipients'). Reçu : '${input}'.`,
    );
  }
  const kind = raw.slice(0, colon).trim();
  const args = raw.slice(colon + 1).trim().replace(/^['"]|['"]$/g, '');

  switch (kind) {
    case 'change-return-shape': {
      const removed: string[] = [];
      const added: string[] = [];
      for (const token of args.split(',').map((s) => s.trim()).filter(Boolean)) {
        if (token.startsWith('-')) removed.push(token.slice(1).trim());
        else if (token.startsWith('+')) added.push(token.slice(1).trim());
        else throw new Error(
          `change-return-shape : chaque entrée doit commencer par '-' ou '+' (ex. '-messageId'). Reçu : '${token}'.`,
        );
      }
      if (removed.length === 0 && added.length === 0) {
        throw new Error("change-return-shape : aucun champ spécifié.");
      }
      return { kind: 'change-return-shape', removed, added };
    }
    case 'remove-param': {
      if (!args) throw new Error("remove-param : nom de paramètre manquant.");
      return { kind: 'remove-param', param: args };
    }
    case 'rename-param': {
      const eq = args.indexOf('=');
      if (eq < 0) throw new Error("rename-param : format 'old=new' attendu.");
      const from = args.slice(0, eq).trim();
      const to = args.slice(eq + 1).trim();
      if (!from || !to) throw new Error("rename-param : 'old' et 'new' requis.");
      return { kind: 'rename-param', from, to };
    }
    case 'rename': {
      if (!args) throw new Error("rename : nouveau nom manquant.");
      return { kind: 'rename', new_name: args };
    }
    default:
      throw new Error(
        `--change : kind '${kind}' inconnu. Supportés : change-return-shape, remove-param, rename-param, rename.`,
      );
  }
}

export function impact(
  index: ProjectIndex,
  fnName: string,
  change: ChangeSpec,
  opts: ImpactOptions = { severity_threshold: 'warn' },
): ImpactResult {
  const rec = index.functions.find((f) => f.name === fnName);
  if (!rec) {
    return {
      kind: 'not_found',
      name: fnName,
      message: `La fonction '${fnName}' est introuvable dans l'index. Lance 'gaslens scan' sur le bon dossier et vérifie le nom (option --fuzzy de inspect peut aider).`,
    };
  }

  const breaks: Finding[] = [];
  const warns: Finding[] = [];
  const safe: Finding[] = [];

  switch (change.kind) {
    case 'change-return-shape':
      applyChangeReturnShape(rec, change, breaks, safe);
      break;
    case 'remove-param':
      applyRemoveParam(rec, change, breaks, warns);
      break;
    case 'rename-param':
      applyRenameParam(rec, change, warns);
      break;
    case 'rename':
      applyRename(rec, change, breaks);
      break;
  }

  const filtered = filterBySeverity(breaks, warns, safe, opts.severity_threshold);
  const verdict = aggregateVerdict(filtered.breaks, filtered.warns);
  const coverage = {
    resolved_pct: rec.coverage.resolved_pct,
    confidence: rec.coverage.confidence,
    unresolved: rec.coverage.unresolved.map((u) => ({
      what: u.what,
      where: u.where,
      reason: u.reason,
    })),
    external_boundaries: rec.coverage.external_boundaries,
  };

  return {
    kind: 'found',
    report: {
      symbol: rec.id,
      proposed_change: describeChange(change),
      breaks: filtered.breaks,
      warns: filtered.warns,
      safe: filtered.safe,
      coverage,
      verdict,
      summary: summarize(filtered.breaks, filtered.warns, coverage.resolved_pct),
    },
  };
}

function describeChange(c: ChangeSpec): string {
  switch (c.kind) {
    case 'change-return-shape': {
      const parts: string[] = [];
      if (c.removed.length) parts.push(`retire ${c.removed.map((s) => `'${s}'`).join(', ')}`);
      if (c.added.length) parts.push(`ajoute ${c.added.map((s) => `'${s}'`).join(', ')}`);
      return `change-return-shape: ${parts.join(' / ')}`;
    }
    case 'remove-param':
      return `remove-param: '${c.param}'`;
    case 'rename-param':
      return `rename-param: '${c.from}' → '${c.to}'`;
    case 'rename':
      return `rename: → '${c.new_name}'`;
  }
}

function applyChangeReturnShape(
  rec: FunctionRecord,
  c: { removed: string[]; added: string[] },
  breaks: Finding[],
  safe: Finding[],
): void {
  const ic = rec.inferred_contract;
  const reads = ic?.return_shape?.fields_read ?? [];
  for (const field of c.removed) {
    let hit = false;
    for (const r of reads) {
      if (r.field !== field) continue;
      hit = true;
      breaks.push({
        severity: 'break',
        symbol: rec.id,
        consumer: { file: r.file, line: r.line },
        consumer_kind: 'client_call.success_handler',
        reason: `le successHandler '${r.handler}' lit result.${field} → deviendra undefined si le champ est retiré`,
        fix_hint: `soit retirer la lecture de '${field}' côté client (${r.file}:${r.line}), soit conserver le champ dans le retour serveur`,
        caused_by: `${rec.name} / return.field_removed:${field}`,
      });
    }
    if (!hit) {
      safe.push({
        severity: 'safe',
        symbol: rec.id,
        consumer: { file: rec.definition.file, line: rec.definition.line },
        consumer_kind: 'internal_caller',
        reason: `champ '${field}' n'est lu par aucun handler analysé — retrait apparemment safe (cf. coverage)`,
      });
    }
  }
  for (const field of c.added) {
    safe.push({
      severity: 'safe',
      symbol: rec.id,
      consumer: { file: rec.definition.file, line: rec.definition.line },
      consumer_kind: 'internal_caller',
      reason: `ajout du champ '${field}' au retour — backward-compatible côté consommateurs`,
    });
  }
}

function applyRemoveParam(
  rec: FunctionRecord,
  c: { param: string },
  breaks: Finding[],
  warns: Finding[],
): void {
  const pos = rec.definition.params.findIndex((p) => p.name === c.param);
  if (pos < 0) {
    warns.push({
      severity: 'warn',
      symbol: rec.id,
      consumer: { file: rec.definition.file, line: rec.definition.line },
      consumer_kind: 'internal_caller',
      reason: `aucun paramètre nommé '${c.param}' sur ${rec.name} — vérifier la signature avant`,
    });
    return;
  }
  // Pour chaque caller, vérifier le nombre d'arguments passés à cette position.
  for (const caller of rec.called_by) {
    const argsCount = caller.arguments_text.length;
    if (argsCount > pos) {
      const file = qualifyFile(caller.file, caller.caller_project);
      breaks.push({
        severity: 'break',
        symbol: rec.id,
        consumer: { file, line: caller.line },
        consumer_kind: 'internal_caller',
        reason: `${caller.caller} passe un argument en position ${pos} ('${caller.arguments_text[pos]}') qui serait ignoré`,
        fix_hint: `retirer cet argument du site d'appel ${file}:${caller.line}`,
        caused_by: `${rec.name} / param.removed:${c.param}`,
      });
    }
  }
  // Côté google.script.run, l'argument est aussi passé positionnellement.
  for (const exp of rec.exposures) {
    if (exp.type !== 'client_call') continue;
    const args = exp.arguments_text ?? [];
    if (args.length > pos) {
      breaks.push({
        severity: 'break',
        symbol: rec.id,
        consumer: { file: exp.file, line: exp.line },
        consumer_kind: 'client_call.invocation',
        reason: `google.script.run.${rec.name} passe un argument en position ${pos} ('${args[pos]}') — il serait ignoré`,
        fix_hint: `retirer l'argument du site google.script.run`,
        caused_by: `${rec.name} / param.removed:${c.param}`,
      });
    }
  }
}

function applyRenameParam(
  rec: FunctionRecord,
  c: { from: string; to: string },
  warns: Finding[],
): void {
  // Rename de param est interne. Aucun consommateur externe ne dépend du nom
  // d'un param positionnel. On émet juste un warn informatif.
  if (rec.definition.params.findIndex((p) => p.name === c.from) < 0) {
    warns.push({
      severity: 'warn',
      symbol: rec.id,
      consumer: { file: rec.definition.file, line: rec.definition.line },
      consumer_kind: 'internal_caller',
      reason: `paramètre '${c.from}' introuvable — vérifier la signature avant le rename`,
    });
    return;
  }
  warns.push({
    severity: 'warn',
    symbol: rec.id,
    consumer: { file: rec.definition.file, line: rec.definition.line },
    consumer_kind: 'internal_caller',
    reason: `rename interne '${c.from}' → '${c.to}' — pas d'impact externe en GAS (params positionnels), mais penser à mettre à jour la JSDoc et le corps`,
  });
}

function applyRename(
  rec: FunctionRecord,
  c: { new_name: string },
  breaks: Finding[],
): void {
  // Tous les callers internes se basent sur le nom — chacun casse.
  for (const caller of rec.called_by) {
    const file = qualifyFile(caller.file, caller.caller_project);
    breaks.push({
      severity: 'break',
      symbol: rec.id,
      consumer: { file, line: caller.line },
      consumer_kind: 'internal_caller',
      reason: `${caller.caller} appelle ${rec.name}(...) ; après rename → identifier introuvable`,
      fix_hint: `remplacer ${rec.name} par ${c.new_name} au site ${file}:${caller.line}`,
      caused_by: `${rec.name} / rename:${c.new_name}`,
    });
  }
  // Expositions — chacune est par nom (string ou identifier).
  for (const exp of rec.exposures) {
    switch (exp.type) {
      case 'client_call':
        breaks.push({
          severity: 'break',
          symbol: rec.id,
          consumer: { file: exp.file, line: exp.line },
          consumer_kind: 'client_call.invocation',
          reason: `google.script.run.${rec.name}(...) référence le nom serveur — après rename → "fonction introuvable" côté client`,
          fix_hint: `remplacer .${rec.name}(...) par .${c.new_name}(...)`,
          caused_by: `${rec.name} / rename:${c.new_name}`,
        });
        break;
      case 'scriptlet':
        breaks.push({
          severity: 'break',
          symbol: rec.id,
          consumer: { file: exp.file, line: exp.line },
          consumer_kind: 'scriptlet',
          reason: `scriptlet ${exp.scriptlet_kind ?? '<?'} ${rec.name}(...) — le rendu serveur cherchera l'ancien nom`,
          fix_hint: `remplacer ${rec.name} par ${c.new_name} dans le scriptlet`,
          caused_by: `${rec.name} / rename:${c.new_name}`,
        });
        break;
      case 'installable_trigger':
        breaks.push({
          severity: 'break',
          symbol: rec.id,
          consumer: { file: exp.file, line: exp.line },
          consumer_kind: 'installable_trigger',
          reason: `ScriptApp.newTrigger('${rec.name}') référence l'ancien nom par chaîne — après rename → trigger orphelin`,
          fix_hint: `remplacer la chaîne par '${c.new_name}', et vérifier les triggers installés en prod`,
          caused_by: `${rec.name} / rename:${c.new_name}`,
        });
        break;
      case 'entry_point_web':
        breaks.push({
          severity: 'break',
          symbol: rec.id,
          consumer: { file: exp.file, line: exp.line },
          consumer_kind: 'entry_point_web',
          reason: `${rec.name} est un entry point web (doGet/doPost) — le renommer casse le routage HTTP de la web app`,
          fix_hint: `garder le nom doGet/doPost, ou modifier le déploiement`,
          caused_by: `${rec.name} / rename:${c.new_name}`,
        });
        break;
      case 'simple_trigger':
        breaks.push({
          severity: 'break',
          symbol: rec.id,
          consumer: { file: exp.file, line: exp.line },
          consumer_kind: 'simple_trigger',
          reason: `${rec.name} est un simple trigger réservé — le renommer désactive l'exécution automatique`,
          caused_by: `${rec.name} / rename:${c.new_name}`,
        });
        break;
    }
  }
}

function qualifyFile(file: string, callerProject?: string): string {
  return callerProject ? `${callerProject}/${file}` : file;
}

function filterBySeverity(
  breaks: Finding[],
  warns: Finding[],
  safe: Finding[],
  threshold: 'info' | 'warn' | 'break',
): { breaks: Finding[]; warns: Finding[]; safe: Finding[] } {
  if (threshold === 'break') return { breaks, warns: [], safe: [] };
  if (threshold === 'warn') return { breaks, warns, safe: [] };
  return { breaks, warns, safe };
}
