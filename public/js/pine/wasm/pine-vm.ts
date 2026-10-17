// pine-vm.ts — AssemblyScript source for the WASM Pine VM.
//
// This is a STUB showing the approach. To build:
//   npm install -D assemblyscript
//   npx asc pine-vm.ts -o pine-vm.wasm --optimize
//
// The compiled WASM binary exports an `execBytecode` function that JS calls
// via WebAssembly.instantiate().

// Opcode constants (must match bytecode.js)
const OP_HALT = 0x00;
const OP_PUSH_NULL = 0x01;
const OP_PUSH_TRUE = 0x02;
const OP_PUSH_FALSE = 0x03;
const OP_PUSH_NUM = 0x04;
const OP_PUSH_STR = 0x05;
const OP_LOAD_LOCAL = 0x07;
const OP_STORE_LOCAL = 0x08;
const OP_LOAD_GLOBAL = 0x09;
const OP_BINOP = 0x0B;
const OP_UNOP = 0x0C;
const OP_CALL_BUILTIN = 0x0D;
const OP_HIST = 0x0F;
const OP_MEMBER = 0x10;
const OP_JUMP = 0x13;
const OP_JUMP_IF_FALSE = 0x14;
const OP_POP = 0x16;
const OP_STORE_LOCAL_POP = 0x1E;

// Binop subcodes
const BIN_ADD = 0;
const BIN_SUB = 1;
const BIN_MUL = 2;
const BIN_DIV = 3;
const BIN_EQ = 6;
const BIN_LT = 8;
const BIN_GT = 9;

// The VM state. In WASM, we use static arrays for the stack and slots.
const STACK_SIZE = 256;
const MAX_SLOTS = 4096;
const LOOKBACK = 4096;

// Static memory (WASM linear memory)
let stack: f64[] = new Array(STACK_SIZE);
let sp: i32 = 0;
let slotValues: Float64Array[] = new Array(MAX_SLOTS);
let bar: i32 = 0;

// Push/pop helpers
function push(v: f64): void {
  stack[sp++] = v;
}

function pop(): f64 {
  return stack[--sp];
}

// Read a slot with ring-buffer modular indexing
function readSlot(idx: i32, offset: i32): f64 {
  const b = bar - offset;
  if (b < 0) return NaN;
  const ri = b % LOOKBACK;
  return slotValues[idx][ri];
}

// Write a slot with ring-buffer modular indexing
function writeSlot(idx: i32, value: f64): void {
  const ri = bar % LOOKBACK;
  slotValues[idx][ri] = value;
}

// The main execution function. Takes bytecode as a Uint8Array and executes it.
// Returns the top of the stack.
export function execBytecode(code: Uint8Array, codeLen: i32): f64 {
  let ip: i32 = 0;
  sp = 0;

  while (ip < codeLen) {
    const op = code[ip++];

    switch (op) {
      case OP_HALT:
        return sp > 0 ? stack[sp - 1] : NaN;

      case OP_PUSH_NULL:
        push(NaN);
        break;

      case OP_PUSH_TRUE:
        push(1.0);
        break;

      case OP_PUSH_FALSE:
        push(0.0);
        break;

      case OP_PUSH_NUM: {
        // Read 8 bytes as f64 (big-endian)
        let v: f64 = 0;
        // Use DataView-like reading
        const buf = new ArrayBuffer(8);
        const view = new DataView(buf);
        for (let i = 0; i < 8; i++) {
          view.setUint8(i, code[ip + i]);
        }
        v = view.getFloat64(0, false);
        ip += 8;
        push(v);
        break;
      }

      case OP_LOAD_LOCAL: {
        const slot = (code[ip] << 8) | code[ip + 1];
        ip += 2;
        push(readSlot(slot, 0));
        break;
      }

      case OP_STORE_LOCAL: {
        const slot = (code[ip] << 8) | code[ip + 1];
        ip += 2;
        const v = pop();
        writeSlot(slot, v);
        push(v);
        break;
      }

      case OP_STORE_LOCAL_POP: {
        const slot = (code[ip] << 8) | code[ip + 1];
        ip += 2;
        const v = pop();
        writeSlot(slot, v);
        break;
      }

      case OP_BINOP: {
        const b = pop();
        const a = pop();
        const opCode = code[ip++];
        let result: f64 = NaN;
        switch (opCode) {
          case BIN_ADD: result = a + b; break;
          case BIN_SUB: result = a - b; break;
          case BIN_MUL: result = a * b; break;
          case BIN_DIV: result = a / b; break;
          case BIN_EQ:  result = a == b ? 1.0 : 0.0; break;
          case BIN_LT:  result = a < b ? 1.0 : 0.0; break;
          case BIN_GT:  result = a > b ? 1.0 : 0.0; break;
          default: break;
        }
        push(result);
        break;
      }

      case OP_HIST: {
        const slot = (code[ip] << 8) | code[ip + 1];
        ip += 2;
        const offset = <i32>pop();
        push(readSlot(slot, offset));
        break;
      }

      case OP_JUMP: {
        let off = (code[ip] << 24) | (code[ip + 1] << 16) | (code[ip + 2] << 8) | code[ip + 3];
        if (off & 0x80000000) off = off - 0x100000000;
        ip += 4;
        ip += off;
        break;
      }

      case OP_JUMP_IF_FALSE: {
        let off = (code[ip] << 24) | (code[ip + 1] << 16) | (code[ip + 2] << 8) | code[ip + 3];
        if (off & 0x80000000) off = off - 0x100000000;
        ip += 4;
        const cond = pop();
        if (cond == 0.0 || isNaN(cond)) ip += off;
        break;
      }

      case OP_POP:
        pop();
        break;

      default:
        // Unknown opcode — halt
        return NaN;
    }
  }

  return sp > 0 ? stack[sp - 1] : NaN;
}

// Set the current bar (called from JS before executing bytecode)
export function setBar(b: i32): void {
  bar = b;
}

// Initialize a slot's ring buffer (called from JS)
export function initSlot(idx: i32): void {
  slotValues[idx] = new Float64Array(LOOKBACK);
  for (let i = 0; i < LOOKBACK; i++) slotValues[idx][i] = NaN;
}
