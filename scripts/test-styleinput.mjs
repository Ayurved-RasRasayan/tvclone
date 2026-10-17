import { runPine } from '../public/js/pine/runtime.js';
const bars = [];
for (let i = 0; i < 100; i++) bars.push({ t: i * 86400000, o: 100, h: 102, l: 98, c: 101, v: 1000 });

const tests = [
  {
    name: 'simple var with input.string',
    src: `//@version=6
indicator("t")
COLORED = 'Colored'
MONOCHROME = 'Monochrome'
styleInput = input.string(COLORED, 'Style', options=[COLORED, MONOCHROME])
plot(styleInput == COLORED ? 1 : 0)`,
  },
  {
    name: 'var referencing earlier non-var decl',
    src: `//@version=6
indicator("t")
COLORED = 'Colored'
MONOCHROME = 'Monochrome'
styleInput = input.string(COLORED, 'Style')
var x = styleInput == MONOCHROME ? 1 : 2
plot(x)`,
  },
  {
    name: 'simple bare input.string assignment',
    src: `//@version=6
indicator("t")
GRP = 'g'
x = input.string('C', 'Style', group=GRP)
plot(x == 'C' ? 1 : 0)`,
  },
];

for (const t of tests) {
  const r = runPine(t.src, { bars, host: { requestSecurity: () => null } });
  console.log(t.name + ': ' + (r.ok ? 'OK' : 'FAIL — ' + (r.error?.message || '?') + ' (line ' + (r.error?.line || '?') + ')'));
}
