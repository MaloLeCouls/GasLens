/**
 * Extraction des signaux statiques côté HTML pour `lint-webapp` (V3 §21.4).
 * Pas d'AST HTML : regex ciblées sur les patterns connus, suffisant pour
 * un lint heuristique. Toute incertitude reste honnête (la règle s'abstient).
 */

export interface MixedContentRef {
  /** Type de tag d'origine (script, link, img, iframe, source, video, audio). */
  tag: string;
  /** Nom d'attribut (src / href / poster). */
  attr: string;
  /** URL http(s)://… extraite. */
  url: string;
  line: number;
}

export interface LinkWithoutTarget {
  href: string;
  line: number;
}

export interface FormWithoutPreventDefault {
  /** Texte du handler onsubmit/onclick (s'il y en a un), sinon null. */
  inline_handler: string | null;
  /** Vrai si le <form> contient un input/button type="submit" (donc default submit). */
  has_submit_control: boolean;
  line: number;
}

export interface ScriptHttpFetch {
  /** URL http:// littérale extraite d'un fetch / XHR open dans un <script>. */
  url: string;
  line: number;
}

export interface HtmlWebappFileExtract {
  file: string;
  has_base_target_top: boolean;
  mixed_content_refs: MixedContentRef[];
  links_without_target: LinkWithoutTarget[];
  forms_without_preventDefault: FormWithoutPreventDefault[];
  script_http_fetches: ScriptHttpFetch[];
}

/** Tags chargeant une ressource active dont l'URL importe pour mixed-content. */
const RESOURCE_TAG_ATTRS: Array<{ tag: string; attr: string }> = [
  { tag: 'script', attr: 'src' },
  { tag: 'link', attr: 'href' },
  { tag: 'img', attr: 'src' },
  { tag: 'iframe', attr: 'src' },
  { tag: 'source', attr: 'src' },
  { tag: 'video', attr: 'src' },
  { tag: 'video', attr: 'poster' },
  { tag: 'audio', attr: 'src' },
];

export function extractHtmlWebappSignals(
  file: string,
  html: string,
): HtmlWebappFileExtract {
  const lineOf = makeLineLookup(html);
  const has_base_target_top = /<base\b[^>]*\btarget\s*=\s*['"](?:_top|_blank)['"]/i.test(
    html,
  );

  const mixed_content_refs: MixedContentRef[] = [];
  for (const { tag, attr } of RESOURCE_TAG_ATTRS) {
    const re = new RegExp(
      `<${tag}\\b([^>]*)`,
      'gi',
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const attrs = m[1] ?? '';
      const url = extractAttrValue(attrs, attr);
      if (!url) continue;
      if (isHttpUrl(url)) {
        mixed_content_refs.push({
          tag,
          attr,
          url,
          line: lineOf(m.index),
        });
      }
    }
  }

  const links_without_target: LinkWithoutTarget[] = [];
  if (!has_base_target_top) {
    const aRe = /<a\b([^>]*)>/gi;
    let m: RegExpExecArray | null;
    while ((m = aRe.exec(html)) !== null) {
      const attrs = m[1] ?? '';
      const href = extractAttrValue(attrs, 'href');
      if (!href) continue;
      if (!isNavigationHref(href)) continue;
      const target = extractAttrValue(attrs, 'target');
      if (target) continue;
      links_without_target.push({ href, line: lineOf(m.index) });
    }
  }

  const forms_without_preventDefault: FormWithoutPreventDefault[] = [];
  const formRe = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let mForm: RegExpExecArray | null;
  while ((mForm = formRe.exec(html)) !== null) {
    const attrs = mForm[1] ?? '';
    const body = mForm[2] ?? '';
    const onsubmit = extractAttrValue(attrs, 'onsubmit');
    const action = extractAttrValue(attrs, 'action');
    const handler = onsubmit ?? null;
    const handlerStopsDefault =
      handler !== null &&
      (handler.includes('preventDefault') || /\breturn\s+false\b/.test(handler));
    if (handlerStopsDefault) continue;
    const has_submit_control =
      /<(?:input|button)\b[^>]*\btype\s*=\s*['"]submit['"]/i.test(body) ||
      /<button\b(?![^>]*\btype\s*=)[^>]*>/i.test(body); // <button> sans type = submit par défaut
    if (!has_submit_control) continue;
    // Si action est défini ET pointe vers une URL externe : aussi suspect, mais on
    // se contente du critère "submit control sans preventDefault" pour V1.
    forms_without_preventDefault.push({
      inline_handler: handler,
      has_submit_control,
      line: lineOf(mForm.index),
    });
    // action lue pour usage futur — pas utilisée en V1 mais évite le warning lint.
    void action;
  }

  const script_http_fetches = extractHttpFetchesInScripts(html, lineOf);

  return {
    file,
    has_base_target_top,
    mixed_content_refs,
    links_without_target,
    forms_without_preventDefault,
    script_http_fetches,
  };
}

function extractHttpFetchesInScripts(
  html: string,
  lineOf: (index: number) => number,
): ScriptHttpFetch[] {
  const out: ScriptHttpFetch[] = [];
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = scriptRe.exec(html)) !== null) {
    const body = m[1] ?? '';
    const bodyOffset = (m.index ?? 0) + (m[0].indexOf(body) >= 0 ? m[0].indexOf(body) : 0);
    // fetch('http://…') / XHR.open('GET', 'http://…') / .src = 'http://…'
    const patterns = [
      /\bfetch\s*\(\s*['"`](http:\/\/[^'"`]+)['"`]/g,
      /\.open\s*\(\s*['"`]\w+['"`]\s*,\s*['"`](http:\/\/[^'"`]+)['"`]/g,
      /\.src\s*=\s*['"`](http:\/\/[^'"`]+)['"`]/g,
    ];
    for (const re of patterns) {
      let p: RegExpExecArray | null;
      while ((p = re.exec(body)) !== null) {
        out.push({
          url: p[1] ?? '',
          line: lineOf(bodyOffset + (p.index ?? 0)),
        });
      }
    }
  }
  return out;
}

function extractAttrValue(attrs: string, name: string): string | null {
  // Match name="val" / name='val' / name=val (sans quote, jusqu'au whitespace ou >).
  const reQuoted = new RegExp(`\\b${name}\\s*=\\s*['"]([^'"]*)['"]`, 'i');
  const m = reQuoted.exec(attrs);
  if (m) return m[1] ?? null;
  const reBare = new RegExp(`\\b${name}\\s*=\\s*([^\\s>'"]+)`, 'i');
  const m2 = reBare.exec(attrs);
  if (m2) return m2[1] ?? null;
  return null;
}

function isHttpUrl(url: string): boolean {
  return /^http:\/\//i.test(url.trim());
}

function isNavigationHref(href: string): boolean {
  const h = href.trim();
  if (h.length === 0) return false;
  if (h.startsWith('#')) return false;
  if (h.startsWith('javascript:')) return false;
  if (h.startsWith('mailto:')) return false;
  if (h.startsWith('tel:')) return false;
  return true;
}

function makeLineLookup(text: string): (index: number) => number {
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  return (index: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}
