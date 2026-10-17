/**
 * Cloud alert worker.
 *
 * Polls every N seconds: for each enabled alert, fetches fresh bars for the
 * alert's symbol, runs the alert's Pine script, checks whether any new alerts
 * have fired since lastFiredBar, and POSTs to the alert's webhook.
 *
 * Alerts are stored in alerts.json (gitignored  contains webhook secrets).
 *
 * Webhook URL handling:
 *   - If URL contains {message}, {symbol}, or {price} placeholders, a GET is
 *     performed against the interpolated URL (works for Telegram bot URLs).
 *   - Otherwise a POST with JSON body {id,name,symbol,message,price,bar,time}
 *     is sent (works for Discord, Slack, custom endpoints).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPine } from './public/js/pine/runtime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ALERTS_PATH = path.join(__dirname, 'alerts.json');

export function loadAlerts(filePath = DEFAULT_ALERTS_PATH) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    console.warn('[cloud-alerts] load failed:', e.message);
    return [];
  }
}

export function saveAlerts(alerts, filePath = DEFAULT_ALERTS_PATH) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(alerts, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function interpolate(template, data) {
  return template
    .replace(/\{message\}/g, encodeURIComponent(data.message ?? ''))
    .replace(/\{symbol\}/g, encodeURIComponent(data.symbol ?? ''))
    .replace(/\{price\}/g, encodeURIComponent(String(data.price ?? '')))
    .replace(/\{name\}/g, encodeURIComponent(data.name ?? ''));
}

export async function deliverWebhook(alert, event, fetchImpl = globalThis.fetch) {
  const url = alert.webhookUrl;
  if (!url) throw new Error('no webhookUrl');

  const isTemplate = url.includes('{message}') || url.includes('{symbol}') || url.includes('{price}');
  if (isTemplate) {
    const finalUrl = interpolate(url, event);
    const res = await fetchImpl(finalUrl, { method: 'GET' });
    if (!res.ok) throw new Error('webhook returned ' + res.status);
    return;
  }
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
  if (!res.ok) throw new Error('webhook returned ' + res.status);
}

/**
 * @param {Object} opts
 * @param {Function} opts.handleChart     required  (URL) => { bars, ... }
 * @param {number}   [opts.intervalMs]    default 60000
 * @param {string}   [opts.alertsPath]
 * @param {Function} [opts.fetchImpl]     for testing
 * @returns {{ tick: Function, stop: Function }}
 */
export function startAlertWorker({ handleChart, intervalMs = 60_000, alertsPath = DEFAULT_ALERTS_PATH, fetchImpl = globalThis.fetch }) {
  if (typeof handleChart !== 'function') throw new Error('startAlertWorker: handleChart is required');

  const tick = async () => {
    const alerts = loadAlerts(alertsPath);
    if (alerts.length === 0) return { checked: 0, fired: 0, errors: 0 };
    let fired = 0;
    let errors = 0;
    let changed = false;

    for (const alert of alerts) {
      if (!alert.enabled) continue;
      if (!alert.scriptSource) { alert.lastErrorMessage = 'no scriptSource'; changed = true; continue; }
      if (!alert.webhookUrl) { alert.lastErrorMessage = 'no webhookUrl'; changed = true; continue; }

      try {
        const chartUrl = new URL(
          `/api/chart?symbol=${encodeURIComponent(alert.symbol)}` +
          `&interval=${encodeURIComponent(alert.interval || '1d')}` +
          `&range=${encodeURIComponent(alert.range || '1y')}`,
          'http://localhost'
        );
        const chart = await handleChart(chartUrl);
        if (!chart || !Array.isArray(chart.bars) || chart.bars.length === 0) continue;

        const result = runPine(alert.scriptSource, { bars: chart.bars, symbol: chart });
        if (!result.ok) throw new Error('script error: ' + (result.error?.message || 'unknown'));

        const allAlerts = result.outputs?.alerts || [];
        // On first run, fire only the latest alert to avoid backfill spam.
        // After that, fire any alert with bar > lastFiredBar.
        let candidates;
        if (alert.lastFiredBar == null || alert.lastFiredBar < 0) {
          candidates = allAlerts.length > 0 ? [allAlerts[allAlerts.length - 1]] : [];
        } else {
          candidates = allAlerts.filter((a) => a.bar > alert.lastFiredBar);
        }
        if (candidates.length === 0) continue;

        const latest = candidates[candidates.length - 1];
        const lastBar = chart.bars[chart.bars.length - 1];
        const event = {
          id: alert.id,
          name: alert.name || alert.id,
          symbol: alert.symbol,
          message: latest.message || '',
          price: lastBar?.c ?? null,
          bar: latest.bar,
          time: latest.time ?? Date.now(),
        };
        await deliverWebhook(alert, event, fetchImpl);
        alert.lastFiredBar = latest.bar;
        alert.lastFiredAt = Date.now();
        alert.lastErrorMessage = null;
        fired += 1;
        changed = true;
      } catch (e) {
        alert.lastErrorMessage = e.message;
        errors += 1;
        changed = true;
        console.warn('[cloud-alert ' + alert.id + '] ' + alert.symbol + ': ' + e.message);
      }
    }

    if (changed) {
      try { saveAlerts(alerts, alertsPath); }
      catch (e) { console.warn('[cloud-alerts] save failed:', e.message); }
    }
    return { checked: alerts.length, fired, errors };
  };

  const timer = setInterval(() => {
    tick().catch((e) => console.warn('[cloud-alerts] tick error:', e.message));
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();  // don't block process exit

  return {
    tick,
    stop: () => clearInterval(timer),
  };
}
