# tvclone

A full-featured TradingView-style charting platform that runs locally and pulls
real market data from Yahoo Finance. It ships its own **Pine Script engine**, so
you can write non-trivial indicators and strategies rather than picking from a
fixed list.

```
npm start          # http://127.0.0.1:8787
npm test           # run every test suite
```

No dependencies, no build step. Node 18+ and a browser are all you need.

---

## Quick start

```powershell
cd tvclone
npm start
```

Then open <http://127.0.0.1:8787>. The first chart loads AAPL on the daily
timeframe with a volume pane.

Useful flags: `node server.mjs --port 9000 --host 0.0.0.0`

---

## What's new in this build

### Pine v6

The engine now accepts `//@version=6` and supports the full v6 surface:

* **`@version=6` directive** — the interpreter exposes `interpreter.pineVersion`
  and the parser preserves it on the AST root.
* **`type` / UDT** — declare user-defined types with fields, defaults and
  methods. `Bar.new(...)` constructs an instance; field access via `bar.field`.
  ```pine
  type Swing
      float hi = 0.0
      float lo = 0.0
      float span() => hi - lo

  var Swing s = Swing.new(high, low)
  plot(s.span())
  ```
* **`enum`** — declares a namespace of named constants.
  ```pine
  enum Side
      LONG  = 1
      SHORT = -1
  plot(Side.LONG)
  ```
* **`method`** — user-defined methods on UDTs and builtin types. Methods are
  dispatched by receiver type at runtime.
* **`import` / `export`** — Pine v6's import and export declarations compile
  cleanly (the engine doesn't load external libraries, but scripts that use
  them don't error out).
* **New `ta.*`** — `ta.supertrend`, `ta.dmi`, `ta.cog`, `ta.cum`,
  `ta.percentile_linear_interpolation`, `ta.percentile_nearest_rank`,
  `ta.hl2` / `ta.hlc3` / `ta.ohlc4` quick accessors.
* **`request.security_refreshed`** — v6's "refresh on every bar" variant of
  `request.security`.
* **`chart.*`** — `chart.left_visible_bar_time`, `chart.right_visible_bar_time`,
  `chart.left_visible_bar_index`, `chart.right_visible_bar_index`,
  `chart.is_standard`, `chart.is_heikinashi`, `chart.bg_color`, `chart.fg_color`.
* **`syminfo` v6 extras** — `currency_code`, `volumetype`, `pricemultiplier`,
  `subtype`, `legs`, `minmove`, `pricescale`, `has_intraday`,
  `has_extended_hours`, `has_volume`, `has_regular_session`.
* **`indicator` / `strategy` v6 flags** — `dynamic_requests`,
  `calc_bars_count`, `max_paint_count`, `max_lines_count`,
  `max_labels_count`, `max_boxes_count`, `max_polylines_count`,
  `explicit_plot_zorder`, `display`, `timeframe`, `timeframe_gaps`.
* A `Pine v6 Starter` template is included in the Pine Editor's template
  gallery — it demonstrates type/enum/method, `ta.supertrend`, `ta.dmi`,
  and the `chart.*` accessors.

The example `EXAMPLE_V6.pine` script in the repo root is a one-paste smoke
test that exercises every new v6 feature.

### Multi-timeframe layout (TradingView style)

* **MTF wizard** — the toolbar's **MTF** button opens a wizard. After you
  pick a pane count (1, 2, 3, 4, 6, or 8), the wizard shows the available
  **orientations** for that count so you can pick the one you like:
  * **1 pane** — back to single chart
  * **2 panes** — horizontal (side-by-side) or vertical (stacked)
  * **3 panes** — 1 top + 2 bottom, or 2 top + 1 bottom (top/bottom pane
    spans the full width; the other two share the opposite row)
  * **4 panes** — 2 up + 2 down (2×2 grid)
  * **6 panes** — 3 columns × 2 rows, or 2 columns × 3 rows
  * **8 panes** — 4 columns × 2 rows, or 2 columns × 4 rows
  Each orientation button has a tiny ASCII preview so you can see the
  shape at a glance. Click **Open** to build the grid and load the active
  symbol on every pane at the chosen timeframes.
* **Independent time axis per pane** — applying an MTF layout automatically
  disables `sync.timeRange` so each pane has its own independent time and
  price axis. Dragging the time axis on one pane only changes that pane;
  it does NOT move every other pane. (Crosshair sync stays on so the
  cursor still tracks the same bar time across panes.)
* **Per-pane header** — each pane has a floating header with a symbol
  input, a timeframe dropdown, and a **fullscreen** button in the
  top-right corner. You can change the symbol or timeframe of any pane
  independently, or click the fullscreen button to expand that pane to
  fill the entire chart area.
* **Per-pane fullscreen** — click the small fullscreen icon on any pane
  to expand that pane to fill the chart area. The other panes are
  temporarily hidden. Click the same button (now highlighted) again to
  restore the multi-pane grid. The fullscreen state is persisted across
  reloads. (Selecting a new MTF layout clears the fullscreen state.)
* **Cross-pane sync** — three toolbar toggles let you link the panes:
  * `↔` Sync crosshair (on by default) — moving the cursor on any pane shows
    the same-time crosshair on every other pane. The crosshair snaps to the
    bar whose time contains the source bar's time, so multi-timeframe
    layouts show the cursor on the right bar on every pane.
  * `SYM` Sync symbol — changing the symbol on any pane propagates it to
    every other pane (TradingView's default for MTF layouts).
  * `T` Sync time range (off by default for MTF layouts) — panning or
    zooming one pane pans/zooms every other pane. Turn this on only if you
    want all panes to share the same visible time range.
* The old 1×1 / 2×2 / 3 / 4 / 6 / 8 layout buttons have been **removed**
  from the toolbar — the MTF wizard fully replaces them.

### Draggable price & time axis (TradingView style)

You can now resize the chart by dragging the axes with the mouse — the same
behaviour as TradingView:

* **Price axis** (the right strip): click and drag vertically.
  * Drag the **top edge** of the price axis up to extend the top of the
    visible price range.
  * Drag the **bottom edge** down to extend the bottom of the range.
  * Drag the **middle** to **zoom** the price range: drag DOWN zooms in
    (range shrinks — bars look taller), drag UP zooms out (range grows).
    The cursor's price stays under the cursor while you drag.
  * The cursor changes to `ns-resize` over the price axis to hint that it's
    draggable.
* **Time axis** (the bottom strip): click and drag horizontally.
  * Drag the **left edge** to extend the left margin.
  * Drag the **right edge** to pan the chart sideways.
  * Drag the **middle** to zoom — drag right to expand the bars (fewer bars
    visible), drag left to compress them (more bars visible).
  * The cursor changes to `ew-resize` over the time axis.
* **Double-click on the price axis** re-enables auto-fit for just the price
  range (independent of the full reset).
* **Double-click on the time axis** fits every bar on the chart (calls
  `Fit`).
* **Double-click on the plot area** does a full reset (price + time), same
  as before.
* **Drag the chart body** to pan:
  * Drag **left / right** to scroll the time axis (existing behaviour).
  * Drag **up / down** to pan the visible price range — drag DOWN moves
    the range down (higher prices scroll into view at the top of the
    chart), drag UP moves the range up. The range width is preserved
    while you pan. A vertical pan turns auto-fit OFF so the manually-set
    range sticks until you double-click the price axis (or click the
    `auto` toolbar button) to re-enable it.
  * Diagonal drag pans both axes at once.
* The **M/A** toolbar toggle switches every pane between manual axis
  scaling (default after any axis drag) and auto-fit (the original
  behaviour).

### Collapsible right sidebar

The right sidebar (watchlist / alerts / news / object tree) is now
collapsible to give the chart more room:

* Click the chevron at the top of the sidebar to collapse it. The sidebar
  shrinks to a thin vertical strip of icons. Click any icon to re-expand
  the sidebar and switch to that panel in one go.
* The keyboard shortcut **`\`** (backslash) toggles the sidebar open/closed.
* The collapse state is persisted across reloads.



## What's in it

### Charts

| Area | Details |
| --- | --- |
| Chart types | Candles, hollow candles, OHLC bars, line, area, baseline |
| Multi-chart | 1, 2 (stacked/side-by-side), 3, 4, 6 and 8 pane grids; per-pane symbol and timeframe; synchronised crosshair |
| Scales | Linear, logarithmic, percent; manual axis zoom; auto-fit and auto-scale |
| Panes | Price + volume + one pane per oscillator, auto-detected from the script's value range |
| Volume | Colour-coded by bar direction with a 20-period volume MA |
| Interaction | Wheel zoom anchored at the cursor, drag to pan, double-click to reset |
| Sessions | Time axis and intraday separators are computed in the exchange's own timezone |
| Legend | Live OHLC, change, volume and bar timestamp for the hovered bar |
| Extras | Screenshot (PNG), CSV export of the loaded bars, per-pane chart settings |

### Pine Script engine

A real interpreter, not a feature checklist. It implements the bar-by-bar
execution model Pine uses, including the thing most clones get wrong:

```pine
//@version=5
indicator("Accumulation demo", overlay = true)

var float acc = 0.0
for i = 1 to 5
    acc += i          // becomes a true series, not a per-bar scalar

plot(acc)             // 15 on every bar
plot(acc[1])          // 15 on every bar after the first
```

Supported language surface:

* **Structure** — `indicator()` / `strategy()`, `input.*`, indentation-based blocks,
  `if` / `else if` / `else`, `switch`, `for … to … by`, `for … in`, `while`,
  `break` / `continue`, `var` / `varip`, tuple destructuring, user functions
  (including recursion), `if`-expressions, ternary (with Pine's implicit `na`
  else-branch), line continuations, `//` comments.
* **Types** — series, `array<>`, `matrix<>`, `map<>`, colours, strings, `na`.
  Variables are series aliases (`src = close` stays a series so `ta.sma(src, 20)` sees history).
* **`ta.*`** — `sma ema wma rma vwma bb stdev variance dev change roc mom rsi macd atr tr sar cmo mfi wpr cci stoch ao vwap correlation linreg median mode range highest lowest highestbars lowestbars pivothigh pivotlow barssince crossover crossunder cross`.
* **`math.*`**, **`str.*`** (formatting, regex, splitting, `format_time`), **`request.*`**
  (including `request.security` with real cross-symbol fetches), **`timeframe.*`**, **`syminfo.*`**,
  **`barstate.*`**, `time` / `timestamp` / date accessors, `nz`, `na()`, `fixnan`.
* **Plotting** — `plot` (all styles: line, stepline, histogram, columns, cross, area,
  circles, breaks), `plotshape`, `plotchar`, `plotarrow`, `plotcandle`, `plotbar`,
  `hline`, `fill` (between plots or hlines), `bgcolor`, `barcolor`.
* **Drawing objects** — `line.new` + setters, `label.new` + setters, `box.new` +
  setters, `table.new` / `table.cell`, with `delete` support.
* **Alerts** — `alertcondition()`, `alert()` with `alert.freq_*`.

#### Strategies

`strategy()` with `entry`, `order`, `close`, `close_all`, `exit`, `cancel`, plus
`strategy.position_size`, `position_avg_price`, `equity` and `netprofit`. The
**Strategy Tester** tab reports net profit, win rate, profit factor, max
drawdown, Sharpe ratio, expectancy, long/short breakdown, an equity curve and a
clickable trade list.

#### The na() gotcha

Both forms work: `na` is the missing-value constant and `na(x)` is the is-na
function.

```pine
plot(nz(na, 5))              // 5
plot(na(close[1]) ? 1 : 0)   // 1 on the first bar
```

### Editor

* Syntax highlighting, line-number gutter, Pine-aware auto-indent, Tab/Shift-Tab
* Errors and warnings reported inline with a clickable line number
* "Add to chart" compiles and attaches the script to the active pane
* Template gallery (MA ribbon, RSI bands, MACD, Bollinger breakout strategy,
  multi-timeframe filter, volume profile POC)
* Saved-script library with rename, export and localStorage persistence

Pine's `log.*` output, `runtime.log` and interpreter warnings go to the
**Console** tab.

### Alerts

* Price alerts: crossing, crossing up/down, greater/less than, percent change up/down
* Script alerts driven by `alertcondition()` or `alert()` in an attached script
* Background polling with a per-alert cooldown, toast notification, sound and a
  timestamped log entry
* Arming/pausing and deletion from the Alerts tab; persisted across reloads

### Bar Replay

Rewinds the chart to any bar, then plays forward at 0.5×–8×. Indicators,
strategies, drawings and the legend all respect the replay cursor, so you can
step through a setup bar by bar.

### Drawing tools

Trend line, ray, horizontal line, rectangle, Fibonacci retracement, text and a
measure tool that reports price delta, percent change and bar count. Drawings
are hit-testable, draggable, serialised to localStorage and shown in the Object
tree.

### Watchlist

Quotes poll in the background, with sparklines, day change, an up/down summary
and per-symbol removal. Click a row to load it into the active pane.

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Ctrl/⌘ + I` | Indicator picker |
| `Ctrl/⌘ + E` | Pine editor (expanded) |
| `Ctrl/⌘ + A` | Create alert |
| `Ctrl/⌘ + Enter` | Compile the editor script |
| `Ctrl/⌘ + S` | Save the editor script |
| `R` | Toggle bar replay |
| `Space` | Play / pause replay |
| `←` / `→` | Step one bar (replay) or scroll (live) |
| `+` / `-` | Zoom in / out |
| `T` `H` `R` `F` `X` `M` | Trend line, horizontal line, rectangle, fib, text, measure |
| `Delete` | Remove the selected drawing |
| `Esc` | Cancel the active tool / exit replay |
| `\` | Collapse / expand the right sidebar |

---

## Architecture

```
server.mjs                  zero-dependency HTTP server + Yahoo Finance proxy
public/
  index.html                app shell, SVG icon sprite
  css/app.css               dark theme, layout, editor, panels
  js/
    app.js                  workspace, pane management, all UI wiring
    datafeed.js             caching datafeed, time/format helpers, aggregation
    alerts.js               alert model, evaluation and panel
    editor.js               Pine editor + syntax highlighter + templates
    strategy-tester.js      performance analytics and reporting
    ui.js                   toasts, modals, context menu, storage
    chart/
      chart.js              canvas renderer, panes, interaction, drawing tools
      scale.js              price/time scales, viewport, tick generation
      pine-bridge.js        Pine <-> chart bridge, request.security cache
    pine/
      lexer.js              tokenizer (indentation, strings, colours, numbers)
      parser.js             recursive-descent parser -> AST
      runtime.js            bar-by-bar interpreter, scopes, series storage
      builtins.js           ta.*/math.*/str.*/array.*/plot/drawing/strategy library
      values.js             colours, style enums, namespaces
test/
  run-all.mjs               runs every suite
  pine.test.mjs             language + numerical accuracy vs reference implementations
  chart.test.mjs            rendering, scales, interaction, drawing maths
  app.test.mjs              full app boot against a mocked datafeed
  live.test.mjs             real Yahoo Finance data end-to-end
  modules.test.mjs          import/export wiring
  dom-shim.mjs              minimal DOM + recording canvas for Node
```

### How the Pine engine executes

A script is evaluated **once per bar** from `0 … n-1`. Every mutable variable
owns a *slot* — a flat array holding that variable's value for each bar. That is
what makes `x[1]` work, and it is what makes compound assignment inside a loop
produce a genuine series rather than a per-bar scalar.

```js
x = 0.0
for i = 1 to 5
    x += i        // series: [15, 15, 15, ...]
plot(x[1])        // series shift: [na, 15, 15, ...]
```

Stateful built-ins (`ta.rsi`, `ta.ema`, …) keep their state in a closure map
keyed by AST node id, so two calls to `ta.rsi` on the same bar never share state.
`request.security()` cannot be fetched synchronously, so cross-symbol series are
pre-loaded into a cache and the script is re-run when data lands — indicators
fill in rather than erroring.

### Data

The browser cannot call Yahoo Finance directly (CORS), so `server.mjs` proxies
`/v8/finance/chart`, `/v1/finance/search` and `/v1/finance/quote`. It caches
responses (20 s intraday, 60 s daily), de-duplicates in-flight requests, retries
across Yahoo's two API hosts, and degrades out-of-range intraday requests to the
longest range Yahoo will serve. `/api/quote` synthesises quotes from the chart
endpoint because Yahoo's `/v7/quote` now requires a crumb cookie.

---

## Tests

```powershell
npm test              # everything
npm run test:pine     # language accuracy (38 cases)
npm run test:chart    # rendering and interaction (35 cases)
npm run test:app      # full app boot with a mocked feed (27 cases)
npm run test:live     # real Yahoo Finance data (14 cases)
```

The Pine suite checks indicator output against independent reference
implementations (SMA/EMA/Wilder RSI computed in the test itself), plus history
semantics, loops, tuples, recursion, arrays, strategies, alert conditions and
error reporting. The chart suite drives the real `Chart` class through a DOM
shim with a recording canvas, asserting pixel geometry, autoscale behaviour,
zoom anchoring, drag panning, hit-testing and Pine overlay rendering.

The live suite hits Yahoo for a year of AAPL daily bars, intraday bars, ETFs,
crypto, FX and indices, then validates bar integrity and runs Pine scripts over
the real series.

> Automated browser tests are not included. This project was developed in a
> sandbox that blocks Chromium's IPC channels, so the app is exercised through
> the DOM shim in `test/dom-shim.mjs` instead of a headless browser.

---

## Known limitations

* Pine `strategy.exit` uses a simplified protective-order model (stop/limit are
  evaluated on following bars); partial fills and pyramiding are not modelled.
* `library()`, `type`, `enum`, `map` iteration order and `matrix` algebra beyond
  the basics are not implemented.
* `request.security` aligns other symbols bar-for-bar by index rather than by
  timestamp, which is accurate for matching sessions but approximate for symbols
  with different trading calendars.
* Yahoo intraday history is limited (about 7 days for 1-minute bars), so short
  timeframes show a truncated range.
* `strategy.percent_of_equity` sizing is approximated with the configured
  default quantity.
