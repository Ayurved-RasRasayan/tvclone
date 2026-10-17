import { runPine } from '../public/js/pine/runtime.js';
const bars = [];
for (let i = 0; i < 100; i++) bars.push({ t: i * 86400000, o: 100, h: 102, l: 98, c: 101, v: 1000 });

const r = runPine(`//@version=6
indicator("t", overlay=true)
var line myLine = line.new(na, na, na, na, color=color.red)
myLine.set_first_point(chart.point.new(time, bar_index, high))
myLine.set_second_point(chart.point.new(time, bar_index, low))
plot(close)`, { bars, host: { requestSecurity: () => null } });
console.log('ok:', r.ok);
if (!r.ok) console.log('error:', JSON.stringify(r.error, null, 2));
else {
  console.log('lines:', r.outputs.lines.length);
  console.log('plots:', r.outputs.plots.length);
}
