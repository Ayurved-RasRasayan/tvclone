/**
 * Pine Script parser -> AST.
 *
 * Grammar (informal):
 *   program    := stmt*
 *   stmt       := varDecl | tupleAssign | reAssign | funDecl | ifStmt | forStmt
 *               | whileStmt | breakStmt | continueStmt | exprStmt
 *   varDecl    := ['var'|'varip'] type? IDENT '=' expr
 *   tupleAssign:= IDENT (',' IDENT)+ '=' expr
 *   reAssign   := lvalue (':=' | '+=' | ...) expr
 *   funDecl    := IDENT '(' params ')' '=>' (expr | NEWLINE INDENT stmt+ DEDENT)
 *   ifStmt     := 'if' expr NEWLINE INDENT stmt+ DEDENT ('else' ('if' expr | NEWLINE INDENT stmt+ DEDENT))?
 *   forStmt    := 'for' IDENT '=' expr ('to' expr ('by' expr)? | 'in' expr)
 *   switch     := 'switch' expr? NEWLINE INDENT (case+ ) DEDENT
 */
import { tokenize, tokenizeWithVersion, readVersionPragma, TT, PineSyntaxError } from './lexer.js';

export const NT = {
  PROGRAM: 'Program',
  BLOCK: 'Block',
  VAR_DECL: 'VarDecl',
  TUPLE: 'TuplePattern',
  ASSIGN: 'Assign',
  FUN_DECL: 'FunDecl',
  METHOD_DECL: 'MethodDecl',
  TYPE_DECL: 'TypeDecl',
  ENUM_DECL: 'EnumDecl',
  IMPORT: 'Import',
  EXPORT: 'Export',
  NEW: 'New',
  IF: 'If',
  FOR: 'For',
  WHILE: 'While',
  SWITCH: 'Switch',
  BREAK: 'Break',
  CONTINUE: 'Continue',
  EXPR_STMT: 'ExprStmt',
  LITERAL: 'Literal',
  IDENT: 'Ident',
  MEMBER: 'Member',
  CALL: 'Call',
  BINARY: 'Binary',
  LOGICAL: 'Logical',
  UNARY: 'Unary',
  TERNARY: 'Ternary',
  INDEX: 'Index',
  HIST: 'History',
  TUPLE_EXPR: 'TupleExpr',
  ARRAY: 'ArrayLit',
};

const TYPE_NAMES = new Set([
  'int', 'float', 'bool', 'string', 'color', 'line', 'label', 'box', 'table',
  'array', 'matrix', 'map', 'series', 'simple', 'const', 'input', 'void',
]);

const COMPOUND_ASSIGN = { '+=': '+', '-=': '-', '*=': '*', '/=': '/', '%=': '%' };

class Parser {
  constructor(tokens) {
    this.toks = tokens;
    this.i = 0;
    this.nodeId = 0;
    // The lexer may attach `pineVersion` (set by tokenizeWithVersion) so the
    // parser and runtime can switch on `//@version=N`.
    this.pineVersion = (tokens && typeof tokens.pineVersion === 'number') ? tokens.pineVersion : 5;
  }

  peek(offset = 0) {
    return this.toks[Math.min(this.i + offset, this.toks.length - 1)];
  }
  next() {
    return this.toks[this.i++];
  }
  is(type, value) {
    const t = this.peek();
    return t.type === type && (value === undefined || t.value === value);
  }
  isOp(value) {
    return this.is(TT.OP, value);
  }
  isKw(value) {
    return this.is(TT.KEYWORD, value);
  }
  eat(type, value) {
    if (!this.is(type, value)) {
      const t = this.peek();
      throw new PineSyntaxError(
        `Expected ${value !== undefined ? JSON.stringify(value) : type} but found ${JSON.stringify(t.value)}`,
        t.line,
        t.col
      );
    }
    return this.next();
  }
  eatOp(value) {
    return this.eat(TT.OP, value);
  }
  eatKw(value) {
    return this.eat(TT.KEYWORD, value);
  }
  maybe(type, value) {
    if (this.is(type, value)) {
      return this.next();
    }
    return null;
  }
  skipNewlines() {
    while (this.is(TT.NEWLINE)) this.next();
  }
  id(node) {
    node.id = ++this.nodeId;
    return node;
  }
  err(msg, tok = this.peek()) {
    throw new PineSyntaxError(msg, tok.line, tok.col);
  }

  tokIndexOf(tok) {
    return this.toks.indexOf(tok);
  }

  _assignTuple(pattern, value) {
    return {
      type: NT.ASSIGN,
      tuple: { type: NT.TUPLE_EXPR, items: pattern, isPattern: true, declare: false },
      op: ':=',
      value,
    };
  }

  /** `[ a , b , c ]` followed by `=` or `:=` */
  looksLikeTuplePattern() {
    let k = this.i + 1;
    for (;;) {
      const t = this.toks[k];
      if (!t || t.type !== TT.IDENT) return false;
      k++;
      const sep = this.toks[k];
      if (sep?.type === TT.OP && sep.value === ',') {
        k++;
        continue;
      }
      break;
    }
    if (this.toks[k]?.type !== TT.OP || this.toks[k].value !== ']') return false;
    k++;
    const op = this.toks[k];
    return !!op && op.type === TT.OP && (op.value === '=' || op.value === ':=');
  }

  parseTuplePattern() {
    this.eatOp('[');
    const items = [];
    do {
      const t = this.eat(TT.IDENT);
      items.push(this.id({ type: NT.IDENT, name: t.value, line: t.line }));
    } while (this.maybe(TT.OP, ','));
    this.eatOp(']');
    return items;
  }

  parseProgram() {
    const body = [];
    this.skipNewlines();
    while (!this.is(TT.EOF)) {
      // A leading INDENT is emitted by the lexer for the first line of the file.
      while (this.is(TT.INDENT) || this.is(TT.DEDENT)) this.next();
      if (this.is(TT.EOF)) break;
      const before = this.i;
      const stmt = this.parseStatement();
      if (stmt) body.push(stmt);
      this.skipNewlines();
      if (this.i === before) this.err('Parser made no progress');
    }
    const root = this.id({ type: NT.PROGRAM, body });
    root.pineVersion = this.pineVersion || 5;
    return root;
  }

  /** A suite: either a single inline statement or an indented block. */
  parseSuite() {
    const save = this.i;
    let sawNewline = false;
    while (this.is(TT.NEWLINE)) {
      this.next();
      sawNewline = true;
    }
    if (this.is(TT.INDENT)) {
      this.next();
      const body = [];
      this.skipNewlines();
      while (!this.is(TT.DEDENT) && !this.is(TT.EOF)) {
        const stmt = this.parseStatement();
        if (stmt) body.push(stmt);
        this.skipNewlines();
      }
      this.eat(TT.DEDENT);
      return this.id({ type: NT.BLOCK, body });
    }
    // Not an indented block: rewind and parse a single inline statement.
    this.i = save;
    if (sawNewline) {
      // `if cond` followed by a blank line and then a block at the same indent.
      let k = this.i;
      while (this.toks[k]?.type === TT.NEWLINE) k++;
      if (this.toks[k]?.type === TT.INDENT) {
        this.i = k;
        return this.parseSuite();
      }
    }
    const stmt = this.parseStatement();
    return this.id({ type: NT.BLOCK, body: stmt ? [stmt] : [] });
  }

  parseStatement() {
    const t = this.peek();

    if (t.type === TT.KEYWORD) {
      switch (t.value) {
        case 'if':
          return this.parseIf();
        case 'for':
          return this.parseFor();
        case 'while':
          return this.parseWhile();
        case 'switch':
          return this.parseSwitch();
        case 'var':
        case 'varip':
          return this.parseVarDecl();
        case 'break': {
          this.next();
          return this.id({ type: NT.BREAK });
        }
        case 'continue': {
          this.next();
          return this.id({ type: NT.CONTINUE });
        }
        case 'type':
          return this.parseTypeDecl();
        case 'enum':
          return this.parseEnumDecl();
        case 'method':
          return this.parseMethodDecl();
        case 'import':
          return this.parseImport();
        case 'export':
          return this.parseExport();
        default:
          break;
      }
    }

    // Tuple destructuring: `[a, b, c] = expr`
    if (t.type === TT.OP && t.value === '[' && this.looksLikeTuplePattern()) {
      const pattern = this.parseTuplePattern();
      const op = this.peek();
      if (op.type === TT.OP && (op.value === '=' || op.value === ':=')) {
        this.next();
        const value = this.parseExpression();
        const node = this._assignTuple(pattern, value);
        node.declare = op.value === '=';
        node.tuple.declare = node.declare;
        return this.id(node);
      }
      // Fall back to a plain expression statement starting with an array literal.
      this.i = this.tokIndexOf(t);
    }

    // Declaration with an explicit type: `float x = 0`, `float[] xs = ...`,
    // `Bar b = ...`, `array<float> xs = ...`, `map<string, int> m = ...`.
    // Pine v5/v6 also allows multiple type qualifiers: `simple int len = ...`,
    // `series float src = ...`, `const color c = ...`. We consume all
    // consecutive TYPE_NAMES tokens until we find the variable name (the
    // last IDENT before `=` or `[`).
    if (
      t.type === TT.IDENT &&
      (TYPE_NAMES.has(t.value) || this._isTypeName(t.value)) &&
      (
        this.peek(1).type === TT.IDENT ||
        (this.peek(1).type === TT.OP &&
          (this.peek(1).value === '[' || this.peek(1).value === '<'))
      )
    ) {
      // Consume all consecutive type qualifiers (e.g. `simple int`, `series float`).
      let declaredType = '';
      while (this.is(TT.IDENT) && (TYPE_NAMES.has(this.peek().value) || this._isTypeName(this.peek().value))) {
        if (declaredType) declaredType += ' ';
        declaredType += this.next().value;
      }
      // Optional `<T>` generic clause.
      if (this.isOp('<')) {
        let depth = 0;
        while (!this.is(TT.EOF)) {
          const t = this.peek();
          if (t.type === TT.OP && t.value === '<') { depth++; this.next(); continue; }
          if (t.type === TT.OP && t.value === '>') { depth--; this.next(); if (depth === 0) break; continue; }
          this.next();
        }
      }
      // Optional `[]` array marker.
      if (this.isOp('[') && this.peek(1).type === TT.OP && this.peek(1).value === ']') {
        this.next(); this.next();
        declaredType += '[]';
      }
      // The next token must be the variable name (IDENT).
      // (If it's not, the parseVarDecl below will handle the error.)
      return this.parseVarDecl();
    }

    // User function declaration: `name(a, b) =>` ...
    if (t.type === TT.IDENT && this.looksLikeFunDecl()) {
      return this.parseFunDecl();
    }

    // Assignment / expression statement
    const expr = this.parseExpression();
    const opTok = this.peek();

    if (opTok.type === TT.OP && (opTok.value === '=' || opTok.value === ':=' || COMPOUND_ASSIGN[opTok.value])) {
      const op = this.next().value;
      const value = this.parseExpression();
      const target = expr;
      if (target.type === NT.IDENT) {
        return this.id({
          type: NT.ASSIGN,
          name: target.name,
          op: op === '=' ? ':=' : op,
          declare: op === '=',
          compound: COMPOUND_ASSIGN[op] || null,
          value,
          line: opTok.line,
        });
      }
      if (target.type === NT.MEMBER) {
        return this.id({
          type: NT.ASSIGN,
          member: target,
          op: op === '=' ? ':=' : op,
          compound: COMPOUND_ASSIGN[op] || null,
          value,
          line: opTok.line,
        });
      }
      if (target.type === NT.INDEX) {
        return this.id({
          type: NT.ASSIGN,
          index: target,
          op: op === '=' ? ':=' : op,
          compound: COMPOUND_ASSIGN[op] || null,
          value,
          line: opTok.line,
        });
      }
      this.err('Invalid assignment target', opTok);
    }

    if (expr.type === NT.TUPLE_EXPR) {
      // `[a, b] = f()` destructuring
      if (this.isOp('=') || this.isOp(':=')) {
        this.next();
        const value = this.parseExpression();
        return this.id({ type: NT.ASSIGN, tuple: expr, op: ':=', value });
      }
    }

    return this.id({ type: NT.EXPR_STMT, expr, line: t.line });
  }

  /** Lookahead: `IDENT ( ident[, ident]* ) =>` means a function declaration. */
  looksLikeFunDecl() {
    let k = this.i + 1;
    if (this.toks[k]?.type !== TT.OP || this.toks[k].value !== '(') return false;
    k++;
    // Words that are reserved-as-keyword in v6 but commonly used as
    // parameter names in real scripts. They count as valid parameter names
    // here so a function declaration like `f_ma(src, len, type) => ...`
    // is recognised.
    const KEYWORDS_AS_NAMES = new Set(['type', 'method', 'enum', 'import', 'export', 'na']);
    if (this.toks[k]?.type === TT.OP && this.toks[k].value === ')') {
      k++;
    } else {
      for (;;) {
        const t = this.toks[k];
        if (!t) return false;
        // Type qualifier followed by IDENT name. The type qualifier may be
        // an IDENT in TYPE_NAMES (`int`, `float`, ...) or an IDENT that's a
        // known UDT name (e.g. `pivot p_ivot`, `trend swingTrend`).
        if (
          t.type === TT.IDENT &&
          (TYPE_NAMES.has(t.value) || this._isTypeName(t.value)) &&
          this.toks[k + 1]?.type === TT.IDENT
        ) {
          k += 2;
          if (this.toks[k]?.type === TT.OP && this.toks[k].value === '[' && this.toks[k + 1]?.value === ']') {
            k += 2;
          }
          // Optional default value: `= expr`. Skip everything up to the
          // next `,` or `)` at depth 0 (so nested `(` `)` in the default
          // value don't confuse us).
          if (this.toks[k]?.type === TT.OP && this.toks[k].value === '=') {
            k++;
            let depth = 0;
            while (k < this.toks.length) {
              const tt = this.toks[k];
              if (tt.type === TT.OP && (tt.value === '(' || tt.value === '[')) depth++;
              else if (tt.type === TT.OP && (tt.value === ')' || tt.value === ']')) {
                if (depth === 0) break;
                depth--;
              }
              else if (depth === 0 && tt.type === TT.OP && tt.value === ',') break;
              else if (depth === 0 && tt.type === TT.NEWLINE) break;
              k++;
            }
          }
        } else if (t.type === TT.IDENT) {
          k++;
          if (this.toks[k]?.type === TT.OP && this.toks[k].value === '.') {
            k++;
            if (this.toks[k]?.type !== TT.IDENT) return false;
            k++;
          }
          if (this.toks[k]?.type === TT.OP && this.toks[k].value === '[' && this.toks[k + 1]?.value === ']') {
            k += 2;
          }
          // Optional default value (same skip logic as above).
          if (this.toks[k]?.type === TT.OP && this.toks[k].value === '=') {
            k++;
            let depth = 0;
            while (k < this.toks.length) {
              const tt = this.toks[k];
              if (tt.type === TT.OP && (tt.value === '(' || tt.value === '[')) depth++;
              else if (tt.type === TT.OP && (tt.value === ')' || tt.value === ']')) {
                if (depth === 0) break;
                depth--;
              }
              else if (depth === 0 && tt.type === TT.OP && tt.value === ',') break;
              else if (depth === 0 && tt.type === TT.NEWLINE) break;
              k++;
            }
          }
        } else if (t.type === TT.KEYWORD && TYPE_NAMES.has(t.value)) {
          // A type qualifier keyword (`int`, `float`, ...) followed by a name.
          k++;
          if (this.toks[k]?.type !== TT.IDENT) return false;
          k++;
          if (this.toks[k]?.type === TT.OP && this.toks[k].value === '[' && this.toks[k + 1]?.value === ']') {
            k += 2;
          }
          // Optional default value.
          if (this.toks[k]?.type === TT.OP && this.toks[k].value === '=') {
            k++;
            let depth = 0;
            while (k < this.toks.length) {
              const tt = this.toks[k];
              if (tt.type === TT.OP && (tt.value === '(' || tt.value === '[')) depth++;
              else if (tt.type === TT.OP && (tt.value === ')' || tt.value === ']')) {
                if (depth === 0) break;
                depth--;
              }
              else if (depth === 0 && tt.type === TT.OP && tt.value === ',') break;
              else if (depth === 0 && tt.type === TT.NEWLINE) break;
              k++;
            }
          }
        } else if (t.type === TT.KEYWORD && KEYWORDS_AS_NAMES.has(t.value)) {
          // A v6 declaration keyword used as a parameter name
          // (e.g. `f_ma(src, len, type)`).
          k++;
        } else {
          return false;
        }
        const sep = this.toks[k];
        if (sep?.type === TT.OP && sep.value === ',') {
          k++;
          continue;
        }
        break;
      }
      if (this.toks[k]?.type !== TT.OP || this.toks[k].value !== ')') return false;
      k++;
    }
    const arrow = this.toks[k];
    return !!arrow && arrow.type === TT.OP && arrow.value === '=>';
  }

  parseFunDecl() {
    const nameTok = this.eat(TT.IDENT);
    this.eatOp('(');
    const params = [];
    this.skipNewlines();
    if (!this.isOp(')')) {
      for (;;) {
        this.skipNewlines();
        // Accept an optional type qualifier before the parameter name. The
        // type qualifier may be:
        //   - a builtin type name (`int`, `float`, `bool`, ...) — currently
        //     emitted as a TT.IDENT token, OR
        //   - one of the v6 declaration keywords (`type`, `method`, ...)
        //     used as a TYPE name in some scripts — emitted as TT.KEYWORD.
        // BUT: those same keywords are commonly used as PARAMETER NAMES
        // (e.g. `f_ma(src, len, type) => ...`). We only consume the current
        // token as a type qualifier when there is a following IDENT that
        // serves as the parameter name. Otherwise the current token IS
        // the parameter name.
        if (this.is(TT.KEYWORD) && this.peek(1).type === TT.IDENT) {
          // keyword followed by an identifier — keyword is the type, next is the name
          this.next();
        } else if (
          this.is(TT.IDENT) &&
          (TYPE_NAMES.has(this.peek().value) || this._isTypeName(this.peek().value)) &&
          this.peek(1).type === TT.IDENT
        ) {
          this.next();
        }
        // The parameter name may itself be a keyword used as a name
        // (`type`, `method`, `enum`, `import`, `export`).
        let pname;
        if (this.is(TT.IDENT)) {
          pname = this.next().value;
        } else if (
          this.is(TT.KEYWORD) &&
          ['type', 'method', 'enum', 'import', 'export', 'na'].includes(this.peek().value)
        ) {
          pname = this.next().value;
        } else {
          this.err('Expected a parameter name', this.peek());
        }
        if (this.isOp('[') && this.peek(1).type === TT.OP && this.peek(1).value === ']') {
          this.next();
          this.next();
        }
        if (this.isOp('.')) {
          this.next();
          pname += '.' + this.eat(TT.IDENT).value;
        }
        // Pine v6 default value: `name = expr`. The default expression is
        // evaluated by the caller when the argument is omitted. We don't
        // model defaults here, but we need to consume the `= expr` clause
        // so parsing doesn't break. The runtime uses positional/named
        // binding, which still works because Pine's defaults are only
        // applied when an argument is missing.
        if (this.isOp('=')) {
          this.next();
          this.parseExpression();
        }
        params.push(pname);
        this.skipNewlines();
        if (this.maybe(TT.OP, ',')) continue;
        break;
      }
    }
    this.skipNewlines();
    this.eatOp(')');
    this.eatOp('=>');
    const body = this.parseSuite();
    return this.id({ type: NT.FUN_DECL, name: nameTok.value, params, body, line: nameTok.line });
  }

  parseVarDecl() {
    const kw = this.peek();
    let mode = 'series';
    if (kw.type === TT.KEYWORD && (kw.value === 'var' || kw.value === 'varip')) {
      mode = this.next().value;
    }
    let declaredType = null;
    // Pine v5/v6: consume all consecutive type qualifiers (`simple int`,
    // `series float`, `const color`, etc.) followed by the variable name.
    if (
      this.is(TT.IDENT) &&
      (TYPE_NAMES.has(this.peek().value) || this._isTypeName(this.peek().value)) &&
      (this.peek(1).type === TT.IDENT ||
        (this.peek(1).type === TT.OP && (this.peek(1).value === '[' || this.peek(1).value === '<')))
    ) {
      let parts = [];
      // Consume consecutive TYPE_NAMES tokens (e.g. `simple int`).
      while (this.is(TT.IDENT) && (TYPE_NAMES.has(this.peek().value) || this._isTypeName(this.peek().value)) &&
             this.peek(1).type === TT.IDENT && (TYPE_NAMES.has(this.peek(1).value) || this._isTypeName(this.peek(1).value))) {
        parts.push(this.next().value);
      }
      // Consume the last type qualifier.
      parts.push(this.next().value);
      declaredType = parts.join(' ');
      // Optional `<T>` or `<T, U>` generic clause.
      if (this.isOp('<')) {
        let depth = 0;
        while (!this.is(TT.EOF)) {
          const t = this.peek();
          if (t.type === TT.OP && t.value === '<') { depth++; this.next(); continue; }
          if (t.type === TT.OP && t.value === '>') { depth--; this.next(); if (depth === 0) break; continue; }
          this.next();
        }
      }
      if (this.isOp('[') && this.peek(1).type === TT.OP && this.peek(1).value === ']') {
        this.next();
        this.next();
        declaredType += '[]';
      }
    }
    const nameTok = this.eat(TT.IDENT);
    this.eatOp('=');
    const value = this.parseExpression();
    return this.id({
      type: NT.VAR_DECL,
      name: nameTok.value,
      mode,
      declaredType,
      value,
      line: nameTok.line,
    });
  }

  /**
   * Lookahead: is `name` a user-defined type we have already seen in this
   * source? We scan all top-level `type Name` declarations before parsing the
   * body so subsequent varDecl lines can use UDT names as declared types.
   */
  _isTypeName(name) {
    if (!this._udtNames) {
      this._udtNames = new Set();
      for (let k = 0; k < this.toks.length - 3; k++) {
        if (this.toks[k].type === TT.KEYWORD && this.toks[k].value === 'type'
            && this.toks[k + 1].type === TT.IDENT) {
          this._udtNames.add(this.toks[k + 1].value);
        }
      }
    }
    return this._udtNames.has(name);
  }

  /**
   * Lookahead: is the current `<` token the start of a generic-type clause
   * on a function call (e.g. `array.new<float>(...)`)? We look for the
   * pattern `< IDENT (, IDENT)* > (` — a closing `>` followed by `(`. We
   * also accept nested `<...>` for `array.new<map<string, float>>(...)`.
   */
  _looksLikeGenericCall() {
    let k = this.i;
    if (this.toks[k]?.type !== TT.OP || this.toks[k].value !== '<') return false;
    k++;
    let depth = 1;
    // Allow up to ~10 tokens inside the generic clause.
    let steps = 0;
    while (k < this.toks.length && steps < 20) {
      const t = this.toks[k];
      if (t.type === TT.OP && t.value === '<') { depth++; k++; steps++; continue; }
      if (t.type === TT.OP && t.value === '>') {
        depth--;
        k++;
        if (depth === 0) break;
        steps++;
        continue;
      }
      if (t.type === TT.IDENT || (t.type === TT.OP && (t.value === ',' || t.value === '.'))) {
        k++; steps++; continue;
      }
      // Anything else (numbers, strings, etc.) means it's NOT a generic.
      return false;
    }
    if (depth !== 0) return false;
    // After the closing `>`, the next token must be `(` for this to be a
    // generic call.
    return this.toks[k]?.type === TT.OP && this.toks[k].value === '(';
  }

  /** Like parseIf, but without the `keyword if` dispatch that parsePrimary does. */
  parseIfBody() {
    const kw = this.eatKw('if');
    const test = this.parseExpression();
    const consequent = this.parseSuite();
    let alternate = null;
    const save = this.i;
    while (this.is(TT.NEWLINE)) this.next();
    if (this.isKw('else')) {
      this.next();
      if (this.isKw('if')) {
        alternate = this.id({ type: NT.BLOCK, body: [this.parseIfBody()] });
      } else {
        alternate = this.parseSuite();
      }
    } else {
      this.i = save;
    }
    return this.id({ type: NT.IF, test, consequent, alternate, line: kw.line });
  }

  parseIf() {
    return this.parseIfBody();
  }

  parseFor() {
    const kw = this.eatKw('for');
    // `for i = 0 to n`  |  `for i in range`  |  `for [i, v] in arr`
    const names = [];
    if (this.isOp('[')) {
      this.next();
      do {
        names.push(this.eat(TT.IDENT).value);
      } while (this.maybe(TT.OP, ','));
      this.eatOp(']');
    } else {
      names.push(this.eat(TT.IDENT).value);
    }

    if (this.isKw('in')) {
      this.next();
      const iterable = this.parseExpression();
      const body = this.parseSuite();
      return this.id({ type: NT.FOR, kind: 'in', names, iterable, body, line: kw.line });
    }

    this.eatOp('=');
    const from = this.parseExpression();
    let to = null;
    let by = null;
    if (this.isKw('to')) {
      this.next();
      to = this.parseExpression();
    }
    if (this.isKw('by')) {
      this.next();
      by = this.parseExpression();
    }
    const body = this.parseSuite();
    return this.id({ type: NT.FOR, kind: 'range', names, from, to, by, body, line: kw.line });
  }

  parseWhile() {
    const kw = this.eatKw('while');
    const test = this.parseExpression();
    const body = this.parseSuite();
    return this.id({ type: NT.WHILE, test, body, line: kw.line });
  }

  parseSwitch() {
    const kw = this.eatKw('switch');
    const subject = this.is(TT.NEWLINE) ? null : this.parseExpression();
    this.eat(TT.NEWLINE);
    this.eat(TT.INDENT);
    const cases = [];
    this.skipNewlines();
    while (!this.is(TT.DEDENT) && !this.is(TT.EOF)) {
      let test = null;
      if (!this.isOp('=>')) {
        test = this.parseExpression();
      }
      this.eatOp('=>');
      const result = this.parseSuite();
      cases.push({ test, result });
      this.skipNewlines();
    }
    this.eat(TT.DEDENT);
    return this.id({ type: NT.SWITCH, subject, cases, line: kw.line });
  }

  /* ---------------- Pine v6 declarations ---------------- */

  /**
   * `type Name` followed by an indented block of field declarations:
   *   type Bar
   *       float high = 0.0
   *       float low  = 0.0
   * Field syntax mirrors a `var` declaration: optional type, name, and a
   * default value. A field may also be `method name(...) => ...`, in which
   * case it becomes a method bound to this type.
   */
  parseTypeDecl() {
    const kw = this.eatKw('type');
    const nameTok = this.eat(TT.IDENT);
    this.eat(TT.NEWLINE);
    this.eat(TT.INDENT);
    const fields = [];
    const methods = [];
    this.skipNewlines();
    while (!this.is(TT.DEDENT) && !this.is(TT.EOF)) {
      if (this.isKw('method')) {
        const m = this.parseMethodDecl(nameTok.value);
        methods.push(m);
      } else if (this.isOp('[')) {
        // Tuple-returning method: `[a, b] name(...) => body` (Pine v6 method syntax).
        const m = this.parseTypeMethodTuple(nameTok.value);
        if (m) methods.push(m);
      } else {
        // Detect an inline method declaration: `[type] name(params) => body`
        // (without the `method` keyword — Pine v6 allows this inside a type).
        const saveI = this.i;
        let fieldType = null;
        if (this.is(TT.IDENT) && TYPE_NAMES.has(this.peek().value)) {
          fieldType = this.peek().value;
        }
        // Skip the optional type qualifier if it's followed by an IDENT that
        // is then followed by `(`.
        if (fieldType && this.peek(1).type === TT.IDENT && this.peek(2).type === TT.OP && this.peek(2).value === '(') {
          this.next(); // consume the type
          const methodNameTok = this.eat(TT.IDENT);
          this.eatOp('(');
          const params = [];
          this.skipNewlines();
          if (!this.isOp(')')) {
            for (;;) {
              this.skipNewlines();
              if (this.is(TT.IDENT) && TYPE_NAMES.has(this.peek().value)) this.next();
              const pname = this.eat(TT.IDENT).value;
              if (this.isOp('.')) { this.next(); pname + '.' + this.eat(TT.IDENT).value; }
              params.push(pname);
              this.skipNewlines();
              if (this.maybe(TT.OP, ',')) continue;
              break;
            }
          }
          this.eatOp(')');
          this.eatOp('=>');
          const body = this.parseSuite();
          methods.push(this.id({
            type: NT.METHOD_DECL,
            name: methodNameTok.value,
            params,
            body,
            receiverType: nameTok.value,
            line: methodNameTok.line,
          }));
        } else {
          // Field: `[type] name [= default]`
          this.i = saveI;
          let ft = null;
          if (this.is(TT.IDENT) && TYPE_NAMES.has(this.peek().value) && this.peek(1).type === TT.IDENT) {
            ft = this.next().value;
            if (this.isOp('[') && this.peek(1).type === TT.OP && this.peek(1).value === ']') {
              this.next(); this.next();
              ft += '[]';
            }
          }
          const name = this.eat(TT.IDENT).value;
          let def = null;
          if (this.isOp('=')) {
            this.next();
            def = this.parseExpression();
          }
          fields.push({ name, type: ft, def });
        }
      }
      this.skipNewlines();
    }
    this.eat(TT.DEDENT);
    return this.id({ type: NT.TYPE_DECL, name: nameTok.value, fields, methods, line: kw.line });
  }

  /** Parse a tuple-returning method declaration: `[a, b] name(params) => body`. */
  parseTypeMethodTuple(forcedReceiverType) {
    // Currently a placeholder — Pine v6 supports this syntax for methods that
    // return multiple values. We accept it but mark the body as a single
    // expression statement; the runtime can return tuples from blocks.
    const save = this.i;
    this.eatOp('[');
    const retTypes = [];
    do {
      if (this.is(TT.IDENT)) retTypes.push(this.next().value);
    } while (this.maybe(TT.OP, ','));
    this.eatOp(']');
    if (!this.is(TT.IDENT) || this.peek(1).type !== TT.OP || this.peek(1).value !== '(') {
      this.i = save;
      return null;
    }
    const nameTok = this.eat(TT.IDENT);
    this.eatOp('(');
    const params = [];
    this.skipNewlines();
    if (!this.isOp(')')) {
      for (;;) {
        this.skipNewlines();
        if (this.is(TT.IDENT) && TYPE_NAMES.has(this.peek().value)) this.next();
        const pname = this.eat(TT.IDENT).value;
        params.push(pname);
        this.skipNewlines();
        if (this.maybe(TT.OP, ',')) continue;
        break;
      }
    }
    this.eatOp(')');
    this.eatOp('=>');
    const body = this.parseSuite();
    return this.id({
      type: NT.METHOD_DECL,
      name: nameTok.value,
      params,
      body,
      receiverType: forcedReceiverType,
      line: nameTok.line,
    });
  }

  /**
   * `enum Name` followed by an indented block of `NAME = value` lines.
   *   enum Side
   *       LONG = 1
   *       SHORT = -1
   */
  parseEnumDecl() {
    const kw = this.eatKw('enum');
    const nameTok = this.eat(TT.IDENT);
    this.eat(TT.NEWLINE);
    this.eat(TT.INDENT);
    const members = [];
    this.skipNewlines();
    while (!this.is(TT.DEDENT) && !this.is(TT.EOF)) {
      const m = this.eat(TT.IDENT).value;
      let value = null;
      if (this.isOp('=')) {
        this.next();
        value = this.parseExpression();
      } else {
        value = this.id({ type: NT.LITERAL, value: members.length, line: this.peek().line });
      }
      members.push({ name: m, value });
      this.skipNewlines();
    }
    this.eat(TT.DEDENT);
    return this.id({ type: NT.ENUM_DECL, name: nameTok.value, members, line: kw.line });
  }

  /**
   * `method name(params) => body` — a user-defined method. The receiver is
   * always the first parameter. The `receiverType` is captured so the runtime
   * can dispatch `bar.foo(...)` to the right method.
   */
  parseMethodDecl(forcedReceiverType = null) {
    const kw = this.eatKw('method');
    const nameTok = this.eat(TT.IDENT);
    this.eatOp('(');
    const params = [];
    this.skipNewlines();
    let receiverType = forcedReceiverType || null;
    if (!this.isOp(')')) {
      let first = true;
      for (;;) {
        this.skipNewlines();
        // Allow an optional type qualifier on the receiver (e.g. `array<float> a`).
        // Pine v6 also allows UDT names (`Counter this`) — accept any IDENT that
        // is followed by another IDENT and not by `=` or `)`.
        const t0 = this.peek();
        if (this.is(TT.IDENT) && (
          TYPE_NAMES.has(t0.value)
          || this._isTypeName(t0.value)
          || (this.peek(1).type === TT.IDENT && first)
        )) {
          const t = this.next().value;
          if (first) receiverType = t;
          if (this.isOp('[') && this.peek(1).type === TT.OP && this.peek(1).value === ']') {
            this.next(); this.next();
            if (first) receiverType = t; // array<T> still keyed as `array`
          } else if (this.isOp('<')) {
            // `array<float>` style generics — consume the inner type and closing `>`.
            this.next();
            while (!this.isOp('>') && !this.is(TT.EOF)) this.next();
            if (this.isOp('>')) this.next();
            if (first) receiverType = t;
          }
        }
        // The parameter name may itself be a keyword used as a name
        // (`type`, `method`, `enum`, `import`, `export`).
        let pname;
        if (this.is(TT.IDENT)) {
          pname = this.next().value;
        } else if (
          this.is(TT.KEYWORD) &&
          ['type', 'method', 'enum', 'import', 'export', 'na'].includes(this.peek().value)
        ) {
          pname = this.next().value;
        } else {
          this.err('Expected a parameter name', this.peek());
        }
        if (this.isOp('.')) {
          this.next();
          pname += '.' + this.eat(TT.IDENT).value;
        }
        params.push(pname);
        if (first) first = false;
        this.skipNewlines();
        if (this.maybe(TT.OP, ',')) continue;
        break;
      }
    }
    this.skipNewlines();
    this.eatOp(')');
    this.eatOp('=>');
    const body = this.parseSuite();
    return this.id({
      type: NT.METHOD_DECL,
      name: nameTok.value,
      params,
      body,
      receiverType,
      line: kw.line,
    });
  }

  /**
   * `import user/lib/version/Name as alias` — Pine v6 import syntax.
   * We record the alias so `alias.foo(...)` resolves later. This engine does
   * not load external libraries, so the alias behaves like an empty namespace.
   */
  parseImport() {
    const kw = this.eatKw('import');
    // Path components separated by `/` (Pine uses slash) or `.` (alias form).
    let path = '';
    while (!this.is(TT.NEWLINE) && !this.is(TT.EOF)) {
      const t = this.next();
      if (t.type === TT.OP && t.value === '/') { path += '/'; continue; }
      if (t.type === TT.OP && t.value === '.') { path += '.'; continue; }
      path += String(t.value);
      if (this.isKw('as') || this.is(TT.NEWLINE) || this.is(TT.EOF)) break;
    }
    let alias = path.split(/[/.]/).pop() || 'lib';
    if (this.isKw('as')) {
      this.next();
      alias = this.eat(TT.IDENT).value;
    }
    return this.id({ type: NT.IMPORT, path, alias, line: kw.line });
  }

  /**
   * `export name` (or `export name(params) => body`) — Pine v6 export.
   * For a function declaration, the body is parsed normally and tagged with
   * `exported: true`. For a type/variable, the bare name is exposed.
   */
  parseExport() {
    const kw = this.eatKw('export');
    if (this.isKw('type')) {
      const t = this.parseTypeDecl();
      t.exported = true;
      return t;
    }
    if (this.isKw('method')) {
      const m = this.parseMethodDecl();
      m.exported = true;
      return m;
    }
    if (this.isKw('enum')) {
      const e = this.parseEnumDecl();
      e.exported = true;
      return e;
    }
    // `export name(...) => body`
    const t = this.peek();
    if (t.type === TT.IDENT && this.peek(1).type === TT.OP && this.peek(1).value === '(') {
      // Parse as a function declaration and tag it exported.
      const saveI = this.i;
      this.next(); // consume name
      this.next(); // consume `(`
      // Reuse parseFunDecl by rewinding to the name.
      this.i = saveI;
      const fn = this.parseFunDecl();
      fn.exported = true;
      return fn;
    }
    // `export name = value`
    if (this.is(TT.IDENT)) {
      const nameTok = this.next();
      if (this.isOp('=')) {
        this.next();
        const value = this.parseExpression();
        return this.id({ type: NT.EXPORT, name: nameTok.value, value, line: kw.line });
      }
      return this.id({ type: NT.EXPORT, name: nameTok.value, value: null, line: kw.line });
    }
    this.err('export must be followed by a function, type, enum, method, or name');
  }

  /* ---------------- expressions ---------------- */

  parseExpression() {
    return this.parseTernary();
  }

  parseTernary() {
    const test = this.parseOr();
    // `a ? b : c` and Pine's `cond ? then` (implicit na else)
    const save = this.i;
    this.discardNewlinesInto(save);
    if (this.isOp('?')) {
      this.next();
      const consequent = this.parseTernary();
      const save2 = this.i;
      this.discardNewlinesInto(save2);
      let alternate = null;
      if (this.isOp(':')) {
        this.next();
        alternate = this.parseTernary();
      }
      return this.id({ type: NT.TERNARY, test, consequent, alternate });
    }
    this.i = save;
    return test;
  }

  /** Pine lets an operator sit at end-of-line; newlines inside parens are also fine. */
  discardNewlinesInto(saveIdx) {
    void saveIdx;
    while (this.is(TT.NEWLINE)) this.next();
  }

  parseOr() {
    let left = this.parseAnd();
    while (this.isKw('or')) {
      this.next();
      this.skipNewlines();
      const right = this.parseAnd();
      left = this.id({ type: NT.LOGICAL, op: 'or', left, right });
    }
    return left;
  }

  parseAnd() {
    let left = this.parseEquality();
    while (this.isKw('and')) {
      this.next();
      this.skipNewlines();
      const right = this.parseEquality();
      left = this.id({ type: NT.LOGICAL, op: 'and', left, right });
    }
    return left;
  }

  parseEquality() {
    let left = this.parseComparison();
    for (;;) {
      if (this.isOp('==') || this.isOp('!=')) {
        const op = this.next().value;
        this.skipNewlines();
        const right = this.parseComparison();
        left = this.id({ type: NT.BINARY, op, left, right });
      } else break;
    }
    return left;
  }

  parseComparison() {
    let left = this.parseAdditive();
    for (;;) {
      if (this.isOp('<') || this.isOp('>') || this.isOp('<=') || this.isOp('>=')) {
        const op = this.next().value;
        this.skipNewlines();
        const right = this.parseAdditive();
        left = this.id({ type: NT.BINARY, op, left, right });
      } else break;
    }
    return left;
  }

  parseAdditive() {
    let left = this.parseMultiplicative();
    for (;;) {
      if (this.isOp('+') || this.isOp('-')) {
        const op = this.next().value;
        this.skipNewlines();
        const right = this.parseMultiplicative();
        left = this.id({ type: NT.BINARY, op, left, right });
      } else break;
    }
    return left;
  }

  parseMultiplicative() {
    let left = this.parseUnary();
    for (;;) {
      if (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
        const op = this.next().value;
        this.skipNewlines();
        const right = this.parseUnary();
        left = this.id({ type: NT.BINARY, op, left, right });
      } else break;
    }
    return left;
  }

  parseUnary() {
    if (this.isOp('-') || this.isOp('+') || this.isKw('not')) {
      const tok = this.next();
      const op = tok.type === TT.KEYWORD ? 'not' : tok.value;
      const operand = this.parseUnary();
      if (op === '-' && operand.type === NT.LITERAL && typeof operand.value === 'number') {
        return this.id({ type: NT.LITERAL, value: -operand.value, line: tok.line });
      }
      return this.id({ type: NT.UNARY, op, operand, line: tok.line });
    }
    return this.parsePostfix();
  }

  parsePostfix() {
    let node = this.parsePrimary();
    for (;;) {
      if (this.isOp('.')) {
        this.next();
        // Member names may collide with keywords (e.g. `arr.size`, `t.get`).
        const t = this.peek();
        if (t.type !== TT.IDENT && t.type !== TT.KEYWORD) {
          this.err(`Expected member name but found ${JSON.stringify(t.value)}`);
        }
        this.next();
        node = this.id({ type: NT.MEMBER, object: node, property: String(t.value), line: t.line });
        continue;
      }
      if (this.isOp('(')) {
        this.next();
        const args = this.parseArguments();
        this.eatOp(')');
        node = this.id({ type: NT.CALL, callee: node, args, line: node.line });
        continue;
      }
      // Pine v6 generic-type call: `array.new<float>(...)`, `map.new<string,
      // float>(...)`. We look ahead: if `<` is followed by IDENTs and `>` and
      // then `(`, it's a generic clause and we skip past the `>` so the next
      // iteration sees the `(` and parses the call normally. If not, leave
      // the `<` alone — it's a comparison operator.
      if (this.isOp('<') && this._looksLikeGenericCall()) {
        // Consume the entire `<...>` clause.
        let depth = 0;
        while (!this.is(TT.EOF)) {
          const t = this.peek();
          if (t.type === TT.OP && t.value === '<') { depth++; this.next(); continue; }
          if (t.type === TT.OP && t.value === '>') {
            depth--;
            this.next();
            if (depth === 0) break;
            continue;
          }
          this.next();
        }
        continue;
      }
      if (this.isOp('[')) {
        const bracket = this.next();
        const index = this.parseExpression();
        this.eatOp(']');
        // `x[1]` where x is a plain identifier is history access; otherwise array index.
        if (node.type === NT.IDENT) {
          node = this.id({ type: NT.HIST, name: node.name, index, line: bracket.line });
        } else {
          node = this.id({ type: NT.INDEX, object: node, index, line: bracket.line });
        }
        continue;
      }
      break;
    }
    return node;
  }

  parseArguments() {
    const args = [];
    this.skipNewlines();
    if (this.isOp(')')) return args;
    for (;;) {
      this.skipNewlines();
      // Named argument: ident '=' expr   (a bare '=' only appears here, never as comparison)
      let name = null;
      const t = this.peek();
      if (t.type === TT.IDENT && this.peek(1).type === TT.OP && this.peek(1).value === '=') {
        name = t.value;
        this.next();
        this.next();
        this.skipNewlines();
      }
      const arg = this.parseExpression();
      args.push({ node: arg, name });
      this.skipNewlines();
      if (this.maybe(TT.OP, ',')) continue;
      break;
    }
    this.skipNewlines();
    return args;
  }

  parsePrimary() {
    const t = this.peek();

    if (t.type === TT.NUMBER) {
      this.next();
      return this.id({ type: NT.LITERAL, value: t.value, line: t.line });
    }
    if (t.type === TT.STRING) {
      this.next();
      return this.id({ type: NT.LITERAL, value: t.value, line: t.line });
    }
    if (t.type === TT.COLOR) {
      this.next();
      return this.id({ type: NT.LITERAL, value: { __color: t.value }, line: t.line });
    }
    if (t.type === TT.KEYWORD) {
      if (t.value === 'true' || t.value === 'false') {
        this.next();
        return this.id({ type: NT.LITERAL, value: t.value === 'true', line: t.line });
      }
      if (t.value === 'na') {
        this.next();
        // `na(x)` is the is-na *function*; bare `na` is the missing-value constant.
        if (this.isOp('(')) {
          return this.id({ type: NT.IDENT, name: 'na', line: t.line });
        }
        return this.id({ type: NT.LITERAL, value: null, line: t.line });
      }
      if (t.value === 'if') {
        // if-expression used as a value
        return this.parseIf();
      }
      if (t.value === 'switch') {
        return this.parseSwitch();
      }
      // Pine v6 declaration keywords (`type`, `method`, `enum`, `import`,
      // `export`) are also commonly used as variable names and parameter
      // names in real scripts. When they appear in an expression position
      // (NOT at the start of a statement — that case is handled by
      // parseStatement), they must be treated as plain identifiers so
      // scripts like `f_ma(src, len, type) => switch type ...` compile.
      if (t.value === 'type' || t.value === 'method' || t.value === 'enum' || t.value === 'import' || t.value === 'export') {
        this.next();
        return this.id({ type: NT.IDENT, name: t.value, line: t.line });
      }
    }
    if (t.type === TT.IDENT) {
      this.next();
      const ident = this.id({ type: NT.IDENT, name: t.value, line: t.line });
      // Function declaration: `name(params) => body`
      if (this.isOp('(')) {
        const save = this.i;
        this.next();
        const params = [];
        let ok = true;
        this.skipNewlines();
        if (!this.isOp(')')) {
          for (;;) {
            this.skipNewlines();
            // The parameter name may itself be a keyword used as a name
            // (`type`, `method`, `enum`, `import`, `export`).
            const cur = this.peek();
            if (this.is(TT.IDENT) && (TYPE_NAMES.has(cur.value) || this._isTypeName(cur.value)) && this.peek(1).type === TT.IDENT) {
              // IDENT type qualifier (e.g. `int size`, `pivot p_ivot`) —
              // consume the type, then the parameter name.
              this.next(); // type qualifier
              params.push(this.eat(TT.IDENT).value);
            } else if (this.is(TT.IDENT)) {
              // Plain IDENT parameter name.
              let pname = this.next().value;
              if (this.isOp('.')) {
                this.next();
                pname += '.' + this.eat(TT.IDENT).value;
              }
              params.push(pname);
            } else if (
              this.is(TT.KEYWORD) &&
              TYPE_NAMES.has(cur.value) &&
              // The keyword is a type qualifier ONLY if followed by an IDENT
              // parameter name. Otherwise the keyword itself is the name
              // (handled by the next branch).
              this.peek(1).type === TT.IDENT
            ) {
              this.next(); // consume the type qualifier
              params.push(this.eat(TT.IDENT).value);
            } else if (
              this.is(TT.KEYWORD) &&
              ['type', 'method', 'enum', 'import', 'export', 'na'].includes(cur.value)
            ) {
              // The keyword itself is the parameter name (e.g.
              // `f_ma(src, len, type) => ...`).
              params.push(this.next().value);
            } else {
              ok = false;
              break;
            }
            // Optional default value: `name = expr`. Skip the `= expr` so
            // parsing doesn't break (defaults are not modelled at runtime
            // — Pine uses them only when an argument is missing).
            if (this.isOp('=')) {
              this.next();
              this.parseExpression();
            }
            this.skipNewlines();
            if (this.maybe(TT.OP, ',')) continue;
            break;
          }
        }
        if (ok && this.isOp(')')) {
          this.next();
          if (this.isOp('=>')) {
            this.next();
            const body = this.parseSuite();
            return this.id({
              type: NT.FUN_DECL,
              name: t.value,
              params,
              body,
              line: t.line,
            });
          }
        }
        this.i = save;
      }
      return ident;
    }
    if (t.type === TT.OP && t.value === '(') {
      this.next();
      this.skipNewlines();
      const inner = this.parseExpression();
      this.skipNewlines();
      this.eatOp(')');
      return inner;
    }
    if (t.type === TT.OP && t.value === '[') {
      this.next();
      this.skipNewlines();
      const items = [];
      if (!this.isOp(']')) {
        for (;;) {
          this.skipNewlines();
          items.push(this.parseExpression());
          this.skipNewlines();
          if (this.maybe(TT.OP, ',')) continue;
          break;
        }
      }
      this.skipNewlines();
      this.eatOp(']');
      // `[a, b] = f()` destructuring target, or an array literal.
      if (items.length > 1 && items.every((n) => n.type === NT.IDENT) && this.isAssignFollow()) {
        return this.id({ type: NT.TUPLE_EXPR, items, line: t.line, isPattern: true });
      }
      if (items.length > 1 && items.every((n) => n.type === NT.IDENT)) {
        return this.id({ type: NT.TUPLE_EXPR, items, line: t.line });
      }
      return this.id({ type: NT.ARRAY, items, line: t.line });
    }

    this.err(`Unexpected token ${JSON.stringify(t.value)}`);
  }

  isAssignFollow() {
    const t = this.peek();
    return t.type === TT.OP && (t.value === '=' || t.value === ':=');
  }
}

export function parse(source) {
  const tokens = tokenizeWithVersion(source);
  const parser = new Parser(tokens);
  return parser.parseProgram();
}

export { PineSyntaxError };
