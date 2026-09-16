/**
 * Colouring code in the inspector.
 *
 * Small on purpose. This is a reader's highlighter, not a parser: it finds
 * comments, strings, numbers, keywords and names by scanning, and anything it
 * cannot classify is left plain. Getting an unusual line slightly wrong costs
 * nothing, so nothing here is worth a dependency or a grammar.
 */

export type Language = "typescript" | "python" | "json" | "plain";

type Kind = "comment" | "string" | "number" | "keyword" | "type" | "name" | "punct" | "key";

interface Token {
  text: string;
  /** Null for text that carries no colour of its own. */
  kind: Kind | null;
}

const TS_KEYWORDS = new Set([
  "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "default", "delete",
  "do", "else", "enum", "export", "extends", "false", "finally", "for", "from", "function", "if",
  "implements", "import", "in", "instanceof", "interface", "is", "keyof", "let", "new", "null", "of",
  "private", "protected", "public", "readonly", "return", "satisfies", "static", "super", "switch",
  "this", "throw", "true", "try", "type", "typeof", "undefined", "var", "void", "while", "yield",
]);

const PY_KEYWORDS = new Set([
  "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else",
  "except", "False", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "None",
  "nonlocal", "not", "or", "pass", "raise", "return", "True", "try", "while", "with", "yield",
]);

/** What a language's comments and strings look like. Everything else is scanned the same way. */
interface Grammar {
  lineComment: string;
  blockComment: [string, string] | null;
  quotes: string[];
  /** Python's triple-quoted strings, which run over several lines. */
  tripleQuotes: boolean;
  keywords: Set<string>;
}

const TYPESCRIPT: Grammar = {
  lineComment: "//",
  blockComment: ["/*", "*/"],
  quotes: ['"', "'", "`"],
  tripleQuotes: false,
  keywords: TS_KEYWORDS,
};

const PYTHON: Grammar = {
  lineComment: "#",
  blockComment: null,
  quotes: ['"', "'"],
  tripleQuotes: true,
  keywords: PY_KEYWORDS,
};

const LETTER = /[A-Za-z_$]/;
const WORD = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;
const PUNCTUATION = /[{}()[\];:,.<>=+\-*/%!?&|^~]/;

/** The language a file is written in, from what the block says and what the file is called. */
export function languageOf(blockLanguage: string | null | undefined, file?: string): Language {
  if (file?.endsWith(".py")) return "python";
  if (file?.endsWith(".ts") || file?.endsWith(".tsx") || file?.endsWith(".js")) return "typescript";
  if (file?.endsWith(".json")) return "json";
  if (blockLanguage === "python") return "python";
  if (blockLanguage === "typescript") return "typescript";
  return "plain";
}

/**
 * Collects what a scan finds. Text that carries no colour of its own is
 * gathered as it goes and only becomes a token when a coloured one interrupts
 * it, so the tokens are as few as the colouring allows.
 */
function collector() {
  const tokens: Token[] = [];
  let plain = "";
  return {
    /** Text with no colour of its own. */
    plain(text: string): void {
      plain += text;
    },
    /** A coloured run, which ends whatever plain text came before it. */
    push(text: string, kind: Kind): void {
      if (plain) tokens.push({ text: plain, kind: null });
      plain = "";
      tokens.push({ text, kind });
    },
    /** Everything found, with any trailing plain text included. */
    done(): Token[] {
      if (plain) tokens.push({ text: plain, kind: null });
      plain = "";
      return tokens;
    },
  };
}

function scanCode(code: string, grammar: Grammar): Token[] {
  const found = collector();
  const push = (text: string, kind: Kind) => found.push(text, kind);
  let i = 0;

  /**
   * Where a run of text closed by `close` ends, given where its body starts.
   * An ordinary string ends at the line it started on however it was written,
   * so a quote this scanner misreads — one inside a regular expression, say —
   * spoils that line and no more.
   */
  const until = (from: number, close: string, escapes: boolean, oneLine = false): number => {
    let at = from;
    while (at < code.length) {
      if (oneLine && code[at] === "\n") return at;
      if (escapes && code[at] === "\\") {
        at += 2;
        continue;
      }
      if (code.startsWith(close, at)) return at + close.length;
      at += 1;
    }
    return code.length;
  };

  while (i < code.length) {
    const rest = code.slice(i);

    if (rest.startsWith(grammar.lineComment)) {
      const end = code.indexOf("\n", i);
      push(code.slice(i, end === -1 ? code.length : end), "comment");
      i = end === -1 ? code.length : end;
      continue;
    }

    if (grammar.blockComment && rest.startsWith(grammar.blockComment[0])) {
      const end = until(i + grammar.blockComment[0].length, grammar.blockComment[1], false);
      push(code.slice(i, end), "comment");
      i = end;
      continue;
    }

    const triple = grammar.tripleQuotes
      ? grammar.quotes.map((quote) => quote.repeat(3)).find((quote) => rest.startsWith(quote))
      : undefined;
    if (triple) {
      const end = until(i + 3, triple, true);
      push(code.slice(i, end), "string");
      i = end;
      continue;
    }

    const quote = grammar.quotes.find((mark) => rest.startsWith(mark));
    if (quote) {
      const end = until(i + 1, quote, true, quote !== "`");
      push(code.slice(i, end), "string");
      i = end;
      continue;
    }

    if (DIGIT.test(code[i]!)) {
      let end = i;
      while (end < code.length && /[0-9a-fA-FxXoObB._]/.test(code[end]!)) end += 1;
      push(code.slice(i, end), "number");
      i = end;
      continue;
    }

    if (LETTER.test(code[i]!)) {
      let end = i;
      while (end < code.length && WORD.test(code[end]!)) end += 1;
      const word = code.slice(i, end);
      // A name followed by "(" is being called, and one that starts with a
      // capital is a type or a class by the conventions of both languages.
      if (grammar.keywords.has(word)) push(word, "keyword");
      else if (/^[A-Z]/.test(word)) push(word, "type");
      else if (/^\s*\(/.test(code.slice(end))) push(word, "name");
      else found.plain(word);
      i = end;
      continue;
    }

    if (PUNCTUATION.test(code[i]!)) {
      push(code[i]!, "punct");
      i += 1;
      continue;
    }

    found.plain(code[i]!);
    i += 1;
  }

  return found.done();
}

/** JSON is scanned apart from the rest, so a field's name can be told from a string value. */
function scanJson(text: string): Token[] {
  const found = collector();
  const push = (piece: string, kind: Kind) => found.push(piece, kind);
  let i = 0;

  while (i < text.length) {
    const char = text[i]!;

    if (char === '"') {
      let end = i + 1;
      while (end < text.length) {
        if (text[end] === "\\") {
          end += 2;
          continue;
        }
        if (text[end] === '"') {
          end += 1;
          break;
        }
        end += 1;
      }
      push(text.slice(i, end), /^\s*:/.test(text.slice(end)) ? "key" : "string");
      i = end;
      continue;
    }

    if (DIGIT.test(char) || (char === "-" && DIGIT.test(text[i + 1] ?? ""))) {
      let end = i + 1;
      while (end < text.length && /[0-9.eE+-]/.test(text[end]!)) end += 1;
      push(text.slice(i, end), "number");
      i = end;
      continue;
    }

    const literal = ["true", "false", "null"].find((word) => text.startsWith(word, i));
    if (literal && !WORD.test(text[i + literal.length] ?? "")) {
      push(literal, "keyword");
      i += literal.length;
      continue;
    }

    if (PUNCTUATION.test(char)) {
      push(char, "punct");
      i += 1;
      continue;
    }

    found.plain(char);
    i += 1;
  }

  return found.done();
}

function tokenize(code: string, language: Language): Token[] {
  if (language === "json") return scanJson(code);
  if (language === "typescript") return scanCode(code, TYPESCRIPT);
  if (language === "python") return scanCode(code, PYTHON);
  return [{ text: code, kind: null }];
}

function piece(text: string, kind: Kind | null): Node {
  if (kind === null) return document.createTextNode(text);
  const span = document.createElement("span");
  span.className = `t-${kind}`;
  span.textContent = text;
  return span;
}

/**
 * One element per line, each holding the coloured pieces of that line. Lines
 * are built from the tokens rather than tokenized one at a time, so a comment
 * or a string that runs over several lines is still coloured as one thing.
 */
export function codeLines(code: string, language: Language): HTMLSpanElement[] {
  const lines: HTMLSpanElement[] = [];
  const start = () => {
    const line = document.createElement("span");
    line.className = "code-line";
    lines.push(line);
    return line;
  };

  let line = start();
  for (const token of tokenize(code, language)) {
    token.text.split("\n").forEach((part, i) => {
      if (i > 0) line = start();
      if (part) line.append(piece(part, token.kind));
    });
  }
  return lines;
}

/** Coloured code as the contents of a `pre`. */
export function codeFragment(code: string, language: Language): DocumentFragment {
  const fragment = document.createDocumentFragment();
  codeLines(code, language).forEach((line, i) => {
    if (i > 0) fragment.append(document.createTextNode("\n"));
    fragment.append(line);
  });
  return fragment;
}

/** A `pre` of coloured code, ready to put in a panel. */
export function codeBlock(code: string, language: Language, className = "code"): HTMLPreElement {
  const pre = document.createElement("pre");
  pre.className = className;
  pre.append(codeFragment(code, language));
  return pre;
}
