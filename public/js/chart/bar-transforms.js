/**
 * Price-driven bar construction algorithms.
 *
 * Each transform is a pure function: (bars, options) -> bars.
 * Input/output bars are OHLCV-like { t, o, h, l, c, v?, direction? }.
 * Output uses the same OHLC shape so existing candle/bar renderers work.
 */

/** Derive a reasonable default size from the bar series (1% of median close). */
export function autoSize(bars, percent = 0.01) {
  if (!Array.isArray(bars) || bars.length === 0) return 1;
  const closes = bars.map(b => b.c).filter(Number.isFinite).sort((a, b) => a - b);
  if (closes.length === 0) return 1;
  const median = closes[Math.floor(closes.length / 2)];
  return Math.max(median * percent, 0.0001);
}

/* ------------------------------ Range Bars ------------------------------ */
export function rangeBars(bars, rangeSize) {
  if (!Array.isArray(bars) || bars.length === 0) return [];
  const size = Number(rangeSize) > 0 ? Number(rangeSize) : autoSize(bars);
  const out = [];
  let pending = null;

  for (const bar of bars) {
    const prices = [bar.o, bar.h, bar.l, bar.c].filter(Number.isFinite);
    for (const price of prices) {
      if (!pending) {
        pending = { t: bar.t, o: price, h: price, l: price, c: price, v: bar.v };
        continue;
      }
      while (Math.abs(price - pending.o) >= size) {
        const closeLevel = price > pending.o ? pending.o + size : pending.o - size;
        if (closeLevel > pending.o) {
          pending.h = Math.max(pending.h, closeLevel);
          pending.c = closeLevel;
          out.push(pending);
          pending = { t: bar.t, o: closeLevel, h: closeLevel, l: closeLevel, c: closeLevel, v: bar.v };
        } else {
          pending.l = Math.min(pending.l, closeLevel);
          pending.c = closeLevel;
          out.push(pending);
          pending = { t: bar.t, o: closeLevel, h: closeLevel, l: closeLevel, c: closeLevel, v: bar.v };
        }
      }
      pending.h = Math.max(pending.h, price);
      pending.l = Math.min(pending.l, price);
      pending.c = price;
    }
  }
  // Only emit trailing pending if price has moved within it (c !== o).
  // A zero-range bar at the current price is a UI artifact, not real data.
  if (pending && pending.c !== pending.o) out.push(pending);
  return out;
}

/* -------------------------------- Renko -------------------------------- */
export function renko(bars, brickSize, options = {}) {
  if (!Array.isArray(bars) || bars.length < 2) return [];
  const size = Number(brickSize) > 0 ? Number(brickSize) : autoSize(bars);
  const reversal = Math.max(1, options.reversal || 2);
  const out = [];
  let lastBrick = bars[0].c;
  let direction = 0;

  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i];
    const c = bar.c;
    if (!Number.isFinite(c)) continue;

    if (direction === 0) {
      if (c >= lastBrick + size) direction = 1;
      else if (c <= lastBrick - size) direction = -1;
      else continue;
    }

    if (direction === 1) {
      while (c >= lastBrick + size) {
        out.push({ t: bar.t, o: lastBrick, c: lastBrick + size, h: lastBrick + size, l: lastBrick, direction: 1 });
        lastBrick += size;
      }
      if (c <= lastBrick - reversal * size) {
        while (c <= lastBrick - size) {
          out.push({ t: bar.t, o: lastBrick, c: lastBrick - size, h: lastBrick, l: lastBrick - size, direction: -1 });
          lastBrick -= size;
        }
        direction = -1;
      }
    } else {
      while (c <= lastBrick - size) {
        out.push({ t: bar.t, o: lastBrick, c: lastBrick - size, h: lastBrick, l: lastBrick - size, direction: -1 });
        lastBrick -= size;
      }
      if (c >= lastBrick + reversal * size) {
        while (c >= lastBrick + size) {
          out.push({ t: bar.t, o: lastBrick, c: lastBrick + size, h: lastBrick + size, l: lastBrick, direction: 1 });
          lastBrick += size;
        }
        direction = 1;
      }
    }
  }
  return out;
}

/* ------------------------------ Line Break ------------------------------ */
export function lineBreak(bars, period = 3) {
  if (!Array.isArray(bars) || bars.length <= period) return [];
  const out = [];
  const closes = [];

  for (const bar of bars) {
    closes.push(bar.c);
    if (closes.length < period + 1) continue;
    const window = closes.slice(closes.length - period - 1, closes.length - 1);
    const high = Math.max(...window);
    const low = Math.min(...window);
    const prevClose = closes[closes.length - 2];

    if (bar.c > high) {
      out.push({ t: bar.t, o: prevClose, c: bar.c, h: bar.c, l: prevClose, direction: 1 });
    } else if (bar.c < low) {
      out.push({ t: bar.t, o: prevClose, c: bar.c, h: prevClose, l: bar.c, direction: -1 });
    }
  }
  return out;
}

/* --------------------------------- Kagi --------------------------------- */
export function kagi(bars, reversalAmount) {
  if (!Array.isArray(bars) || bars.length === 0) return [];
  const rev = Number(reversalAmount) > 0 ? Number(reversalAmount) : autoSize(bars);
  const out = [];
  let direction = 0;
  let lineStart = null;
  let lastExtreme = null;
  let pending = null;

  for (const bar of bars) {
    const c = bar.c;
    if (!Number.isFinite(c)) continue;

    if (lineStart === null) {
      lineStart = c;
      lastExtreme = c;
      continue;
    }

    if (direction === 0) {
      if (c > lineStart) { direction = 1; lastExtreme = c; }
      else if (c < lineStart) { direction = -1; lastExtreme = c; }
      continue;
    }

    if (direction === 1) {
      if (c > lastExtreme) {
        lastExtreme = c;
        pending = { t: bar.t, o: lineStart, c, h: c, l: lineStart, direction: 1 };
      } else if (c <= lastExtreme - rev) {
        out.push({ t: bar.t, o: lineStart, c: lastExtreme, h: lastExtreme, l: lineStart, direction: 1 });
        lineStart = lastExtreme;
        lastExtreme = c;
        direction = -1;
        pending = { t: bar.t, o: lineStart, c, h: lineStart, l: c, direction: -1 };
      }
    } else {
      if (c < lastExtreme) {
        lastExtreme = c;
        pending = { t: bar.t, o: lineStart, c, h: lineStart, l: c, direction: -1 };
      } else if (c >= lastExtreme + rev) {
        out.push({ t: bar.t, o: lineStart, c: lastExtreme, h: lineStart, l: lastExtreme, direction: -1 });
        lineStart = lastExtreme;
        lastExtreme = c;
        direction = 1;
        pending = { t: bar.t, o: lineStart, c, h: c, l: lineStart, direction: 1 };
      }
    }
  }

  if (pending) {
    out.push({
      t: pending.t,
      o: pending.o,
      c: lastExtreme,
      h: Math.max(pending.o, lastExtreme),
      l: Math.min(pending.o, lastExtreme),
      direction: pending.direction,
    });
  }
  return out;
}

/* ---------------------------- Point & Figure ---------------------------- */
export function pointFigure(bars, boxSize, reversal = 3) {
  if (!Array.isArray(bars) || bars.length < 2) return [];
  const size = Number(boxSize) > 0 ? Number(boxSize) : autoSize(bars);
  const rev = Math.max(1, Math.floor(reversal));
  const out = [];
  let direction = 0;
  let lastLevel = Math.floor(bars[0].c / size) * size;

  const pushBox = (t, from, to, dir) => {
    out.push({
      t,
      o: from,
      c: to,
      h: Math.max(from, to),
      l: Math.min(from, to),
      direction: dir,
    });
  };

  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i];
    const c = bar.c;
    if (!Number.isFinite(c)) continue;
    const level = Math.floor(c / size) * size;

    if (direction === 0) {
      const upLevels = Math.round((level - lastLevel) / size);
      const downLevels = Math.round((lastLevel - level) / size);
      if (upLevels >= 1) {
        direction = 1;
        for (let k = 1; k <= upLevels; k++) pushBox(bar.t, lastLevel + (k - 1) * size, lastLevel + k * size, 1);
        lastLevel += upLevels * size;
      } else if (downLevels >= 1) {
        direction = -1;
        for (let k = 1; k <= downLevels; k++) pushBox(bar.t, lastLevel - (k - 1) * size, lastLevel - k * size, -1);
        lastLevel -= downLevels * size;
      }
      continue;
    }

    if (direction === 1) {
      const upLevels = Math.round((level - lastLevel) / size);
      if (upLevels > 0) {
        for (let k = 1; k <= upLevels; k++) pushBox(bar.t, lastLevel + (k - 1) * size, lastLevel + k * size, 1);
        lastLevel += upLevels * size;
      } else {
        const downLevels = Math.round((lastLevel - level) / size);
        if (downLevels >= rev) {
          direction = -1;
          for (let k = 1; k <= downLevels; k++) pushBox(bar.t, lastLevel - (k - 1) * size, lastLevel - k * size, -1);
          lastLevel -= downLevels * size;
        }
      }
    } else {
      const downLevels = Math.round((lastLevel - level) / size);
      if (downLevels > 0) {
        for (let k = 1; k <= downLevels; k++) pushBox(bar.t, lastLevel - (k - 1) * size, lastLevel - k * size, -1);
        lastLevel -= downLevels * size;
      } else {
        const upLevels = Math.round((level - lastLevel) / size);
        if (upLevels >= rev) {
          direction = 1;
          for (let k = 1; k <= upLevels; k++) pushBox(bar.t, lastLevel + (k - 1) * size, lastLevel + k * size, 1);
          lastLevel += upLevels * size;
        }
      }
    }
  }
  return out;
}
