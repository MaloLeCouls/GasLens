import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';

let cached: Parser | null = null;

export function getJsParser(): Parser {
  if (cached) return cached;
  const p = new Parser();
  p.setLanguage(JavaScript);
  cached = p;
  return p;
}

export function parseSource(source: string): Parser.Tree {
  return getJsParser().parse(source);
}
