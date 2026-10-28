"use strict";
// Small SVG charts, no libraries. Colours and sizes come from CSS classes so the strict CSP is untouched.
(function () {
  const NS = "http://www.w3.org/2000/svg";
  function s(tag, attrs, ...kids) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
    for (const k of kids) if (k) el.append(k);
    return el;
  }
  const num = (n) => Math.round(n * 10) / 10;

  /** Tiny trend line for cards. */
  function spark(values, cls) {
    const w = 120;
    const h = 32;
    if (values.length > 1 && values[values.length - 1] < values[0]) cls = (cls || "") + " neg";
    const min = Math.min(...values);
    const span = Math.max(...values) - min || 1;
    const step = values.length > 1 ? w / (values.length - 1) : w;
    const pts = values.map(
      (v, i) => num(i * step) + "," + num(h - 3 - ((v - min) / span) * (h - 6)),
    );
    return s(
      "svg",
      { class: "spark " + (cls || ""), viewBox: "0 0 " + w + " " + h, "aria-hidden": "true" },
      s("polyline", { points: pts.join(" "), class: "ln", fill: "none" }),
    );
  }

  /**
   * Full chart. kind is "line" or "bars". labels are day starts. fmt formats the y axis.
   * Adds a text summary for screen readers.
   */
  function draw(kind, values, days, fmt, label) {
    const w = 640;
    const h = 220;
    const pad = { l: 48, r: 12, t: 12, b: 28 };
    const iw = w - pad.l - pad.r;
    const ih = h - pad.t - pad.b;
    const lo = kind === "bars" ? 0 : Math.min(0, ...values);
    let hi = Math.max(...values, 1);
    if (kind === "bars" && fmt(0) === "0") hi = Math.ceil(hi / 4) * 4;
    if (hi === lo) hi = lo + 1;
    const y = (v) => num(pad.t + ih - ((v - lo) / (hi - lo)) * ih);
    const n = values.length;
    const x = (i) => num(pad.l + (n > 1 ? (i / (n - 1)) * iw : iw / 2));
    const svg = s("svg", {
      class: "chart-svg",
      viewBox: "0 0 " + w + " " + h,
      role: "img",
      "aria-label":
        label +
        ". Latest " +
        fmt(values[n - 1] || 0) +
        ", highest " +
        fmt(Math.max(...values)) +
        ".",
    });
    for (let i = 0; i <= 4; i++) {
      const v = lo + ((hi - lo) * i) / 4;
      svg.append(
        s("line", { class: "gl", x1: pad.l, x2: w - pad.r, y1: y(v), y2: y(v) }),
        Object.assign(s("text", { class: "ax", x: pad.l - 8, y: y(v) + 4, "text-anchor": "end" }), {
          textContent: fmt(v),
        }),
      );
    }
    const tick = Math.max(1, Math.ceil(n / 6));
    days.forEach((d, i) => {
      if (i % tick !== 0) return;
      const dt = new Date(d);
      svg.append(
        Object.assign(s("text", { class: "ax", x: x(i), y: h - 8, "text-anchor": "middle" }), {
          textContent: dt.getUTCMonth() + 1 + "/" + dt.getUTCDate(),
        }),
      );
    });
    if (kind === "bars") {
      const bw = Math.max(2, Math.min(18, (iw / n) * 0.6));
      values.forEach((v, i) => {
        if (v <= 0) return;
        svg.append(
          s("rect", {
            class: "bar",
            x: num(x(i) - bw / 2),
            y: y(v),
            width: num(bw),
            height: num(pad.t + ih - y(v)),
            rx: 2,
          }),
        );
      });
    } else {
      const pts = values.map((v, i) => x(i) + "," + y(v));
      svg.append(
        s("polygon", {
          class: "area",
          points: x(0) + "," + y(lo) + " " + pts.join(" ") + " " + x(n - 1) + "," + y(lo),
        }),
        s("polyline", { class: "ln", fill: "none", points: pts.join(" ") }),
        s("circle", { class: "dot-end", cx: x(n - 1), cy: y(values[n - 1] || 0), r: 4 }),
      );
    }
    return svg;
  }
  /** Candlestick chart with a volume strip. fmt formats prices, cs is [{t,o,h,l,c,v}]. */
  function candles(cs, fmt, label, fmtT) {
    const w = 720;
    const h = 340;
    const pad = { l: 8, r: 72, t: 12, b: 24 };
    const vh = 52;
    const ph = h - pad.t - pad.b - vh - 8;
    const iw = w - pad.l - pad.r;
    const lo0 = Math.min(...cs.map((k) => k.l));
    const hi0 = Math.max(...cs.map((k) => k.h));
    const m = (hi0 - lo0) * 0.06 || hi0 * 0.01;
    const lo = lo0 - m;
    const hi = hi0 + m;
    const y = (v) => num(pad.t + ph - ((v - lo) / (hi - lo)) * ph);
    const n = cs.length;
    const slot = iw / n;
    const cx = (i) => num(pad.l + slot * i + slot / 2);
    const vmax = Math.max(...cs.map((k) => k.v), 1);
    const svg = s("svg", {
      class: "chart-svg",
      viewBox: "0 0 " + w + " " + h,
      role: "img",
      "aria-label": label + ". Last price " + fmt(cs[n - 1].c) + ".",
    });
    for (let i = 0; i <= 5; i++) {
      const v = lo + ((hi - lo) * i) / 5;
      svg.append(
        s("line", { class: "gl", x1: pad.l, x2: w - pad.r, y1: y(v), y2: y(v) }),
        Object.assign(s("text", { class: "ax", x: w - pad.r + 8, y: y(v) + 4 }), {
          textContent: fmt(v),
        }),
      );
    }
    const tick = Math.max(1, Math.ceil(n / 7));
    cs.forEach((k, i) => {
      if (i % tick || i === 0) return;
      svg.append(
        Object.assign(s("text", { class: "ax", x: cx(i), y: h - 6, "text-anchor": "middle" }), {
          textContent: fmtT(k.t),
        }),
      );
    });
    const bw = Math.max(1.5, slot * 0.64);
    cs.forEach((k, i) => {
      const up = k.c >= k.o;
      const cls = up ? "up-c" : "dn-c";
      svg.append(
        s("line", { class: "wick " + cls, x1: cx(i), x2: cx(i), y1: y(k.h), y2: y(k.l) }),
        s("rect", {
          class: cls,
          x: num(cx(i) - bw / 2),
          y: Math.min(y(k.o), y(k.c)),
          width: num(bw),
          height: Math.max(1, Math.abs(y(k.o) - y(k.c))),
        }),
        s("rect", {
          class: up ? "vol-up" : "vol-dn",
          x: num(cx(i) - bw / 2),
          y: num(h - pad.b - (k.v / vmax) * vh),
          width: num(bw),
          height: num((k.v / vmax) * vh),
        }),
      );
    });
    const last = cs[n - 1].c;
    svg.append(
      s("line", { class: "last", x1: pad.l, x2: w - pad.r, y1: y(last), y2: y(last) }),
      s("rect", {
        class: "lastbg",
        x: w - pad.r + 2,
        y: y(last) - 9,
        width: pad.r - 4,
        height: 18,
        rx: 4,
      }),
      Object.assign(s("text", { class: "ax lastlbl", x: w - pad.r + 8, y: y(last) + 4 }), {
        textContent: fmt(last),
      }),
    );
    return svg;
  }
  window.Chart = { spark, draw, candles };
})();
