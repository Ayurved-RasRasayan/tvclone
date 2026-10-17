// Minimal test of applyLayout logic. We don't call app.boot() — we just
// construct the App, then directly call applyLayout and observe the
// resulting pane structure. This avoids all the network/quote/timer setup.
import { installDomShim } from '../test/dom-shim.mjs';

const { document } = installDomShim({ width: 1400, height: 800 });
global.window.localStorage = global.localStorage;

const registry = new Map();
function register(id, node) { registry.set(`#${id}`, node); node.id = id; }
const ids = [
  'symbolSearch', 'symbolInput', 'searchResults', 'intervalGroup',
  'btnChartType', 'btnIndicators', 'btnPine', 'btnAlert', 'btnReplay',
  'feedDot', 'feedText', 'leftRail', 'replayBar', 'chartToolbar',
  'chartArea', 'rightSidebar', 'sidebarTabs', 'panel-watchlist',
  'panel-alerts', 'panel-news', 'panel-data', 'bottomPanel', 'bottomTabs',
  'editorGutter', 'editorScroll', 'editorArea', 'editorHighlight', 'editorInput',
  'editorErrors', 'logList', 'strategyPane', 'scriptsPane', 'editorRun',
  'editorSave', 'editorNew', 'editorTemplates', 'bottomExpand', 'bottomClose',
  'modalBackdrop', 'modal', 'ctxMenu', 'toastWrap',
  'rpStepBack', 'rpPlay', 'rpStep', 'rpSpeed', 'rpPosition', 'rpSlider',
  'rpRealtime', 'rpClose',
];
for (const id of ids) register(id, document.createElement('div'));
document.querySelector = (sel) => registry.get(sel) || null;
document.querySelectorAll = () => [];
document.getElementById = (id) => registry.get(`#${id}`) || null;
registry.get('#chartArea')._width = 1400;
registry.get('#chartArea')._height = 700;

const mod = await import('../public/js/app.js');
const app = mod.app;
// Stub out things that would normally hit network/UI.
app.toast = () => {};
app.updateStatus = () => {};
app.persistPaneState = () => {};
app.renderToolbarState = () => {};
app.renderSidebarState = () => {};
app.renderStrategy = () => {};
app.renderDataWindow = () => {};
app.refreshLegendExtras = () => {};
app.loadAllPanes = async () => {};
app.chartArea = registry.get('#chartArea');

console.log('--- Initial state ---');
console.log('  panes.length:', app.panes.length);
console.log('  chartArea children:', app.chartArea.children.length);
console.log('  state.layout:', app.state.layout);

console.log('\n--- applyLayout("1") (single pane) ---');
app.applyLayout('1');
console.log('  panes.length:', app.panes.length);
console.log('  chartArea children:', app.chartArea.children.length);
console.log('  chartArea.dataset.layout:', app.chartArea.dataset.layout);

console.log('\n--- applyLayout("2v") (two side-by-side) ---');
app.applyLayout('2v');
console.log('  panes.length:', app.panes.length);
console.log('  chartArea children:', app.chartArea.children.length);
console.log('  chartArea.dataset.layout:', app.chartArea.dataset.layout);
for (let i = 0; i < app.panes.length; i++) {
  const p = app.panes[i];
  console.log(`  pane ${i}: className="${p.wrap.className}", parentNode=${p.wrap.parentNode?.id || 'null'}, dataset.index="${p.wrap.dataset.index}"`);
}

console.log('\n--- applyLayout("4") (2x2 grid) ---');
app.applyLayout('4');
console.log('  panes.length:', app.panes.length);
console.log('  chartArea children:', app.chartArea.children.length);
console.log('  chartArea.dataset.layout:', app.chartArea.dataset.layout);
for (let i = 0; i < app.panes.length; i++) {
  const p = app.panes[i];
  console.log(`  pane ${i}: className="${p.wrap.className}", parentNode=${p.wrap.parentNode?.id || 'null'}, dataset.index="${p.wrap.dataset.index}"`);
}

console.log('\n--- Walk chartArea children ---');
function walk(node, depth = 0) {
  if (!node || depth > 3) return;
  const tag = node.tagName || '(text)';
  const cls = node.className || '';
  const id = node.id || '';
  console.log(`${'  '.repeat(depth + 1)}${tag}${id ? '#' + id : ''}${cls ? '.' + cls.split(' ').join('.') : ''}`);
  for (const c of node.children || []) walk(c, depth + 1);
}
walk(app.chartArea);
