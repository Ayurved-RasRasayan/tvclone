# WASM Backend Design for Pine Engine

## Goal
Replace the JavaScript AST interpreter with a WebAssembly bytecode VM for 5-10x speedup.

## Architecture

```
Pine Source → Parser (JS) → AST → Compiler (JS) → WASM Bytecode → WASM VM (WASM)
                                                              ↓
                                                         Results (JS)
```

## Approach: AssemblyScript

AssemblyScript compiles TypeScript-like code to WASM. We rewrite the bytecode VM
(`bytecode.js`) in AssemblyScript, compile to WASM, and call it from JS.

## Implementation plan

### Phase 1: WASM VM core (3-5 days)
- Rewrite `execBytecode()` in AssemblyScript
- Implement all 33 opcodes as WASM functions
- Share the `BytecodeChunk` format between JS and WASM

### Phase 2: WASM ta.* builtins (2-3 days)
- Rolling-window ta.sma/ema/rma/highest/lowest/stdev in WASM

### Phase 3: WASM compiler (2-3 days)
- Move AST→bytecode compiler to WASM

### Phase 4: Persistent cache (1-2 days)
- Store compiled bytecode in IndexedDB

## Expected performance

| | Current (JS) | With WASM | Speedup |
|---|---|---|---|
| 2000 bars PSAI | 10.3s | ~2s | 5x |
| 8000 bars PSAI | 54s | ~10s | 5x |
| Live update (1 bar) | 50ms | ~10ms | 5x |
| Memory 8000 bars | 90MB | ~30MB | 3x |
