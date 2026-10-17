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
