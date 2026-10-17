// FIX C: Main-thread wrapper around the Pine Web Worker.
// Provides a promise-based runPineAsync() that dispatches heavy computation
// to a Web Worker, keeping the UI thread responsive. Falls back to
// synchronous execution if Workers aren't available.

import { runPine } from './pine/runtime.js';

let worker = null;
let nextId = 1;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  if (typeof Worker === 'undefined') return null;
  try {
    worker = new Worker(new URL('./pine-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const { id, ok, result, error, stack } = e.data;
      const resolver = pending.get(id);
      if (!resolver) return;
      pending.delete(id);
      if (ok) resolver.resolve(result);
      else resolver.reject(new Error(error || 'Worker error'));
    };
    worker.onerror = (e) => {
      // Reject ALL pending promises on fatal worker error.
      for (const [, r] of pending) r.reject(new Error(e.message || 'Worker crashed'));
      pending.clear();
    };
    return worker;
  } catch {
    return null;
  }
}

/**
 * Run a Pine script asynchronously in a Web Worker.
 * Falls back to synchronous runPine() if Workers are unavailable.
 * @param {string} source - Pine v6 source code
 * @param {Array} bars - OHLCV bar data
 * @param {Object} options - { inputs, symbol, timeframe, host, ... }
 * @returns {Promise<Object>} - { ok, outputs, inputs, warnings, ... }
 */
export function runPineAsync(source, bars, options = {}) {
  const w = getWorker();
  if (!w) {
    // Fallback: synchronous execution on main thread.
    try {
      return Promise.resolve(runPine(source, { bars, ...options }));
    } catch (err) {
      return Promise.reject(err);
    }
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, mode: 'default', source, bars, options });
  });
}

/**
 * Run a Pine script with progress callbacks (streaming mode).
 * @param {string} source
 * @param {Array} bars
 * @param {Object} options
 * @param {(progress:number)=>void} onProgress - called with 0..1
 * @returns {Promise<Object>}
 */
export function runPineStream(source, bars, options = {}, onProgress) {
  const w = getWorker();
  if (!w) {
    try {
      const r = runPine(source, { bars, ...options });
      if (onProgress) onProgress(1);
      return Promise.resolve(r);
    } catch (err) {
      return Promise.reject(err);
    }
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, mode: 'stream', source, bars, options });
  });
}

/**
 * Cancel any in-flight worker computation.
 */
export function cancelPineWorker() {
  if (!worker) return;
  for (const [, r] of pending) r.reject(new Error('cancelled'));
  pending.clear();
  // Terminate and recreate the worker to cancel immediately.
  worker.terminate();
  worker = null;
}

/**
 * Check if the worker is available.
 */
export function hasWorker() {
  return typeof Worker !== 'undefined';
}
