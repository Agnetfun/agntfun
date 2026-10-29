"use strict";
// Market chart on TradingView Lightweight Charts: candles, volume, crosshair, live updates. Colors from DESIGN.md.
(function () {
  const win = window;
  const LWC = win.LightweightCharts;
  if (!LWC) return; // the built in SVG chart stays as the fallback
  const GREEN = "#4ade80";
  const RED = "#f87171";

  // Tall enough to read a move: about 60% of the window, between 440 and 680px (phones get 320).
  const fitHeight = () => (win.innerWidth < 640 ? 320 : Math.round(Math.min(680, Math.max(440, win.innerHeight * 0.6))));

  function create(box) {
    box.replaceChildren();
    box.style.height = fitHeight() + "px";
    const chart = LWC.createChart(box, {
      autoSize: true,
      layout: {
        background: { type: "solid", color: "#000000" },
        textColor: "#9b9b9b",
        fontFamily: "Geist Mono, ui-monospace, monospace",
        fontSize: 12,
      },
      grid: { vertLines: { color: "#181818" }, horzLines: { color: "#181818" } },
      rightPriceScale: { borderColor: "#272727", scaleMargins: { top: 0.1, bottom: 0.25 } },
      timeScale: { borderColor: "#272727", timeVisible: true, secondsVisible: false, rightOffset: 4 },
      crosshair: {
        mode: LWC.CrosshairMode.Normal,
        vertLine: { color: "#9b9b9b", labelBackgroundColor: "#313131" },
        horzLine: { color: "#9b9b9b", labelBackgroundColor: "#313131" },
      },
      handleScale: { axisPressedMouseMove: true },
    });
    const candles = chart.addCandlestickSeries({
      upColor: GREEN,
      downColor: RED,
      borderVisible: false,
      wickUpColor: GREEN,
      wickDownColor: RED,
      priceLineColor: "#9b9b9b",
    });
    const volume = chart.addHistogramSeries({ priceScaleId: "", priceFormat: { type: "volume" }, lastValueVisible: false });
    chart.priceScale("").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    return { chart, candles, volume, el: box.firstElementChild, key: "" };
  }

  /** Draws or updates the chart. `cs` candles have t (ms), o/h/l/c already scaled to price or market cap. */
  win.addEventListener("resize", () => {
    for (const b of document.querySelectorAll("#market-chart")) if (b._lw) b.style.height = fitHeight() + "px";
  });

  window.DA.lwChart = function (box, cs, fmt, tf) {
    let s = box._lw;
    if (!s || !box.contains(s.el)) s = box._lw = create(box);
    // Axis labels need enough decimals to tell neighbouring ticks apart: pick them from the data's own range,
    // so a flat $42 reads $41.9, $42.0, $42.1 instead of "$42" on every line.
    const hi = Math.max(...cs.map((c) => c.h));
    const lo = Math.min(...cs.map((c) => c.l));
    const step = (hi - lo || Math.abs(hi) * 0.05 || 1e-9) / 10;
    const decimals = Math.min(12, Math.max(0, Math.ceil(-Math.log10(step))));
    const label = (v) => "$" + (Math.abs(v) >= 1e6 && decimals === 0 ? (v / 1e6).toFixed(2) + "M" : v.toFixed(decimals));
    s.candles.applyOptions({
      priceFormat: { type: "custom", formatter: label, minMove: Math.pow(10, -Math.max(decimals, 2)) },
      // A price that has not moved gets 5% of room above and below instead of a hairline range.
      autoscaleInfoProvider: (original) => {
        const r = original();
        if (!r || !r.priceRange) return r;
        const { minValue: a, maxValue: b } = r.priceRange;
        if (b - a > Math.abs(b) * 0.02) return r;
        const pad = Math.abs(b) * 0.05 || 1e-9;
        return { ...r, priceRange: { minValue: a - pad, maxValue: b + pad } };
      },
    });
    void fmt;
    // One candle per time bucket, oldest first, in seconds.
    const seen = new Set();
    const rows = cs
      .map((c) => ({ ...c, time: Math.floor(c.t / 1000) }))
      .filter((c) => (seen.has(c.time) ? false : seen.add(c.time)))
      .sort((a, b) => a.time - b.time);
    s.candles.setData(rows.map((c) => ({ time: c.time, open: c.o, high: c.h, low: c.l, close: c.c })));
    const hasVol = rows.some((c) => c.v > 0);
    // Without volume the bottom band would sit empty and squash the candles, so they take the full height.
    s.chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.08, bottom: hasVol ? 0.25 : 0.06 } });
    s.volume.setData(
      hasVol
        ? rows.map((c) => ({ time: c.time, value: c.v, color: c.c >= c.o ? "rgba(74,222,128,0.35)" : "rgba(248,113,113,0.35)" }))
        : [],
    );
    // Reframe on a new timeframe; keep the user's zoom on live updates.
    if (s.key !== tf) {
      s.key = tf;
      s.chart.timeScale().fitContent();
    }
  };
})();
