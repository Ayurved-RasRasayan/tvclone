/**
 * Pine value types: colours, style constants and their namespaces.
 */

const NAMED_COLORS = {
  red: '#F23645',
  green: '#089981',
  blue: '#2962FF',
  white: '#FFFFFF',
  black: '#000000',
  yellow: '#FDD835',
  orange: '#FF9800',
  purple: '#9C27B0',
  fuchsia: '#E040FB',
  magenta: '#E040FB',
  lime: '#00E676',
  aqua: '#00BCD4',
  teal: '#009688',
  navy: '#000080',
  olive: '#808000',
  maroon: '#800000',
  silver: '#C0C0C0',
  gray: '#787B86',
  grey: '#787B86',
  pink: '#FF80AB',
  brown: '#795548',
};

export class PineColor {
  constructor(value, transparency = 0) {
    this.__color = true;
    this.value = String(value).replace('#', '').toLowerCase();
    this.transparency = transparency;
  }
  toString() {
    return `#${this.value}`;
  }
  get rgb() {
    const v = this.value;
    const r = parseInt(v.slice(0, 2), 16);
    const g = parseInt(v.slice(2, 4), 16);
    const b = parseInt(v.slice(4, 6), 16);
    const a = v.length >= 8 ? parseInt(v.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
  }
}

export function makeColor(value, transparency = 0) {
  if (value instanceof PineColor) {
    if (transparency) return new PineColor(value.value, transparency);
    return value;
  }
  if (typeof value === 'string') {
    const v = value.trim().replace('#', '');
    if (/^[0-9a-fA-F]{6}$/.test(v) || /^[0-9a-fA-F]{8}$/.test(v)) {
      return new PineColor(v.toLowerCase(), transparency);
    }
    const named = NAMED_COLORS[v.toLowerCase()];
    if (named) return new PineColor(named.slice(1), transparency);
  }
  return new PineColor('000000', transparency);
}

/** "#RRGGBB" + transparency 0..100 -> canvas rgba() */
export function colorToCss(value, fallback = 'transparent') {
  if (!value) return fallback;
  const c = value instanceof PineColor ? value : makeColor(value);
  const { r, g, b } = c.rgb;
  const alpha = Math.max(0, Math.min(1, 1 - (c.transparency || 0) / 100));
  return `rgba(${r},${g},${b},${alpha})`;
}

export function colorToHex(value) {
  if (!value) return '#000000';
  const c = value instanceof PineColor ? value : makeColor(value);
  return `#${c.value.slice(0, 6)}`;
}

/* ---------------- style constant enums ---------------- */

function enumOf(pairs) {
  const out = { __enum: true };
  for (const [name, value] of Object.entries(pairs)) {
    out[name] = value;
  }
  return Object.freeze(out);
}

export const plotStyle = enumOf({
  line: 0,
  stepline: 1,
  histogram: 2,
  cross: 3,
  area: 4,
  columns: 5,
  circles: 6,
  linebr: 7,
  areabr: 8,
  stepline_diamond: 9,
  steplinebr: 10,
  labels: 11,
});

export const shapeStyle = enumOf({
  xcross: 'xcross',
  cross: 'cross',
  triangleup: 'triangleup',
  triangledown: 'triangledown',
  flag: 'flag',
  circle: 'circle',
  arrowup: 'arrowup',
  arrowdown: 'arrowdown',
  labelup: 'labelup',
  labeldown: 'labeldown',
  square: 'square',
  diamond: 'diamond',
});

export const lineStyle = enumOf({
  solid: 'solid',
  dotted: 'dotted',
  dashed: 'dashed',
  arrow_right: 'arrow_right',
  arrow_left: 'arrow_left',
  arrow_both: 'arrow_both',
});

export const sizeStyle = enumOf({
  auto: 'auto',
  tiny: 'tiny',
  small: 'small',
  normal: 'normal',
  large: 'large',
  huge: 'huge',
});

export const positionStyle = enumOf({
  top_left: 'top_left',
  top_center: 'top_center',
  top_right: 'top_right',
  middle_left: 'middle_left',
  middle_center: 'middle_center',
  middle_right: 'middle_right',
  bottom_left: 'bottom_left',
  bottom_center: 'bottom_center',
  bottom_right: 'bottom_right',
});

export const textStyle = enumOf({
  none: 'none',
  left: 'left',
  center: 'center',
  right: 'right',
  upper_left: 'upper_left',
  upper_center: 'upper_center',
  upper_right: 'upper_right',
  lower_left: 'lower_left',
  lower_center: 'lower_center',
  lower_right: 'lower_right',
});

export const extendStyle = enumOf({
  none: 'none',
  left: 'left',
  right: 'right',
  both: 'both',
});

export const xlocStyle = enumOf({ bar_index: 'bar_index', bar_time: 'bar_time' });
export const ylocStyle = enumOf({ price: 'price', abovebar: 'abovebar', belowbar: 'belowbar' });
export const displayStyle = enumOf({
  none: 0,
  all: 1,
  data_window: 2,
  pane: 3,
  price_scale: 4,
});
export const scaleStyle = enumOf({ none: 0, right: 1, left: 2, no_scale: 3 });
export const barmergeGaps = enumOf({ gaps_off: 'gaps_off', gaps_on: 'gaps_on' });
export const barmergeLookahead = enumOf({
  lookahead_off: 'lookahead_off',
  lookahead_on: 'lookahead_on',
});
export const currencyStyle = enumOf({
  NONE: 'NONE',
  USD: 'USD',
  EUR: 'EUR',
  GBP: 'GBP',
  JPY: 'JPY',
  AUD: 'AUD',
  CAD: 'CAD',
  CHF: 'CHF',
  CNY: 'CNY',
  INR: 'INR',
  BTC: 'BTC',
  ETH: 'ETH',
});
export const orderStyle = enumOf({ market: 'market', limit: 'limit', stop: 'stop', stop_limit: 'stop_limit' });
export const directionStyle = enumOf({ long: 'long', short: 'short' });
export const alertFreqStyle = enumOf({
  once_per_bar: 'once_per_bar',
  once_per_bar_close: 'once_per_bar_close',
  alert_once: 'alert_once',
});
export const mathNamespaceExtras = {
  pi: Math.PI,
  e: Math.E,
  phi: 1.618033988749895,
  rphi: 0.6180339887498949,
  maxint: 9007199254740991,
  minint: -9007199254740991,
  maxfloat: Number.MAX_VALUE,
  minfloat: Number.MIN_VALUE,
};

export function buildColorNamespace() {
  const ns = { __namespace: 'color' };
  for (const [name, hex] of Object.entries(NAMED_COLORS)) {
    ns[name] = new PineColor(hex.slice(1));
  }
  ns.new = (r, g, b, t) => new PineColor(hexFromRgb(r, g, b), t || 0);
  ns.rgb = (r, g, b, t) => new PineColor(hexFromRgb(r, g, b), t || 0);
  ns.from_gradient = (value, bottom, top, bottomColor, topColor) => {
    const v = Number(value);
    const bv = Number(bottom);
    const tv = Number(top);
    if (!Number.isFinite(v) || !Number.isFinite(bv) || !Number.isFinite(tv) || tv === bv) {
      return bottomColor instanceof PineColor ? bottomColor : makeColor(bottomColor);
    }
    const t = Math.max(0, Math.min(1, (v - bv) / (tv - bv)));
    const a = bottomColor instanceof PineColor ? bottomColor.rgb : makeColor(bottomColor).rgb;
    const b2 = topColor instanceof PineColor ? topColor.rgb : makeColor(topColor).rgb;
    const mix = {
      r: Math.round(a.r + (b2.r - a.r) * t),
      g: Math.round(a.g + (b2.g - a.g) * t),
      b: Math.round(a.b + (b2.b - a.b) * t),
    };
    return new PineColor(hexFromRgb(mix.r, mix.g, mix.b));
  };
  ns.t = (c, transparency) => makeColor(c, transparency);
  return ns;
}

export function hexFromRgb(r, g, b) {
  const cl = (x) => Math.max(0, Math.min(255, Math.round(Number(x) || 0)));
  return (
    cl(r).toString(16).padStart(2, '0') +
    cl(g).toString(16).padStart(2, '0') +
    cl(b).toString(16).padStart(2, '0')
  );
}

export const colorNamespace = buildColorNamespace();
export { NAMED_COLORS };
