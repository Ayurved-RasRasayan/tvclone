/**
 * Strategy performance analytics and the Strategy Tester panel.
 */
import { el } from './ui.js';
import { formatCompact, formatDateMedium, formatTime } from './datafeed.js';

/**
 * Compute performance statistics from a strategy result.
 * @param {Object} strategy  interpreter output (`outputs.strategy`)
 * @param {Array} bars
 */
export function computeStats(strategy, bars = []) {
  if (!strategy) return null;
  const trades = strategy.trades || [];
  const initial = strategy.initialCapital || 1e6;

  let grossProfit = 0;
  let grossLoss = 0;
  let wins = 0;
  let losses = 0;
  let largestWin = 0;
  let largestLoss = 0;
  let sumWin = 0;
  let sumLoss = 0;
  let totalCommission = 0;
  let barsHeld = 0;
  let longTrades = 0;
  let longWins = 0;
  let shortTrades = 0;
  let shortWins = 0;

  for (const t of trades) {
    const p = t.profit || 0;
    totalCommission += t.commission || 0;
    barsHeld += Math.max(0, (t.exitBar ?? 0) - (t.entryBar ?? 0));
    if (t.direction === 'long') {
      longTrades++;
      if (p > 0) longWins++;
    } else {
      shortTrades++;
      if (p > 0) shortWins++;
    }
    if (p > 0) {
      wins++;
      grossProfit += p;
      sumWin += p;
      largestWin = Math.max(largestWin, p);
    } else if (p < 0) {
      losses++;
      grossLoss += -p;
      sumLoss += -p;
      largestLoss = Math.min(largestLoss, p);
    }
  }

  // Equity curve: prefer the interpreter's per-bar curve, else rebuild from trades.
  let equity = [];
  if (strategy.equityCurve && strategy.equityCurve.length) {
    equity = strategy.equityCurve.slice();
  } else {
    let e = initial;
    equity = [e];
    for (const t of trades) {
      e += t.profit || 0;
      equity.push(e);
    }
  }
  const clean = equity.filter((v) => v !== null && v !== undefined && Number.isFinite(v));
  const finalEquity = clean.length ? clean[clean.length - 1] : initial;
  const netProfit = finalEquity - initial;

  // Max drawdown on the equity curve
  let peak = -Infinity;
  let maxDD = 0;
  let maxDDPct = 0;
  for (const v of clean) {
    peak = Math.max(peak, v);
    const dd = peak - v;
    if (dd > maxDD) {
      maxDD = dd;
      maxDDPct = peak > 0 ? (dd / peak) * 100 : 0;
    }
  }

  // Sharpe-ish ratio on equity returns (annualisation omitted deliberately).
  const rets = [];
  for (let i = 1; i < clean.length; i++) {
    if (clean[i - 1] > 0) rets.push(clean[i] / clean[i - 1] - 1);
  }
  const meanRet = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const varRet = rets.length ? rets.reduce((a, b) => a + (b - meanRet) ** 2, 0) / rets.length : 0;
  const sd = Math.sqrt(varRet);
  const sharpe = sd > 0 ? (meanRet / sd) * Math.sqrt(252) : 0;

  // __sortino_commission_export__ Sortino: downside-deviation-only ratio.
  const downs = rets.filter((r) => r < 0);
  let sortino = 0;
  if (downs.length > 0) {
    const meanDown = downs.reduce((a, b) => a + b, 0) / downs.length;
    const varDown = downs.reduce((a, b) => a + (b - meanDown) ** 2, 0) / downs.length;
    const sdDown = Math.sqrt(varDown);
    if (sdDown > 0) sortino = (meanRet / sdDown) * Math.sqrt(252);
  }

  const avgBars = trades.length ? barsHeld / trades.length : 0;
  const expectancy = trades.length ? netProfit / trades.length : 0;

  return {
    netProfit,
    netProfitPct: initial ? (netProfit / initial) * 100 : 0,
    finalEquity,
    initialCapital: initial,
    totalTrades: trades.length,
    closedTrades: trades.length,
    openTrades: strategy.position?.size ? 1 : 0,
    openSize: strategy.position?.size || 0,
    openAvgPrice: strategy.position?.avgPrice ?? NaN,
    wins,
    losses,
    winRate: trades.length ? (wins / trades.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    grossProfit,
    grossLoss,
    avgWin: wins ? sumWin / wins : 0,
    avgLoss: losses ? sumLoss / losses : 0,
    largestWin,
    largestLoss,
    totalCommission,
    maxDrawdown: maxDD,
    maxDrawdownPct: maxDDPct,
    sharpe,
    sortino,
    avgBarsInTrade: avgBars,
    expectancy,
    longTrades,
    longWins,
    shortTrades,
    shortWins,
    orders: (strategy.orders || []).length,
    bars: bars.length,
  };
}

/** Render the Strategy Tester pane. */
export function renderStrategyPane(container, { stats, strategy, symbol, timezone, onGoToBar }) {
  container.innerHTML = '';
  if (!stats && !strategy) {
    container.appendChild(
      el('div', { class: 'empty-note', text: 'No strategy running.\nAdd a script that calls strategy() to see performance here.' })
    );
    return;
  }
  if (!stats || stats.totalTrades === 0) {
    container.appendChild(
      el('div', {
        class: 'empty-note',
        text:
          `Strategy is running but produced no closed trades yet.\n` +
          `Orders placed: ${stats?.orders ?? 0}` +
          (stats?.openSize ? `\nOpen position: ${stats.openSize}` : ''),
      })
    );
    if (stats?.orders) renderOrders(container, strategy, timezone);
    return;
  }

  const money = (v) => (Number.isFinite(v) ? `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—');
  const pct = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : '—');
  const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');

  const cards = [
    ['Net profit', money(stats.netProfit), cls(stats.netProfit)],
    ['Net profit %', pct(stats.netProfitPct), cls(stats.netProfitPct)],
    ['Total trades', String(stats.totalTrades), ''],
    ['Win rate', `${stats.winRate.toFixed(1)}%`, stats.winRate >= 50 ? 'up' : 'down'],
    ['Profit factor', Number.isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : '∞', stats.profitFactor >= 1 ? 'up' : 'down'],
    ['Max drawdown', money(-stats.maxDrawdown), 'down'],
    ['Max drawdown %', `${stats.maxDrawdownPct.toFixed(2)}%`, 'down'],
    ['Sharpe ratio', Number.isFinite(stats.sharpe) ? stats.sharpe.toFixed(2) : '—', cls(stats.sharpe)],
    ['Sortino ratio', Number.isFinite(stats.sortino) ? stats.sortino.toFixed(2) : '—', cls(stats.sortino)],
    ['Gross profit', money(stats.grossProfit), 'up'],
    ['Gross loss', money(-stats.grossLoss), 'down'],
    ['Avg win', money(stats.avgWin), 'up'],
    ['Avg loss', money(-stats.avgLoss), 'down'],
    ['Largest win', money(stats.largestWin), 'up'],
    ['Largest loss', money(stats.largestLoss), 'down'],
    ['Expectancy / trade', money(stats.expectancy), cls(stats.expectancy)],
    ['Avg bars in trade', stats.avgBarsInTrade.toFixed(1), ''],
    ['Long trades', `${stats.longTrades} (${stats.longTrades ? ((stats.longWins / stats.longTrades) * 100).toFixed(0) : 0}% win)`, ''],
    ['Short trades', `${stats.shortTrades} (${stats.shortTrades ? ((stats.shortWins / stats.shortTrades) * 100).toFixed(0) : 0}% win)`, ''],
    ['Commission', money(stats.totalCommission), ''],
    ['Final equity', money(stats.finalEquity), cls(stats.netProfit)],
  ];

  const grid = el('div', { class: 'stats-grid' });
  for (const [label, value, klass] of cards) {
    grid.appendChild(el('div', { class: 'stat-card' }, [el('div', { class: 's-label', text: label }), el('div', { class: `s-value ${klass}`, text: value })]));
  }
  container.appendChild(grid);

  // Equity sparkline
  const equity = (strategy?.equityCurve || []).filter((v) => Number.isFinite(v));
  if (equity.length > 2) {
    container.appendChild(renderEquityChart(equity, stats));
    // __sortino_commission_export__ Equity curve CSV download
    {
      const exportBtn = el('button', {
        class: 'btn sm',
        text: 'Export equity CSV',
        style: { margin: '0 10px 12px' },
        onclick: () => {
          const rows = ['Equity'];
          for (const v of equity) rows.push(String(v));
          const blob = new Blob([rows.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'equity_' + (symbol || 'strategy') + '_' + new Date().toISOString().slice(0, 10) + '.csv';
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 2000);
        },
      });
      container.appendChild(exportBtn);
    }
  }

  // Trades table
  const wrap = el('div', { style: { padding: '0 10px 16px' } });
  wrap.appendChild(el('div', { class: 'input-group-title', text: 'Closed trades' }));
  const table = el('table', { class: 'trades-table' });
  table.appendChild(
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: '#' }),
        el('th', { text: 'Dir' }),
        el('th', { text: 'Entry time' }),
        el('th', { class: 'num', text: 'Entry' }),
        el('th', { text: 'Exit time' }),
        el('th', { class: 'num', text: 'Exit' }),
        el('th', { class: 'num', text: 'Size' }),
        el('th', { class: 'num', text: 'P&L' }),
        el('th', { class: 'num', text: 'P&L %' }),
        el('th', { class: 'num', text: 'Commission' }),
      ]),
    ])
  );
  const tbody = el('tbody');
  (strategy.trades || []).forEach((t, i) => {
    const plPct = t.entryPrice ? ((t.exitPrice - t.entryPrice) / t.entryPrice) * 100 * (t.size > 0 ? 1 : -1) : 0;
    const row = el('tr', { style: { cursor: 'pointer' }, onclick: () => onGoToBar?.(t.entryBar) }, [
      el('td', { text: String(i + 1) }),
      el('td', { text: t.direction === 'long' ? 'Long' : 'Short', style: { color: t.direction === 'long' ? 'var(--up)' : 'var(--down)' } }),
      el('td', { text: fmtTime(t.entryTime, timezone) }),
      el('td', { class: 'num', text: fmtPrice(t.entryPrice) }),
      el('td', { text: fmtTime(t.exitTime, timezone) }),
      el('td', { class: 'num', text: fmtPrice(t.exitPrice) }),
      el('td', { class: 'num', text: String(Math.abs(t.size)) }),
      el('td', { class: 'num', style: { color: t.profit >= 0 ? 'var(--up)' : 'var(--down)' }, text: t.profit.toFixed(2) }),
      el('td', { class: 'num', style: { color: plPct >= 0 ? 'var(--up)' : 'var(--down)' }, text: `${plPct >= 0 ? '+' : ''}${plPct.toFixed(2)}%` }),
      el('td', { class: 'num', text: (Number(t.commission) || 0).toFixed(2) }),
    ]);
    tbody.appendChild(row);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);
  void symbol;
  void formatCompact;
}

function renderOrders(container, strategy, timezone) {
  const wrap = el('div', { style: { padding: '0 10px 16px' } });
  wrap.appendChild(el('div', { class: 'input-group-title', text: 'Orders placed' }));
  const table = el('table', { class: 'trades-table' });
  table.appendChild(
    el('thead', {}, [
      el('tr', {}, [el('th', { text: '#' }), el('th', { text: 'Time' }), el('th', { text: 'Kind' }), el('th', { class: 'num', text: 'Qty' }), el('th', { class: 'num', text: 'Price' })]),
    ])
  );
  const tbody = el('tbody');
  for (const [i, o] of (strategy.orders || []).entries()) {
    tbody.appendChild(
      el('tr', {}, [
        el('td', { text: String(i + 1) }),
        el('td', { text: fmtTime(o.time, timezone) }),
        el('td', { text: o.kind }),
        el('td', { class: 'num', text: String(o.qty) }),
        el('td', { class: 'num', text: fmtPrice(o.price) }),
      ])
    );
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);
}

function renderEquityChart(values, stats) {
  const wrap = el('div', { style: { padding: '0 10px 14px' } });
  wrap.appendChild(el('div', { class: 'input-group-title', text: 'Equity curve' }));
  const canvas = el('canvas', { width: '900', height: '150', style: { width: '100%', height: '150px', display: 'block', background: '#171b26', borderRadius: '4px' } });
  wrap.appendChild(canvas);
  setTimeout(() => {
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const pad = (max - min) * 0.1 || 1;
    const yOf = (v) => h - ((v - (min - pad)) / (max - min + pad * 2)) * h;
    // baseline
    ctx.strokeStyle = '#2a2e39';
    ctx.beginPath();
    const baseY = yOf(stats.initialCapital);
    ctx.moveTo(0, baseY);
    ctx.lineTo(w, baseY);
    ctx.stroke();
    // curve
    const up = stats.netProfit >= 0;
    ctx.strokeStyle = up ? '#089981' : '#f23645';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    values.forEach((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = yOf(v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    // fill
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, up ? 'rgba(8,153,129,0.25)' : 'rgba(242,54,69,0.25)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fill();
  }, 0);
  return wrap;
}

function fmtTime(ms, timezone) {
  if (!ms) return '—';
  return `${formatDateMedium(ms, timezone)} ${formatTime(ms, timezone)}`;
}

function fmtPrice(v) {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const d = a >= 100 ? 2 : a >= 1 ? 3 : 5;
  return v.toFixed(d);
}
