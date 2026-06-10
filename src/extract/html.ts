/**
 * Extraction des morceaux JS embarqués dans un fichier HTML GAS :
 *   - scriptlets `<? ... ?>`, `<?= ... ?>`, `<?!= ... ?>` (exécutés côté serveur
 *     au moment du rendu) ;
 *   - blocs `<script> ... </script>` (JS *client*).
 *
 * Chaque chunk porte son offset (line/col 1-based) dans le fichier d'origine
 * pour que les positions des nodes tree-sitter puissent être réparentées.
 */

export type ScriptletKind = '<?' | '<?=' | '<?!=';

export interface HtmlChunk {
  /** Kind = 'script' pour un bloc <script>, sinon kind de scriptlet. */
  kind: ScriptletKind | 'script';
  /** Source JS du chunk (entre les délimiteurs). */
  source: string;
  /** Ligne 1-based du *premier caractère* du `source` dans le fichier HTML. */
  start_line: number;
  /** Colonne 0-based du premier caractère du `source` sur sa ligne d'origine. */
  start_col: number;
  /** Index octet de début du `source` dans le HTML brut (utile pour debug). */
  start_index: number;
}

export function extractHtmlChunks(html: string): HtmlChunk[] {
  const chunks: HtmlChunk[] = [];
  const posOf = makePosLookup(html);

  // Scriptlets — ordre des regex sans importance ici, on consomme tout le buffer
  // en un seul scan unifié pour préserver le pas-d'imbrication.
  const scriptletRe = /<\?(!=|=)?\s*([\s\S]*?)\s*\?>/g;
  let m: RegExpExecArray | null;
  while ((m = scriptletRe.exec(html)) !== null) {
    const sigil = m[1] ?? '';
    const body = m[2] ?? '';
    const kind: ScriptletKind = sigil === '!=' ? '<?!=' : sigil === '=' ? '<?=' : '<?';
    // start position of body: m.index points to `<?`; skip `<?` + sigil + the
    // whitespace that the regex collapsed. Use m.index + (m[0].indexOf(body)) for safety.
    const bodyOffsetInMatch = m[0].indexOf(body);
    const start_index = m.index + (bodyOffsetInMatch >= 0 ? bodyOffsetInMatch : 2);
    const p = posOf(start_index);
    chunks.push({
      kind,
      source: body,
      start_line: p.line,
      start_col: p.col,
      start_index,
    });
  }

  // Blocs <script>...</script>. On ignore les <script src="..."> (pas de body).
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  while ((m = scriptRe.exec(html)) !== null) {
    const attrs = m[1] ?? '';
    if (/\bsrc\s*=/.test(attrs)) continue;
    const body = m[2] ?? '';
    const bodyStartInMatch = m[0].length - m[0].slice(m[0].indexOf('>') + 1).length;
    // Plus simple : recalcule la position du premier char du body.
    const openTagEnd = html.indexOf('>', m.index) + 1;
    if (openTagEnd <= 0) continue;
    const start_index = openTagEnd;
    const p = posOf(start_index);
    chunks.push({
      kind: 'script',
      source: body,
      start_line: p.line,
      start_col: p.col,
      start_index,
    });
  }

  // Tri par position pour que les consommateurs voient l'ordre du fichier.
  chunks.sort((a, b) => a.start_index - b.start_index);
  return chunks;
}

/** Translate (row,col) tree-sitter du chunk en (line,col) 1-based fichier. */
export function translatePosition(
  chunk: HtmlChunk,
  nodeRow: number,
  nodeCol: number,
): { line: number; col: number } {
  // tree-sitter row est 0-based.
  if (nodeRow === 0) {
    return { line: chunk.start_line, col: chunk.start_col + nodeCol };
  }
  return { line: chunk.start_line + nodeRow, col: nodeCol };
}

function makePosLookup(text: string): (index: number) => { line: number; col: number } {
  // Précalcule l'offset (index) de début de chaque ligne.
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  return (index: number) => {
    // Recherche binaire de la plus grande ligne dont le start <= index.
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    const line = lo + 1; // 1-based
    const col = index - lineStarts[lo]!;
    return { line, col };
  };
}
