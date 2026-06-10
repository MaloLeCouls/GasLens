import type { Exposure } from '../types.js';
import type { RawCallSite } from './calls.js';

const SIMPLE_TRIGGERS = new Set([
  'onOpen',
  'onEdit',
  'onSelectionChange',
  'onInstall',
]);
const WEB_ENTRY_POINTS = new Set(['doGet', 'doPost']);

/**
 * Pour une définition donnée, dérive ses expositions issues de son *nom* :
 *   - doGet/doPost → entry_point_web
 *   - onOpen/onEdit/onSelectionChange/onInstall → simple_trigger
 */
export function exposuresFromName(
  name: string,
  file: string,
  line: number,
): Exposure[] {
  if (WEB_ENTRY_POINTS.has(name)) {
    return [{ type: 'entry_point_web', file, line, detail: name }];
  }
  if (SIMPLE_TRIGGERS.has(name)) {
    return [{ type: 'simple_trigger', file, line, detail: name }];
  }
  return [];
}

/**
 * Extrait les expositions « par chaîne » : `ScriptApp.newTrigger('runWeeklyReport')`
 * → expose `runWeeklyReport` comme installable_trigger.
 *
 * Retourne une map { nom de fonction exposée → liste d'expositions }, pour que
 * le scanner les attache aux records correspondants.
 */
export function installableTriggersFromCalls(
  callSites: RawCallSite[],
  file: string,
): Map<string, Exposure[]> {
  const out = new Map<string, Exposure[]>();
  for (const c of callSites) {
    if (
      c.receiver === 'ScriptApp' &&
      c.final_name === 'newTrigger' &&
      c.arguments_text.length >= 1
    ) {
      const raw = c.arguments_text[0]!;
      const literal = stringLiteral(raw);
      if (literal === null) continue;
      const exp: Exposure = {
        type: 'installable_trigger',
        file,
        line: c.line,
        detail: `ScriptApp.newTrigger('${literal}')`,
      };
      const list = out.get(literal) ?? [];
      list.push(exp);
      out.set(literal, list);
    }
  }
  return out;
}

function stringLiteral(text: string): string | null {
  const t = text.trim();
  if (t.length < 2) return null;
  const first = t[0];
  const last = t[t.length - 1];
  if ((first === "'" || first === '"') && first === last) {
    return t.slice(1, -1);
  }
  return null;
}
