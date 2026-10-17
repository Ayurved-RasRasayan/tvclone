// Test the specific patterns in the failing script
import { runPine } from '../public/js/pine/runtime.js';

const cases = [
  { name: 'bare input() call', src:
`//@version=6
indicator("test")
x = input(false, 'Color Candles', group="g")
plot(x ? 1 : 0)` },

  { name: 'input.string with options', src:
`//@version=6
indicator("test")
HISTORICAL = 'Historical'
PRESENT = 'Present'
x = input.string(HISTORICAL, 'Mode', options=[HISTORICAL, PRESENT])
plot(x == HISTORICAL ? 1 : 0)` },

  { name: 'f_ma with type param', src:
`//@version=6
indicator("test")
f_ma(src, len, type) =>
    switch type
        'EMA' => ta.ema(src, len)
        'SMA' => ta.sma(src, len)
plot(f_ma(close, 20, 'EMA'))` },

  { name: 'input.bool true literal as first arg', src:
`//@version=6
indicator("test")
x = input(true, 'name')
plot(x ? 1 : 0)` },

  { name: 'var color', src:
`//@version=6
indicator("test")
var color HIDE_COLOR = color.new(color.black, 100)
plot(close, color = HIDE_COLOR)` },

  { name: 'inline arg name group=', src:
`//@version=6
indicator("test")
GRP = "g"
x = input(false, 'Color', group=GRP)
plot(x ? 1 : 0)` },

  { name: 'inline arg with options array', src:
`//@version=6
indicator("test")
GRP = "g"
A = 'a'
B = 'b'
x = input.string(A, 'Mode', group=GRP, options=[A, B])
plot(x == A ? 1 : 0)` },
];

const bars = [];
for (let i = 0; i < 200; i++) {
  bars.push({ t: i * 86400000, o: 100, h: 102, l: 98, c: 101, v: 1000 });
}

for (const c of cases) {
  const r = runPine(c.src, { bars, host: { requestSecurity: () => null } });
  console.log(c.name + ': ' + (r.ok ? 'OK' : 'FAIL — ' + (r.error?.message || '?') + ' (line ' + (r.error?.line || '?') + ')'));
}
