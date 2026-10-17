/**
 * Alerts: creation, persistence, polling evaluation and notification.
 *
 * Two kinds of alert are supported:
 *   - "price":  a simple cross-above / cross-below / greater / less test on the
 *               last traded price.
 *   - "script": driven by a named Pine `alertcondition()` (or the value of a
 *               plotted series) on a chart that has the script attached.
 */
import { $, el, icon, openModal, store, toast, beep } from './ui.js';

const STORAGE_KEY = 'alerts';

export class AlertManager {
  constructor({ onLog, onFire }) {
    this.alerts = store.get(STORAGE_KEY, []);
    this.onLog = onLog || (() => {});
    this.onFire = onFire || (() => {});
    this.timer = null;
    this.lastFired = new Map();
    this.history = [];
    this.tick = 0;
  }

  /* ---------------- CRUD ---------------- */

  add(alert) {
    const entry = {
      id: `al_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      createdAt: Date.now(),
      enabled: true,
      triggeredCount: 0,
      ...alert,
    };
    this.alerts.push(entry);
    this.persist();
    return entry;
  }

  remove(id) {
    const i = this.alerts.findIndex((a) => a.id === id);
    if (i >= 0) {
      this.alerts.splice(i, 1);
      this.persist();
      this.emit();
    }
  }

  toggle(id) {
    const a = this.alerts.find((x) => x.id === id);
    if (a) {
      a.enabled = !a.enabled;
      this.persist();
      this.emit();
    }
  }

  clearAll() {
    this.alerts = [];
    this.persist();
    this.emit();
  }

  persist() {
    store.set(STORAGE_KEY, this.alerts);
  }

  emit() {
    window.dispatchEvent(new CustomEvent('alerts:changed', { detail: this.alerts }));
  }

  /* ---------------- evaluation ---------------- */

  /**
   * Evaluate all alerts.
   * @param {Object} ctx
   * @param {Function} ctx.getQuote  (symbol) => { price, previousClose, ... }
   * @param {Function} ctx.getScriptAlerts (symbol) => [{ title, message, conditionId, firing, time }]
   */
  async evaluate(ctx) {
    this.tick++;
    for (const alert of this.alerts) {
      if (!alert.enabled) continue;
      try {
        if (alert.kind === 'script') {
          const items = ctx.getScriptAlerts(alert.symbol) || [];
          for (const item of items) {
            if (alert.conditionId && item.conditionId !== alert.conditionId) continue;
            this.fire(alert, item.message || alert.message || item.title, { source: 'script', time: item.time });
          }
        } else {
          const q = ctx.getQuote(alert.symbol);
          if (!q || q.price === null || q.price === undefined) continue;
          const price = Number(q.price);
          const prev = alert.lastPrice ?? q.previousClose ?? price;
          const hit = evalPriceCondition(alert, price, prev);
          if (hit) this.fire(alert, alert.message || `${alert.symbol} ${alert.condition} ${alert.value}`, { source: 'price', price });
          alert.lastPrice = price;
        }
      } catch (err) {
        this.onLog('error', `Alert "${alert.name}" failed: ${err.message}`);
      }
    }
    this.persist();
  }

  fire(alert, message, extra = {}) {
    const cooldown = 3000;
    const last = this.lastFired.get(alert.id) || 0;
    if (Date.now() - last < cooldown) return;
    this.lastFired.set(alert.id, Date.now());
    alert.lastTriggered = Date.now();
    alert.triggeredCount = (alert.triggeredCount || 0) + 1;

    const event = { alert, message, at: Date.now(), ...extra };
    this.history.unshift(event);
    if (this.history.length > 200) this.history.length = 200;

    toast(`🔔 ${alert.name || alert.symbol}`, message, 'alert', 8000);
    beep('alert');
    this.onLog('alert', `${alert.name || alert.symbol}: ${message}`);
    this.onFire(event);
    this.emit();
    window.dispatchEvent(new CustomEvent('alert:fired', { detail: event }));
  }

  start(getContext, intervalMs = 5000) {
    this.stop();
    this.timer = setInterval(() => {
      if (document.hidden) return;
      this.evaluate(getContext());
    }, intervalMs);
    // Evaluate once right away so the user sees immediate feedback.
    setTimeout(() => this.evaluate(getContext()), 800);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Count of alerts that fired recently, for the header badge. */
  firingCount() {
    const cutoff = Date.now() - 60000;
    return this.alerts.filter((a) => a.triggeredCount > 0 && a.lastTriggered > cutoff).length;
  }
}

function evalPriceCondition(alert, price, prev) {
  const v = Number(alert.value);
  switch (alert.condition) {
    case 'crossing_up':
      return prev <= v && price > v;
    case 'crossing_down':
      return prev >= v && price < v;
    case 'crossing':
      return (prev <= v && price > v) || (prev >= v && price < v);
    case 'greater_than':
      return price > v;
    case 'less_than':
      return price < v;
    case 'pct_change_up':
      return prev ? ((price - prev) / prev) * 100 >= v : false;
    case 'pct_change_down':
      return prev ? ((price - prev) / prev) * 100 <= -v : false;
    default:
      return false;
  }
}

export const CONDITION_LABELS = {
  crossing: 'Crossing',
  crossing_up: 'Crossing up',
  crossing_down: 'Crossing down',
  greater_than: 'Greater than',
  less_than: 'Less than',
  pct_change_up: 'Percent change up',
  pct_change_down: 'Percent change down',
};

/* ------------------------------------------------------------------ *
 * UI
 * ------------------------------------------------------------------ */

/**
 * Open the create-alert dialog.
 * @param {Object} opts
 * @param {string} opts.symbol
 * @param {number} opts.price
 * @param {Array}  opts.scriptConditions  [{ title, message, conditionId }]
 * @param {Function} opts.onSubmit
 */
export function openAlertDialog(opts) {
  const { symbol, price, scriptConditions = [], onSubmit } = opts;
  const state = {
    kind: scriptConditions.length ? 'script' : 'price',
    name: `${symbol} alert`,
    condition: 'crossing',
    value: round4(price),
    conditionId: scriptConditions[0]?.conditionId || null,
    message: '',
  };

  const body = el('div');

  const kindRow = el('div', { class: 'field' }, [
    el('label', { text: 'Alert type' }),
    el('div', { class: 'btn-group', style: { width: '100%' } }, [
      el('button', { class: `btn ${state.kind === 'price' ? 'active' : ''}`, text: 'Price', style: { flex: '1' }, onclick: () => setKind('price') }),
      el('button', {
        class: `btn ${state.kind === 'script' ? 'active' : ''}`,
        text: 'Script condition',
        style: { flex: '1' },
        disabled: !scriptConditions.length,
        onclick: () => setKind('script'),
      }),
    ]),
    scriptConditions.length
      ? null
      : el('div', { style: { fontSize: '11px', color: 'var(--text-dim)', marginTop: '5px' }, text: 'Add a script with alertcondition() to enable script alerts.' }),
  ]);

  const nameField = field('Alert name', el('input', { type: 'text', value: state.name, oninput: (e) => (state.name = e.target.value) }));

  const priceSection = el('div');
  const condSelect = el(
    'select',
    { onchange: (e) => (state.condition = e.target.value) },
    Object.entries(CONDITION_LABELS).map(([v, l]) => el('option', { value: v, text: l, selected: v === state.condition }))
  );
  const valueInput = el('input', { type: 'number', step: 'any', value: String(state.value), oninput: (e) => (state.value = Number(e.target.value)) });
  priceSection.append(
    el('div', { class: 'field-row' }, [field('Condition', condSelect), field('Value', valueInput)]),
    el('div', { style: { fontSize: '11px', color: 'var(--text-dim)', marginTop: '-4px' }, text: `Last price: ${price ?? '—'}` })
  );

  const scriptSection = el(
    'div',
    { class: state.kind === 'script' ? '' : 'hidden' },
    [
      field(
        'Condition',
        el(
          'select',
          { onchange: (e) => (state.conditionId = e.target.value) },
          scriptConditions.map((c) => el('option', { value: c.conditionId, text: c.title, selected: c.conditionId === state.conditionId }))
        )
      ),
    ]
  );

  const messageField = field(
    'Message (optional)',
    el('textarea', { placeholder: 'Custom notification text', oninput: (e) => (state.message = e.target.value) })
  );

  body.append(kindRow, nameField, priceSection, scriptSection, messageField);

  function setKind(kind) {
    state.kind = kind;
    priceSection.classList.toggle('hidden', kind !== 'price');
    scriptSection.classList.toggle('hidden', kind !== 'script');
    [...kindRow.querySelectorAll('.btn')].forEach((b, i) => b.classList.toggle('active', (i === 0) === (kind === 'price')));
  }

  openModal({
    title: 'Create alert',
    body,
    width: 420,
    actions: [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: 'Create alert',
        primary: true,
        onClick: (close) => {
          if (state.kind === 'price' && !Number.isFinite(Number(state.value))) {
            toast('Invalid value', 'Enter a numeric trigger value.', 'error');
            return;
          }
          onSubmit({ ...state, symbol });
          close();
        },
      },
    ],
  });
}

function field(label, control) {
  return el('div', { class: 'field' }, [el('label', { text: label }), control]);
}

function round4(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 10000) / 10000;
}

/** Render the alerts sidebar panel. */
export function renderAlertsPanel(container, manager, { onSelect, onCreate }) {
  container.innerHTML = '';
  const head = el('div', { class: 'watchlist-head' }, [
    el('span', { text: `${manager.alerts.length} alert${manager.alerts.length === 1 ? '' : 's'}` }),
    el('span', { style: { flex: '1' } }),
    el('button', { class: 'btn sm', text: '+ New', onclick: onCreate }),
    manager.alerts.length ? el('button', { class: 'btn sm', text: 'Clear', onclick: () => manager.clearAll() }) : null,
  ]);
  container.appendChild(head);

  if (!manager.alerts.length) {
    container.appendChild(
      el('div', { class: 'empty-note', text: 'No alerts yet.\nPress Ctrl+A or click the Alert button to create one.' })
    );
    return;
  }

  for (const a of manager.alerts) {
    const when = a.lastTriggered ? new Date(a.lastTriggered).toLocaleTimeString() : null;
    const sub =
      a.kind === 'script'
        ? `${a.symbol} · script condition`
        : `${a.symbol} · ${CONDITION_LABELS[a.condition] || a.condition} ${a.value}`;
    container.appendChild(
      el('div', { class: 'alert-item' }, [
        el('div', { class: 'a-main' }, [
          el('div', { class: 'a-title' }, [
            el('span', { text: a.name || a.symbol }),
            el('span', { class: `badge ${a.enabled ? 'on' : 'off'}`, text: a.enabled ? 'armed' : 'paused' }),
            a.triggeredCount ? el('span', { class: 'badge', text: `${a.triggeredCount}×` }) : null,
          ]),
          el('div', { class: 'a-sub', text: sub + (when ? ` · last ${when}` : '') }),
        ]),
        el('span', { class: 'a-del', text: a.enabled ? '⏸' : '▶', title: 'Pause / resume', onclick: () => manager.toggle(a.id) }),
        el('span', { class: 'a-del', text: '✕', title: 'Delete', onclick: () => manager.remove(a.id) }),
      ])
    );
  }
  void onSelect;
}
