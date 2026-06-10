declare module 'tree-sitter' {
  export interface Point {
    row: number;
    column: number;
  }

  export interface SyntaxNode {
    readonly type: string;
    readonly text: string;
    readonly startPosition: Point;
    readonly endPosition: Point;
    readonly startIndex: number;
    readonly endIndex: number;
    readonly parent: SyntaxNode | null;
    readonly children: SyntaxNode[];
    readonly namedChildren: SyntaxNode[];
    readonly childCount: number;
    readonly namedChildCount: number;
    readonly firstChild: SyntaxNode | null;
    readonly firstNamedChild: SyntaxNode | null;
    readonly lastChild: SyntaxNode | null;
    readonly lastNamedChild: SyntaxNode | null;
    readonly nextSibling: SyntaxNode | null;
    readonly nextNamedSibling: SyntaxNode | null;
    readonly previousSibling: SyntaxNode | null;
    readonly previousNamedSibling: SyntaxNode | null;
    child(index: number): SyntaxNode | null;
    namedChild(index: number): SyntaxNode | null;
    childForFieldName(name: string): SyntaxNode | null;
    descendantsOfType(type: string | string[]): SyntaxNode[];
    toString(): string;
  }

  export interface Tree {
    readonly rootNode: SyntaxNode;
  }

  export interface Language {
    readonly nodeTypeCount: number;
  }

  export default class Parser {
    constructor();
    setLanguage(language: Language): void;
    parse(input: string): Tree;
  }
}

declare module 'tree-sitter-javascript' {
  import { Language } from 'tree-sitter';
  const language: Language;
  export default language;
}
