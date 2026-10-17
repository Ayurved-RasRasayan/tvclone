/**
 * Pine Script lexer.
 * Handles indentation-sensitive line structure, comments, strings, numbers,
 * colour literals and the Pine keyword set.
 */

export const TT = {
  NUMBER: 'number',
  STRING: 'string',
  COLOR: 'color',
  IDENT: 'ident',
  KEYWORD: 'keyword',
  OP: 'op',
  NEWLINE: 'newline',
  INDENT: 'indent',
  DEDENT: 'dedent',
  EOF: 'eof',
};

export const KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'to', 'by', 'in', 'var', 'varip',
  'and', 'or', 'not', 'true', 'false', 'na', 'break', 'continue',
  'import', 'export', 'type', 'method', 'switch', 'enum',
]);

/** Multi-character operators, longest first. */
const OPERATORS = [
  ':=', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=',
  '=>', '->', '?', ':', '.', ',', '(', ')', '[', ']',
  '+', '-', '*', '/', '%', '<', '>', '=',
];

export class PineSyntaxError extends Error {
  constructor(message, line, col) {
    super(message);
    this.name = 'PineSyntaxError';
    this.line = line;
    this.col = col;
  }
}

function isDigit(c) {
  return c >= '0' && c <= '9';
}
function isIdentStart(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
}
function isIdentPart(c) {
  return isIdentStart(c) || isDigit(c);
}

/**
 * @param {string} source
 * @returns {Array<{type:string,value:any,line:number,col:number}>}
 */
export function tokenize(source) {
  // Normalise line endings and drop a UTF-8 BOM (which editors/console tools add).
  const src = String(source).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  // Extract Pine version pragma before stripping comments so callers can read it.
  const versionPragma = readVersionPragma(src);
  const lines = src.split('\n');
  const tokens = [];

  // Stack of indentation widths. Start at -1 so the first line always opens a block.
  const indents = [-1];

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    let raw = lines[lineNo];

    // Whole-line comment or blank -> skip entirely (does not affect indent).
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('//')) continue;

    // Measure indentation (tabs count as 4).
    let indent = 0;
    let i = 0;
    while (i < raw.length) {
      const c = raw[i];
      if (c === ' ') indent += 1;
      else if (c === '\t') indent += 4;
      else break;
      i++;
    }

    // Line continuations: a line ending in a trailing operator (or with an
    // unclosed bracket) continues onto the next line. Joined lines become
    // one logical line. We check needsContinuation on the JOINED result
    // (not just the last physical line) so a `(` opened on line 1 keeps
    // consuming lines until its matching `)` — even if the closing `)` is
    // on a line that, taken alone, has no open bracket.
    //
    // We strip `//` line comments from each physical line BEFORE joining so
    // that a `//` comment containing unbalanced parens (e.g. `// (was
    // color.new(color.black, 100))`) doesn't fool needsContinuation into
    // thinking the `(` is still open — the `)` that closes the call is on a
    // later physical line and the comment shouldn't hide it.
    const stripComment = (ln) => {
      // Strip from the first `//` not inside a string. We do a quick scan
      // for `"` and `'` to skip string contents.
      let inDq = false, inSq = false;
      for (let k = 0; k < ln.length; k++) {
        const c = ln[k];
        if (inDq) { if (c === '\\') k++; else if (c === '"') inDq = false; continue; }
        if (inSq) { if (c === '\\') k++; else if (c === "'") inSq = false; continue; }
        if (c === '"') inDq = true;
        else if (c === "'") inSq = true;
        else if (c === '/' && ln[k + 1] === '/') return ln.slice(0, k);
      }
      return ln;
    };
    let logical = stripComment(raw);
    while (needsContinuation(logical) && lineNo + 1 < lines.length) {
      lineNo++;
      logical += ` ${stripComment(lines[lineNo]).trim()}`;
    }
    raw = logical;
    const startLine = lineNo; // used for error positions only

    if (indent > indents[indents.length - 1]) {
      indents.push(indent);
      tokens.push({ type: TT.INDENT, value: indent, line: startLine + 1, col: 0 });
    } else {
      while (indent < indents[indents.length - 1]) {
        indents.pop();
        tokens.push({ type: TT.DEDENT, value: indent, line: startLine + 1, col: 0 });
      }
      if (indent !== indents[indents.length - 1]) {
        throw new PineSyntaxError(
          `Bad indentation: ${indent} spaces does not match any enclosing block`,
          startLine + 1,
          indent
        );
      }
    }

    lexLine(raw, startLine + 1, i, tokens);
  }

  // Close open blocks
  while (indents.length > 1) {
    indents.pop();
    tokens.push({ type: TT.DEDENT, value: 0, line: lines.length, col: 0 });
  }
  tokens.push({ type: TT.EOF, value: null, line: lines.length, col: 0 });
  return tokens;
}

/** True when a physical line continues (unclosed bracket or trailing binary operator). */
function needsContinuation(text) {
  let depth = 0;
  let inStr = false;
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (inStr) {
      if (c === '\\') k++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '/' && text[k + 1] === '/') break;
    if (c === '"') inStr = true;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
  }
  if (inStr || depth > 0) return true;
  const stripped = text.replace(/\/\/.*$/, '').trimEnd();
  if (!stripped) return false;
  // A trailing `=>` opens a block body; it never continues the line.
  if (/=>$/.test(stripped)) return false;
  // Splitting an expression across lines is only intended when the operator
  // clearly expects a right-hand operand. `x = (a + b)` ends with a complete
  // operand, so it must NOT swallow the following line.
  const m = /(?:[+\-*/%<>=!]=?|:=|\?|:|,|\band\b|\bor\b|\bnot\b)$/.exec(stripped);
  if (!m) return false;
  const op = m[0];
  // Assignment/compound operators always want an operand on the next line.
  if (/^(?:[+\-*/%]=|:=|=|,|\?|:|and|or|not)$/.test(op)) return true;
  // Comparison and arithmetic operators: continue only if the statement does
  // not already look like a complete assignment or a call.
  if (/(?:^|\s)[A-Za-z_][\w.]*\s*=\s*[^\s].*[+\-*/%<>=!]$/.test(stripped) && !/[)\]]$/.test(stripped)) {
    return true;
  }
  return false;
}

function lexLine(text, lineNo, startCol, tokens) {
  let k = startCol;
  const push = (type, value, col) => tokens.push({ type, value, line: lineNo, col });

  while (k < text.length) {
    const c = text[k];

    if (c === ' ' || c === '\t') {
      k++;
      continue;
    }

    // A leftover newline can appear when lines were joined for a continuation.
    if (c === '\n') {
      k++;
      continue;
    }

    // Comment: rest of physical line
    if (c === '/' && text[k + 1] === '/') break;

    // Colour literal #RRGGBB / #RRGGBBAA
    if (c === '#') {
      const m = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/.exec(text.slice(k));
      if (!m) throw new PineSyntaxError(`Invalid colour literal at column ${k}`, lineNo, k);
      push(TT.COLOR, m[1].toLowerCase(), k);
      k += m[0].length;
      continue;
    }

    // String literal
    if (c === '"' || c === "'") {
      const quote = c;
      let out = '';
      let j = k + 1;
      let closed = false;
      while (j < text.length) {
        if (text[j] === '\\') {
          const n = text[j + 1];
          out += n === 'n' ? '\n' : n === 't' ? '\t' : n === '\\' ? '\\' : n === '"' ? '"' : n === "'" ? "'" : n;
          j += 2;
          continue;
        }
        if (text[j] === quote) {
          closed = true;
          j++;
          break;
        }
        out += text[j];
        j++;
      }
      if (!closed) throw new PineSyntaxError('Unterminated string literal', lineNo, k);
      push(TT.STRING, out, k);
      k = j;
      continue;
    }

    // Number
    if (isDigit(c) || (c === '.' && isDigit(text[k + 1]))) {
      const m = /^(?:0[xX][0-9a-fA-F]+)|(?:\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)|(?:\.\d+(?:[eE][+-]?\d+)?)/.exec(
        text.slice(k)
      );
      if (!m) throw new PineSyntaxError(`Malformed number at column ${k}`, lineNo, k);
      const raw = m[0];
      const value = /^0[xX]/.test(raw) ? parseInt(raw, 16) : parseFloat(raw);
      push(TT.NUMBER, value, k);
      k += raw.length;
      continue;
    }

    // Identifier / keyword
    if (isIdentStart(c)) {
      let j = k;
      while (j < text.length && isIdentPart(text[j])) j++;
      const word = text.slice(k, j);
      push(KEYWORDS.has(word) ? TT.KEYWORD : TT.IDENT, word, k);
      k = j;
      continue;
    }

    // Operator
    let matched = null;
    for (const op of OPERATORS) {
      if (text.startsWith(op, k)) {
        matched = op;
        break;
      }
    }
    if (matched) {
      push(TT.OP, matched, k);
      k += matched.length;
      continue;
    }

    throw new PineSyntaxError(`Unexpected character ${JSON.stringify(c)}`, lineNo, k);
  }

  push(TT.NEWLINE, '\n', text.length);
}

/**
 * Read the `//@version=N` pragma from the leading comment block.
 * Pine v6 scripts begin with `//@version=6`; v5 with `//@version=5`.
 * Returns 5 (the historical default of this engine) when no pragma is present,
 * or the explicit version integer when one is.
 */
export function readVersionPragma(src) {
  if (typeof src !== 'string') return 5;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (!t.startsWith('//')) break; // first non-comment line ends the search
    const m = /@version\s*=\s*(\d+)/.exec(t);
    if (m) return Math.max(1, Math.min(99, parseInt(m[1], 10)));
  }
  return 5;
}

/** Attach a Pine version marker to a token stream so the parser/runtime can read it. */
export function tokenizeWithVersion(source) {
  const toks = tokenize(source);
  toks.pineVersion = readVersionPragma(source);
  return toks;
}
