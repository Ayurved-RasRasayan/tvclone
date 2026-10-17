/**
 * Pine Script editor: syntax highlighting, gutter, error reporting,
 * script library and template gallery.
 */
import { $, el, icon, openModal, store, toast, escapeHtml, showContextMenu } from './ui.js';

const KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'to', 'by', 'in', 'var', 'varip', 'and', 'or', 'not',
  'true', 'false', 'na', 'break', 'continue', 'switch', 'import', 'export', 'type', 'enum', 'method',
]);

const TYPE_WORDS = new Set([
  'int', 'float', 'bool', 'string', 'color', 'line', 'label', 'box', 'table', 'array',
  'matrix', 'map', 'series', 'simple', 'const', 'input', 'void',
]);

const NAMESPACES = new Set([
  'ta', 'math', 'str', 'array', 'matrix', 'map', 'request', 'input', 'color', 'label',
  'line', 'box', 'table', 'strategy', 'timeframe', 'syminfo', 'barstate', 'alert',
  'shape', 'size', 'position', 'location', 'extend', 'xloc', 'yloc', 'display', 'format',
  'scale', 'currency', 'order', 'direction', 'plot', 'session', 'dayofweek',
]);

const BUILTINS = new Set([
  'plot', 'plotshape', 'plotchar', 'plotarrow', 'plotcandle', 'plotbar', 'hline', 'fill',
  'bgcolor', 'barcolor', 'alertcondition', 'alert', 'indicator', 'strategy', 'library',
  'nz', 'fixnan', 'tostring', 'tonumber', 'timestamp', 'time', 'time_close', 'year', 'month',
  'dayofmonth', 'dayofweek', 'hour', 'minute', 'second', 'weekofyear', 'max_bars_back',
  'runtime', 'color', 'na',
]);

const TEMPLATES = [
  {
    name: 'PSAI — Pro Scalper AI',
    description: 'Pro Scalper AI indicator with DI/ADX trend, momentum (Stoch RSI/Fisher/Williams), TDI, OBV volume, dynamic weighting, AI forecast, latched signals, and visualisation.',
    source: `//@version=6
indicator("PSAI \u2014 Pro Scalper AI", overlay=false)

// HELPER FUNCTIONS
f_nr(src) => barstate.isconfirmed ? src : nz(src[1])
f_tanh(x) =>
    e2x = math.exp(2.0 * x)
    (e2x - 1.0) / (e2x + 1.0)
f_hma(src, length) =>
    wma1 = ta.wma(src, length)
    wma2 = ta.wma(src, math.round(length / 2))
    ta.wma(2 * wma2 - wma1, math.round(math.sqrt(length)))
f_create_label(id, y_pos, col, txt, tooltip_text) =>
    ret_id = id
    if barstate.islast
        label.delete(id)
        ret_id := label.new(bar_index + 10, y_pos, txt, style=label.style_label_left, color=color.new(col, 50), textcolor=color.white, size=size.small, tooltip=tooltip_text, xloc=xloc.bar_index)
    ret_id

// CONFIRMED OHLCV
cOpen   = f_nr(open)
cHigh   = f_nr(high)
cLow    = f_nr(low)
cClose  = f_nr(close)
cVolume = f_nr(volume)
f_tr(_h, _l, _c) => math.max(_h - _l, math.abs(_h - nz(_c[1])), math.abs(_l - nz(_c[1])))
sharedTR = f_tr(cHigh, cLow, cClose)

// PSAI SETTINGS
grp_psai = "====================PSAI Settings===================="
useHTF_sfds          = input.bool(false,  "Use Higher Timeframe Trend Filter?", inline="HTF", group=grp_psai)
htf_tf_sfds          = input.timeframe("15", "HTF",                             inline="HTF", group=grp_psai)
adxLen_sfds  = input.int(14, "ADX Length", group=grp_psai)
diLen_sfds   = input.int(14, "DI Length",  group=grp_psai)
atrLen_sfds  = input.int(14, "ATR Length", group=grp_psai)
hmaLen_sfds  = input.int(21, "HMA Length", group=grp_psai)
momChoice_sfds   = input.string("Stochastic RSI", "Momentum Mode", options=["Stochastic RSI","Fisher RSI","Williams %R"], group=grp_psai)
stochRsiLen_sfds = input.int(12, "Stoch RSI Length",       group="Stoch RSI")
stochKLen_sfds   = input.int(3,  "Stoch RSI %K Smoothing", group="Stoch RSI")
stochDLen_sfds   = input.int(3,  "Stoch RSI %D Smoothing", group="Stoch RSI")
fisherRsiLen_sfds= input.int(14, "Fisher RSI Length",      group="Fisher RSI")
wprLen_sfds      = input.int(14, "Williams %R Length",     group="Williams %R")
tdiRsiLen_sfds    = input.int(13, "TDI RSI Length",    group=grp_psai)
tdiSignalLen_sfds = input.int(7,  "TDI Signal Length", group=grp_psai)
wTrend_sfds      = input.float(0.3,  "Trend Weight",              step=0.1, group=grp_psai)
wMomentum_sfds   = input.float(0.3,  "Momentum Weight",           step=0.1, group=grp_psai)
wVolatility_sfds = input.float(0.2,  "Volatility Weight",         step=0.1, group=grp_psai)
wVolume_sfds     = input.float(0.2,  "Volume Weight",             step=0.1, group=grp_psai)
baseUpper_sfds   = input.float(25.0, "Base Upper Threshold",      step=0.1, group=grp_psai)
baseLower_sfds   = input.float(-25.0,"Base Lower Threshold",      step=0.1, group=grp_psai)
dynMultiplier    = input.float(0.5,  "Dynamic Threshold Mult.",   step=0.1, group=grp_psai)
oscLookback_sfds = input.int(50,     "Oscillator Std Dev Lookback",          group=grp_psai)
useDynamicW_sfds   = input.bool(true,  "Use Dynamic Weighting?",    group=grp_psai)
maxVolFactor_sfds  = input.float(2.0,  "Max Volatility Factor",     step=0.1, group=grp_psai)
maxTrendFactor_sfds= input.float(1.5,  "Max Trend Factor",          step=0.1, group=grp_psai)
volLookback_sfds   = input.int(50,     "Volume Lookback",            group=grp_psai)
useAI_sfds        = input.bool(true,  "Use AI Forecast?",           group=grp_psai)
ai_length_sfds    = input.int(20,     "AI Length", minval=1,         group=grp_psai)
ai_future_sfds    = input.int(2,      "AI Forecast Bars Ahead", minval=1, group=grp_psai)
aiAdjustment_sfds = input.float(1.5,  "AI Threshold Shift",         step=0.1, group=grp_psai)
aiSmoothing_sfds  = input.bool(true,  "Smooth AI Forecast?",        group=grp_psai)
useLatching_sfds  = input.bool(true,  "Enable Latching?",           group=grp_psai)
visualLowerRange_sfds = input.float(2700, "Visual Lower Range", minval=-10000, group="Visual Range Settings")
visualUpperRange_sfds = input.float(3700, "Visual Upper Range", minval=-10000, group="Visual Range Settings")

// DI / ADX
f_dirmov(len) =>
    up   = ta.change(cHigh)
    down = -ta.change(cLow)
    plusDM  = na(up)   ? na : (up > down   and up   > 0 ? up   : 0)
    minusDM = na(down) ? na : (down > up   and down > 0 ? down : 0)
    truerange = ta.rma(sharedTR, len)
    plusVal   = nz(100 * ta.rma(plusDM,  len) / truerange)
    minusVal  = nz(100 * ta.rma(minusDM, len) / truerange)
    [plusVal, minusVal]
[diplus, diminus] = f_dirmov(diLen_sfds)
adxVal    = 100 * ta.rma(math.abs(diplus - diminus) / math.max(diplus + diminus, 1), adxLen_sfds)
trendDir  = diplus > diminus ? 1.0 : diminus > diplus ? -1.0 : 0.0
normTrend = trendDir * math.min(math.max((adxVal - 20) / 20, 0.0), 1.0)
confirmedADX       = f_nr(adxVal)
confirmedNormTrend = f_nr(normTrend)

// ATR / Volatility
atrVal  = ta.rma(sharedTR, atrLen_sfds)
normATR = atrVal / cClose
confirmedNormVolatility = f_nr(normATR * 2 - 1)

// Momentum
f_stochRsi(len, k, d) =>
    rsi  = ta.rsi(cClose, len)
    lo   = ta.lowest(rsi, len)
    hi   = ta.highest(rsi, len)
    K    = ta.sma((rsi - lo) / math.max(hi - lo, 0.0001), k)
    (K - 0.5) * 2
f_fisherRsi(len) =>
    rsi      = ta.rsi(cClose, len)
    norm     = (rsi / 100.0) * 2 - 1
    clipped  = math.max(math.min(norm, 0.999), -0.999)
    f_tanh(0.5 * math.log((1 + clipped) / (1 - clipped)))
f_wpr(len) =>
    hh = ta.highest(cHigh, len)
    ll = ta.lowest(cLow, len)
    ((hh - cClose) / math.max(hh - ll, 0.0001) * -100 + 50) / 50 - 1
momentumVal = switch momChoice_sfds
    "Stochastic RSI" => f_stochRsi(stochRsiLen_sfds, stochKLen_sfds, stochDLen_sfds)
    "Fisher RSI"     => f_fisherRsi(fisherRsiLen_sfds)
    "Williams %R"    => f_wpr(wprLen_sfds)
confirmedMomentum = f_nr(momentumVal)

// TDI
confirmedTdiRsi    = f_nr(ta.rsi(cClose, tdiRsiLen_sfds))
confirmedTdiSignal = f_nr(ta.ema(confirmedTdiRsi, tdiSignalLen_sfds))

// OBV / Volume
var float obvVal = 0.0
obvVal := nz(obvVal[1]) + (cClose > cClose[1] ? cVolume : cClose < cClose[1] ? -cVolume : 0)
obvMin = ta.lowest(obvVal, volLookback_sfds)
obvMax = ta.highest(obvVal, volLookback_sfds)
confirmedVolumeNorm = f_nr(((obvVal - obvMin) / math.max(obvMax - obvMin, 0.0001)) * 2 - 1)

// Dynamic Weighting
volFactor   = useDynamicW_sfds ? math.min(normATR / 0.005, maxVolFactor_sfds)  : 1.0
trendFactor = useDynamicW_sfds ? math.min(adxVal  / 25.0,  maxTrendFactor_sfds): 1.0
effWTrend      = wTrend_sfds      * trendFactor
effWVolatility = wVolatility_sfds * volFactor
totalWeight    = effWTrend + wMomentum_sfds + effWVolatility + wVolume_sfds
oscillator = (effWTrend * confirmedNormTrend + wMomentum_sfds * confirmedMomentum + effWVolatility * confirmedNormVolatility + wVolume_sfds * confirmedVolumeNorm) / totalWeight * 100
confirmedOscillator = f_nr(oscillator)
oscStd          = ta.stdev(confirmedOscillator, oscLookback_sfds)
upperThreshold  = baseUpper_sfds + oscStd * dynMultiplier
lowerThreshold  = baseLower_sfds - oscStd * dynMultiplier
confirmedUT     = f_nr(upperThreshold)
confirmedLT     = f_nr(lowerThreshold)

// AI Forecast
var float aiBias = 0.0
if useAI_sfds
    aiVal     = ta.linreg(cClose, ai_length_sfds, 0)
    aiSlope   = aiVal - ta.linreg(cClose, ai_length_sfds, 1)
    aiPred    = aiSmoothing_sfds ? ta.sma(aiVal + aiSlope * ai_future_sfds, 2) : aiVal + aiSlope * ai_future_sfds
    oscLo     = ta.lowest(confirmedOscillator, ai_length_sfds)
    oscHi     = ta.highest(confirmedOscillator, ai_length_sfds)
    aiLo      = ta.lowest(aiPred, ai_length_sfds)
    aiHi      = ta.highest(aiPred, ai_length_sfds)
    oscRange  = math.max(oscHi - oscLo, 0.001)
    aiRange   = math.max(aiHi - aiLo,  0.001)
    aiOsc     = ((aiPred - aiLo) / aiRange) * oscRange + oscLo
    aiBias   := aiOsc - (baseUpper_sfds + baseLower_sfds) / 2
confirmedAiBias = f_nr(aiBias)
adjUT = useAI_sfds ? confirmedUT + (confirmedAiBias > 0 ?  aiAdjustment_sfds : 0) : confirmedUT
adjLT = useAI_sfds ? confirmedLT + (confirmedAiBias < 0 ? -aiAdjustment_sfds : 0) : confirmedLT
confirmedAdjUT = f_nr(adjUT)
confirmedAdjLT = f_nr(adjLT)

// HMA Trend
localHMA       = f_hma(cClose, hmaLen_sfds)
trendHMA       = cClose > localHMA ? 1.0 : cClose < localHMA ? -1.0 : 0.0
confirmedTrendHMA = f_nr(trendHMA)
htfTrend = 0.0
if useHTF_sfds
    htfHMA   = request.security(syminfo.tickerid, htf_tf_sfds, f_hma(cClose, hmaLen_sfds), lookahead=barmerge.lookahead_off)
    htfTrend := na(htfHMA) ? 0.0 : cClose > htfHMA ? 1.0 : cClose < htfHMA ? -1.0 : 0.0
confirmedHTFTrend = f_nr(htfTrend)

// Signal Generation
condSBuy  = confirmedOscillator > confirmedAdjUT and confirmedTrendHMA > 0 and (not useHTF_sfds or confirmedHTFTrend > 0) and confirmedADX > 20
condSSell = confirmedOscillator < confirmedAdjLT and confirmedTrendHMA < 0 and (not useHTF_sfds or confirmedHTFTrend < 0) and confirmedADX > 20
condEBuy  = confirmedOscillator > baseUpper_sfds  and confirmedOscillator < confirmedAdjUT
condESell = confirmedOscillator < baseLower_sfds  and confirmedOscillator > confirmedAdjLT
immSig = condSBuy ? "S.Buy" : condSSell ? "S.Sel" : condEBuy ? "E.Buy" : condESell ? "E.Sel" : "None"
var string storedState = "Neut"
if useLatching_sfds and barstate.isconfirmed
    if storedState == "Neut"
        storedState := condEBuy ? "EBuy" : condESell ? "ESel" : condSBuy ? "Long" : condSSell ? "Shrt" : storedState
    else if storedState == "EBuy"
        storedState := condSBuy ? "Long" : not condEBuy ? "Neut" : storedState
    else if storedState == "Long"
        storedState := condSSell ? "Shrt" : condESell ? "ESel" : storedState
    else if storedState == "ESel"
        storedState := condSSell ? "Shrt" : not condESell ? "Neut" : storedState
    else if storedState == "Shrt"
        storedState := condSBuy ? "Long" : condEBuy ? "EBuy" : storedState
storedSig = storedState == "Long" ? "S.Buy" : storedState == "Shrt" ? "S.Sel" : storedState == "EBuy" ? "E.Buy" : storedState == "ESel" ? "E.Sel" : "None"

// Visualisation
visualCenter  = (visualLowerRange_sfds + visualUpperRange_sfds) / 2
visualSpan    = visualUpperRange_sfds - visualLowerRange_sfds
vizScale      = visualSpan / 100
signalBuyY    = visualLowerRange_sfds - 40
signalSellY   = visualUpperRange_sfds + 40
map_to_pane(val) => visualCenter + val * vizScale
mappedOsc    = map_to_pane(confirmedOscillator)
mappedUpper  = map_to_pane(confirmedUT)
mappedLower  = map_to_pane(confirmedLT)
mappedZero   = map_to_pane(0)
mappedAiBias = map_to_pane(confirmedAiBias)
plotOsc    = plot(mappedOsc,   color=mappedOsc >= visualCenter ? color.green : color.red, linewidth=2, title="Composite Oscillator")
plotZero   = plot(mappedZero, color=color.gray,   title="Zero Line")
plotUpper  = plot(mappedUpper, color=color.purple, linewidth=1, title="Dynamic Upper Threshold")
plotLower  = plot(mappedLower, color=color.purple, linewidth=1, title="Dynamic Lower Threshold")
activeSig  = useLatching_sfds ? storedSig : immSig
fillColor  = activeSig == "S.Buy" ? color.new(color.green,  80) : activeSig == "S.Sel" ? color.new(color.red,    80) : activeSig == "E.Buy" ? color.new(color.lime,   80) : activeSig == "E.Sel" ? color.new(color.maroon, 80) : color.new(color.blue, 90)
fill(plotUpper, plotLower, color=fillColor, title="Band Background")
plotshape(useLatching_sfds and storedState == "Long" ? signalBuyY  : na, style=shape.triangleup,   color=color.green,  title="Latched Strong Buy",  location=location.absolute, size=size.tiny)
plotshape(useLatching_sfds and storedState == "Shrt" ? signalSellY : na, style=shape.triangledown, color=color.red,    title="Latched Strong Sell", location=location.absolute, size=size.tiny)
plotshape(useLatching_sfds and storedState == "EBuy" ? signalBuyY  : na, style=shape.diamond,      color=color.lime,   title="Latched Early Buy",   location=location.absolute, size=size.tiny)
plotshape(useLatching_sfds and storedState == "ESel" ? signalSellY : na, style=shape.diamond,      color=color.maroon, title="Latched Early Sell",  location=location.absolute, size=size.tiny)
plot(useAI_sfds ? mappedAiBias : na, color=color.blue, title="AI Bias")
var label psai_lab = na
psai_lab := f_create_label(psai_lab, visualUpperRange_sfds + 20, color.purple, "PSAI (" + timeframe.period + ")", "Pro Scalper AI - Chart Timeframe")
`,
  },
  {
    name: 'EMA 10/20/200',
    description: 'Three exponential moving averages (10, 20, 200 periods) overlaid on the price chart.',
    source: `//@version=5
indicator("EMA 10/20/200", overlay=true)

ema10  = ta.ema(close, 10)
ema20  = ta.ema(close, 20)
ema200 = ta.ema(close, 200)

plot(ema10,  "EMA 10",  color = #00ff00, linewidth = 1)
plot(ema20,  "EMA 20",  color = #ff0000, linewidth = 1)
plot(ema200, "EMA 200", color = #ffffff, linewidth = 2)
`,
  },
  {
    name: 'Normalised T3 Oscillator [BackQuant]',
    description: 'Normalised Tillson T3 oscillator with overbought/oversold zones, signal MA, and candle coloring.',
    source: `// This Pine Script\u2122 code is subject to the terms of the Mozilla Public License 2.0 at https://mozilla.org/MPL/2.0/
// \u00a9 BackQuant

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
`,
  },
  {
    name: 'Pine v6 Starter (UDT + enum + method)',
    description: 'A v6 indicator using user-defined types, enum, methods, ta.supertrend, and the chart.* namespace.',
    source: `//@version=6
indicator("Pine v6 Starter", overlay = true, dynamic_requests = true)

// User-defined type with a field-accessor method.
type Swing
    float hi = 0.0
    float lo = 0.0
    float span() => hi - lo

enum Side
    LONG  = 1
    SHORT = -1

// Supertrend gives us a [value, direction] tuple.
[st, dir] = ta.supertrend(3, 10)
plot(st, color = dir == 1 ? color.green : color.red, linewidth = 2, title = "Supertrend")

// DMI gives us [DI+, DI-, ADX].
[plus, minus, adx] = ta.dmi(14, 14)
plot(adx, color = color.orange, title = "ADX")

// UDT usage with method call.
var Swing s = Swing.new(high, low)
plot(s.span(), color = color.aqua, title = "Swing span")

// Enum access for color coding.
trendColor = dir == 1 ? Side.LONG : Side.SHORT
bgcolor(trendColor == Side.LONG ? color.new(color.green, 92) : color.new(color.red, 92))

// chart.* context accessors.
if barstate.islast
    label.new(chart.right_visible_bar_index - 1, high, text = "Last", style = label.style_label_down)
`,
  },
  {
    name: 'Moving Average Ribbon',
    description: 'Multiple EMAs with a gradient fill between the extremes.',
    source: `//@version=5
indicator("MA Ribbon", overlay = true)

fastLen = input.int(8,  title = "Fast length", minval = 1)
midLen  = input.int(21, title = "Mid length",  minval = 1)
slowLen = input.int(55, title = "Slow length", minval = 1)

fast = ta.ema(close, fastLen)
mid  = ta.ema(close, midLen)
slow = ta.ema(close, slowLen)

up = fast > slow

p1 = plot(fast, "Fast", color = up ? color.new(color.teal, 0) : color.new(color.red, 0), linewidth = 2)
plot(mid, "Mid", color = color.new(color.orange, 0), linewidth = 2)
p3 = plot(slow, "Slow", color = color.new(color.blue, 0), linewidth = 2)

fill(p1, p3, color = up ? color.new(color.teal, 88) : color.new(color.red, 88), title = "Ribbon")

plotshape(ta.crossover(fast, slow),  "Bull cross", shape.triangleup,   location.belowbar, color.green, size = size.small)
plotshape(ta.crossunder(fast, slow), "Bear cross", shape.triangledown, location.abovebar, color.red,   size = size.small)
`,
  },
  {
    name: 'RSI with Divergence Zones',
    description: 'RSI in its own pane with overbought / oversold bands and background shading.',
    source: `//@version=5
indicator("RSI Bands", overlay = false)

len      = input.int(14,   "RSI length",    minval = 2)
obLevel  = input.float(70, "Overbought",    minval = 50, maxval = 100)
osLevel  = input.float(30, "Oversold",      minval = 0,  maxval = 50)
src      = input.source(close, "Source")

r = ta.rsi(src, len)

plot(r, "RSI", color = color.new(color.purple, 0), linewidth = 2)
hline(50, "Midline", color = color.new(color.gray, 40), linestyle = hline.style_dotted)
h1 = hline(obLevel, "Overbought", color = color.new(color.red, 0))
h2 = hline(osLevel, "Oversold",   color = color.new(color.green, 0))
fill(h1, h2, color = color.new(color.blue, 94), title = "Channel")

bgcolor(r > obLevel ? color.new(color.red, 88)  : na, title = "OB shade")
bgcolor(r < osLevel ? color.new(color.green, 88) : na, title = "OS shade")

alertcondition(ta.crossunder(r, osLevel), "RSI exits oversold", "RSI crossed back above oversold")
alertcondition(ta.crossover(r, obLevel),  "RSI exits overbought", "RSI crossed back below overbought")
`,
  },
  {
    name: 'MACD + Signals',
    description: 'Classic MACD with histogram colouring and cross alerts.',
    source: `//@version=5
indicator("MACD Signals", overlay = false)

fastLen   = input.int(12, "Fast length")
slowLen   = input.int(26, "Slow length")
signalLen = input.int(9,  "Signal length")

[macdLine, signalLine, histLine] = ta.macd(close, fastLen, slowLen, signalLen)

plot(macdLine,   "MACD",   color = color.new(color.blue, 0),   linewidth = 2)
plot(signalLine, "Signal", color = color.new(color.orange, 0), linewidth = 2)

plot(histLine, "Histogram", style = plot.style_columns,
     color = histLine >= 0 ? color.new(color.green, 30) : color.new(color.red, 30))

hline(0, "Zero", color = color.new(color.gray, 50))

bullCross = ta.crossover(macdLine, signalLine)
bearCross = ta.crossunder(macdLine, signalLine)

plotshape(bullCross, "Buy",  shape.labelup,   location.bottom, color.green, text = "BUY",  textcolor = color.white, size = size.tiny)
plotshape(bearCross, "Sell", shape.labeldown, location.top,    color.red,   text = "SELL", textcolor = color.white, size = size.tiny)

alertcondition(bullCross, "MACD bullish cross", "MACD crossed above its signal line")
alertcondition(bearCross, "MACD bearish cross", "MACD crossed below its signal line")
`,
  },
  {
    name: 'Bollinger Breakout Strategy',
    description: 'Full strategy with entries, exits, stop loss and take profit. Try it in the Strategy Tester tab.',
    source: `//@version=5
strategy("Bollinger Breakout", overlay = true, initial_capital = 100000,
         default_qty_type = strategy.percent_of_equity, default_qty_value = 25)

len    = input.int(20,    "BB length",    minval = 2)
mult   = input.float(2.0, "BB multiplier", minval = 0.5, step = 0.1)
slPct  = input.float(4.0, "Stop loss %",  minval = 0.1, step = 0.1)
tpPct  = input.float(8.0, "Take profit %", minval = 0.1, step = 0.1)

[upper, basis, lower] = ta.bb(close, len, mult)

pU = plot(upper, "Upper", color = color.new(color.gray, 40))
plot(basis, "Basis", color = color.new(color.orange, 0))
pL = plot(lower, "Lower", color = color.new(color.gray, 40))
fill(pU, pL, color = color.new(color.blue, 95))

longCondition  = ta.crossover(close, upper)
shortCondition = ta.crossunder(close, lower)

if longCondition
    strategy.entry("Long", strategy.long)
    strategy.exit("Long exit", from_entry = "Long",
         stop = close * (1 - slPct / 100), limit = close * (1 + tpPct / 100))

if shortCondition
    strategy.entry("Short", strategy.short)
    strategy.exit("Short exit", from_entry = "Short",
         stop = close * (1 + slPct / 100), limit = close * (1 - tpPct / 100))

plotshape(longCondition,  "Long",  shape.triangleup,   location.belowbar, color.green, size = size.small)
plotshape(shortCondition, "Short", shape.triangledown, location.abovebar, color.red,   size = size.small)
`,
  },
  {
    name: 'Multi-Timeframe Trend Filter',
    description: 'Uses request.security() to compare the daily trend against the current chart.',
    source: `//@version=5
indicator("MTF Trend Filter", overlay = true)

htf      = input.timeframe("1D", "Higher timeframe")
len      = input.int(50, "HTF MA length", minval = 2)
showFill = input.bool(true, "Shade trend")

htfClose = request.security(syminfo.tickerid, htf, close)
htfMa    = request.security(syminfo.tickerid, htf, ta.sma(close, len))

bull = htfClose > htfMa

plot(htfMa, "HTF MA", color = bull ? color.new(color.green, 0) : color.new(color.red, 0), linewidth = 3)

bgcolor(showFill ? (bull ? color.new(color.green, 93) : color.new(color.red, 93)) : na, title = "HTF bias")

var string labelText = na
if barstate.islast
    labelText := (bull ? "HTF BULLISH" : "HTF BEARISH") + "  |  " + htf + " MA " + str.tostring(htfMa, "#.##")
    label.new(bar_index, high, text = labelText, style = bull ? label.style_label_down : label.style_label_up,
              color = bull ? color.new(color.green, 15) : color.new(color.red, 15),
              textcolor = color.white, size = size.normal)
`,
  },
  {
    name: 'Volume Profile (POC)',
    description: 'Builds an intraday volume profile with the point of control marked.',
    source: `//@version=5
indicator("Volume Profile POC", overlay = true)

bins     = input.int(24, "Price bins", minval = 4, maxval = 100)
lookback = input.int(200, "Lookback bars", minval = 20)
anchor   = input.string("Day", "Reset", options = ["Day", "Week", "Month", "Session"])

var float[] edges = array.new_float()
var float[] vols  = array.new_float()

newPeriod = timeframe.change(anchor == "Week" ? "1W" : anchor == "Month" ? "1M" : "1D")

if newPeriod
    array.clear(edges)
    array.clear(vols)
    hi = ta.highest(high, lookback)
    lo = ta.lowest(low, lookback)
    if not na(hi) and not na(lo) and hi > lo
        step = (hi - lo) / bins
        for i = 0 to bins
            array.push(edges, lo + step * i)
            array.push(vols, 0.0)

if array.size(vols) > 0 and not na(close)
    hi = ta.highest(high, lookback)
    lo = ta.lowest(low, lookback)
    step = (hi - lo) / bins
    if step > 0
        idx = math.floor((close - lo) / step)
        if idx >= 0 and idx < array.size(vols)
            array.set(vols, idx, array.get(vols, idx) + volume)

maxVol = array.max(vols)
pocIdx = array.indexof(vols, maxVol)
poc = array.size(edges) > 0 and pocIdx >= 0 ? array.get(edges, pocIdx) + (ta.highest(high, lookback) - ta.lowest(low, lookback)) / bins / 2 : na

plot(poc, "POC", color = color.new(color.orange, 0), linewidth = 2, style = plot.style_linebr)

var label pocLabel = na
if barstate.islast and not na(poc)
    label.delete(pocLabel)
    pocLabel := label.new(bar_index, poc, text = "POC " + str.tostring(poc, "#.##"),
                          style = label.style_label_left, color = color.new(color.orange, 10),
                          textcolor = color.white)
`,
  },
];

export class PineEditor {
  constructor({ container, onRun, onSave }) {
    this.onRun = onRun;
    this.onSave = onSave;
    this.input = $('#editorInput');
    this.highlight = $('#editorHighlight');
    this.gutter = $('#editorGutter');
    this.scroll = $('#editorScroll');
    this.errors = $('#editorErrors');
    this.currentId = null;
    this.currentName = 'Untitled';
    this.dirty = false;
    this._bind();
    this._refresh();
  }

  _bind() {
    const ta = this.input;
    ta.addEventListener('input', () => {
      this.dirty = true;
      this._refresh();
    });
    ta.addEventListener('scroll', () => this._syncScroll());
    ta.addEventListener('keydown', (e) => this._onKeyDown(e));
    document.addEventListener('selectionchange', () => {
      if (document.activeElement === ta) this._syncCaretLine();
    });
    // Tab out of the textarea normally; insert spaces when it is focused.
    ta.addEventListener('blur', () => {
      if (this.dirty) this.autoSave();
    });
  }

  get value() {
    return this.input.value;
  }

  setValue(text, { name = null, id = null } = {}) {
    this.input.value = text;
    if (name) this.currentName = name;
    if (id !== undefined) this.currentId = id;
    this.dirty = false;
    this._refresh();
  }

  focus() {
    this.input.focus();
  }

  _onKeyDown(e) {
    const ta = this.input;
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      if (e.shiftKey) {
        // outdent the current line
        const lineStart = ta.value.lastIndexOf('\n', start - 1) + 1;
        if (ta.value.slice(lineStart, lineStart + 4) === '    ') {
          ta.value = ta.value.slice(0, lineStart) + ta.value.slice(lineStart + 4);
          ta.selectionStart = ta.selectionEnd = Math.max(lineStart, start - 4);
        }
      } else {
        ta.value = `${ta.value.slice(0, start)}    ${ta.value.slice(end)}`;
        ta.selectionStart = ta.selectionEnd = start + 4;
      }
      this.dirty = true;
      this._refresh();
      return;
    }
    if (e.key === 'Enter') {
      // Keep Pine's indentation and auto-indent after a block opener.
      const start = ta.selectionStart;
      const lineStart = ta.value.lastIndexOf('\n', start - 1) + 1;
      const line = ta.value.slice(lineStart, start);
      const indent = (line.match(/^[ \t]*/) || [''])[0];
      const opensBlock = /(=>|\bif\b.*|\belse\b|\bfor\b.*|\bwhile\b.*|\bswitch\b.*)$/.test(line.trimEnd());
      const extra = opensBlock ? '    ' : '';
      e.preventDefault();
      const insert = `\n${indent}${extra}`;
      ta.value = ta.value.slice(0, start) + insert + ta.value.slice(ta.selectionEnd);
      ta.selectionStart = ta.selectionEnd = start + insert.length;
      this.dirty = true;
      this._refresh();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      this.run();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      this.save();
    }
  }

  _syncScroll() {
    this.highlight.scrollTop = this.input.scrollTop;
    this.highlight.scrollLeft = this.input.scrollLeft;
    this.gutter.scrollTop = this.input.scrollTop;
  }

  _syncCaretLine() {
    const upto = this.input.value.slice(0, this.input.selectionStart);
    const line = upto.split('\n').length;
    [...this.gutter.children].forEach((n, i) => n.classList.toggle('active', i + 1 === line));
  }

  _refresh() {
    const text = this.input.value;
    this.highlight.innerHTML = highlightPine(text);
    const lines = text.split('\n').length;
    if (this.gutter.childElementCount !== lines) {
      const frag = document.createDocumentFragment();
      for (let i = 1; i <= lines; i++) frag.appendChild(el('div', { text: String(i) }));
      this.gutter.innerHTML = '';
      this.gutter.appendChild(frag);
      this.gutter.style.lineHeight = '18px';
    }
    // Grow the textarea to fit its content so the outer div scrolls.
    const contentHeight = lines * 18 + 16;
    this.input.style.height = `${Math.max(contentHeight, this.scroll.clientHeight)}px`;
    this.highlight.style.height = this.input.style.height;
    this._syncCaretLine();
  }

  setErrors(result) {
    this.errors.innerHTML = '';
    if (!result) return;
    if (result.ok) {
      const warn = result.warnings || [];
      this.errors.appendChild(
        el('div', { class: 'err-line ok', text: `✓ Compiled — ${result.outputs?.plots?.length ?? 0} plot(s), ${result.inputs?.length ?? 0} input(s)` })
      );
      for (const w of warn.slice(0, 8)) this.errors.appendChild(el('div', { class: 'err-line warn', text: `⚠ ${w}` }));
      for (const log of (result.outputs?.logs || []).slice(-6)) {
        this.errors.appendChild(el('div', { class: 'err-line', text: `log: ${log.message}` }));
      }
      return;
    }
    const err = result.error || {};
    const line = err.line ? `Line ${err.line}: ` : '';
    const node = el('div', { class: 'err-line', text: `${line}${err.message}` });
    if (err.line) {
      node.addEventListener('click', () => this.goToLine(err.line));
    }
    this.errors.appendChild(node);
  }

  goToLine(line) {
    const lines = this.input.value.split('\n');
    let pos = 0;
    for (let i = 0; i < Math.min(line - 1, lines.length - 1); i++) pos += lines[i].length + 1;
    this.input.focus();
    this.input.selectionStart = this.input.selectionEnd = pos;
    this.input.scrollTop = Math.max(0, (line - 6) * 18);
    this._syncScroll();
  }

  run() {
    const result = this.onRun?.(this.input.value, { name: this.currentName, id: this.currentId });
    this.setErrors(result);
    return result;
  }

  save() {
    const id = this.onSave?.(this.input.value, { name: this.currentName, id: this.currentId });
    if (id) {
      this.currentId = id;
      this.dirty = false;
    }
    return id;
  }

  autoSave() {
    if (!this.dirty) return;
    const saved = store.get('pine:autosave', null);
    if (saved === this.input.value) return;
    store.set('pine:autosave', this.input.value);
  }

  static templates() {
    return TEMPLATES;
  }
}

/* ------------------------------------------------------------------ *
 * Syntax highlighting
 * ------------------------------------------------------------------ */

export function highlightPine(source) {
  const out = [];
  let i = 0;
  const push = (cls, text) => out.push(cls ? `<span class="${cls}">${escapeHtml(text)}</span>` : escapeHtml(text));
  const n = source.length;
  while (i < n) {
    const c = source[i];

    // line comment
    if (c === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      push('tk-com', source.slice(i, stop));
      i = stop;
      continue;
    }

    // string
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      while (j < n && source[j] !== quote) {
        if (source[j] === '\\') j++;
        j++;
      }
      push('tk-str', source.slice(i, Math.min(j + 1, n)));
      i = j + 1;
      continue;
    }

    // colour literal
    if (c === '#') {
      const m = /^#[0-9a-fA-F]{6,8}/.exec(source.slice(i));
      if (m) {
        push('tk-color', m[0]);
        i += m[0].length;
        continue;
      }
      push(null, c);
      i++;
      continue;
    }

    // number
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(source[i + 1] || ''))) {
      const m = /^\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(source.slice(i));
      if (m) {
        push('tk-num', m[0]);
        i += m[0].length;
        continue;
      }
    }

    // identifier
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(source[j])) j++;
      const word = source.slice(i, j);
      if (KEYWORDS.has(word)) push('tk-kw', word);
      else if (TYPE_WORDS.has(word) && /[\s\[]/.test(source[j] || ' ')) push('tk-builtin', word);
      else if (NAMESPACES.has(word)) push('tk-ns', word);
      else if (BUILTINS.has(word)) push('tk-fn', word);
      // identifiers that will be called are functions
      else if (source[j] === '(') push('tk-fn', word);
      else push(null, word);
      i = j;
      continue;
    }

    if ('+-*/%<>=!?:,()[]{}'.includes(c)) {
      const m = /^(:=|==|!=|<=|>=|=>|->|[+\-*/%<>=!?:,()\[\]{}])/.exec(source.slice(i));
      push('tk-op', m ? m[0] : c);
      i += m ? m[0].length : 1;
      continue;
    }

    push(null, c);
    i++;
  }
  return out.join('');
}

/* ------------------------------------------------------------------ *
 * Script library UI
 * ------------------------------------------------------------------ */

export function renderScriptLibrary(container, { scripts, onLoad, onDelete, onRename, onExport }) {
  container.innerHTML = '';
  const header = el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px' } }, [
    el('strong', { text: 'Saved scripts' }),
    el('span', { style: { color: 'var(--text-dim)', fontSize: '11px' }, text: `${scripts.length} saved` }),
    el('span', { style: { flex: '1' } }),
  ]);
  container.appendChild(header);

  const list = el('div', { style: { display: 'grid', gap: '8px', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' } });
  for (const s of scripts) {
    const card = el('div', { class: 'stat-card', style: { cursor: 'pointer' } }, [
      el('div', { class: 's-label', text: s.name || 'Untitled' }),
      el('div', {
        style: { fontSize: '11px', color: 'var(--text-dim)', marginTop: '6px', maxHeight: '48px', overflow: 'hidden' },
        text: (s.source || '').split('\n').slice(0, 3).join('\n'),
      }),
      el('div', { style: { display: 'flex', gap: '6px', marginTop: '8px' } }, [
        el('button', {
          class: 'btn sm',
          text: 'Load',
          onclick: (e) => {
            e.stopPropagation();
            onLoad(s);
          },
        }),
        el('button', {
          class: 'btn sm',
          text: 'Chart',
          onclick: (e) => {
            e.stopPropagation();
            onLoad(s, true);
          },
        }),
        el('span', { style: { flex: '1' } }),
        el('button', {
          class: 'btn sm',
          text: 'Export',
          onclick: (e) => {
            e.stopPropagation();
            onExport?.(s);
          },
        }),
        el('button', {
          class: 'btn sm',
          text: 'Rename',
          onclick: (e) => {
            e.stopPropagation();
            onRename?.(s);
          },
        }),
        el('button', {
          class: 'btn sm',
          text: 'Delete',
          onclick: (e) => {
            e.stopPropagation();
            onDelete?.(s);
          },
        }),
      ]),
    ]);
    list.appendChild(card);
  }
  if (!scripts.length) {
    container.appendChild(el('div', { class: 'empty-note', text: 'No saved scripts yet. Write something in the editor and press Save.' }));
  }
  container.appendChild(list);

  container.appendChild(el('div', { style: { height: '1px', background: 'var(--border)', margin: '18px 0' } }));
  container.appendChild(el('strong', { text: 'Templates' }));
  const tpl = el('div', { style: { display: 'grid', gap: '8px', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', marginTop: '10px' } });
  for (const t of TEMPLATES) {
    tpl.appendChild(
      el('div', { class: 'stat-card' }, [
        el('div', { class: 's-label', text: t.name }),
        el('div', { style: { fontSize: '11px', color: 'var(--text-dim)', margin: '6px 0 8px' }, text: t.description }),
        el('button', { class: 'btn sm', text: 'Open in editor', onclick: () => onLoad({ name: t.name, source: t.source, id: null }, false) }),
      ])
    );
  }
  container.appendChild(tpl);
}

export function openTemplatesModal(onPick) {
  const body = el('div', { style: { display: 'grid', gap: '10px' } });
  for (const t of TEMPLATES) {
    body.appendChild(
      el('div', { class: 'stat-card', style: { cursor: 'pointer' }, onclick: () => { onPick(t); close(); } }, [
        el('div', { class: 's-label', text: t.name }),
        el('div', { style: { fontSize: '11px', color: 'var(--text-dim)', marginTop: '5px' }, text: t.description }),
      ])
    );
  }
  const { close } = openModal({ title: 'Pine Script templates', body, minWidth: '420px' });
}

export function renderErrorList(container, result) {
  container.innerHTML = '';
  if (!result) return;
  if (result.ok) {
    container.appendChild(el('div', { class: 'err-line ok', text: '✓ No errors' }));
    return;
  }
  container.appendChild(el('div', { class: 'err-line', text: result.error?.message || 'Unknown error' }));
}

export { TEMPLATES };
