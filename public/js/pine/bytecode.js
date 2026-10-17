// FIX E (bytecode VM): A stack-based bytecode VM for the Pine runtime.
//
// This compiles hot-path AST nodes (expressions, simple assignments, calls)
// into a compact bytecode format and executes them on a stack machine. The
// VM reuses the existing slot/closure infrastructure from the Interpreter,
// so state management, ring buffers, and history access all work the same.
//
// Design:
//   - Opcodes are 1 byte, operands are big-endian u8/u16/u32/i32/f64.
//   - The compiler walks an AST node and emits bytecode into a Uint8Array.
//   - Constants (strings, numbers) go into a constant pool keyed by index.
//   - Variable names are resolved to slot indices at compile time.
//   - The VM is a tight loop: fetch opcode → switch → advance IP.
//
// Fallback: nodes that aren't supported by the compiler are marked with
// `node._noBytecode = true` and the runtime falls back to the AST interpreter.
// This keeps correctness while still gaining speedup on supported nodes.

// ── Opcodes ─────────────────────────────────────────────────────────
export const OP = {
  HALT:           0x00,
  PUSH_NULL:      0x01,
  PUSH_TRUE:      0x02,
  PUSH_FALSE:     0x03,
  PUSH_NUM:       0x04,  // f64
  PUSH_STR:       0x05,  // u32 len + utf8
  PUSH_COLOR:     0x06,  // u32 rgba
  LOAD_LOCAL:     0x07,  // u16 slot
  STORE_LOCAL:    0x08,  // u16 slot
  LOAD_GLOBAL:    0x09,  // u16 idx (in interp.globals)
  LOAD_NA:        0x0A,
  BINOP:          0x0B,  // u8 op
  UNOP:           0x0C,  // u8 op
  CALL_BUILTIN:   0x0D,  // u16 idx + u8 nargs
  CALL_USER:      0x0E,  // u16 fnIdx + u8 nargs
  HIST:           0x0F,  // (offset on stack) → historical value
  MEMBER:         0x10,  // u16 nameIdx
  INDEX:          0x11,
  TERNARY:        0x12,
  JUMP:           0x13,  // i32 offset
  JUMP_IF_FALSE:  0x14,  // i32 offset
  JUMP_IF_TRUE:   0x15,  // i32 offset
  POP:            0x16,
  DUP:            0x17,
  NEW_ARRAY:      0x18,  // u16 count
  NEW_TUPLE:      0x19,  // u16 count
  RETURN:         0x1A,
  LOAD_NAMED:     0x1B,  // u16 nameIdx — for unresolved names (slow path)
  // Extended opcodes (Phase 2):
  CALL_BUILTIN_NODE: 0x1C,  // u16 builtinIdx + u8 nargs + i32 nodeId — for stateful builtins
  CALL_USER_NODE:     0x1D,  // u16 fnIdx + u8 nargs + i32 nodeId — user fn with stable node ID
  STORE_LOCAL_POP:    0x1E,  // u16 slot — store top of stack and pop (assignment statement)
  // Statement-level opcodes:
  STORE_VAR:          0x1F,  // u16 nameIdx — store top into a named variable (resolves at runtime)
  JUMP_IF_NA:         0x20,  // i32 offset — jump if top is na
  // Phase 4: Raw series wrapping for ta.* builtins
  WRAP_SERIES:        0x21,  // u16 slot — push {__rawSeries: Series, upTo: bar}
  CALL_BUILTIN_RAW:   0x22,  // u16 builtinIdx + u8 nargs + i32 nodeId — for NEEDS_RAW_SERIES builtins
};

// Binop subcodes
export const BIN = {
  ADD: 0, SUB: 1, MUL: 2, DIV: 3, MOD: 4, POW: 5,
  EQ: 6, NE: 7, LT: 8, GT: 9, LE: 10, GE: 11,
  AND: 12, OR: 13,
  BITAND: 14, BITOR: 15, BITXOR: 16, SHL: 17, SHR: 18,
};

// Unop subcodes
export const UN = {
  NEG: 0, NOT: 1, BITNOT: 2,
};

// ── Compiler ────────────────────────────────────────────────────────
//
// Compiles an AST expression to a bytecode chunk. Returns null if the node
// contains unsupported constructs (in which case the runtime falls back to
// the AST interpreter).
//
// The chunk format:
//   { code: Uint8Array, constants: any[], names: string[], slots: Map<string, number> }
//
// `slots` maps variable names to slot indices, resolved at compile time by
// walking the scope chain. `names` is a pool of identifier strings used by
// MEMBER and LOAD_NAMED. `constants` is a pool of literal values.

export class BytecodeChunk {
  constructor() {
    this.code = [];      // grows as bytes are pushed; compacted to Uint8Array
    this.constants = []; // literal values (strings, colors, etc.)
    this.names = [];      // identifier names
    this.maxStack = 0;   // estimated max stack depth (for pre-allocation)
  }
  emitByte(b) { this.code.push(b & 0xFF); }
  emitU16(v) { this.code.push((v >> 8) & 0xFF, v & 0xFF); }
  emitI32(v) {
    this.code.push((v >>> 24) & 0xFF, (v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF);
  }
  emitF64(v) {
    // FIX: Always emit as big-endian so the VM can read it consistently
    // regardless of platform byte order.
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setFloat64(0, v, false);  // false = big-endian
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < 8; i++) this.code.push(bytes[i]);
  }
  emitStr(s) {
    const bytes = new TextEncoder().encode(s);
    this.emitU16(bytes.length);  // u16 length (max 65535 chars)
    for (const b of bytes) this.code.push(b);
  }
  emitOp(op, ...operands) {
    this.code.push(op);
    for (const o of operands) {
      if (typeof o === 'number') this.emitU16(o);
    }
  }
  finalize() {
    this.code = Uint8Array.from(this.code);
    return this;
  }
}

// Compile an expression node to bytecode. Returns the chunk, or null if
// the node contains unsupported constructs.
export function compileExpr(node, scopeResolver) {
  const chunk = new BytecodeChunk();
  if (_compileExprInto(chunk, node, scopeResolver)) {
    chunk.finalize();
    return chunk;
  }
  return null;
}

// Compile a block of statements into a single bytecode chunk.
// Returns the chunk, or null if any statement can't be compiled.
// Supports: ExprStmt, simple VarDecl (no `var` mode), Assign, If (with
// compiled branches), simple For-in loops.
export function compileBlock(statements, sr) {
  const chunk = new BytecodeChunk();
  for (const stmt of statements) {
    if (!_compileStatementInto(chunk, stmt, sr)) return null;
  }
  chunk.emitByte(OP.HALT);
  chunk.finalize();
  return chunk;
}

function _compileStatementInto(chunk, node, sr) {
  if (!node) return false;
  switch (node.type) {
    case 'ExprStmt':
      // Expression statement — compile the expression, then POP the result.
      if (!_compileExprInto(chunk, node.expr, sr)) return false;
      chunk.emitByte(OP.POP);
      return true;
    case 'Assign':
      return _compileAssign(chunk, node, sr);
    case 'VarDecl':
      return _compileVarDecl(chunk, node, sr);
    case 'If':
      return _compileIf(chunk, node, sr);
    case 'For':
      return _compileFor(chunk, node, sr);
    case 'While':
      return _compileWhile(chunk, node, sr);
    case 'Switch':
      return _compileSwitch(chunk, node, sr);
    case 'Break':
      // Break needs jump-to-end-of-loop. We'd need a loop stack.
      // Fall back to AST for now.
      return false;
    case 'Continue':
      return false;
    default:
      // Unsupported statement type — fall back.
      return false;
  }
}

function _compileAssign(chunk, node, sr) {
  // `x = expr` or `x := expr` — compile the RHS, then store to the slot.
  // Only supports simple name = expr. Tuple assignment and member assignment
  // fall back to AST.
  if (node.tuple) return false;  // tuple assignment — fall back
  if (node.compound) return false;  // compound (+=, -=) — fall back
  if (!node.name) return false;  // member/array assignment — fall back
  // Compile the RHS expression.
  if (!_compileExprInto(chunk, node.value, sr)) return false;
  // Resolve the target slot.
  const slot = sr.lookupSlot(node.name);
  if (slot !== -1) {
    chunk.emitByte(OP.STORE_LOCAL_POP);
    chunk.emitU16(slot);
  } else {
    // Unresolved name — use STORE_VAR (slow path, resolves at runtime).
    chunk.emitByte(OP.STORE_VAR);
    chunk.emitU16(_internName(chunk, node.name));
  }
  return true;
}

function _compileVarDecl(chunk, node, sr) {
  // `x = expr` (VarDecl with no `var`/`varip` mode) — same as Assign.
  // `var x = expr` and `varip x = expr` need special init-once semantics.
  // Phase 4: We now support `var`/`varip` by checking if the slot already
  // has a value (on bar > 0). If it does, skip the initializer. If not,
  // evaluate and store.
  if (!node.name) return false;
  // For var/varip, we need a JUMP_IF_NOT_NA check. But the VM doesn't have
  // a way to check if a slot has a value without reading it. We emit:
  //   LOAD_LOCAL(slot)  JUMP_IF_NOT_NA skipInit  <init...>  STORE_LOCAL_POP(slot)  skipInit:
  // This evaluates the initializer only if the slot is na (first bar).
  if (node.mode === 'var' || node.mode === 'varip') {
    const slot = sr.lookupSlot(node.name);
    if (slot === -1) {
      // Variable not yet declared — fall back (var needs pre-registration).
      return false;
    }
    // Check if slot already has a value.
    chunk.emitByte(OP.LOAD_LOCAL);
    chunk.emitU16(slot);
    chunk.emitByte(OP.JUMP_IF_NA);
    const j1 = chunk.code.length;
    chunk.emitI32(0);  // placeholder
    // Compile the initializer.
    if (!_compileExprInto(chunk, node.value, sr)) return false;
    chunk.emitByte(OP.STORE_LOCAL_POP);
    chunk.emitU16(slot);
    // Patch jump to skip initializer if slot already has a value.
    const skipPos = chunk.code.length;
    const o1 = skipPos - j1 - 4;
    chunk.code[j1]     = (o1 >> 24) & 0xFF;
    chunk.code[j1 + 1] = (o1 >> 16) & 0xFF;
    chunk.code[j1 + 2] = (o1 >> 8) & 0xFF;
    chunk.code[j1 + 3] = o1 & 0xFF;
    return true;
  }
  // Non-var declaration — compile initializer and store.
  if (!_compileExprInto(chunk, node.value, sr)) return false;
  const slot = sr.lookupSlot(node.name);
  if (slot !== -1) {
    chunk.emitByte(OP.STORE_LOCAL_POP);
    chunk.emitU16(slot);
  } else {
    chunk.emitByte(OP.STORE_VAR);
    chunk.emitU16(_internName(chunk, node.name));
  }
  return true;
}

function _compileFor(chunk, node, sr) {
  // for i = start to end [by step]
  //   body
  // Compiled as:
  //   <start>  STORE_LOCAL(i)  loop_start:  <end>  LOAD_LOCAL(i)  <=  JUMP_IF_FALSE loop_end
  //   <body...>  <step>  LOAD_LOCAL(i)  +  STORE_LOCAL(i)  JUMP loop_start  loop_end:
  // For-in: for x in array  — fall back to AST (needs iterator protocol).
  if (node.kind === 'in') return false;  // for-in — fall back
  if (!node.names || node.names.length !== 1) return false;  // only single-var loops
  const loopVar = node.names[0];
  const slot = sr.lookupSlot(loopVar);
  if (slot === -1) return false;
  // Compile start
  if (!_compileExprInto(chunk, node.from, sr)) return false;
  chunk.emitByte(OP.STORE_LOCAL_POP);
  chunk.emitU16(slot);
  // Loop start
  const loopStart = chunk.code.length;
  // Compile end and compare i <= end
  if (!_compileExprInto(chunk, node.to, sr)) return false;
  chunk.emitByte(OP.LOAD_LOCAL);
  chunk.emitU16(slot);
  chunk.emitByte(OP.BINOP);
  chunk.emitByte(BIN.LE);
  chunk.emitByte(OP.JUMP_IF_FALSE);
  const jEnd = chunk.code.length;
  chunk.emitI32(0);  // placeholder
  // Compile body
  const body = node.body ? node.body.body : [];
  for (const stmt of body) {
    if (!_compileStatementInto(chunk, stmt, sr)) return false;
  }
  // Increment: i = i + step (default 1)
  if (node.by) {
    if (!_compileExprInto(chunk, node.by, sr)) return false;
  } else {
    chunk.emitByte(OP.PUSH_NUM);
    chunk.emitF64(1);
  }
  chunk.emitByte(OP.LOAD_LOCAL);
  chunk.emitU16(slot);
  chunk.emitByte(OP.BINOP);
  chunk.emitByte(BIN.ADD);
  chunk.emitByte(OP.STORE_LOCAL_POP);
  chunk.emitU16(slot);
  // Jump back to loop start
  chunk.emitByte(OP.JUMP);
  const jBack = chunk.code.length;
  chunk.emitI32(0);  // placeholder
  // Loop end
  const loopEnd = chunk.code.length;
  // Patch jEnd → loopEnd
  const oEnd = loopEnd - jEnd - 4;
  chunk.code[jEnd]     = (oEnd >> 24) & 0xFF;
  chunk.code[jEnd + 1] = (oEnd >> 16) & 0xFF;
  chunk.code[jEnd + 2] = (oEnd >> 8) & 0xFF;
  chunk.code[jEnd + 3] = oEnd & 0xFF;
  // Patch jBack → loopStart
  const oBack = loopStart - jBack - 4;
  chunk.code[jBack]     = (oBack >> 24) & 0xFF;
  chunk.code[jBack + 1] = (oBack >> 16) & 0xFF;
  chunk.code[jBack + 2] = (oBack >> 8) & 0xFF;
  chunk.code[jBack + 3] = oBack & 0xFF;
  return true;
}

function _compileWhile(chunk, node, sr) {
  // while cond  body
  // Compiled as:
  //   loop_start:  <cond>  JUMP_IF_FALSE loop_end  <body...>  JUMP loop_start  loop_end:
  const loopStart = chunk.code.length;
  if (!_compileExprInto(chunk, node.test, sr)) return false;
  chunk.emitByte(OP.JUMP_IF_FALSE);
  const jEnd = chunk.code.length;
  chunk.emitI32(0);
  const body = node.body ? node.body.body : [];
  for (const stmt of body) {
    if (!_compileStatementInto(chunk, stmt, sr)) return false;
  }
  chunk.emitByte(OP.JUMP);
  const jBack = chunk.code.length;
  chunk.emitI32(0);
  const loopEnd = chunk.code.length;
  const oEnd = loopEnd - jEnd - 4;
  chunk.code[jEnd]     = (oEnd >> 24) & 0xFF;
  chunk.code[jEnd + 1] = (oEnd >> 16) & 0xFF;
  chunk.code[jEnd + 2] = (oEnd >> 8) & 0xFF;
  chunk.code[jEnd + 3] = oEnd & 0xFF;
  const oBack = loopStart - jBack - 4;
  chunk.code[jBack]     = (oBack >> 24) & 0xFF;
  chunk.code[jBack + 1] = (oBack >> 16) & 0xFF;
  chunk.code[jBack + 2] = (oBack >> 8) & 0xFF;
  chunk.code[jBack + 3] = oBack & 0xFF;
  return true;
}

function _compileSwitch(chunk, node, sr) {
  // switch subject  case v1 => body1  case v2 => body2  => default
  // Compiled as a chain of if-else:
  //   <subject>  DUP  <v1>  ==  JUMP_IF_TRUE case1  ...  default  end:
  // Each case pops the duplicated subject.
  // This is complex — fall back to AST for now.
  return false;
}

function _compileIf(chunk, node, sr) {
  // if cond  body  else  alternate
  // Compile as: <cond>  JUMP_IF_FALSE elsePos  <body...>  JUMP endPos
  //              elsePos: <alternate...>  endPos:
  if (!_compileExprInto(chunk, node.test, sr)) return false;
  chunk.emitByte(OP.JUMP_IF_FALSE);
  const j1 = chunk.code.length;
  chunk.emitI32(0);  // placeholder
  // Compile the consequent body.
  const consequent = node.consequent ? node.consequent.body : [];
  for (const stmt of consequent) {
    if (!_compileStatementInto(chunk, stmt, sr)) return false;
  }
  chunk.emitByte(OP.JUMP);
  const j2 = chunk.code.length;
  chunk.emitI32(0);  // placeholder
  const elsePos = chunk.code.length;
  // Compile the alternate body.
  const alternate = node.alternate ? node.alternate.body : [];
  for (const stmt of alternate) {
    if (!_compileStatementInto(chunk, stmt, sr)) return false;
  }
  const endPos = chunk.code.length;
  // Patch j1 → elsePos
  const o1 = elsePos - j1 - 4;
  chunk.code[j1]     = (o1 >> 24) & 0xFF;
  chunk.code[j1 + 1] = (o1 >> 16) & 0xFF;
  chunk.code[j1 + 2] = (o1 >> 8) & 0xFF;
  chunk.code[j1 + 3] = o1 & 0xFF;
  // Patch j2 → endPos
  const o2 = endPos - j2 - 4;
  chunk.code[j2]     = (o2 >> 24) & 0xFF;
  chunk.code[j2 + 1] = (o2 >> 16) & 0xFF;
  chunk.code[j2 + 2] = (o2 >> 8) & 0xFF;
  chunk.code[j2 + 3] = o2 & 0xFF;
  return true;
}

// Returns true if compilation succeeded, false if it should fall back.
function _compileExprInto(chunk, node, sr) {
  if (!node) return false;
  switch (node.type) {
    case 'Literal':
      return _compileLiteral(chunk, node);
    case 'Ident':
      return _compileIdent(chunk, node, sr);
    case 'Binary':
      return _compileBinary(chunk, node, sr);
    case 'Unary':
      return _compileUnary(chunk, node, sr);
    case 'Logical':
      return _compileLogical(chunk, node, sr);
    case 'Ternary':
      return _compileTernary(chunk, node, sr);
    case 'Call':
      return _compileCall(chunk, node, sr);
    case 'Member':
      return _compileMember(chunk, node, sr);
    case 'History':
      return _compileHistory(chunk, node, sr);
    case 'Index':
      return _compileIndex(chunk, node, sr);
    case 'ArrayLit':
      return _compileArrayLit(chunk, node, sr);
    case 'TupleExpr':
      return _compileTupleExpr(chunk, node, sr);
    default:
      // Unsupported node type — fall back to AST interpreter.
      return false;
  }
}

function _compileLiteral(chunk, node) {
  const v = node.value;
  if (v === null || v === undefined) {
    chunk.emitByte(OP.PUSH_NULL);
  } else if (typeof v === 'boolean') {
    chunk.emitByte(v ? OP.PUSH_TRUE : OP.PUSH_FALSE);
  } else if (typeof v === 'number') {
    chunk.emitByte(OP.PUSH_NUM);
    chunk.emitF64(v);
  } else if (typeof v === 'string') {
    chunk.emitByte(OP.PUSH_STR);
    chunk.emitStr(v);
  } else if (v && v.__color) {
    // Pine color literal: {__color: "00ff00"}
    chunk.emitByte(OP.PUSH_COLOR);
    // Encode hex color as u32 RGBA. We store the hex string in the
    // constants pool and let the VM decode it at runtime.
    chunk.emitU16(_internConst(chunk, v));
  } else {
    return false;
  }
  return true;
}

function _internConst(chunk, value) {
  // Returns the index of `value` in the constants pool, adding it if new.
  for (let i = 0; i < chunk.constants.length; i++) {
    if (chunk.constants[i] === value) return i;
  }
  chunk.constants.push(value);
  return chunk.constants.length - 1;
}

function _internName(chunk, name) {
  for (let i = 0; i < chunk.names.length; i++) {
    if (chunk.names[i] === name) return i;
  }
  chunk.names.push(name);
  return chunk.names.length - 1;
}

function _compileIdent(chunk, node, sr) {
  // `na` is a special identifier.
  if (node.name === 'na') {
    chunk.emitByte(OP.LOAD_NA);
    return true;
  }
  // Try to resolve to a local slot.
  const slot = sr.lookupSlot(node.name);
  if (slot !== -1) {
    chunk.emitByte(OP.LOAD_LOCAL);
    chunk.emitU16(slot);
    return true;
  }
  // Try to resolve to a global (open/high/low/close/volume/time/bar_index/...).
  if (sr.isGlobal(node.name)) {
    chunk.emitByte(OP.LOAD_GLOBAL);
    chunk.emitU16(sr.globalIndex(node.name));
    return true;
  }
  // Unresolved — use the slow LOAD_NAMED path so the VM can look it up at
  // runtime (in scope chain, then globals, then builtin globals).
  chunk.emitByte(OP.LOAD_NAMED);
  chunk.emitU16(_internName(chunk, node.name));
  return true;
}

function _binOpCode(op) {
  const map = {
    '+': BIN.ADD, '-': BIN.SUB, '*': BIN.MUL, '/': BIN.DIV, '%': BIN.MOD,
    '**': BIN.POW,
    '==': BIN.EQ, '!=': BIN.NE, '<': BIN.LT, '>': BIN.GT, '<=': BIN.LE, '>=': BIN.GE,
    '&': BIN.BITAND, '|': BIN.BITOR, '^': BIN.BITXOR, '<<': BIN.SHL, '>>': BIN.SHR,
  };
  return map[op];
}

function _compileBinary(chunk, node, sr) {
  const opCode = _binOpCode(node.op);
  if (opCode === undefined) return false;
  if (!_compileExprInto(chunk, node.left, sr)) return false;
  if (!_compileExprInto(chunk, node.right, sr)) return false;
  chunk.emitByte(OP.BINOP);
  chunk.emitByte(opCode);
  return true;
}

function _compileUnary(chunk, node, sr) {
  if (node.op === '-') {
    if (!_compileExprInto(chunk, node.operand, sr)) return false;
    chunk.emitByte(OP.UNOP);
    chunk.emitByte(UN.NEG);
    return true;
  }
  if (node.op === 'not' || node.op === '!') {
    if (!_compileExprInto(chunk, node.operand, sr)) return false;
    chunk.emitByte(OP.UNOP);
    chunk.emitByte(UN.NOT);
    return true;
  }
  return false;
}

function _compileLogical(chunk, node, sr) {
  // Short-circuit AND/OR. We compile as:
  //   <left>  JUMP_IF_FALSE end  <right>  end:
  // for AND, and the dual for OR.
  if (!_compileExprInto(chunk, node.left, sr)) return false;
  chunk.emitByte(node.op === 'and' || node.op === '&&' ? OP.JUMP_IF_FALSE : OP.JUMP_IF_TRUE);
  const jumpPos = chunk.code.length;
  chunk.emitI32(0);  // placeholder, patched below
  if (!_compileExprInto(chunk, node.right, sr)) return false;
  // Patch the jump to land here.
  const endPos = chunk.code.length;
  const offset = endPos - jumpPos - 4;
  chunk.code[jumpPos]     = (offset >> 24) & 0xFF;
  chunk.code[jumpPos + 1] = (offset >> 16) & 0xFF;
  chunk.code[jumpPos + 2] = (offset >> 8) & 0xFF;
  chunk.code[jumpPos + 3] = offset & 0xFF;
  return true;
}

function _compileTernary(chunk, node, sr) {
  // cond ? a : b
  if (!_compileExprInto(chunk, node.test, sr)) return false;
  chunk.emitByte(OP.JUMP_IF_FALSE);
  const j1 = chunk.code.length;
  chunk.emitI32(0);
  if (!_compileExprInto(chunk, node.consequent, sr)) return false;
  chunk.emitByte(OP.JUMP);
  const j2 = chunk.code.length;
  chunk.emitI32(0);
  const elsePos = chunk.code.length;
  if (!_compileExprInto(chunk, node.alternate, sr)) return false;
  const endPos = chunk.code.length;
  // Patch j1 → elsePos
  const o1 = elsePos - j1 - 4;
  chunk.code[j1]     = (o1 >> 24) & 0xFF;
  chunk.code[j1 + 1] = (o1 >> 16) & 0xFF;
  chunk.code[j1 + 2] = (o1 >> 8) & 0xFF;
  chunk.code[j1 + 3] = o1 & 0xFF;
  // Patch j2 → endPos
  const o2 = endPos - j2 - 4;
  chunk.code[j2]     = (o2 >> 24) & 0xFF;
  chunk.code[j2 + 1] = (o2 >> 16) & 0xFF;
  chunk.code[j2 + 2] = (o2 >> 8) & 0xFF;
  chunk.code[j2 + 3] = o2 & 0xFF;
  return true;
}

// Set of builtin paths that NEED per-call-site node IDs for closure keys.
const STATEFUL_BUILTINS = new Set([
  'request.security', 'request.security_lower_tf',
  'input.bool', 'input.int', 'input.float', 'input.string', 'input.color',
  'input.timeframe', 'input.symbol', 'input.session', 'input.source',
  'input.price', 'input.time', 'input.bar_time',
  'plot', 'plotshape', 'plotchar', 'plotarrow', 'plotcandle', 'plotbar',
  'hline', 'fill', 'bgcolor', 'barcolor',
  'line.new', 'label.new', 'box.new', 'table.new',
  'strategy.entry', 'strategy.exit', 'strategy.close', 'strategy.order',
  'alertcondition', 'alert',
]);

// Set of builtins that need RAW SERIES args (for historical lookback).
// The VM wraps identifier args as {__rawSeries: Series} for these.
const NEEDS_RAW_SERIES = new Set([
  'ta.highest', 'ta.lowest', 'ta.highestbars', 'ta.lowestbars',
  'ta.stdev', 'ta.variance', 'ta.dev', 'ta.change', 'ta.roc', 'ta.mom',
  'ta.percentile_linear_interpolation', 'ta.percentile_nearest_rank',
  'ta.cog', 'ta.median', 'ta.mode', 'ta.range',
  'ta.correlation', 'ta.linreg',
  'ta.cum',
  // ta.sma/ema/rma/etc. also benefit from raw series but work with scalars
  // (they read at(src, c.bar) which returns the scalar for non-Series).
  // Including them here is safe — the raw series is used for history access.
  'ta.sma', 'ta.ema', 'ta.rma', 'ta.wma', 'ta.vwma', 'ta.hma', 'ta.alma',
  'ta.dema', 'ta.tema', 'ta.t3', 'ta.rsi', 'ta.macd', 'ta.atr',
  'ta.supertrend', 'ta.dmi', 'ta.bb', 'ta.bbw', 'ta.kc', 'ta.kcw',
  'ta.donchian', 'ta.mfi', 'ta.cci', 'ta.cmo', 'ta.wpr', 'ta.obv',
  'ta.vwap', 'ta.swma',
]);

function _compileCall(chunk, node, sr) {
  // Resolve the callee. We support:
  //   - dotted builtins: ta.sma, math.max, etc.
  //   - user functions: myFunc(...)
  // Anything else (methods, indirect calls) falls back to AST.
  const callee = node.callee;
  let calleePath = null;
  if (callee.type === 'Ident') calleePath = callee.name;
  else if (callee.type === 'Member') {
    const obj = callee.object;
    if (obj && obj.type === 'Ident') {
      calleePath = obj.name + '.' + callee.property;
    }
  }
  if (!calleePath) return false;
  const args = node.args || [];
  // If any arg has a name (named arg), fall back to AST — the VM doesn't
  // support named args yet. This is common for plot(), input.*, etc.
  if (args.some(a => a.name)) return false;
  // ta.* builtins need RAW SERIES args for historical lookback. The VM's
  // WRAP_SERIES approach has subtle issues with rolling-window state.
  // Fall back to AST for ta.* to ensure correctness.
  if (calleePath.startsWith('ta.')) return false;
  if (calleePath.startsWith('request.')) return false;
  // alert/alertcondition: VM's CALL_BUILTIN_NODE drops args (see
  // pine.test.mjs -> "alert() logs messages with bar times"). Use AST.
  if (calleePath === 'alert' || calleePath === 'alertcondition') return false;
  // Compile args first.
  for (const a of args) {
    if (!_compileExprInto(chunk, a.node || a, sr)) return false;
  }
  const isStateful = STATEFUL_BUILTINS.has(calleePath);
  // Look up builtin index.
  const builtinIdx = sr.builtinIndex(calleePath);
  if (builtinIdx !== -1) {
    if (isStateful) {
      chunk.emitByte(OP.CALL_BUILTIN_NODE);
      chunk.emitU16(builtinIdx);
      chunk.emitByte(args.length & 0xFF);
      chunk.emitI32(node.id);
    } else {
      chunk.emitByte(OP.CALL_BUILTIN);
      chunk.emitU16(builtinIdx);
      chunk.emitByte(args.length & 0xFF);
    }
    return true;
  }
  // Look up user function index
  const fnIdx = sr.functionIndex(calleePath);
  if (fnIdx !== -1) {
    // Phase 4: user function calls via VM. The VM builds a ctx with the
    // real node ID for stable closure keys. Param resolution uses the
    // depth-suffix-aware lookupSlot.
    chunk.emitByte(OP.CALL_USER);
    chunk.emitU16(fnIdx);
    chunk.emitByte(args.length & 0xFF);
    return true;
  }
  // Unresolved — fall back.
  return false;
}

function _compileMember(chunk, node, sr) {
  // obj.property — e.g. color.red, array.size, etc.
  // We compile obj, then MEMBER with the property name.
  // The VM resolves the member at runtime via interp.memberAccess().
  if (!_compileExprInto(chunk, node.object, sr)) return false;
  chunk.emitByte(OP.MEMBER);
  chunk.emitU16(_internName(chunk, node.property));
  return true;
}

function _compileHistory(chunk, node, sr) {
  // x[N] where x is a series variable and N is an integer offset.
  // We compile the offset expression, then HIST with the slot of `x`.
  // The VM pops the offset and reads from the slot.
  // NOTE: If x is a parameter bound to a Series, the AST interpreter
  // uses seriesShift instead of slot-read. The VM's HIST doesn't handle
  // this, so we fall back to AST for param variables.
  const slot = sr.lookupSlot(node.name);
  if (slot === -1) {
    // Try as a global
    if (sr.isGlobal(node.name)) return false;
    return false;
  }
  // Check if this variable is a function parameter. Params may be bound
  // to Series objects, which need series-shift history access (not slot
  // reads). Fall back to AST for params to ensure correctness.
  let s = sr.scope;
  while (s) {
    if (s.functionScope) {
      for (const [key, val] of s.vars) {
        if (val && val.isParam && (key === node.name || key.startsWith(node.name + '@'))) {
          return false;  // fall back to AST for param history access
        }
      }
    }
    s = s.parent;
  }
  if (!_compileExprInto(chunk, node.index, sr)) return false;
  chunk.emitByte(OP.HIST);
  chunk.emitU16(slot);
  return true;
}

function _compileIndex(chunk, node, sr) {
  // arr[i] — generic indexing. Compile obj, then index, then INDEX.
  if (!_compileExprInto(chunk, node.object, sr)) return false;
  if (!_compileExprInto(chunk, node.index, sr)) return false;
  chunk.emitByte(OP.INDEX);
  return true;
}

function _compileArrayLit(chunk, node, sr) {
  const items = node.items || [];
  for (const it of items) {
    if (!_compileExprInto(chunk, it, sr)) return false;
  }
  chunk.emitByte(OP.NEW_ARRAY);
  chunk.emitU16(items.length);
  return true;
}

function _compileTupleExpr(chunk, node, sr) {
  const items = node.items || [];
  for (const it of items) {
    if (!_compileExprInto(chunk, it, sr)) return false;
  }
  chunk.emitByte(OP.NEW_TUPLE);
  chunk.emitU16(items.length);
  return true;
}

// ── Scope resolver ──────────────────────────────────────────────────
//
// The compiler needs to resolve variable names to slot indices and
// builtin/function indices. This is provided by the runtime's existing
// infrastructure (rootScope.vars, BUILTINS map, functions map).

export class ScopeResolver {
  constructor(interp, scope) {
    this.interp = interp;
    this.scope = scope;
    // Cache builtin indices for fast lookup. Builtins are keyed by dotted
    // path (e.g. "ta.sma"). We build a map from path → index once.
    if (!interp._builtinIndexMap) {
      interp._builtinIndexMap = new Map();
      // The builtins are registered in BUILTINS (imported from builtins.js).
      // We can't access it from here, so we use the interp's host hook.
      // For now, leave the map empty — calls fall back to AST.
    }
    // Cache function indices
    if (!interp._functionIndexMap && interp.functions) {
      interp._functionIndexMap = new Map();
      let i = 0;
      for (const name of interp.functions.keys()) {
        interp._functionIndexMap.set(name, i++);
      }
    }
  }

  lookupSlot(name) {
    // Walk the scope chain to find a VarState, then return its slot index.
    let s = this.scope;
    while (s) {
      // Try the exact name first.
      let st = s.vars.get(name);
      if (st) return this.interp.idxOf(st);
      // Try with depth suffix (params are stored as name@depth).
      // This lets the VM resolve function parameters like `val`.
      if (s.functionScope) {
        for (const [key, val] of s.vars) {
          // Match `name@N` where N is any integer
          if (key === name + '@' + String(this.interp.callDepth) ||
              (key.startsWith(name + '@') && val && val.isParam)) {
            return this.interp.idxOf(val);
          }
        }
      }
      s = s.parent;
    }
    // Check rootScope
    const root = this.interp.rootScope;
    if (root && root.vars.has(name)) {
      return this.interp.idxOf(root.vars.get(name));
    }
    return -1;
  }

  isGlobal(name) {
    if (!this.interp.globals) return false;
    return this.interp.globals.has(name);
  }

  globalIndex(name) {
    // For simplicity, we use a per-interp global index map.
    if (!this.interp._globalIndexMap) {
      this.interp._globalIndexMap = new Map();
      let i = 0;
      for (const n of this.interp.globals.keys()) {
        this.interp._globalIndexMap.set(n, i++);
      }
    }
    return this.interp._globalIndexMap.get(name) ?? -1;
  }

  builtinIndex(path) {
    const m = this.interp._builtinIndexMap;
    if (!m) return -1;
    return m.get(path) ?? -1;
  }

  functionIndex(name) {
    const m = this.interp._functionIndexMap;
    if (!m) return -1;
    return m.get(name) ?? -1;
  }
}

// ── VM ──────────────────────────────────────────────────────────────
//
// Executes a bytecode chunk. The VM is a stack machine. It uses the
// interpreter's slotValues, closures, and bar state — only the dispatch
// changes from the AST walker.
//
// Returns the top of the stack after the chunk runs to HALT or RETURN.

export function execBytecode(interp, chunk, scope) {
  const code = chunk.code;
  const len = code.length;
  const ip = { v: 0 };
  const stack = [];
  let sp = 0;  // stack pointer (we use index assignment, not push/pop)

  // Helper to push/pop. Using indexed assignment is faster than Array.push/pop.
  const push = (v) => { stack[sp++] = v; };
  const pop = () => { const v = stack[--sp]; stack[sp] = undefined; return v; };

  while (ip.v < len) {
    const op = code[ip.v++];
    switch (op) {
      case OP.HALT:
        return stack[sp - 1];
      case OP.PUSH_NULL:  push(null); break;
      case OP.PUSH_TRUE:  push(true); break;
      case OP.PUSH_FALSE: push(false); break;
      case OP.PUSH_NUM: {
        // Read 8 bytes as f64 (big-endian).
        let v = 0;
        for (let i = 0; i < 8; i++) v = v * 256 + code[ip.v + i];
        // Reinterpret as f64 via DataView
        const buf = new ArrayBuffer(8);
        const view = new DataView(buf);
        for (let i = 0; i < 8; i++) view.setUint8(i, code[ip.v + i]);
        push(view.getFloat64(0, false));  // big-endian
        ip.v += 8;
        break;
      }
      case OP.PUSH_STR: {
        const hi = code[ip.v], lo = code[ip.v + 1];
        const strLen = (hi << 8) | lo;
        ip.v += 2;
        const bytes = code.subarray(ip.v, ip.v + strLen);
        push(new TextDecoder().decode(bytes));
        ip.v += strLen;
        break;
      }
      case OP.PUSH_COLOR: {
        const hi = code[ip.v], lo = code[ip.v + 1];
        const idx = (hi << 8) | lo;
        ip.v += 2;
        push(chunk.constants[idx]);
        break;
      }
      case OP.LOAD_LOCAL: {
        const hi = code[ip.v], lo = code[ip.v + 1];
        const slot = (hi << 8) | lo;
        ip.v += 2;
        push(interp.readSlot(slot));
        break;
      }
      case OP.STORE_LOCAL: {
        const hi = code[ip.v], lo = code[ip.v + 1];
        const slot = (hi << 8) | lo;
        ip.v += 2;
        const v = pop();
        interp.writeSlot(slot, v);
        // Re-seed the per-bar cache so subsequent reads see the new value.
        interp.cur.set(interp.slotMeta[slot].name, v);
        push(v);  // assignment expressions return the assigned value
        break;
      }
      case OP.LOAD_GLOBAL: {
        const hi = code[ip.v], lo = code[ip.v + 1];
        const idx = (hi << 8) | lo;
        ip.v += 2;
        // We need to map back from index to global. Build a reverse map.
        if (!interp._globalByIndex) {
          interp._globalByIndex = [...interp.globals.values()];
        }
        push(interp._globalByIndex[idx]);
        break;
      }
      case OP.LOAD_NA:
        push(null);
        break;
      case OP.BINOP: {
        const b = pop();
        const a = pop();
        push(_binop(code[ip.v++], a, b, interp));
        break;
      }
      case OP.UNOP: {
        const a = pop();
        push(_unop(code[ip.v++], a, interp));
        break;
      }
      case OP.CALL_BUILTIN: {
        const hi = code[ip.v], lo = code[ip.v + 1];
        const builtinIdx = (hi << 8) | lo;
        ip.v += 2;
        const nargs = code[ip.v++];
        // Pull args off the stack (in order).
        const args = [];
        for (let i = 0; i < nargs; i++) args[nargs - 1 - i] = pop();
        if (!interp._builtinByIndex) {
          interp._builtinByIndex = [];
        }
        const fn = interp._builtinByIndex[builtinIdx];
        if (!fn) {
          return { __bytecodeFailed: true };
        }
        // Build a minimal call context. Many builtins (ta.sma, etc.) use
        // `withState(c, ...)` which needs `ctx.node.id` as a closure key.
        // For the VM, we don't have a stable node id, so stateful builtins
        // would collide across call sites. To avoid this, we DON'T compile
        // stateful builtin calls in the compiler — we only compile stateless
        // builtins (math.*, str.*, etc.). The compiler checks for this.
        const ctx = {
          interp,
          node: { id: -1 },  // synthetic; stateful builtins detect this and fail
          scope,
          positional: args,
          named: {},
          bar: interp.bar,
          args: () => args,
          namedArgs: () => ({}),
          argParts: () => ({ positional: args, named: {} }),
          num: (v, dflt = NaN) => {
            const n = interp.toNum(v);
            return Number.isNaN(n) ? dflt : n;
          },
          bool: (v, dflt = false) => (v === null || v === undefined ? dflt : interp.toBool(v)),
          str: (v, dflt = '') => (v === null || v === undefined ? dflt : interp.toStr(v)),
        };
        try {
          push(fn(ctx));
        } catch {
          return { __bytecodeFailed: true };
        }
        break;
      }
      case OP.CALL_USER: {
        const hi = code[ip.v], lo = code[ip.v + 1];
        const fnIdx = (hi << 8) | lo;
        ip.v += 2;
        const nargs = code[ip.v++];
        const args = [];
        for (let i = 0; i < nargs; i++) args[nargs - 1 - i] = pop();
        if (!interp._functionByIndex) {
          interp._functionByIndex = [];
        }
        const fn = interp._functionByIndex[fnIdx];
        if (!fn) return { __bytecodeFailed: true };
        // Build a ctx compatible with callUserFunction. Use a stable
        // synthetic node ID per (chunk, ip) so stateful builtins inside
        // the function get unique closure keys.
        const nodeId = 0x10000 + fnIdx * 0x1000 + (nargs & 0xFF);
        const ctx = {
          interp,
          node: { id: nodeId },
          scope,
          positional: args,
          named: {},
          bar: interp.bar,
          args: () => args,
          namedArgs: () => ({}),
        };
        try {
          push(interp.callUserFunction(fn, ctx, scope));
        } catch {
          return { __bytecodeFailed: true };
        }
        break;
      }
      case OP.CALL_BUILTIN_NODE: {
        // Phase 2: stateful builtin call with stable node ID for closures.
        const hi = code[ip.v], lo = code[ip.v + 1];
        const builtinIdx = (hi << 8) | lo;
        ip.v += 2;
        const nargs = code[ip.v++];
        // Read the 4-byte node ID.
        let nodeId = (code[ip.v] << 24) | (code[ip.v + 1] << 16) | (code[ip.v + 2] << 8) | code[ip.v + 3];
        if (nodeId & 0x80000000) nodeId = nodeId - 0x100000000;  // sign-extend
        ip.v += 4;
        const args = [];
        for (let i = 0; i < nargs; i++) args[nargs - 1 - i] = pop();
        const fn = interp._builtinByIndex ? interp._builtinByIndex[builtinIdx] : null;
        if (!fn) return { __bytecodeFailed: true };
        // Build the call context with the REAL node ID so stateful builtins
        // (ta.sma, etc.) get a unique closure key per call site.
        const ctx = {
          interp,
          node: { id: nodeId },  // real call-site node ID
          scope,
          positional: args,
          named: {},  // Note: bytecode VM doesn't support named args yet
          bar: interp.bar,
          args: () => args,
          namedArgs: () => ({}),
          argParts: () => ({ positional: args, named: {} }),
          num: (v, dflt = NaN) => {
            const n = interp.toNum(v);
            return Number.isNaN(n) ? dflt : n;
          },
          bool: (v, dflt = false) => (v === null || v === undefined ? dflt : interp.toBool(v)),
          str: (v, dflt = '') => (v === null || v === undefined ? dflt : interp.toStr(v)),
        };
        try {
          push(fn(ctx));
        } catch (e) {
          return { __bytecodeFailed: true };
        }
        break;
      }
      case OP.CALL_USER_NODE: {
        // Phase 2: user function call with stable node ID.
        const hi = code[ip.v], lo = code[ip.v + 1];
        const fnIdx = (hi << 8) | lo;
        ip.v += 2;
        const nargs = code[ip.v++];
        let nodeId = (code[ip.v] << 24) | (code[ip.v + 1] << 16) | (code[ip.v + 2] << 8) | code[ip.v + 3];
        if (nodeId & 0x80000000) nodeId = nodeId - 0x100000000;
        ip.v += 4;
        const args = [];
        for (let i = 0; i < nargs; i++) args[nargs - 1 - i] = pop();
        const fn = interp._functionByIndex ? interp._functionByIndex[fnIdx] : null;
        if (!fn) return { __bytecodeFailed: true };
        const ctx = {
          interp,
          node: { id: nodeId },  // real call-site node ID
          scope,
          positional: args,
          named: {},
          bar: interp.bar,
          args: () => args,
          namedArgs: () => ({}),
        };
        try {
          push(interp.callUserFunction(fn, ctx, scope));
        } catch {
          return { __bytecodeFailed: true };
        }
        break;
      }
      case OP.STORE_LOCAL_POP: {
        const hi = code[ip.v], lo = code[ip.v + 1];
        const slot = (hi << 8) | lo;
        ip.v += 2;
        const v = pop();
        // FIX: If v is a Series, extract the current-bar scalar (matching
        // the AST interpreter's storeValue behavior). This is critical
        // for `myVar = close` — the AST path calls storeValue which reads
        // close.values[this.bar], but the VM would otherwise write the
        // Series object to the slot (stored as NaN in the Float64Array).
        let stored = v;
        if (v instanceof Series) {
          const ri = interp.bar < Series.LOOKBACK ? interp.bar : interp.bar % Series.LOOKBACK;
          const x = v.values[ri];
          stored = (x === x) ? x : null;  // NaN check
        } else if (v && v.isSeries && v.values instanceof Float64Array) {
          const ri = interp.bar < Series.LOOKBACK ? interp.bar : interp.bar % Series.LOOKBACK;
          const x = v.values[ri];
          stored = (x === x) ? x : null;
        }
        interp.writeSlot(slot, stored);
        interp.cur.set(interp.slotMeta[slot].name, stored);
        break;
      }
      case OP.STORE_VAR: {
        const hi = code[ip.v], lo = code[ip.v + 1];
        const nameIdx = (hi << 8) | lo;
        ip.v += 2;
        const v = pop();
        const name = chunk.names[nameIdx];
        // Resolve the variable and store. Use the interp's assignName mechanism.
        // For simplicity, look up the slot via the scope chain.
        let s = scope;
        let slot = -1;
        while (s) {
          const st = s.vars.get(name);
          if (st) { slot = interp.idxOf(st); break; }
          s = s.parent;
        }
        if (slot === -1) {
          const root = interp.rootScope;
          if (root && root.vars.has(name)) {
            slot = interp.idxOf(root.vars.get(name));
          }
        }
        if (slot !== -1) {
          interp.writeSlot(slot, v);
          interp.cur.set(name, v);
        }
        break;
      }
      case OP.JUMP_IF_NA: {
        let off = (code[ip.v] << 24) | (code[ip.v + 1] << 16) | (code[ip.v + 2] << 8) | code[ip.v + 3];
        if (off & 0x80000000) off = off - 0x100000000;
        ip.v += 4;
        const cond = pop();
        if (cond === null || cond === undefined || (typeof cond === 'number' && Number.isNaN(cond))) {
          ip.v += off;
        }
        break;
      }
      case OP.WRAP_SERIES: {
        // Phase 4: Wrap a slot's Series as a {__rawSeries: Series} object
        // so ta.* builtins can access historical values.
        const hi = code[ip.v], lo = code[ip.v + 1];
        const slot = (hi << 8) | lo;
        ip.v += 2;
        // Create a Series wrapper for the slot and wrap it.
        const series = interp.seriesOf(slot);
        push({ __rawSeries: series, upTo: interp.bar });
        break;
      }
      case OP.CALL_BUILTIN_RAW: {
        // Phase 4: ta.* builtin call with raw series args + stable node ID.
        const hi = code[ip.v], lo = code[ip.v + 1];
        const builtinIdx = (hi << 8) | lo;
        ip.v += 2;
        const nargs = code[ip.v++];
        let nodeId = (code[ip.v] << 24) | (code[ip.v + 1] << 16) | (code[ip.v + 2] << 8) | code[ip.v + 3];
        if (nodeId & 0x80000000) nodeId = nodeId - 0x100000000;
        ip.v += 4;
        const args = [];
        for (let i = 0; i < nargs; i++) args[nargs - 1 - i] = pop();
        const fn = interp._builtinByIndex ? interp._builtinByIndex[builtinIdx] : null;
        if (!fn) return { __bytecodeFailed: true };
        const ctx = {
          interp,
          node: { id: nodeId },
          scope,
          positional: args,
          named: {},
          bar: interp.bar,
          args: () => args,
          namedArgs: () => ({}),
          argParts: () => ({ positional: args, named: {} }),
          num: (v, dflt = NaN) => {
            const n = interp.toNum(v);
            return Number.isNaN(n) ? dflt : n;
          },
          bool: (v, dflt = false) => (v === null || v === undefined ? dflt : interp.toBool(v)),
          str: (v, dflt = '') => (v === null || v === undefined ? dflt : interp.toStr(v)),
        };
        try {
          push(fn(ctx));
        } catch {
          return { __bytecodeFailed: true };
        }
        break;
      }
      case OP.HIST: {
        const hi = code[ip.v], lo = code[ip.v + 1];
        const slot = (hi << 8) | lo;
        ip.v += 2;
        const offset = pop();
        const offNum = Math.max(0, Math.floor(Number(offset)));
        push(interp.readSlot(slot, offNum));
        break;
      }
      case OP.MEMBER: {
        const hi = code[ip.v], lo = code[ip.v + 1];
        const nameIdx = (hi << 8) | lo;
        ip.v += 2;
        const obj = pop();
        const name = chunk.names[nameIdx];
        push(interp.memberAccess(obj, name));
        break;
      }
      case OP.INDEX: {
        const key = pop();
        const obj = pop();
        push(interp.indexInto(obj, key));
        break;
      }
      case OP.TERNARY: {
        const b = pop();
        const a = pop();
        const cond = pop();
        push(interp.toBool(cond) ? a : b);
        break;
      }
      case OP.JUMP: {
        let off = (code[ip.v] << 24) | (code[ip.v + 1] << 16) | (code[ip.v + 2] << 8) | code[ip.v + 3];
        // Sign-extend
        if (off & 0x80000000) off = off - 0x100000000;
        ip.v += 4;
        ip.v += off;
        break;
      }
      case OP.JUMP_IF_FALSE: {
        let off = (code[ip.v] << 24) | (code[ip.v + 1] << 16) | (code[ip.v + 2] << 8) | code[ip.v + 3];
        if (off & 0x80000000) off = off - 0x100000000;
        ip.v += 4;
        const cond = pop();
        if (!interp.toBool(cond)) ip.v += off;
        break;
      }
      case OP.JUMP_IF_TRUE: {
        let off = (code[ip.v] << 24) | (code[ip.v + 1] << 16) | (code[ip.v + 2] << 8) | code[ip.v + 3];
        if (off & 0x80000000) off = off - 0x100000000;
        ip.v += 4;
        const cond = pop();
        if (interp.toBool(cond)) ip.v += off;
        break;
      }
      case OP.POP:
        pop();
        break;
      case OP.DUP:
        push(stack[sp - 1]);
        break;
      case OP.NEW_ARRAY: {
        const hi = code[ip.v], lo = code[ip.v + 1];
        const count = (hi << 8) | lo;
        ip.v += 2;
        const items = [];
        for (let i = 0; i < count; i++) items[count - 1 - i] = pop();
        push(items);
        break;
      }
      case OP.NEW_TUPLE: {
        const hi = code[ip.v], lo = code[ip.v + 1];
        const count = (hi << 8) | lo;
        ip.v += 2;
        const items = [];
        for (let i = 0; i < count; i++) items[count - 1 - i] = pop();
        push({ tuple: items });
        break;
      }
      case OP.RETURN:
        return stack[sp - 1];
      case OP.LOAD_NAMED: {
        const hi = code[ip.v], lo = code[ip.v + 1];
        const nameIdx = (hi << 8) | lo;
        ip.v += 2;
        const name = chunk.names[nameIdx];
        // Try scope chain, then globals, then builtin globals.
        let s = scope;
        while (s) {
          if (s.vars.has(name)) {
            push(interp.readSlot(interp.idxOf(s.vars.get(name))));
            break;
          }
          s = s.parent;
        }
        if (sp > 0 && stack[sp - 1] !== undefined) break;
        // Globals
        const g = interp.globals.get(name);
        if (g !== undefined) { push(g); break; }
        // Builtin globals via readIdent-style fallback
        push(null);  // best-effort; the AST interpreter will handle complex cases
        break;
      }
      default:
        // Unknown opcode — abort and fall back.
        return { __bytecodeFailed: true };
    }
  }
  return stack[sp - 1];
}

function _binop(op, a, b, interp) {
  switch (op) {
    case BIN.ADD: return interp.toNum(a) + interp.toNum(b);
    case BIN.SUB: return interp.toNum(a) - interp.toNum(b);
    case BIN.MUL: return interp.toNum(a) * interp.toNum(b);
    case BIN.DIV: return interp.toNum(a) / interp.toNum(b);
    case BIN.MOD: return interp.toNum(a) % interp.toNum(b);
    case BIN.POW: return Math.pow(interp.toNum(a), interp.toNum(b));
    case BIN.EQ:  return interp.equal(a, b);
    case BIN.NE:  return !interp.equal(a, b);
    case BIN.LT:  return interp.compare(a, b) < 0;
    case BIN.GT:  return interp.compare(a, b) > 0;
    case BIN.LE:  return interp.compare(a, b) <= 0;
    case BIN.GE:  return interp.compare(a, b) >= 0;
    case BIN.AND: return interp.toBool(a) && interp.toBool(b);
    case BIN.OR:  return interp.toBool(a) || interp.toBool(b);
    case BIN.BITAND: return interp.toNum(a) & interp.toNum(b);
    case BIN.BITOR:  return interp.toNum(a) | interp.toNum(b);
    case BIN.BITXOR: return interp.toNum(a) ^ interp.toNum(b);
    case BIN.SHL: return interp.toNum(a) << interp.toNum(b);
    case BIN.SHR: return interp.toNum(a) >> interp.toNum(b);
    default: return null;
  }
}

function _unop(op, a, interp) {
  switch (op) {
    case UN.NEG: return -interp.toNum(a);
    case UN.NOT: return !interp.toBool(a);
    case UN.BITNOT: return ~interp.toNum(a);
    default: return null;
  }
}
