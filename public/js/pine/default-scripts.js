export const DEFAULT_INDICATOR_SOURCE = `// This Pine Script™ code is subject to the terms of the Mozilla Public License 2.0 at https://mozilla.org/MPL/2.0/
// © BackQuant

//@version=5
indicator(
 title = "Normalised T3 Oscillator [BackQuant]", 
 shorttitle = "Normalised T3 [BackQuant]", 
 overlay = false, 
 timeframe = "", 
 timeframe_gaps = true
 )

import TradingView/ta/7 as ta

// Define User Inputs
simple int len           =    input.int(2, "T3 Calculation Period", group = "Calculation", inline = "1")
series float source      =    input.source(close, "Calculation Source", group = "Calculation", inline = "1")
simple float vf          =    input.float(0.7, "T3 Volume Factor", group = "Calculation", inline = "2")
simple int norm_period   =    input.int(title='Normalisation Period', defval=50, minval=1, group = "Calculation", inline = "2")
simple bool showosc      =    input.bool(true, "Show Oscillator?", group = "Signals")
simple bool showma       =    input.bool(true, "Show Oscillator Moving Average", group = "Signals", tooltip = "If you are going to use the moving average as the signal line, go onto the style menu and change the moving average line into columns")
string matype            =    input.string("SMA", title = "Moving Average Type", options=["SMA","EMA","DEMA","TEMA","RMA","WMA","HMA","T3","ALMA","LINREG","VWMA"], group = "Signals")
simple int malen         =    input.int(18, "MA Period", group = "Signals")
simple bool paintCandles =    input.bool(false, "Paint Candles according to Trend?", group = "UI Settings")
simple bool showstatic   =    input.bool(true, "Show Static Levels?", group = "UI Settings")

// Call put T3
subject = ta.t3(source, len, vf)
// Normalisation Calculation
lowest = ta.lowest(subject, norm_period)
highest = ta.highest(subject, norm_period)
plotosc = (subject - lowest) / (highest - lowest) - 0.50

f_ma(src, len, type) =>
    switch type 
        "SMA"    => ta.sma(src, len)
        "EMA"    => ta.ema(src, len)
        "DEMA"   => ta.dema(src, len)
        "TEMA"   => ta.tema(src, len)
        "RMA"    => ta.rma(src, len)
        "WMA"    => ta.wma(src, len)
        "HMA"    => ta.hma(src, len)
        "T3"     => ta.t3(src, len, 0.7)
        "ALMA"   => ta.alma(src, len, 0, 0.6)
        "LINREG" => ta.linreg(src, len, 0)
        "VWMA"   => ta.vwma(src, len)
// Moving Average Out
sig_ma = f_ma(plotosc, malen, matype)

// Conditional Oscillator Plot Color
var plotcol = #1dcaff4d
if plotosc > 0 and plotosc<0.125
    plotcol := #1dcaff4d
if plotosc > 0 and plotosc>0.125
    plotcol := #1e9b254d
if plotosc > 0 and plotosc>0.25
    plotcol := #00ff003d
if plotosc > 0 and plotosc>0.4
    plotcol := #00ff0080
if plotosc > 0 and plotosc>0.49
    plotcol := #33ff00fc
if plotosc < 0 and plotosc>-0.125
    plotcol := #e651004d
if plotosc < 0 and plotosc<-.125
    plotcol := #7715154d
if plotosc < 0 and plotosc<-0.25
    plotcol := #ff00004d
if plotosc < 0 and plotosc<-0.4
    plotcol := #ff000080
if plotosc < 0 and plotosc<-0.49
    plotcol := #ff0000

// Colouring
osbgcol          =       #00e6764d
obbgcol          =       #ff52524d
obcol            =       #ff0000fc
oscol            =       #00ff00fc 
midcol           =       #ffffff4d 

// Plotting
plot(showosc ? plotosc : na, 'T3 Normalised', plotcol, 2, plot.style_columns)
plot(showma ? sig_ma : na, "Moving Average", color = color.white)
obupper = plot(showstatic ? 0.5 : na, "+", obcol )
osupper = plot(showstatic ? -0.4 : na, "-", oscol)
oblower = plot(showstatic ? 0.4 : na, "+", obcol )
oslower = plot(showstatic ? -0.5 : na, "-", oscol)
fill(obupper, oblower, #7715154d, 'OB Fill')
fill(osupper, oslower, #1e9b254d, 'OS Fill')
midline = hline(0, "0 Line", midcol, hline.style_solid)

// Bar Colour
var barColour = #ffffff
if plotosc > 0 
    barColour := #00ff00
else if plotosc < 0
    barColour := #ff0000

// barcolor
barcolor(paintCandles ? barColour : na)
`;
export const DEFAULT_INDICATOR_NAME = "Normalised T3 [BackQuant]";
