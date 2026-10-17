/**
 * Cloud alerts client library.
 *
 * Cloud alerts are evaluated server-side and fire even with the browser
 * closed. Delivery goes to a webhook URL: either a GET against a URL with
 * {message} / {symbol} / {price} placeholders (e.g. Telegram bot URLs), or
 * a POST with JSON body (Discord, Slack, custom endpoints).
 *
 * The UI wiring (a button that opens openCloudAlertDialog) is intentionally
 * left to the caller  this module only exposes the primitives.
 */

const API = '';

export async function listCloudAlerts() {
  const res = await fetch(`${API}/api/cloud-alerts`);
  if (!res.ok) throw new Error('load failed: ' + res.status);
  return res.json();
}

export async function createCloudAlert({ name, symbol, interval, range, scriptSource, webhookUrl }) {
  const res = await fetch(`${API}/api/cloud-alerts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, symbol, interval, range, scriptSource, webhookUrl }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || ('create failed: ' + res.status));
  return body;
}

export async function deleteCloudAlert(id) {
  const res = await fetch(`${API}/api/cloud-alerts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('delete failed: ' + res.status);
  return res.json();
}

export async function testCloudAlert(id) {
  const res = await fetch(`${API}/api/cloud-alerts/${encodeURIComponent(id)}/test`, { method: 'POST' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || ('test failed: ' + res.status));
  return body;
}

/**
 * Open a modal dialog to create a cloud alert.
 * Self-contained  does not depend on any specific modal library.
 *
 * @param {Object} opts
 * @param {Object} [opts.app]         optional  used for symbol/script defaults
 * @param {Function} [opts.onSaved]   called with the created alert
 */
export function openCloudAlertDialog({ app, onSaved } = {}) {
  const chart = app?.activePane?.chart;
  const defaultSymbol = chart?.symbol || 'AAPL';
  const defaultInterval = chart?.interval || '1d';
  const defaultScript = `//@version=6
indicator("Cloud Alert")
if close > ta.sma(close, 20)
    alert("price crossed above SMA20", alert.freq_once_per_bar)`;

  const makeInput = (type, value, placeholder) => {
    const i = document.createElement('input');
    i.type = type;
    i.value = value || '';
    if (placeholder) i.placeholder = placeholder;
    i.style.cssText = 'background:#131722;color:#d1d4dc;border:1px solid #363a45;border-radius:3px;padding:6px 8px;font-family:inherit';
    return i;
  };

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center';
  const dialog = document.createElement('div');
  dialog.style.cssText = 'background:#1e222d;color:#d1d4dc;padding:20px;border-radius:6px;width:540px;max-width:90vw;max-height:90vh;overflow:auto;display:flex;flex-direction:column;gap:10px;box-shadow:0 10px 40px rgba(0,0,0,0.5);font-family:system-ui,sans-serif';

  const title = document.createElement('div');
  title.textContent = 'Create Cloud Alert (fires with browser closed)';
  title.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:6px';

  const label = (text) => { const l = document.createElement('label'); l.textContent = text; l.style.cssText = 'font-size:12px;color:#787b86;margin-bottom:2px'; return l; };

  const nameInput = makeInput('text', defaultSymbol + ' SMA cross', 'Alert name');
  const symbolInput = makeInput('text', defaultSymbol, 'Symbol');
  const intervalInput = makeInput('text', defaultInterval, 'Interval (1d, 1h, etc.)');
  const rangeInput = makeInput('text', '1y', 'Range (1y, 6mo, etc.)');
  const webhookInput = makeInput('text', '', 'Webhook URL');
  webhookInput.style.width = '100%';

  const webhookHelp = document.createElement('div');
  webhookHelp.style.cssText = 'font-size:11px;color:#787b86;line-height:1.4;margin-top:-6px';
  webhookHelp.innerHTML = 'Telegram: https://api.telegram.org/bot&lt;TOKEN&gt;/sendMessage?chat_id=&lt;CHAT&gt;&amp;text={message}<br>' +
    'Discord: https://discord.com/api/webhooks/&lt;ID&gt;/&lt;TOKEN&gt;<br>' +
    'Slack: https://hooks.slack.com/services/&lt;TOKEN&gt;<br>' +
    'Or any custom URL that accepts POST JSON.';

  const scriptInput = document.createElement('textarea');
  scriptInput.value = defaultScript;
  scriptInput.rows = 8;
  scriptInput.style.cssText = 'background:#131722;color:#d1d4dc;border:1px solid #363a45;border-radius:3px;padding:8px;font-family:monospace;font-size:12px;resize:vertical;width:100%';

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:8px';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = 'background:#2a2e39;color:#d1d4dc;border:none;border-radius:3px;padding:8px 16px;cursor:pointer';
  cancelBtn.onclick = () => document.body.removeChild(overlay);

  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Create Cloud Alert';
  saveBtn.style.cssText = 'background:#2962ff;color:#fff;border:none;border-radius:3px;padding:8px 16px;cursor:pointer;font-weight:600';

  const setStatus = (msg, color) => {
    let s = dialog.querySelector('.status-line');
    if (!s) {
      s = document.createElement('div');
      s.className = 'status-line';
      s.style.cssText = 'font-size:12px;margin-top:6px';
      dialog.insertBefore(s, btnRow);
    }
    s.textContent = msg;
    s.style.color = color || '#d1d4dc';
  };

  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    try {
      const created = await createCloudAlert({
        name: nameInput.value.trim() || 'Cloud Alert',
        symbol: symbolInput.value.trim().toUpperCase(),
        interval: intervalInput.value.trim() || '1d',
        range: rangeInput.value.trim() || '1y',
        scriptSource: scriptInput.value,
        webhookUrl: webhookInput.value.trim(),
      });
      setStatus('Created: ' + (created.id || 'ok'), '#26a69a');
      if (onSaved) onSaved(created);
      setTimeout(() => document.body.removeChild(overlay), 800);
    } catch (e) {
      setStatus('Error: ' + e.message, '#ef5350');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Create Cloud Alert';
    }
  };

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(saveBtn);

  dialog.appendChild(title);
  dialog.appendChild(label('Name')); dialog.appendChild(nameInput);
  dialog.appendChild(label('Symbol')); dialog.appendChild(symbolInput);
  dialog.appendChild(label('Interval')); dialog.appendChild(intervalInput);
  dialog.appendChild(label('Range')); dialog.appendChild(rangeInput);
  dialog.appendChild(label('Webhook URL')); dialog.appendChild(webhookInput);
  dialog.appendChild(webhookHelp);
  dialog.appendChild(label('Pine script')); dialog.appendChild(scriptInput);
  dialog.appendChild(btnRow);

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
}


// __cloud_alerts_ui__ best-effort style application.
// Real browsers accept style.cssText; the test DOM shim's Style class has
// cssText as getter-only. Catch per-op so shim tests survive.
function _safeStyle(el, cssText) {
  if (!el || !el.style) return;
  try { el.style.cssText = cssText; } catch { /* shim limitation */ }
}

export async function renderCloudAlertsPanel(container, { app, onChange } = {}) {
  if (!container) return;
  try {
    const existing = container.querySelector('.cloud-alerts-section');
    if (existing) existing.remove();

    const section = document.createElement('div');
    section.className = 'cloud-alerts-section';
    _safeStyle(section, 'margin-top:12px;padding-top:12px;border-top:1px solid #2a2e39');

    const header = document.createElement('div');
    header.className = 'watchlist-head';
    _safeStyle(header, 'display:flex;align-items:center;gap:8px;margin-bottom:6px');
    const title = document.createElement('span');
    title.textContent = 'Cloud alerts';
    _safeStyle(title, 'font-size:12px;color:#787b86;font-weight:600');
    header.appendChild(title);
    const spacer = document.createElement('span');
    _safeStyle(spacer, 'flex:1');
    header.appendChild(spacer);
    const newBtn = document.createElement('button');
    newBtn.className = 'btn sm';
    newBtn.textContent = '+ New';
    newBtn.title = 'Create a cloud alert (fires with browser closed)';
    newBtn.onclick = () => {
      openCloudAlertDialog({
        app,
        onSaved: () => {
          if (onChange) onChange();
          else renderCloudAlertsPanel(container, { app, onChange });
        },
      });
    };
    header.appendChild(newBtn);
    section.appendChild(header);

    const listEl = document.createElement('div');
    listEl.className = 'cloud-alerts-list';
    section.appendChild(listEl);
    container.appendChild(section);

    let alerts = [];
    let loadError = null;
    try { alerts = await listCloudAlerts(); } catch (e) { loadError = e.message; }

    if (loadError) {
      const err = document.createElement('div');
      err.className = 'empty-note';
      _safeStyle(err, 'color:#ef5350;font-size:11px;padding:4px');
      err.textContent = 'Cloud alerts unavailable: ' + loadError;
      listEl.appendChild(err);
      return;
    }

    if (!Array.isArray(alerts) || alerts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-note';
      _safeStyle(empty, 'font-size:11px;padding:4px;color:#787b86');
      empty.textContent = 'No cloud alerts. Click "+ New" to create one.';
      listEl.appendChild(empty);
      return;
    }

    for (const a of alerts) {
      const item = document.createElement('div');
      item.className = 'alert-item';
      _safeStyle(item, 'padding:6px 8px;font-size:12px;border-bottom:1px solid #2a2e39;display:flex;gap:6px;align-items:center');

      const main = document.createElement('div');
      _safeStyle(main, 'flex:1;display:flex;flex-direction:column;gap:2px;min-width:0');
      const nameLine = document.createElement('div');
      _safeStyle(nameLine, 'display:flex;align-items:center;gap:6px;flex-wrap:wrap');

      const nameSpan = document.createElement('span');
      nameSpan.textContent = a.name || a.symbol;
      _safeStyle(nameSpan, 'font-weight:500');
      nameLine.appendChild(nameSpan);
      const symBadge = document.createElement('span');
      symBadge.className = 'badge';
      symBadge.textContent = a.symbol;
      nameLine.appendChild(symBadge);
      const tfBadge = document.createElement('span');
      tfBadge.className = 'badge';
      tfBadge.textContent = (a.interval || '1d') + ' - ' + (a.range || '1y');
      nameLine.appendChild(tfBadge);
      if (a.lastErrorMessage) {
        const errBadge = document.createElement('span');
        errBadge.className = 'badge';
        _safeStyle(errBadge, 'color:#ef5350');
        errBadge.textContent = 'error';
        errBadge.title = a.lastErrorMessage;
        nameLine.appendChild(errBadge);
      }
      main.appendChild(nameLine);

      const statusLine = document.createElement('div');
      _safeStyle(statusLine, 'font-size:10px;color:#787b86;overflow:hidden;text-overflow:ellipsis;white-space:nowrap');
      statusLine.textContent = (a.lastFiredAt
        ? 'Last fired ' + new Date(a.lastFiredAt).toLocaleString()
        : 'Not fired yet') + ' - ' + a.webhookUrl;
      main.appendChild(statusLine);
      item.appendChild(main);

      const actions = document.createElement('div');
      _safeStyle(actions, 'display:flex;gap:4px;align-items:center;flex-shrink:0');

      const testBtn = document.createElement('button');
      testBtn.className = 'btn sm';
      testBtn.textContent = 'Test';
      testBtn.title = 'Fire the webhook now (does not mark as fired)';
      testBtn.onclick = async () => {
        testBtn.disabled = true;
        testBtn.textContent = '...';
        try {
          await testCloudAlert(a.id);
          testBtn.textContent = 'OK';
          _safeStyle(testBtn, 'color:#26a69a');
        } catch (e) {
          testBtn.textContent = 'ERR';
          _safeStyle(testBtn, 'color:#ef5350');
          testBtn.title = e.message;
        }
        setTimeout(() => {
          testBtn.disabled = false;
          testBtn.textContent = 'Test';
          _safeStyle(testBtn, 'color:');
        }, 1800);
      };
      actions.appendChild(testBtn);

      const delBtn = document.createElement('button');
      delBtn.className = 'btn sm';
      delBtn.textContent = 'X';
      delBtn.title = 'Delete cloud alert';
      delBtn.onclick = async () => {
        if (!confirm('Delete cloud alert "' + (a.name || a.symbol) + '"?')) return;
        try {
          await deleteCloudAlert(a.id);
          if (onChange) onChange();
          else renderCloudAlertsPanel(container, { app, onChange });
        } catch (e) { alert('Delete failed: ' + e.message); }
      };
      actions.appendChild(delBtn);
      item.appendChild(actions);
      listEl.appendChild(item);
    }
  } catch (e) {
    console.warn('[cloud-alerts] render failed:', (e && e.message) || e);
  }
}

// __cloud_alerts_ui__ manager modal
export function openCloudAlertsManager({ app, onChange } = {}) {
  try {
    const overlay = document.createElement('div');
    _safeStyle(overlay, 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center');
    const dialog = document.createElement('div');
    _safeStyle(dialog, 'background:#1e222d;color:#d1d4dc;padding:20px;border-radius:6px;width:680px;max-width:92vw;max-height:80vh;overflow:auto;box-shadow:0 10px 40px rgba(0,0,0,0.5);font-family:system-ui,sans-serif');
    const title = document.createElement('div');
    title.textContent = 'Cloud Alerts (fire with browser closed)';
    _safeStyle(title, 'font-size:15px;font-weight:600;margin-bottom:4px');
    dialog.appendChild(title);
    const subtitle = document.createElement('div');
    subtitle.textContent = 'Server polls every 60s and delivers to a webhook. Works without the browser open.';
    _safeStyle(subtitle, 'font-size:11px;color:#787b86;margin-bottom:12px');
    dialog.appendChild(subtitle);
    const listContainer = document.createElement('div');
    dialog.appendChild(listContainer);
    const btnRow = document.createElement('div');
    _safeStyle(btnRow, 'display:flex;gap:8px;justify-content:flex-end;margin-top:16px');
    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    _safeStyle(closeBtn, 'background:#2a2e39;color:#d1d4dc;border:none;border-radius:3px;padding:8px 16px;cursor:pointer');
    closeBtn.onclick = () => document.body.removeChild(overlay);
    btnRow.appendChild(closeBtn);
    dialog.appendChild(btnRow);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const refresh = () => {
      listContainer.innerHTML = '';
      renderCloudAlertsPanel(listContainer, {
        app,
        onChange: () => {
          refresh();
          if (onChange) onChange();
        },
      });
    };
    refresh();
  } catch (e) {
    console.warn('[cloud-alerts] manager failed:', (e && e.message) || e);
  }
}
