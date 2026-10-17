// End-to-end: create the Pine indicator via the bridge, add it to a Chart,
// then check that the chart's indicator list has it as an overlay and
// actually rendered something.
import { installDomShim } from '../test/dom-shim.mjs';
const { document } = installDomShim({ width: 1400, height: 800 });
global.window.localStorage = global.localStorage;

import { spawn } from 'node:child_process';
const server = spawn(process.execPath, ['server.mjs', '--port', '8852'], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
server.stdout.on('data', () => {});
server.stderr.on('data', () => {});
await new Promise((r) => setTimeout(r, 2000));

try {
  const { Chart } = await import('../public/js/chart/chart.js');
  const { createPineIndicator } = await import('../public/js/chart/pine-bridge.js');
  const fs = await import('node:fs');

  const res = await fetch(`http://127.0.0.1:8852/api/chart?symbol=AAPL&interval=1d&range=2y&prepost=0`);
  const j = await res.json();
  console.log('bars:', j.bars.length);

  const container = document.createElement('div');
  container._width = 1400; container._height = 800;
  const chart = new Chart(container, { symbol: 'AAPL', interval: '1d' });
  chart.resize();
  chart.setData(j.bars, j.meta || { currency: 'USD', exchange: 'Nasdaq' });

  const src = fs.readFileSync(new URL('./real-v6-script.pine', import.meta.url), 'utf8');
  const ind = createPineIndicator({
    id: 'test_1',
    name: 'Real script',
    source: src,
    inputs: {},
    feed: { getBars: async () => ({ bars: j.bars, meta: {} }) },
    onUpdate: () => {},
  });

  console.log('indicator.overlay (before add):', ind.overlay);
  const added = chart.addIndicator(ind);
  console.log('added.overlay:', added.overlay);
  console.log('added.result.ok:', added.result?.ok);
  console.log('chart._isOverlay(added):', chart._isOverlay(added));

  chart.recomputeIndicators();
  chart._layoutPanes();
  chart.render();

  // Inspect chart panes
  console.log('chart.panes.length:', chart.panes.length);
  for (let i = 0; i < chart.panes.length; i++) {
    const p = chart.panes[i];
    console.log(`  pane ${i}: type=${p.type} h=${p.h.toFixed(0)}`, p.indicator?.name || '');
  }
  // Inspect indicator list
  console.log('chart.indicators.length:', chart.indicators.length);
  for (const i of chart.indicators) {
    console.log(`  ind: name=${i.name} overlay=${i.overlay} result.ok=${i.result?.ok} visible=${i.visible}`);
  }
  // Count render calls
  console.log('canvas ops:', chart.ctx.countOf ? chart.ctx.countOf('fillRect') : 'n/a');
} catch (err) {
  console.log('error:', err.message, err.stack);
} finally {
  server.kill('SIGTERM');
}
