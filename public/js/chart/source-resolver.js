/**
 * Indicator source resolution.
 *
 * A builtin indicator can take another indicator's output as its input.
 * The reference format is `ind:<indicatorId>:<plotIndex>`, e.g. `ind:abc:0`
 * means "the first plot of indicator `abc`".
 *
 * resolveSourceBars returns bars with o/h/l/c substituted by the indicator
 * plot values, so a builtin that normally reads close (SMA, RSI, etc.)
 * computes on the indicator output instead. null/NaN values fall back to
 * the original bar so the builtin's own na-handling kicks in naturally.
 */
export function resolveSourceBars(chart, bars, sourceSpec) {
  if (!sourceSpec || typeof sourceSpec !== 'string') return bars;
  if (!sourceSpec.startsWith('ind:')) return bars;
  const parts = sourceSpec.split(':');
  const parentId = parts[1];
  const plotIdx = parseInt(parts[2] || '0', 10);
  const parent = chart?.indicators?.find((i) => i.id === parentId);
  const plot = parent?.result?.outputs?.plots?.[plotIdx];
  if (!plot || !Array.isArray(plot.values)) return bars;
  return bars.map((b, i) => {
    const v = plot.values[i];
    if (v == null || !Number.isFinite(v)) return b;
    return { ...b, o: v, h: v, l: v, c: v };
  });
}

/**
 * List everything that can be a source: builtin OHLC fields plus every plot
 * of every already-computed indicator on the chart.
 * @returns {{value:string,label:string}[]}
 */
export function listAvailableSources(chart) {
  const sources = [
    { value: 'close', label: 'close' },
    { value: 'open', label: 'open' },
    { value: 'high', label: 'high' },
    { value: 'low', label: 'low' },
    { value: 'hl2', label: 'hl2' },
    { value: 'hlc3', label: 'hlc3' },
    { value: 'ohlc4', label: 'ohlc4' },
  ];
  if (!chart?.indicators) return sources;
  for (const ind of chart.indicators) {
    if (!ind.result?.ok || !ind.result.outputs?.plots) continue;
    for (let i = 0; i < ind.result.outputs.plots.length; i++) {
      const p = ind.result.outputs.plots[i];
      const title = p.title || 'plot' + (i + 1);
      sources.push({
        value: `ind:${ind.id}:${i}`,
        label: `${ind.name || ind.id} -> ${title}`,
      });
    }
  }
  return sources;
}
