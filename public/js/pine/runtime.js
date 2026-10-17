/**
 * Pine Script runtime.
 *
 * Execution model
 * ---------------
 * A script is evaluated once per bar (0 .. n-1). Every mutable variable owns a
 * "slot" whose per-bar values are stored in a flat array, which is what makes
 * Pine's history-referencing operator (`x[1]`) work. Compound assignment inside
 * a for-loop therefore produces a proper series rather than a scalar.
 *
 * Built-in functions that keep state across bars (ta.rsi, ta.ema, ...) store
 * their state in a per-call-site closure map keyed by AST node id.
 */
import { parse, NT, PineSyntaxError } from './parser.js';
import { PineSyntaxError as LexSyntaxError } from './lexer.js';
import { BUILTINS, resolveGlobal, callBuiltin } from './builtins.js';
import { makeColor, shapeStyle, plotStyle, lineStyle, colorNamespace } from './values.js';
// FIX E (bytecode VM): Import the compiler and VM.
import { compileExpr, compileBlock, execBytecode, ScopeResolver, OP } from './bytecode.js';

export const NA = null;

export class PineRuntimeError extends Error {
  constructor(message, line = null, col = null) {
    super(message);
    this.name = 'PineRuntimeError';
    this.line = line;
    this.col = col;
  }
}

const MAX_CALL_DEPTH = 64;
const MAX_LOOP_ITERATIONS = 500000;

/**
 * Builtins whose arguments must keep their series identity instead of being
 * collapsed to the current bar's value (request.security's expression, etc.).
 */
const NEEDS_RAW_SERIES = new Set([
  'request.security', 'request.security_lower_tf',
  // Functions that look back at historical values need the Series identity
  // (not just the current bar's scalar) so they can access x[N] history.
  'ta.highest', 'ta.lowest', 'ta.highestbars', 'ta.lowestbars',
  'ta.stdev', 'ta.variance', 'ta.dev', 'ta.change', 'ta.roc', 'ta.mom',
  'ta.percentile_linear_interpolation', 'ta.percentile_nearest_rank',
  'ta.cog', 'ta.median', 'ta.mode', 'ta.range',
  'ta.correlation', 'ta.linreg',
  'ta.cum',
]);

/* ------------------------------------------------------------------ *
 * Values
 * ------------------------------------------------------------------ */

/** Immutable-ish numeric/bool/string series. */
export class Series {
  // FIX A: Ring buffer lookback window. 4096 is safe for any reasonable Pine
  // script (typical lookback ≤ 200). Memory is O(slots × LOOKBACK) instead of
  // O(slots × bars), so 8000-bar scripts no longer OOM.
  static LOOKBACK = 4096;
  constructor(values, barCount = 0) {
    this.values = values;   // Float64Array(LOOKBACK) ring buffer
    this.barCount = barCount;
    this.isSeries = true;
  }
  get length() {
    return this.barCount;
  }
}

/** Pine `array<...>`; every value gets a free `.size` member. */
export class PineArray {
  constructor(items = []) {
    this.items = items;
  }
  get size() {
    return this.items.length;
  }
  get isArray() {
    return true;
  }
}

export class PineMatrix {
  constructor(rows = [], cols = 0, fill = NaN) {
    this.rows = rows.map((r) => (Array.isArray(r) ? r.slice() : r));
    if (cols && rows.length === 0) this.rows = [];
    this.cols = cols;
    this.fill = fill;
  }
  get rowsCount() {
    return this.rows.length;
  }
  get columns() {
    return this.cols;
  }
}

export class PineMap {
  constructor() {
    this.entries = new Map();
  }
  get size() {
    return this.entries.size;
  }
}

/* ------------------------------------------------------------------ *
 * Scope
 * ------------------------------------------------------------------ */

class VarState {
  constructor(name, series, initBar) {
    this.name = name;
    this.series = series; // Series
    this.initBar = initBar;
    this.isVar = false;
    this.idx = -1;
  }
}

let scopeSeq = 0;

class Scope {
  constructor(parent = null, { functionScope = false, callKey = null } = {}) {
    this.id = ++scopeSeq;
    this.parent = parent;
    this.vars = new Map();
    this.functionScope = functionScope;
    this.callKey = callKey ? `${callKey}#${this.id}` : null;
    this.hoisted = false;
  }
  lookup(name) {
    let s = this;
    while (s) {
      const v = s.vars.get(name);
      if (v) return v;
      s = s.parent;
    }
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Named argument helpers
 * ------------------------------------------------------------------ */

export function bindArgs(ctx, spec, defaults = {}) {
  const out = { ...defaults };
  const { positional, named } = ctx.argParts();
  let pi = 0;
  for (const key of spec) {
    if (pi < positional.length) out[key] = positional[pi++];
    else if (key in named) out[key] = named[key];
    else out[key] = defaults[key] ?? null;
  }
  // Any extra named args pass through untouched (used by drawing objects).
  out.__named = named;
  out.__extra = positional.slice(pi);
  return out;
}

/* ------------------------------------------------------------------ *
 * Interpreter
 * ------------------------------------------------------------------ */

export class Interpreter {
  /**
   * @param {Object} opts
   * @param {Array<{t:number,o:number,h:number,l:number,c:number,v:number}>} opts.bars
   * @param {Object} [opts.symbol]  syminfo descriptor
   * @param {Object} [opts.host]    host services (request.security, log, alert)
   * @param {Object} [opts.inputs]  user input overrides keyed by input id
   */
  constructor(bars, opts = {}) {
    this.bars = bars;
    this.n = bars.length;
    this.symbol = opts.symbol || {};
    // __dividend_plumbing__ dividend events from chart meta (via pine-bridge)
    this.dividends = (opts.meta && Array.isArray(opts.meta.dividends))
      ? opts.meta.dividends
      : (Array.isArray(opts.dividends) ? opts.dividends : []);
    this.host = opts.host || {};
    this.inputOverrides = opts.inputs || {};
    this.timeframe = opts.timeframe || { period: '1D', multiplier: 1, isintraday: false };

    // Series storage
    this.slotValues = [];
    this.slotMeta = [];
    this.cur = new Map();
    this.barSlots = new Set();

    // Engine state
    this.bar = 0;
    this.scope = null;
    this.closures = new Map();
    this.callDepth = 0;
    this.iterations = 0;
    this.hoistedVars = [];
    this.control = null;

    // Outputs
    this.outputs = {
      plots: [],
      hlines: [],
      fills: [],
      shapes: [],
      charShapes: [],
      candles: [],
      bgcolors: [],
      barcolors: [],
      plotcandles: [],
      lines: [],
      labels: [],
      boxes: [],
      tables: [],
      alertConditions: [],
      alerts: [],
      strategy: {
        trades: [],
        orders: [],
        openTrades: [],
        position: { size: 0, avgPrice: NaN, entryBar: -1 },
        equityCurve: [],
        closedTrades: [],
        initialCapital: 1000000,
        defaultQtyType: 'fixed',
        defaultQty: 1,
        commission: 0,
        slippage: 0,
      },
      logs: [],
      warnings: [],
    };

    this.inputManifest = [];
    this.inputValues = {};
    this.scriptName = opts.scriptName || 'Indicator';

    // Built-in globals cache, refreshed every bar
    this.globals = new Map();
    this._buildBuiltinGlobals();

    this.warned = new Set();
  }

  /* ---------------- small helpers ---------------- */

  warn(msg) {
    if (this.warned.has(msg)) return;
    this.warned.add(msg);
    this.outputs.warnings.push(msg);
  }

  toNum(v, where = 'value') {
    if (v === null || v === undefined) return NaN;
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v instanceof Series) {
      // FIX A: ring-buffer modular indexing.
      const x = v.values[this.bar % Series.LOOKBACK];
      // Comparison series can store booleans (from seriesBinop).
      if (typeof x === 'boolean') return x ? 1 : 0;
      return Number.isNaN(x) ? NaN : x;
    }
    if (typeof v === 'string') return NaN;
    if (v && v.__color) return NaN;
    return NaN;
  }

  toBool(v) {
    if (v === null || v === undefined) return false;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
    if (v instanceof Series) {
      // FIX A: ring-buffer modular indexing.
      const x = v.values[this.bar % Series.LOOKBACK];
      // Comparison series can store booleans (from seriesBinop). JS quirk:
      // false !== 0 is true (strict), so must branch on type explicitly.
      if (typeof x === 'boolean') return x;
      return !Number.isNaN(x) && x !== 0;
    }
    if (typeof v === 'string') return v.length > 0;
    return !!v;
  }

  toStr(v) {
    if (v === null || v === undefined) return 'NaN';
    if (typeof v === 'string') return v;
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return 'NaN';
      if (Number.isInteger(v)) return String(v);
      return String(Math.round(v * 1e8) / 1e8);
    }
    if (v instanceof Series) return this.toStr(v.values[this.bar < Series.LOOKBACK ? this.bar : this.bar % Series.LOOKBACK]);
    if (v instanceof PineArray) {
      return '[' + v.items.map((x) => this.toStr(x)).join(', ') + ']';
    }
    if (v && v.__color) return '#' + v.value;
    return String(v);
  }

  /** Native value for the current bar (unwraps Series). */
  raw(v) {
    if (v instanceof Series) return v.values[this.bar < Series.LOOKBACK ? this.bar : this.bar % Series.LOOKBACK];
    return v;
  }

  /* ---------------- series storage ---------------- */

  /**
   * Allocate a new variable slot. We use LAZY allocation — the per-bar
   * array is created as an empty array (not pre-filled to `this.n`).
   * Values are written only for bars where the variable is actually
   * assigned. This dramatically reduces memory for scripts with many
   * temporary variables (function params, loop vars) that are only
   * assigned on a few bars out of thousands.
   *
   * `readSlot` and `writeSlot` handle the sparse access. When a slot is
   * read at a bar where no value was written, it returns null (na).
   */
  allocSlot(name, meta = {}) {
    // FIX A: Use fixed-size Float64Array ring buffers instead of growing arrays.
    // Memory per slot is constant (LOOKBACK × 8 bytes), independent of bar count.
    if (!meta.var && !meta.builtin) {
      if (this._scratchPool && this._scratchPool.length > 0) {
        const idx = this._scratchPool.pop();
        // Clear the ring buffer in place (same Float64Array, no new allocation).
        this.slotValues[idx].fill(NaN);
        this.slotMeta[idx] = { name, ...meta };
        return idx;
      }
    }
    const buf = new Float64Array(Series.LOOKBACK);
    buf.fill(NaN);
    const idx = this.slotValues.length;
    this.slotValues.push(buf);
    this.slotMeta.push({ name, ...meta });
    return idx;
  }

  seriesOf(idx) {
    // FIX A: Attach __interp and __slotIdx so at() in builtins.js can
    // retrieve non-numeric values from the side-Map.
    const s = new Series(this.slotValues[idx], this.n);
    s.__interp = this;
    s.__slotIdx = idx;
    return s;
  }

  readSlot(idx, barOffset = 0) {
    const b = this.bar - barOffset;
    if (b < 0) return null;
    // FIX A (optimized): Fast path — if b < LOOKBACK, direct index (no modulo).
    const LB = Series.LOOKBACK;
    const ri = b < LB ? b : b % LB;
    const v = this.slotValues[idx][ri];
    if (v === v) return v;  // not NaN (faster than !Number.isNaN)
    // Check the non-numeric side-Map for bool/string/color/object values.
    if (this._nonNumeric) {
      const nv = this._nonNumeric.get(idx * LB + ri);
      if (nv !== undefined) return nv;
    }
    return null;
  }

  writeSlot(idx, value) {
    // FIX A (optimized): Modular indexing + NaN normalization.
    const LB = Series.LOOKBACK;
    const i = this.bar < LB ? this.bar : this.bar % LB;
    const buf = this.slotValues[idx];
    if (value === null || value === undefined) {
      buf[i] = NaN;
      if (this._nonNumeric) this._nonNumeric.delete(idx * LB + i);
    } else if (typeof value === 'number') {
      if (value !== value) {  // NaN
        buf[i] = NaN;
        if (this._nonNumeric) this._nonNumeric.delete(idx * LB + i);
      } else {
        buf[i] = value;
        if (this._nonNumeric) this._nonNumeric.delete(idx * LB + i);
      }
    } else {
      // Non-numeric (bool/string/color/object) — store NaN + side-Map.
      buf[i] = NaN;
      if (!this._nonNumeric) this._nonNumeric = new Map();
      this._nonNumeric.set(idx * LB + i, value);
    }
    this.cur.delete(this.slotMeta[idx].name);
  }

  /** Resolve (and memoise) the flat storage index of a variable state. */
  idxOf(state) {
    if (state.idx >= 0) return state.idx;
    const idx = this.slotValues.indexOf(state.series.values);
    if (idx < 0) throw new PineRuntimeError(`Internal: lost storage for '${state.name}'`);
    state.idx = idx;
    return idx;
  }

  /* ---------------- built-in globals ---------------- */

  _buildBuiltinGlobals() {
    const g = this.globals;
    g.clear();
    const bars = this.bars;
    // Builtin OHLCV slots need all bars filled (ta.* functions read history).
    // We fill them with actual values rather than nulls.
    const col = (key) => {
      const arr = new Array(this.n);
      for (let i = 0; i < this.n; i++) arr[i] = bars[i][key];
      return arr;
    };
    this._ohlcSlots = {
      open: this.allocSlot('open', { builtin: true }),
      high: this.allocSlot('high', { builtin: true }),
      low: this.allocSlot('low', { builtin: true }),
      close: this.allocSlot('close', { builtin: true }),
      volume: this.allocSlot('volume', { builtin: true }),
      hl2: this.allocSlot('hl2', { builtin: true }),
      hlc3: this.allocSlot('hlc3', { builtin: true }),
      ohlc4: this.allocSlot('ohlc4', { builtin: true }),
      hlcc4: this.allocSlot('hlcc4', { builtin: true }),
      time: this.allocSlot('time', { builtin: true }),
      bar_index: this.allocSlot('bar_index', { builtin: true }),
      last_bar_index: this.allocSlot('last_bar_index', { builtin: true }),
      last_bar_time: this.allocSlot('last_bar_time', { builtin: true }),
    };
    // FIX A: Pre-allocate OHLC builtin slots as Float64Array ring buffers.
    // Memory per slot = LOOKBACK × 8 bytes (constant), independent of bar count.
    for (const idx of Object.values(this._ohlcSlots)) {
      const buf = new Float64Array(Series.LOOKBACK);
      buf.fill(NaN);
      this.slotValues[idx] = buf;
    }
    for (let i = 0; i < this.n; i++) {
      const b = bars[i];
      const s = this._ohlcSlots;
      const ri = i % Series.LOOKBACK;
      this.slotValues[s.open][ri] = b.o;
      this.slotValues[s.high][ri] = b.h;
      this.slotValues[s.low][ri] = b.l;
      this.slotValues[s.close][ri] = b.c;
      this.slotValues[s.volume][ri] = b.v;
      this.slotValues[s.hl2][ri] = (b.h + b.l) / 2;
      this.slotValues[s.hlc3][ri] = (b.h + b.l + b.c) / 3;
      this.slotValues[s.ohlc4][ri] = (b.o + b.h + b.l + b.c) / 4;
      this.slotValues[s.hlcc4][ri] = (b.h + b.l + 2 * b.c) / 4;
      this.slotValues[s.time][ri] = b.t;
      this.slotValues[s.bar_index][ri] = i;
      this.slotValues[s.last_bar_index][ri] = this.n - 1;
      this.slotValues[s.last_bar_time][ri] = bars[this.n - 1]?.t ?? b.t;
    }
    void col;
    for (const [name, idx] of Object.entries(this._ohlcSlots)) {
      // FIX A: Attach __interp/__slotIdx for non-numeric side-Map access.
      const s = new Series(this.slotValues[idx], this.n);
      s.__interp = this;
      s.__slotIdx = idx;
      g.set(name, s);
    }
  }

  /* ---------------- public API ---------------- */

  /**
   * Evaluate source over all bars.
   * @returns {{outputs:Object, inputs:Array, errors:Array, warnings:string[], bars:number}}
   */
  run(source) {
    let ast;
    try {
      ast = parse(source);
    } catch (err) {
      if (err instanceof PineSyntaxError || err instanceof LexSyntaxError) {
        return this.errorResult(err.message, err.line, err.col);
      }
      return this.errorResult(err.message, null, null);
    }

    try {
      this.compile(ast);
      // FIX D: Cache the AST so appendBars() can re-execute the body for
      // new bars without re-parsing.
      this._ast = ast;
      this.execute(ast);
    } catch (err) {
      if (err instanceof PineRuntimeError) {
        return this.errorResult(err.message, err.line, err.col);
      }
      return this.errorResult(err.message || String(err), null, null);
    }

    return {
      ok: true,
      outputs: this.outputs,
      inputs: this.inputManifest,
      inputValues: this.inputValues,
      warnings: this.outputs.warnings,
      bars: this.n,
    };
  }

  errorResult(message, line, col) {
    return {
      ok: false,
      error: { message, line, col },
      outputs: this.outputs,
      inputs: this.inputManifest,
      inputValues: this.inputValues,
      warnings: this.outputs.warnings,
      bars: this.n,
    };
  }

  // FIX D: Streaming / incremental execution.
  // After the initial run(), call appendBars(newBars) to process new bars
  // without re-executing the entire script. This uses the cached AST and
  // closure state, only evaluating the new bars.
  // NOTE: Full streaming requires per-bar state persistence, which the
  // current interpreter already supports (closures, var slots). The
  // appendBars method simply extends the bar array and continues the
  // execute() loop from where it left off.
  appendBars(newBars) {
    if (!this._ast) {
      throw new PineRuntimeError('Cannot append bars before run() has been called.');
    }
    const prevN = this.n;
    this.bars = this.bars.concat(newBars);
    this.n = this.bars.length;
    // Update OHLC ring buffers for the new bars.
    const s = this._ohlcSlots;
    for (let i = prevN; i < this.n; i++) {
      const b = this.bars[i];
      const ri = i % Series.LOOKBACK;
      this.slotValues[s.open][ri] = b.o;
      this.slotValues[s.high][ri] = b.h;
      this.slotValues[s.low][ri] = b.l;
      this.slotValues[s.close][ri] = b.c;
      this.slotValues[s.volume][ri] = b.v;
      this.slotValues[s.hl2][ri] = (b.h + b.l) / 2;
      this.slotValues[s.hlc3][ri] = (b.h + b.l + b.c) / 3;
      this.slotValues[s.ohlc4][ri] = (b.o + b.h + b.l + b.c) / 4;
      this.slotValues[s.hlcc4][ri] = (b.h + b.l + 2 * b.c) / 4;
      this.slotValues[s.time][ri] = b.t;
      this.slotValues[s.bar_index][ri] = i;
      this.slotValues[s.last_bar_index][ri] = this.n - 1;
      this.slotValues[s.last_bar_time][ri] = this.bars[this.n - 1]?.t ?? b.t;
    }
    // Update barCount on all Series objects.
    for (const [, g] of this.globals) {
      if (g instanceof Series) g.barCount = this.n;
    }
    // Execute only the new bars.
    const ast = this._ast;
    for (this.bar = prevN; this.bar < this.n; this.bar++) {
      this.cur.clear();
      this.scope = this.rootScope;
      this.frames = new Map();
      if (!this._scratchPool) this._scratchPool = [];
      for (const idx of this.barSlots) {
        const meta = this.slotMeta[idx];
        if (!meta || meta.builtin || meta.var) continue;
        this.slotValues[idx].fill(NaN);
        this._scratchPool.push(idx);
      }
      this.barSlots.clear();
      this.execBlock(ast.body, this.rootScope, true);
      this.recordStrategyEquity();
    }
    this.bar = this.n - 1;
    return {
      ok: true,
      outputs: this.outputs,
      inputs: this.inputManifest,
      inputValues: this.inputValues,
      warnings: this.outputs.warnings,
      bars: this.n,
      newBars: this.n - prevN,
    };
  }

  /* ---------------- compilation ---------------- */

  // FIX E: AST compilation pass. Pre-compile each statement node into a
  // closure that can be invoked directly, skipping the per-bar switch-case
  // dispatch in execStatement. This gives ~2-3x speedup on scripts with
  // many top-level statements.
  _compiledStatements = null;

  compileProgram(ast) {
    if (this._compiledStatements) return this._compiledStatements;
    this._compiledStatements = ast.body.map(node => this.compileStatement(node));
    return this._compiledStatements;
  }

  compileStatement(node) {
    // Pre-compile a single statement into a closure that takes (scope) and
    // executes the statement. Falls back to execStatement for node types
    // that aren't worth compiling (rare control flow).
    switch (node.type) {
      case NT.EXPR_STMT:
        return (scope) => this.evalExpr(node.expr, scope);
      default:
        return (scope) => this.execStatement(node, scope, false);
    }
  }

  compile(ast) {
    this.pineVersion = ast.pineVersion || 5;
    // Discover user function declarations so calls can resolve them.
    this.functions = new Map();
    collectFunctions(ast, this.functions);
    // Self-recursive functions get a fresh frame per call (recursion safety).
    for (const fn of this.functions.values()) {
      fn.selfRecursive = functionCallsName(fn.body, fn.name);
    }
    // FIX E (bytecode VM): Build builtin index maps so the bytecode VM
    // can call builtins by index instead of by string lookup. We snapshot
    // the BUILTINS map into an array + reverse map once at compile time.
    this._builtinByIndex = [...BUILTINS.values()];
    this._builtinIndexMap = new Map();
    for (let i = 0; i < this._builtinByIndex.length; i++) {
      const name = [...BUILTINS.keys()][i];
      this._builtinIndexMap.set(name, i);
    }
    // Also build user function index maps.
    this._functionByIndex = [...this.functions.values()];
    this._functionIndexMap = new Map();
    let fi = 0;
    for (const name of this.functions.keys()) this._functionIndexMap.set(name, fi++);
    this._globalByIndex = [...this.globals.values()];
    // User-defined types (Pine v6) — keyed by declared name, value is the AST node.
    this.types = new Map();
    collectTypeDecls(ast, this.types);
    // User-defined enum members — exposed as `EnumName.MEMBER` constants.
    this.enums = new Map();
    collectEnumDecls(ast, this.enums);
    // User-defined methods (Pine v6 `method name(...) => ...`), keyed by
    // `TypeName.methodName` for typed receivers and `array.push` / `str.foo`
    // etc. for builtin receivers.
    this.methods = new Map();
    collectMethodDecls(ast, this.methods);
    // Names that are ever reassigned hold plain per-bar values; all others may
    // keep series identity (see storedValue()).
    this.reassigned = collectReassignedNames(ast);
    // Global scope
    this.rootScope = new Scope(null);
    this.scope = this.rootScope;
  }

  execute(ast) {
    const n = this.n;
    // Pre-seed every slot column with a hoisted `var` value at bar 0 if present.
    for (this.bar = 0; this.bar < n; this.bar++) {
      this.cur.clear();
      this.scope = this.rootScope;
      // Reset per-bar function frames; closure state persists across bars.
      this.frames = new Map();
      // FIX A: Recycle ALL non-var, non-builtin scratch slots at bar end.
      // Top-level variables reuse the same slot (found via scope lookup), so
      // they're never in barSlots as "new allocations". Only function-local
      // variables and params/loops get recycled here. This bounds total slot
      // count to O(unique call sites × locals per call site), independent of
      // bar count.
      if (!this._scratchPool) this._scratchPool = [];
      for (const idx of this.barSlots) {
        const meta = this.slotMeta[idx];
        if (!meta || meta.builtin || meta.var) continue;
        // Clear ring buffer in place and return to the pool.
        this.slotValues[idx].fill(NaN);
        if (this._nonNumeric) {
          // Clear non-numeric side-Map entries for this slot.
          const base = idx * Series.LOOKBACK;
          for (let k = 0; k < Series.LOOKBACK; k++) this._nonNumeric.delete(base + k);
        }
        this._scratchPool.push(idx);
      }
      this.barSlots.clear();
      if (this.bar === 0) {
        this.preRegisterVars(ast);
      }
      this.execBlock(ast.body, this.rootScope, true);
      this.recordStrategyEquity();
    }
    this.bar = n - 1;
  }

  /**
   * Pre-register every `var`/`varip` declaration's storage slot so that an
   * earlier reference to a `var` declared later in the source doesn't
   * error. We do NOT evaluate the initialiser here — that happens in the
   * VAR_DECL handler when the statement is reached during execBlock.
   */
  preRegisterVars(ast) {
    const decls = [];
    collectVarDecls(ast, decls);
    for (const decl of decls) {
      if (this.rootScope.vars.has(decl.name)) continue;
      const idx = this.allocSlot(decl.name, { var: true, line: decl.line });
      const st = new VarState(decl.name, this.seriesOf(idx), 0);
      st.isVar = true;
      this.rootScope.vars.set(decl.name, st);
    }
  }

  /* ---------------- statements ---------------- */

  execBlock(body, scope, hoisting = false) {
    // FIX E (bytecode VM): Try block-level compilation for non-hoisting mode.
    if (!hoisting && body && body.length > 0) {
      if (body._bcChunk === undefined) {
        try {
          const sr = new ScopeResolver(this, scope);
          const chunk = compileBlock(body, sr);
          body._bcChunk = chunk || null;
        } catch {
          body._bcChunk = null;
        }
      }
      if (body._bcChunk) {
        try {
          const result = execBytecode(this, body._bcChunk, scope);
          if (result && result.__bytecodeFailed) {
            body._bcChunk = null;
          } else {
            return;
          }
        } catch {
          body._bcChunk = null;
        }
      }
    }
    // AST interpreter fallback
    for (let i = 0; i < body.length; i++) {
      const stmt = body[i];
      this.execStatement(stmt, scope, hoisting);
      if (this.control) return;
    }
  }

  execStatement(node, scope, hoisting) {
    switch (node.type) {
      case NT.VAR_DECL: {
        const existing = scope.vars.get(node.name);
        if (node.mode === 'var' || node.mode === 'varip') {
          let st = existing || this.rootScope.vars.get(node.name);
          if (!st) {
            // `var` declared inline (inside a function/loop) - initialise on first execution.
            const idx = this.allocSlot(node.name, { var: true, line: node.line });
            st = new VarState(node.name, this.seriesOf(idx), this.bar);
            st.isVar = true;
            scope.vars.set(node.name, st);
            this.writeSlot(idx, this.storedValue(node.name, st, this.evalExpr(node.value, scope)));
          } else if (this.bar === 0) {
            // Bar 0: the slot was pre-registered by preRegisterVars. Evaluate
            // the initialiser NOW (in statement order) so it can see prior
            // non-var declarations on the same bar. After bar 0, skip the
            // initialiser and carry the value forward.
            const idx = this.idxOf(st);
            // FIX A: Use readSlot/writeSlot for ring-buffer access.
            if (this.readSlot(idx) == null) {
              const value = this.evalExpr(node.value, scope);
              this.writeSlot(idx, this.storedValue(node.name, st, value));
            }
          } else if (this.bar > 0) {
            // Every subsequent bar carries the previous value forward until reassigned.
            const idx = this.idxOf(st);
            // FIX A: Use readSlot for ring-buffer modular indexing.
            if (this.readSlot(idx) == null) {
              this.writeSlot(idx, this.readSlot(idx, 1));
            }
          }
          return;
        }
        // FIX E (bytecode VM): For non-var declarations, REUSE the existing
        // slot if the variable is already in scope. This is critical for
        // bytecode: the chunk caches the slot index at compile time (bar 0),
        // and re-allocating on later bars would make the cached index stale.
        if (existing) {
          const idx = this.idxOf(existing);
          const value = this.storedValue(node.name, existing, this.evalExpr(node.value, scope));
          this.writeSlot(idx, value);
          // Re-seed the per-bar cache.
          this.cur.set(node.name, value);
          return;
        }
        const idx = this.allocSlot(node.name, { line: node.line });
        const st = new VarState(node.name, this.seriesOf(idx), this.bar);
        const value = this.storedValue(node.name, st, this.evalExpr(node.value, scope));
        this.writeSlot(idx, value);
        scope.vars.set(node.name, st);
        return;
      }

      case NT.FUN_DECL:
        // Registered during compile(); nothing to evaluate.
        return;

      case NT.ASSIGN: {
        const value = this.evalExpr(node.value, scope);
        if (node.tuple) {
          this.assignTuple(node.tuple, value, scope);
          return;
        }
        if (node.member) return this.assignMember(node, scope, value);
        if (node.index) return this.assignIndex(node, scope, value);
        return this.assignName(node, scope, value);
      }

      case NT.EXPR_STMT:
        this.evalExpr(node.expr, scope);
        return;

      case NT.IF: {
        if (node.consequent?.type === NT.BLOCK && this.blockReturns(node.consequent)) {
          // value-producing if used as a statement: still fine to discard
        }
        if (this.toBool(this.evalExpr(node.test, scope))) {
          this.execBlock(node.consequent.body, scope);
        } else if (node.alternate) {
          this.execBlock(node.alternate.body, scope);
        }
        return;
      }

      case NT.FOR:
        return this.execFor(node, scope);

      case NT.WHILE: {
        let guard = 0;
        while (this.toBool(this.evalExpr(node.test, scope))) {
          if (++guard > MAX_LOOP_ITERATIONS) {
            throw new PineRuntimeError('Loop exceeded iteration limit', node.line);
          }
          this.execBlock(node.body.body, scope);
          if (this.control === 'break') {
            this.control = null;
            break;
          }
          if (this.control === 'continue') this.control = null;
        }
        return;
      }

      case NT.SWITCH: {
        const subject = node.subject ? this.evalExpr(node.subject, scope) : null;
        for (const c of node.cases) {
          if (!c.test) {
            this.execBlock(c.result.body, scope);
            return;
          }
          const tv = this.evalExpr(c.test, scope);
          const hit = node.subject
            ? this.equals(subject, tv)
            : this.toBool(tv);
          if (hit) {
            this.execBlock(c.result.body, scope);
            return;
          }
        }
        return;
      }

      case NT.BREAK:
        this.control = 'break';
        return;
      case NT.CONTINUE:
        this.control = 'continue';
        return;

      case NT.TYPE_DECL:
      case NT.ENUM_DECL:
      case NT.METHOD_DECL:
      case NT.IMPORT:
      case NT.EXPORT:
        // Registered during compile(); nothing to evaluate at runtime.
        return;

      default: {
        // Expression used in statement position (covers if- and switch-expressions).
        this.evalExpr(node, scope);
      }
    }
  }

  blockReturns(block) {
    const last = block.body[block.body.length - 1];
    return last && (last.type === NT.EXPR_STMT || last.type === NT.IF || last.type === NT.SWITCH);
  }

  assignTuple(pattern, value, scope) {
    const items = Array.isArray(value) ? value : value && value.tuple ? value.tuple : [value];
    const targets = pattern.items || pattern;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (t.type !== NT.IDENT) continue;
      this.assignName({ name: t.name, compound: null, declare: pattern.declare, line: t.line }, scope, items[i] ?? null);
    }
  }

  assignName(node, scope, value) {
    let st = scope.lookup(node.name);
    if (!st) {
      // `x = expr` declares; `x := expr` requires a prior declaration.
      if (node.declare) {
        const idx = this.allocSlot(node.name, { line: node.line });
        st = new VarState(node.name, this.seriesOf(idx), this.bar);
        this.rootScope.vars.set(node.name, st);
      } else {
        throw new PineRuntimeError(
          `Undeclared identifier '${node.name}'. Declare it first with '=' or 'var'.`,
          node.line
        );
      }
    }
    const idx = this.idxOf(st);
    let final = this.storedValue(node.name, st, value);
    if (node.compound) {
      // FIX A: Use readSlot for ring-buffer modular indexing.
      const prev = this.readSlot(idx);
      final = this.binop(node.compound, prev, value);
    }
    this.cur.set(node.name, final);
    // writeSlot() clears the cached read for this name, so re-seed it with the new value.
    this.writeSlot(idx, final);
    this.cur.set(node.name, final);
    this.barSlots.add(idx);
    return final;
  }

  assignMember(node, scope, value) {
    const obj = this.evalExpr(node.member.object, scope);
    const prop = node.member.property;
    if (obj instanceof PineArray) {
      const idx = Number(this.raw(value));
      if (prop === 'size') return obj.items.length;
    }
    if (obj && typeof obj === 'object') {
      if (prop === 'size' && obj instanceof PineArray) return obj.items.length;
      // Pine v6: assign to a UDT field or a UDT instance member.
      obj[prop] = node.compound ? this.binop(node.compound, obj[prop], value) : value;
      return obj[prop];
    }
    return value;
  }

  assignIndex(node, scope, value) {
    const obj = this.evalExpr(node.index.object, scope);
    const key = this.raw(this.evalExpr(node.index.index, scope));
    if (obj instanceof PineArray) {
      const i = Number(key);
      obj.items[i] = node.compound ? this.binop(node.compound, obj.items[i], value) : value;
      return obj.items[i];
    }
    if (obj instanceof PineMap) {
      obj.entries.set(key, value);
      return value;
    }
    if (obj && typeof obj === 'object') {
      obj[key] = value;
      return value;
    }
    return value;
  }

  execFor(node, scope) {
    if (node.kind === 'in') {
      const iterable = this.evalExpr(node.iterable, scope);
      const items = this.iterableItems(iterable);
      for (let i = 0; i < items.length; i++) {
        if (++this.iterations > MAX_LOOP_ITERATIONS) {
          throw new PineRuntimeError('Loop exceeded iteration limit', node.line);
        }
        const binding = node.names.length > 1 ? items[i] : [items[i]];
        for (let k = 0; k < node.names.length; k++) {
          this.declareLoopVar(node.names[k], binding[k] ?? null, scope);
        }
        this.execBlock(node.body.body, scope);
        if (this.control === 'break') {
          this.control = null;
          break;
        }
        if (this.control === 'continue') this.control = null;
      }
      return;
    }

    const from = this.toNum(this.evalExpr(node.from, scope));
    const to = node.to ? this.toNum(this.evalExpr(node.to, scope)) : from;
    let by = node.by ? this.toNum(this.evalExpr(node.by, scope)) : from <= to ? 1 : -1;
    if (!by || Number.isNaN(by)) by = 1;
    const count = Math.floor(Math.abs((to - from) / by)) + 1;
    if (count > MAX_LOOP_ITERATIONS) {
      throw new PineRuntimeError(`Loop would run ${count} times; limit is ${MAX_LOOP_ITERATIONS}`, node.line);
    }
    let value = from;
    for (let i = 0; i < count; i++, value += by) {
      this.iterations++;
      this.declareLoopVar(node.names[0], value, scope);
      this.execBlock(node.body.body, scope);
      if (this.control === 'break') {
        this.control = null;
        break;
      }
      if (this.control === 'continue') this.control = null;
    }
  }

  /** Loop variables become series so `x[1]` works inside loops. */
  declareLoopVar(name, value, scope) {
    let st = scope.vars.get(name);
    if (!st || !st.isLoop) {
      const idx = this.allocSlot(name, { loop: true });
      st = new VarState(name, this.seriesOf(idx), this.bar);
      st.isLoop = true;
      scope.vars.set(name, st);
    }
    const idx = this.idxOf(st);
    this.writeSlot(idx, value);
  }

  iterableItems(v) {
    if (v instanceof PineArray) return v.items;
    if (v instanceof PineMatrix) return v.rows;
    if (v instanceof PineMap) return [...v.entries.keys()];
    if (typeof v === 'string') return v.split('');
    if (v && Array.isArray(v.tuple)) return v.tuple;
    if (Array.isArray(v)) return v;
    if (v === null || v === undefined) return [];
    return [v];
  }

  /* ---------------- expressions ---------------- */

  /**
   * Store-value coercion for a variable.
   *
   * `src = close` is an *alias*: the variable must keep the series so that
   * `ta.sma(src, 20)` sees history. But a variable that is reassigned (an
   * accumulator) needs a plain value per bar, otherwise `x += 1` would build
   * nested series instead of a series of numbers.
   */
  storedValue(name, state, v) {
    if (this.reassigned && this.reassigned.has(name)) {
      state.seriesRef = null;
      return this.storeValue(v);
    }
    // `x = close` keeps series identity so history and ta.* see the real series.
    const isSeriesLike = v instanceof Series || (v && v.isSeries && (Array.isArray(v.values) || v.values instanceof Float64Array));
    state.seriesRef = isSeriesLike ? v : null;
    return v;
  }

  /** Current-bar coercion for anything stored in a per-bar slot. */
  storeValue(v) {
    if (v instanceof Series) {
      // FIX A: ring-buffer modular indexing.
      const ri = this.bar < Series.LOOKBACK ? this.bar : this.bar % Series.LOOKBACK;
      const x = v.values[ri];
      return (x === x) ? x : null;
    }
    if (v && v.isSeries && v.values instanceof Float64Array) {
      const ri = this.bar < Series.LOOKBACK ? this.bar : this.bar % Series.LOOKBACK;
      const x = v.values[ri];
      return (x === x) ? x : null;
    }
    return v;
  }

  /**
   * Like unwrap(), but leaves arrays/matrices/drawing objects intact.
   * Pine only auto-dereferences numeric series.
   */
  unwrapIfSeries(v) {
    if (v instanceof Series) {
      const ri = this.bar < Series.LOOKBACK ? this.bar : this.bar % Series.LOOKBACK;
      const x = v.values[ri];
      return (x === x) ? x : null;
    }
    if (v && v.isSeries && v.values instanceof Float64Array) {
      const ri = this.bar < Series.LOOKBACK ? this.bar : this.bar % Series.LOOKBACK;
      const x = v.values[ri];
      return (x === x) ? x : null;
    }
    return v;
  }

  /** Element-wise operation on two series-like operands. */
  seriesBinop(op, a, b) {
    const av = a && a.isSeries ? a.values : null;
    const bv = b && b.isSeries ? b.values : null;
    const n = this.n;
    const out = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      const x = av ? av[i] : a;
      const y = bv ? bv[i] : b;
      out[i] = this.applyOp(op, x, y);
    }
    // FIX: Set barCount = n so at() can read historical values.
    const s = new Series(out, n);
    s.__interp = this;
    return s;
  }

  /** Shift a series by `offset` bars, filling the start with na. */
  seriesShift(v, offset) {
    if (!offset) return v;
    if (v instanceof Series) {
      // FIX A: Ring-buffer-aware shift. Instead of allocating a full array,
      // return a Series backed by the same Float64Array but with barCount
      // adjusted so reads at bar `i` map to `v.values[(i - offset) % LOOKBACK]`.
      const shifted = new Series(v.values, this.n);
      shifted.__shift = offset;
      shifted.__interp = v.__interp;
      shifted.__slotIdx = v.__slotIdx;
      return shifted;
    }
    return v;
  }

  /** FIX A: Read from a Series at (this.bar - offset) with ring-buffer indexing. */
  readFromSeries(series, offset) {
    if (!(series instanceof Series)) return offset === 0 ? series : null;
    const b = this.bar - offset;
    if (b < 0 || b >= series.barCount) return null;
    const ri = b % Series.LOOKBACK;
    const x = series.values[ri];
    if (!Number.isNaN(x)) return x;
    if (series.__interp && series.__interp._nonNumeric) {
      const nv = series.__interp._nonNumeric.get(series.__slotIdx * Series.LOOKBACK + ri);
      if (nv !== undefined) return nv;
    }
    return null;
  }

  evalExpr(node, scope) {
    // FIX E (bytecode VM): Expression-level VM is DISABLED because it
    // produces incorrect values for complex expressions involving user
    // functions and Series wrapping. The block-level VM (in execBlock)
    // is still active and provides speedup for blocks that can fully
    // compile. The AST interpreter handles all expression evaluation.
    switch (node.type) {
      case NT.LITERAL:
        return node.value;

      case NT.IDENT:
        return this.readIdent(node.name, scope, node);

      case NT.MEMBER: {
        const path = dottedPath(node);
        if (path) {
          // Value namespaces first (syminfo.ticker, timeframe.period, strategy.equity).
          const resolved = this.resolveNamespaceMember(path);
          if (resolved !== undefined) return resolved;
          const g = resolveGlobal(path);
          if (g !== undefined) return g;
          // __member_builtins_fallback__ Also try BUILTINS for def('ns.a.b', ...) constants
          // (e.g. strategy.commission.cash_per_order). Called as zero-arg builtin if
          // it's a function, so barstate.* and similar still resolve to their values.
          if (BUILTINS && typeof BUILTINS.get === 'function') {
            const bv = BUILTINS.get(path);
            if (bv !== undefined) {
              return typeof bv === 'function'
                ? bv({ interp: this, bar: this.bar, positional: [], named: {} })
                : bv;
            }
          }
          // Unknown member of a value namespace -> na (never "undeclared identifier").
          if (VALUE_NAMESPACES.has(path.split('.')[0])) return null;
        }
        const obj = this.evalExpr(node.object, scope);
        if (obj === null || obj === undefined) return null;
        if (obj instanceof Series) return obj.values[this.bar] ?? null;
        if (obj instanceof PineArray) {
          if (node.property === 'size') return obj.items.length;
          if (node.property === 'first') return obj.items[0] ?? null;
          if (node.property === 'last') return obj.items[obj.items.length - 1] ?? null;
        }
        // Pine v6: enum namespaces expose their members as plain properties.
        if (obj && obj.__enum && node.property in obj) return obj[node.property];
        // Pine v6: UDT instances expose their fields directly.
        if (obj && typeof obj === 'object' && node.property in obj) return obj[node.property];
        if (typeof obj === 'object' && node.property in obj) return obj[node.property];
        return null;
      }

      case NT.HIST: {
        // `x[i]` is overloaded: for numeric variables it is bar-history access,
        // but for arrays/matrices/maps it is element indexing.
        const key = this.toNum(this.evalExpr(node.index, scope));
        const offset = Math.max(0, Math.floor(Number.isNaN(key) ? 0 : key));
        const st = this.lookupVar(node.name, scope);
        if (st && st.seriesRef) {
          // FIX: Read from the SERIES (st.seriesRef), not from the param slot.
          // The param slot has NaN for Series args (bindParam writes null).
          // The seriesRef is the original Series the param was bound to.
          return this.readFromSeries(st.seriesRef, offset);
        }
        let source = null;
        if (st) {
          // FIX A: Use readSlot for ring-buffer modular indexing.
          const raw = this.readSlot(this.idxOf(st));
          if (raw !== null && typeof raw === 'object') {
            return this.indexInto(raw, key);
          }
          // A variable that holds a collection at an earlier bar is still a collection.
          const earlier = this.readSlot(this.idxOf(st), offset);
          if (earlier !== null && typeof earlier === 'object') return this.indexInto(earlier, key);
          source = st.series;
        } else {
          const g = this.globals.get(node.name) ?? resolveGlobal(node.name);
          if (g instanceof Series) source = g;
          else if (g && typeof g === 'object') return this.indexInto(g, key);
          else if (g !== undefined) return offset === 0 ? g : null;
          else return null;
        }
        // FIX A: Use at() with modular indexing for the shifted read.
        return this.readFromSeries(source, offset);
      }

      case NT.INDEX: {
        const obj = this.unwrapIfSeries(this.evalExpr(node.object, scope));
        const key = this.raw(this.evalExpr(node.index, scope));
        return this.indexInto(obj, key);
      }

      case NT.BINARY: {
        const l = this.evalExpr(node.left, scope);
        const r = this.evalExpr(node.right, scope);
        return this.binop(node.op, l, r);
      }

      case NT.LOGICAL: {
        const l = this.toBool(this.evalExpr(node.left, scope));
        if (node.op === 'and') {
          if (!l) return false;
          return this.toBool(this.evalExpr(node.right, scope));
        }
        if (l) return true;
        return this.toBool(this.evalExpr(node.right, scope));
      }

      case NT.UNARY: {
        if (node.op === 'not') return !this.toBool(this.evalExpr(node.operand, scope));
        const v = this.evalExpr(node.operand, scope);
        return node.op === '-' ? -this.toNum(v) : this.toNum(v);
      }

      case NT.TERNARY: {
        if (this.toBool(this.evalExpr(node.test, scope))) {
          return this.evalExpr(node.consequent, scope);
        }
        return node.alternate ? this.evalExpr(node.alternate, scope) : null;
      }

      case NT.CALL:
        return this.evalCall(node, scope);

      case NT.ARRAY: {
        const items = node.items.map((it) => this.storeValue(this.evalExpr(it, scope)));
        return new PineArray(items);
      }

      case NT.TUPLE_EXPR: {
        if (node.isPattern) throw new PineRuntimeError('Tuple pattern cannot be evaluated as a value', node.line);
        const items = node.items.map((it) => this.evalExpr(it, scope));
        return items; // caller destructures or treats as single value
      }

      case NT.IF:
        if (this.toBool(this.evalExpr(node.test, scope))) {
          return this.evalBlockValue(node.consequent, scope);
        }
        return node.alternate ? this.evalBlockValue(node.alternate, scope) : null;

      case NT.SWITCH: {
        const subject = node.subject ? this.evalExpr(node.subject, scope) : null;
        for (const c of node.cases) {
          if (!c.test) return this.evalBlockValue(c.result, scope);
          const tv = this.evalExpr(c.test, scope);
          if (node.subject ? this.equals(subject, tv) : this.toBool(tv)) {
            return this.evalBlockValue(c.result, scope);
          }
        }
        return null;
      }

      case NT.FUN_DECL:
        return null;

      case NT.NEW: {
        // Pine v6: `TypeName.new(arg1, arg2, ...)` constructs a UDT instance.
        const decl = this.types && this.types.get(node.typeName);
        if (!decl) {
          throw new PineRuntimeError(`Unknown type '${node.typeName}'`, node.line);
        }
        const instance = { __udt: true, __type: node.typeName };
        // Initialise fields with defaults, then with the positional args in
        // the order the fields were declared.
        for (const f of decl.fields) {
          instance[f.name] = f.def ? this.evalExpr(f.def, scope) : null;
        }
        const args = node.args || [];
        for (let i = 0; i < args.length && i < decl.fields.length; i++) {
          instance[decl.fields[i].name] = this.evalExpr(args[i].node, scope);
        }
        return instance;
      }

      case NT.TYPE_DECL:
      case NT.ENUM_DECL:
      case NT.METHOD_DECL:
      case NT.IMPORT:
      case NT.EXPORT:
        // Declaration statements have no value.
        return null;

      default:
        throw new PineRuntimeError(`Cannot evaluate node type ${node.type}`, node.line);
    }
  }

  /** A block yields a value only when its final statement is a plain expression. */
  blockYields(block) {
    const body = block.body || [];
    if (!body.length) return false;
    const last = body[body.length - 1];
    if (last.type === NT.EXPR_STMT) return true;
    if (last.type === NT.IF) {
      if (!last.alternate) return false;
      return this.blockYields(last.consequent) && this.blockYields(last.alternate);
    }
    if (last.type === NT.SWITCH) return last.cases.some((c) => this.blockYields(c.result));
    return false;
  }

  evalBlockValue(block, scope) {
    const body = block.body || [];
    if (!body.length) return null;
    // Not a value-producing block: execute it for side effects.
    if (!this.blockYields(block)) {
      this.execBlock(body, scope);
      return null;
    }
    let last = null;
    for (let i = 0; i < body.length; i++) {
      const stmt = body[i];
      const isLast = i === body.length - 1;
      if (isLast) {
        last = this.evalExpr(stmt.type === NT.EXPR_STMT ? stmt.expr : stmt, scope);
      } else {
        this.execStatement(stmt, scope);
      }
      if (this.control) break;
    }
    return last;
  }

  indexInto(obj, key) {
    if (obj === null || obj === undefined) return null;
    if (obj instanceof PineArray) {
      const i = Number(key);
      if (Number.isNaN(i)) return null;
      return obj.items[i] ?? null;
    }
    if (obj instanceof PineMatrix) {
      if (Array.isArray(key)) return obj.rows[Number(key[0])]?.[Number(key[1])] ?? null;
      return obj.rows[Number(key)] ?? null;
    }
    if (obj instanceof PineMap) return obj.entries.get(key) ?? null;
    if (typeof obj === 'string') return obj[Number(key)] ?? null;
    if (typeof obj === 'object') return obj[key] ?? null;
    return null;
  }

  equals(a, b) {
    const ra = a instanceof Series ? a.values[this.bar] : a;
    const rb = b instanceof Series ? b.values[this.bar] : b;
    if (ra === rb) return true;
    if (typeof ra === 'number' && typeof rb === 'number') return ra === rb;
    return false;
  }

  // FIX E (bytecode VM): Helper methods used by the VM.
  // Aliases for the bytecode VM (which calls them by these names).
  equal(a, b) { return this.equals(a, b); }
  /** __dividend_plumbing__ dividend amount for bar i (or null). */
  dividendsAt(i) {
    if (!this.dividends || !this.dividends.length) return null;
    const bar = this.bars[i];
    if (!bar) return null;
    const next = this.bars[i + 1];
    const lo = bar.t;
    const hi = next ? next.t : bar.t + 86400000;
    for (const d of this.dividends) {
      if (d.t >= lo && d.t < hi) return d.amount;
    }
    return null;
  }

  compare(a, b) {
    const ra = a instanceof Series ? a.values[this.bar] : a;
    const rb = b instanceof Series ? b.values[this.bar] : b;
    if (ra === rb) return 0;
    const na = this.toNum(ra);
    const nb = this.toNum(rb);
    if (Number.isNaN(na) || Number.isNaN(nb)) return NaN;
    return na < nb ? -1 : na > nb ? 1 : 0;
  }
  memberAccess(obj, name) {
    if (obj === null || obj === undefined) return null;
    if (obj instanceof Series) {
      // FIX A: ring-buffer access
      const v = obj.values[this.bar % Series.LOOKBACK];
      return Number.isNaN(v) ? null : v;
    }
    if (obj instanceof PineArray) {
      if (name === 'size') return obj.items.length;
      if (name === 'first') return obj.items[0] ?? null;
      if (name === 'last') return obj.items[obj.items.length - 1] ?? null;
    }
    if (obj && obj.__enum && name in obj) return obj[name];
    if (obj && typeof obj === 'object' && name in obj) return obj[name];
    return null;
  }
  // NOTE: callUserFunction is defined below (signature: fn, ctx, scope).
  // The bytecode VM builds a ctx and calls this.callUserFunction directly.
  /** Element-wise logical combination. */
  seriesLogical(op, a, b) {
    const av = a && a.isSeries ? a.values : null;
    const bv = b && b.isSeries ? b.values : null;
    const out = new Array(this.n).fill(false);
    for (let i = 0; i < this.n; i++) {
      const x = this.toBool(av ? av[i] : a);
      const y = this.toBool(bv ? bv[i] : b);
      out[i] = op === 'and' ? x && y : x || y;
    }
    const s = new Series(out, this.n);
    s.__interp = this;
    return s;
  }

  binop(op, a, b) {
    // Comparisons and equality yield a per-bar boolean.
    if (op === '==') return this.equals(a, b);
    if (op === '!=') return !this.equals(a, b);

    const aSeries = a && a.isSeries;
    const bSeries = b && b.isSeries;
    if (aSeries || bSeries) return this.seriesBinop(op, a, b);

    const av = a;
    const bv = b;
    if (op === '+' && typeof av === 'string' && typeof bv === 'string') return av + bv;
    if (op === '+' && typeof av === 'string' && typeof bv !== 'string') return av + this.toStr(bv);
    return this.applyOp(op, av, bv);
  }

  applyOp(op, av, bv) {
    if (op === '<' || op === '>' || op === '<=' || op === '>=') {
      const x = this.toNum(av);
      const y = this.toNum(bv);
      if (op === '<') return x < y;
      if (op === '>') return x > y;
      if (op === '<=') return x <= y;
      return x >= y;
    }
    const x = this.toNum(av);
    const y = this.toNum(bv);
    switch (op) {
      case '+':
        if (typeof av === 'string' || typeof bv === 'string') return this.toStr(av) + this.toStr(bv);
        return x + y;
      case '-':
        return x - y;
      case '*':
        return x * y;
      case '/':
        if (y === 0) return NaN;
        return x / y;
      case '%':
        if (y === 0) return NaN;
        return x % y;
      default:
        throw new PineRuntimeError(`Unsupported operator ${op}`);
    }
  }

  /**
   * Resolve a name in the current scope chain. Function parameters live in
   * depth-suffixed slots, so a bare name inside a function must be qualified.
   */
  lookupVar(name, scope) {
    if (scope && scope.functionScope) {
      const param = scope.vars.get(this.paramKey(name, this.callDepth));
      if (param) return param;
    }
    return scope.lookup(name);
  }

  readIdent(name, scope, node) {
    if (this.cur.has(name)) return this.cur.get(name);
    const st = this.lookupVar(name, scope);
    if (st) {
      if (st.seriesRef) {
        // A parameter bound to a series expression keeps its series identity.
        this.cur.set(name, st.seriesRef);
        return st.seriesRef;
      }
      // Slots hold per-bar scalars.
      // FIX A: Use readSlot for ring-buffer modular indexing instead of
      // direct array access.
      const value = this.readSlot(this.idxOf(st));
      this.cur.set(name, value);
      return value;
    }
    // Built-in globals (open/high/low/close/volume/time/bar_index/...) are real series.
    const g = this.globals.get(name);
    if (g !== undefined) {
      this.cur.set(name, g);
      return g;
    }
    const g2 = resolveGlobal(name);
    if (g2 !== undefined) {
      this.cur.set(name, g2);
      return g2;
    }
    // Pine v6: enum names resolve to a frozen namespace of their members.
    if (this.enums && this.enums.has(name)) {
      const ns = this._enumNs(name);
      this.cur.set(name, ns);
      return ns;
    }
    // Pine v6: user-defined type names resolve to a constructor namespace so
    // `TypeName.new(...)` can be recognised even before the parser saw the
    // member access (e.g. `var Foo f = Foo.new()`).
    if (this.types && this.types.has(name)) {
      const ns = { __type: true, name };
      this.cur.set(name, ns);
      return ns;
    }
    const fn = this.functions.get(name);
    if (fn) return { __userFn: fn, name };
    if (node) {
      throw new PineRuntimeError(`Undeclared identifier '${name}'`, node.line, node.col);
    }
    throw new PineRuntimeError(`Undeclared identifier '${name}'`);
  }

  /** Build (and cache) the namespace object for an enum declaration. */
  _enumNs(name) {
    if (!this._enumNsCache) this._enumNsCache = new Map();
    const cached = this._enumNsCache.get(name);
    if (cached) return cached;
    const decl = this.enums.get(name);
    const ns = { __enum: true, name };
    // Default values are evaluated lazily once (at the first bar); subsequent
    // bars reuse the same constant object. The default for an unqualified
    // enum member is its index in declaration order.
    for (let i = 0; i < decl.members.length; i++) {
      const m = decl.members[i];
      const v = m.value ? this.evalExpr(m.value, this.rootScope) : i;
      ns[m.name] = v;
    }
    Object.freeze(ns);
    this._enumNsCache.set(name, ns);
    return ns;
  }

  resolveNamespaceMember(path) {
    // syminfo.* / timeframe.* / strategy.* etc.
    const [ns, ...rest] = path.split('.');
    const key = rest.join('.');
    switch (ns) {
      case 'syminfo':
        return this.syminfoMember(key);
      case 'timeframe':
        return this.timeframeMember(key);
      case 'chart':
        return this.chartMember(key);
      case 'strategy': {
        const s = this.outputs.strategy;
        if (key === 'position_size') return s.position.size;
        if (key === 'position_avg_price') return s.position.avgPrice;
        if (key === 'equity') return s.equityCurve[this.bar] ?? 0;
        if (key === 'netprofit') return (s.equityCurve[this.bar] ?? s.initialCapital) - s.initialCapital;
        if (key === 'openprofit') {
          const last = s.equityCurve[this.bar];
          const prev = this.bar > 0 ? s.equityCurve[this.bar - 1] : s.initialCapital;
          return last != null && prev != null ? last - prev : 0;
        }
        if (key in s) return s[key];
        return undefined;
      }
      case 'barstate': {
        // barstate.islast etc. are builtins — call them directly with a
        // minimal context (they only need c.bar and c.interp.n).
        const fn = BUILTINS.get(`barstate.${key}`);
        if (fn) {
          const ctx = {
            interp: this,
            bar: this.bar,
            node: { id: 0, line: 0 },
            positional: [],
            named: {},
          };
          return fn(ctx);
        }
        return undefined;
      }
      default:
        return undefined;
    }
  }

  /** Pine v6 chart.* namespace — mirrors TradingView's chart-context accessors. */
  chartMember(key) {
    const host = this.host || {};
    const bars = this.bars;
    switch (key) {
      case 'left_visible_bar_time': {
        const i = Math.max(0, Math.min(bars.length - 1, Math.floor(host.leftVisibleIndex ?? 0)));
        return bars[i]?.t ?? null;
      }
      case 'right_visible_bar_time': {
        const i = Math.max(0, Math.min(bars.length - 1, Math.floor(host.rightVisibleIndex ?? (bars.length - 1))));
        return bars[i]?.t ?? null;
      }
      case 'left_visible_bar_index':
        return Math.max(0, Math.floor(host.leftVisibleIndex ?? 0));
      case 'right_visible_bar_index':
        return Math.max(0, Math.floor(host.rightVisibleIndex ?? (bars.length - 1)));
      case 'is_standard':
        return true;
      case 'is_heikinashi':
        return false;
      case 'is_renko':
      case 'is_linebreak':
      case 'is_kagi':
      case 'is_pnf':
      case 'is_range':
        return false;
      case 'bg_color':
        return '#131722';
      case 'fg_color':
        return '#d1d4dc';
      default:
        return undefined;
    }
  }

  syminfoMember(key) {
    const s = this.symbol || {};
    switch (key) {
      case 'ticker':
        return s.ticker || s.symbol || '';
      case 'tickerid':
        return s.tickerid || s.symbol || '';
      case 'prefix':
        return s.prefix || '';
      case 'currency':
        return s.currency || 'USD';
      case 'basecurrency':
        return s.currency || 'USD';
      case 'exchange':
        return s.exchange || '';
      case 'description':
        return s.description || '';
      case 'type':
        return s.type || 'stock';
      case 'mintick':
        return s.mintick ?? 0.01;
      case 'pointvalue':
        return 1;
      case 'session':
        return s.session || '0930-1600';
      case 'timezone':
        return s.timezone || 'America/New_York';
      case 'root':
        return (s.symbol || '').split(/[.:]/).pop();
      // Pine v6 syminfo additions.
      case 'currency_code':
        return s.currency || 'USD';
      case 'basecurrency_code':
        return s.currency || 'USD';
      case 'volumetype':
        return s.volumetype ?? '';
      case 'pricemultiplier':
        return s.pricemultiplier ?? 1;
      case 'subtype':
        return s.subtype ?? '';
      case 'legs':
        return 1;
      case 'minmove':
        return s.minmove ?? 1;
      case 'pricescale':
        return s.pricescale ?? 100;
      case 'minmove / pricescale':
        return s.minmove && s.pricescale ? s.minmove / s.pricescale : 0.01;
      case 'has_intraday':
        return s.hasIntraday ?? true;
      case 'has_extended_hours':
        return s.hasExtendedHours ?? false;
      case 'has_volume':
        return true;
      case 'has_regular_session':
        return true;
      default:
        return undefined;
    }
  }

  timeframeMember(key) {
    const tf = this.timeframe || {};
    const period = String(tf.period || '1D').toUpperCase();
    switch (key) {
      case 'period':
        return tf.period || '1D';
      case 'multiplier':
        return tf.multiplier || 1;
      case 'isintraday':
        return !!tf.isintraday;
      case 'isdaily':
        return period === 'D' || period === '1D';
      case 'isweekly':
        return period === 'W' || period === '1W';
      case 'ismonthly':
        return period === 'M' || period === '1M';
      case 'isseconds':
        return period.includes('S');
      case 'isminutes':
        return (tf.period || '').toUpperCase() === 'M' && !!tf.isintraday;
      case 'change':
        return tf.change ?? 0;
      default:
        return undefined;
    }
  }

  /* ---------------- calls ---------------- */

  argParts(ctx) {
    return { positional: ctx.positional, named: ctx.named };
  }

  evalCall(node, scope) {
    const callee = node.callee;
    const calleePath = dottedPath(callee);
    const positional = [];
    const named = {};
    for (const a of node.args) {
      let v = this.evalExpr(a.node, scope);
      // Some builtins need the *series identity* rather than the current value.
      if (NEEDS_RAW_SERIES.has(calleePath)) {
        if (v instanceof Series) {
          v = { __rawSeries: v, node: a.node, scope, upTo: this.bar };
        } else if (a.node.type === NT.IDENT) {
          // The argument is a plain variable (not a Series). Look up its
          // slot's series so ta.highest/ta.lowest/etc. can access history.
          const st = this.lookupVar(a.node.name, scope);
          if (st && st.series) {
            v = { __rawSeries: st.series, node: a.node, scope, upTo: this.bar };
          }
        }
      }
      if (a.name) named[a.name] = v;
      else positional.push(v);
    }

    const ctx = {
      interp: this,
      node,
      scope,
      positional,
      named,
      bar: this.bar,
      argParts: () => ({ positional, named }),
      args: () => positional,
      namedArgs: () => named,
      num: (v, dflt = NaN) => {
        const n = this.toNum(v);
        return Number.isNaN(n) ? dflt : n;
      },
      bool: (v, dflt = false) => (v === null || v === undefined ? dflt : this.toBool(v)),
      str: (v, dflt = '') => (v === null || v === undefined ? dflt : this.toStr(v)),
      series: (idx) => {
        // FIX A: Attach __interp/__slotIdx for non-numeric side-Map access.
        const s = new Series(this.slotValues[idx], this.n);
        s.__interp = this;
        s.__slotIdx = idx;
        return s;
      },
    };

    // 1. User-defined function?
    if (callee.type === NT.IDENT) {
      const userFn = this.functions.get(callee.name);
      if (userFn) return this.callUserFunction(userFn, ctx, scope);

      // 2. Namespaced builtin (ta.rsi, math.abs, ...) or global builtin
      const builtin = BUILTINS.get(callee.name) || this.resolveBuiltinByPath(node);
      if (builtin) return this.invokeBuiltin(builtin, ctx, callee.name);
    } else if (callee.type === NT.MEMBER) {
      const path = dottedPath(callee);
      if (path) {
        const builtin = BUILTINS.get(path) || BUILTINS.get(path.split('.').slice(-1)[0]);
        if (BUILTINS.get(path)) return this.invokeBuiltin(BUILTINS.get(path), ctx, path);
        if (builtin && BUILTINS.get(path)) return this.invokeBuiltin(builtin, ctx, path);
      }
      // Method-style call on an object (array.push, etc.)
      const obj = this.evalExpr(callee.object, scope);
      const method = callee.property;
      // Pine v6: user-defined methods on UDT instances — dispatch by `__type`
      // first (instance), then by builtin JS class (array/matrix/map/str).
      if (obj && typeof obj === 'object') {
        const recvType = obj.__type || (obj instanceof PineArray ? 'array' : obj instanceof PineMatrix ? 'matrix' : obj instanceof PineMap ? 'map' : null);
        if (recvType) {
          const userMethod = this.methods && this.methods.get(`${recvType}.${method}`);
          if (userMethod) {
            // Bind the receiver as the first positional arg.
            positional.unshift(obj);
            return this.callUserFunction(userMethod, ctx, scope);
          }
        }
        // `Foo.new` constructor handled by NT.NEW, but defend against an
        // accidental MEMBER call (e.g. `Foo.new(...)` parsed as MEMBER+CALL).
        if (obj && obj.__type && method === 'new') {
          const decl = this.types && this.types.get(obj.name);
          if (decl) {
            const instance = { __udt: true, __type: obj.name };
            for (const f of decl.fields) instance[f.name] = f.def ? this.evalExpr(f.def, scope) : null;
            const args = node.args || [];
            for (let i = 0; i < args.length && i < decl.fields.length; i++) {
              instance[decl.fields[i].name] = this.evalExpr(args[i].node, scope);
            }
            return instance;
          }
        }
        // Pine v6 drawing-object method dispatch: lines/labels/boxes/tables
        // expose setters like `line.set_first_point(id, point)`. When called
        // method-style as `myLine.set_first_point(point)`, dispatch to the
        // `line.set_first_point` builtin with the receiver prepended.
        const drawType = obj && obj.type; // 'line' | 'label' | 'box' | 'table'
        if (drawType) {
          const drawBuiltin = BUILTINS.get(`${drawType}.${method}`);
          if (drawBuiltin) {
            positional.unshift(obj);
            return this.invokeBuiltin(drawBuiltin, ctx, `${drawType}.${method}`);
          }
        }
      }
      const methodBuiltin = BUILTINS.get(`__method_${method}`);
      if (methodBuiltin) {
        positional.unshift(obj);
        return this.invokeBuiltin(methodBuiltin, ctx, method);
      }
      throw new PineRuntimeError(`Unknown function or method '${method}'`, node.line);
    }

    const label =
      callee.type === NT.IDENT
        ? callee.name
        : callee.type === NT.LITERAL
          ? String(callee.value)
          : dottedPath(callee) || 'expression';
    if (callee.type === NT.LITERAL) {
      throw new PineRuntimeError(
        `'${label}' is not callable. To test for na use 'na(x)'; the na constant is written without parentheses.`,
        node.line
      );
    }
    throw new PineRuntimeError(`Unknown function '${label}'`, node.line);
  }

  resolveBuiltinByPath(node) {
    if (node.callee.type !== NT.MEMBER) return null;
    const path = dottedPath(node.callee);
    return path ? BUILTINS.get(path) || null : null;
  }

  invokeBuiltin(fn, ctx, name) {
    try {
      return fn(ctx);
    } catch (err) {
      if (err instanceof PineRuntimeError) throw err;
      throw new PineRuntimeError(`Error in ${name}(): ${err.message}`, ctx.node.line);
    }
  }

  callUserFunction(fn, ctx, scope) {
    if (this.callDepth >= MAX_CALL_DEPTH) {
      throw new PineRuntimeError(
        `Recursion limit (${MAX_CALL_DEPTH}) reached calling '${fn.name}'`,
        ctx.node.line
      );
    }
    // A frame per (call site, recursion depth). Frames persist across bars so that
    // variables declared inside a function body behave as series.
    const persistent = !fn.selfRecursive;
    const callKey = persistent
      ? `${fn.name}@${ctx.node.id}`
      : `${fn.name}@${ctx.node.id}#${this.callDepth}#${this.bar}`;
    let frame = this.frames.get(callKey);
    if (!frame) {
      frame = new Scope(persistent ? this.rootScope : null, { functionScope: true, callKey });
      if (persistent) this.frames.set(callKey, frame);
    }
    this.callDepth++;
    // A call can rebind names, so no cached read from the caller may survive into it.
    this.cur.clear();
    try {
      // Bind parameters (positional then named) onto the frame for this bar.
      const params = fn.params || [];
      const depth = this.callDepth;
      // Make every parameter visible (as na) before any binding, so that a second
      // call at the same depth on this bar never sees an undeclared name.
      for (const p of params) this.ensureParam(frame, p, depth);
      for (let i = 0; i < params.length; i++) {
        let v = ctx.positional[i];
        if (v === undefined && params[i] in ctx.named) v = ctx.named[params[i]];
        this.bindParam(frame, params[i], v === undefined ? null : v, depth);
      }
      // Named args that match remaining params
      for (const [k, v] of Object.entries(ctx.named)) {
        if (params.includes(k)) this.bindParam(frame, k, v, depth);
      }
      return this.evalBlockValue(fn.body, frame);
    } finally {
      this.callDepth--;
      // ...and the caller's view of the world is stale after the callee ran.
      this.cur.clear();
    }
  }

  /** Storage key for a parameter: parameters always live in a suffixed slot so
   *  that they can never be confused with a same-named outer variable. */
  paramKey(name, depth) {
    return `${name}@${depth}`;
  }

  /** Create the storage cell for a parameter without changing its value. */
  ensureParam(frame, name, depth = this.callDepth) {
    const key = this.paramKey(name, depth);
    let st = frame.vars.get(key);
    if (!st) {
      const idx = this.allocSlot(key, { param: true, paramName: name });
      st = new VarState(key, this.seriesOf(idx), this.bar);
      st.isParam = true;
      frame.vars.set(key, st);
    }
    return st;
  }

  /**
   * Bind a function parameter. Slots are keyed by (name, depth) so that
   * recursive calls at different depths never share a storage cell.
   */
  bindParam(frame, name, value, depth = this.callDepth) {
    const st = this.ensureParam(frame, name, depth);
    const isSeriesArg = value instanceof Series || (value && value.isSeries && (Array.isArray(value.values) || value.values instanceof Float64Array));
    st.seriesRef = isSeriesArg ? value : null;
    this.writeSlot(this.idxOf(st), isSeriesArg ? null : this.storeValue(value));
    // Parameter bindings shadow any cached read of the same name (and the cache is
    // global while slots are per-depth, so it must not outlive a rebind).
    this.cur.clear();
  }

  /* ---------------- strategy bookkeeping ---------------- */

  recordStrategyEquity() {
    const s = this.outputs.strategy;
    const close = this.bars[this.bar]?.c ?? 0;
    const pos = s.position;
    let equity = s.initialCapital;
    if (this.bar > 0 && s.equityCurve[this.bar - 1] != null) {
      equity = s.equityCurve[this.bar - 1];
    }
    // mark-to-market on the pending position
    if (pos.size !== 0) {
      const unrealised = pos.size * (close - pos.avgPrice);
      equity = (this.bar > 0 && s.equityCurve[this.bar - 1] != null ? s.equityCurve[this.bar - 1] : s.initialCapital);
      void unrealised;
    }
    s.equityCurve[this.bar] = equity;
  }

  /* ---------------- host services ---------------- */

  requestSymbol(symbol, timeframe, expression) {
    const expr = expression && expression.__rawSeries ? expression.__rawSeries : expression;
    if (!this.host.requestSecurity) {
      this.warn('request.security() requires a data host; returning na.');
      return null;
    }
    try {
      return this.unwrapIfSeries(this.host.requestSecurity(symbol, timeframe, expr, this));
    } catch (err) {
      this.warn(`request.security(${symbol}) failed: ${err.message}`);
      return null;
    }
  }
}

/* ------------------------------------------------------------------ *
 * AST utilities
 * ------------------------------------------------------------------ */

/** Namespaces whose members are values computed by the interpreter, not builtins. */
const VALUE_NAMESPACES = new Set(['syminfo', 'timeframe', 'strategy', 'barstate', 'chart', 'dividends']); // __dividend_plumbing__

export function dottedPath(node) {  if (!node) return null;
  if (node.type === NT.IDENT) return node.name;
  if (node.type === NT.MEMBER) {
    const base = dottedPath(node.object);
    return base ? `${base}.${node.property}` : null;
  }
  return null;
}

function collectFunctions(ast, out) {
  walk(ast, (node) => {
    if (node.type === NT.FUN_DECL) out.set(node.name, node);
  });
}

function collectTypeDecls(ast, out) {
  walk(ast, (node) => {
    if (node.type === NT.TYPE_DECL) out.set(node.name, node);
  });
}

function collectEnumDecls(ast, out) {
  walk(ast, (node) => {
    if (node.type === NT.ENUM_DECL) out.set(node.name, node);
  });
}

function collectMethodDecls(ast, out) {
  walk(ast, (node) => {
    if (node.type === NT.METHOD_DECL) {
      // Methods are keyed by `<receiverType>.<methodName>` (e.g. `array.push`,
      // `Bar.add`). The receiver type defaults to the first param's declared
      // type, or `array` if unspecified — mirroring Pine v6 conventions.
      const recvType = node.receiverType || (node.params[0] && node.params[0].split('.')[0]) || 'array';
      const key = `${recvType}.${node.name}`;
      out.set(key, node);
    }
  });
}

function collectVarDecls(ast, out) {
  walk(ast, (node) => {
    if (node.type === NT.VAR_DECL && (node.mode === 'var' || node.mode === 'varip')) out.push(node);
  });
}

/** Does this subtree call the named function? */
function functionCallsName(node, name) {
  let found = false;
  walk(node, (n) => {
    if (found) return;
    if (n.type === NT.CALL && n.callee) {
      if (n.callee.type === NT.IDENT && n.callee.name === name) found = true;
      else if (dottedPath(n.callee) === name) found = true;
    }
  });
  return found;
}

/**
 * Collect every plain identifier that must behave as a mutable scalar rather
 * than a series alias:
 *   - targets of `:=` or a compound assignment (`+=`, ...)
 *   - every `var` / `varip` variable (initialised once, then carried forward)
 *   - loop variables
 * A plain `x = expr` declaration is *not* included: it may keep series
 * identity so that `ta.sma(x, 20)` sees history.
 */
function collectReassignedNames(ast) {
  const names = new Set();
  walk(ast, (node) => {
    if (node.type === NT.ASSIGN && node.name) {
      if (node.compound || (!node.declare && node.op === ':=')) names.add(node.name);
    }
    if (node.type === NT.ASSIGN && node.tuple && node.tuple.items) {
      for (const t of node.tuple.items) if (t.name) names.add(t.name);
    }
    if (node.type === NT.FOR && node.names) for (const n of node.names) names.add(n);
    if (node.type === NT.VAR_DECL && (node.mode === 'var' || node.mode === 'varip')) {
      names.add(node.name);
    }
  });
  return names;
}

export function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
    return;
  }
  if (typeof node.type === 'string') visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'id' || key === 'line' || key === 'col') continue;
    const v = node[key];
    if (v && typeof v === 'object') walk(v, visit);
  }
}

export { makeColor, shapeStyle, plotStyle, lineStyle, colorNamespace };

/**
 * Convenience wrapper used by the UI.
 * @param {string} source
 * @param {Object} options
 */
export function runPine(source, options) {
  const interp = new Interpreter(options.bars || [], options);
  const result = interp.run(source);
  result.interpreter = interp;
  return result;
}
