// pine-wasm.js — JS wrapper for the WASM Pine VM.
//
// This is a STUB showing how the WASM VM would be loaded and called.
// The actual WASM binary needs to be compiled from pine-vm.ts using
// AssemblyScript:
//   npm install -D assemblyscript
//   npx asc pine-vm.ts -o pine-vm.wasm --optimize
//
// Until the WASM binary is built, this module falls back to the JS VM.

import { execBytecode as execJS } from '../bytecode.js';

let wasmInstance = null;
let wasmReady = false;

async function loadWASM() {
  try {
    const response = await fetch(new URL('./pine-vm.wasm', import.meta.url));
    const wasmBytes = await response.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(wasmBytes, {
      env: {
        // JS functions imported by the WASM VM (for calling back into JS
        // for builtins, user functions, etc.)
        callBuiltin: (idx, nargs) => { /* ... */ },
        callUserFn: (idx, nargs) => { /* ... */ },
        // Memory management
        memory: new WebAssembly.Memory({ initial: 256 }),
      },
    });
    wasmInstance = instance;
    wasmReady = true;
  } catch (e) {
    console.warn('WASM VM not available, using JS fallback:', e.message);
    wasmReady = false;
  }
}

// Start loading WASM in the background
loadWASM();

/**
 * Execute a bytecode chunk. Uses WASM if available, falls back to JS.
 * @param {Object} interp — the Pine interpreter
 * @param {Object} chunk — the compiled bytecode chunk
 * @param {Object} scope — the current scope
 * @returns {*} — the top of the stack
 */
export function execBytecode(interp, chunk, scope) {
  if (wasmReady && wasmInstance) {
    // WASM path: copy bytecode to WASM memory, call execBytecode
    try {
      const code = chunk.code;
      const codeLen = code.length;
      // Copy bytecode to WASM linear memory
      // (In a real implementation, we'd share a memory buffer)
      wasmInstance.exports.setBar(interp.bar);
      const result = wasmInstance.exports.execBytecode(code, codeLen);
      return result;
    } catch (e) {
      // WASM failed — fall back to JS
      return execJS(interp, chunk, scope);
    }
  }
  // JS fallback
  return execJS(interp, chunk, scope);
}

export function hasWASM() {
  return wasmReady;
}
