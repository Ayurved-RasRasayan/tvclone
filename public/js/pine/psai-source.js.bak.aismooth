export const PSAI_SOURCE = `//@version=6
indicator("Linreg Debug", overlay=false)

len = 20

linreg0 = ta.linreg(close, len, 0)
linreg1 = ta.linreg(close, len, 1)
slope   = linreg0 - linreg1

plot(close,        color=#ff0000, linewidth=2, title="Close")
plot(linreg0,      color=#00ff00, linewidth=2, title="Linreg0")
plot(linreg1,      color=#0000ff, linewidth=2, title="Linreg1")
plot(slope * 500,  color=#ffff00, linewidth=1, title="Slope500")`;
