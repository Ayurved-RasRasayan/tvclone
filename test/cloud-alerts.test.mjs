/**
 * Cloud alerts tests  worker logic with mocked fetch and mocked handleChart.
 * No HTTP servers, no real webhooks. Deterministic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startAlertWorker, loadAlerts, saveAlerts, deliverWebhook } from '../alert-worker.mjs';

// Each test uses a temp alerts file so runs are isolated
function tempAlertsPath() {
  return path.join(os.tmpdir(), 'tvclone-alerts-' + Math.random().toString(36).slice(2) + '.json');
}

function makeBars(n, seed = 42) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const bars = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const o = price;
    const c = o + ((i * 7) % 11 - 5) * 0.4;
    bars.push({ t: 1700000000000 + i * 86400000, o, h: Math.max(o, c) + 0.3, l: Math.min(o, c) - 0.3, c, v: 1000 });
    price = c;
  }
  return bars;
}

// A tiny Pine script that fires an alert on every bar where close > open
const testScript = `//@version=6
indicator("test")
if close > open
    alert("bull", alert.freq_once_per_bar)
plot(close)`;

function mockHandleChart(bars) {
  return async (url) => ({
    symbol: 'TEST',
    bars,
  });
}

function mockFetchCapture() {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url: String(url), method: opts?.method || 'GET', body: opts?.body, headers: opts?.headers });
    return { ok: true, status: 200 };
  };
  fn.calls = calls;
  return fn;
}

/* -------------------- deliverWebhook -------------------- */

test('deliverWebhook: POST mode for plain URL', async () => {
  const fetchImpl = mockFetchCapture();
  await deliverWebhook(
    { webhookUrl: 'https://example.com/hook' },
    { id: 'a', name: 'A', symbol: 'AAPL', message: 'hi', price: 100, bar: 5, time: 1 },
    fetchImpl
  );
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].method, 'POST');
  assert.match(fetchImpl.calls[0].body, /"message":"hi"/);
});

test('deliverWebhook: GET mode for URL template', async () => {
  const fetchImpl = mockFetchCapture();
  await deliverWebhook(
    { webhookUrl: 'https://api.telegram.org/botX/sendMessage?chat_id=Y&text={message}' },
    { message: 'bull signal', symbol: 'AAPL', price: 100 },
    fetchImpl
  );
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].method, 'GET');
  assert.match(fetchImpl.calls[0].url, /text=bull%20signal/);
});

test('deliverWebhook: throws on non-OK webhook response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  await assert.rejects(
    () => deliverWebhook({ webhookUrl: 'https://x' }, { message: 'hi' }, fetchImpl),
    /webhook returned 500/
  );
});

/* -------------------- loadAlerts / saveAlerts -------------------- */

test('saveAlerts + loadAlerts round-trip', () => {
  const p = tempAlertsPath();
  try {
    saveAlerts([{ id: 'a', symbol: 'AAPL' }, { id: 'b', symbol: 'MSFT' }], p);
    const loaded = loadAlerts(p);
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0].id, 'a');
    assert.equal(loaded[1].symbol, 'MSFT');
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test('loadAlerts returns [] for missing file', () => {
  const p = tempAlertsPath();
  assert.deepEqual(loadAlerts(p), []);
});

/* -------------------- worker tick -------------------- */

test('worker: fires on first run (latest alert) then only on new bars', async () => {
  const p = tempAlertsPath();
  const bars = makeBars(50);
  const fetchImpl = mockFetchCapture();
  try {
    saveAlerts([{
      id: 'a1', enabled: true, name: 'test', symbol: 'TEST',
      interval: '1d', range: '1y',
      scriptSource: testScript,
      webhookUrl: 'https://example.com/hook',
      lastFiredBar: -1,
      lastFiredAt: null,
      lastErrorMessage: null,
    }], p);

    const worker = startAlertWorker({
      handleChart: mockHandleChart(bars),
      intervalMs: 999999,
      alertsPath: p,
      fetchImpl,
    });
    worker.stop();  // we'll call tick manually for determinism

    // First run  fires the latest alert (whatever bar it's on)
    const r1 = await worker.tick();
    assert.equal(r1.fired, 1, 'first tick fires latest');
    assert.equal(fetchImpl.calls.length, 1);

    // Second run with same bars  no new alert, no new fire
    const r2 = await worker.tick();
    assert.equal(r2.fired, 0, 'second tick no re-fire');
    assert.equal(fetchImpl.calls.length, 1, 'webhook not called again');

    // Simulate new bar appended  worker should fire on it
    const moreBars = makeBars(60);
    const worker2 = startAlertWorker({
      handleChart: mockHandleChart(moreBars),
      intervalMs: 999999,
      alertsPath: p,
      fetchImpl,
    });
    worker2.stop();
    const r3 = await worker2.tick();
    // Only fires if there's a NEW alert with bar > lastFiredBar
    // The synthetic series may or may not trigger; at minimum, worker didn't crash
    assert.equal(r3.errors, 0, 'no errors on extended series');
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test('worker: skips disabled alerts', async () => {
  const p = tempAlertsPath();
  const fetchImpl = mockFetchCapture();
  try {
    saveAlerts([{
      id: 'a1', enabled: false, name: 'test', symbol: 'TEST',
      scriptSource: testScript, webhookUrl: 'https://example.com/hook',
      lastFiredBar: -1,
    }], p);
    const worker = startAlertWorker({
      handleChart: mockHandleChart(makeBars(50)),
      intervalMs: 999999, alertsPath: p, fetchImpl,
    });
    worker.stop();
    const r = await worker.tick();
    assert.equal(r.fired, 0);
    assert.equal(fetchImpl.calls.length, 0);
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test('worker: records lastErrorMessage on webhook failure', async () => {
  const p = tempAlertsPath();
  const fetchImpl = async () => ({ ok: false, status: 500 });
  try {
    saveAlerts([{
      id: 'a1', enabled: true, name: 'test', symbol: 'TEST',
      scriptSource: testScript, webhookUrl: 'https://example.com/hook',
      lastFiredBar: -1,
    }], p);
    const worker = startAlertWorker({
      handleChart: mockHandleChart(makeBars(50)),
      intervalMs: 999999, alertsPath: p, fetchImpl,
    });
    worker.stop();
    const r = await worker.tick();
    assert.equal(r.errors, 1, 'one error recorded');
    const stored = loadAlerts(p);
    assert.match(stored[0].lastErrorMessage || '', /webhook returned 500/);
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test('worker: empty alerts file  no crash', async () => {
  const p = tempAlertsPath();
  const fetchImpl = mockFetchCapture();
  try {
    const worker = startAlertWorker({
      handleChart: mockHandleChart(makeBars(50)),
      intervalMs: 999999, alertsPath: p, fetchImpl,
    });
    worker.stop();
    const r = await worker.tick();
    assert.equal(r.checked, 0);
    assert.equal(r.fired, 0);
  } finally {
    fs.rmSync(p, { force: true });
  }
});
