"use strict";
// Shell: sidebar collapse and close, live count, platform token link, and small shared motion helpers.
(function () {
  const $ = (id) => document.getElementById(id);
  const { requestAnimationFrame, performance, localStorage, setTimeout } = window;
  const root = document.documentElement;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const store = {
    get: (k) => {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set: (k, v) => {
      try {
        localStorage.setItem(k, v);
      } catch {
        /* storage blocked: the choice just is not remembered */
      }
    },
  };

  // Desktop: collapse to an icon rail, remembered per browser.
  const toggle = $("side-toggle");
  const setMin = (on) => {
    root.classList.toggle("side-min", on);
    toggle.setAttribute("aria-label", on ? "Expand sidebar" : "Collapse sidebar");
    toggle.title = toggle.getAttribute("aria-label");
    store.set("da-side-min", on ? "1" : "0");
  };
  if (store.get("da-side-min") === "1") setMin(true);
  toggle.addEventListener("click", () => setMin(!root.classList.contains("side-min")));

  // Phones: an explicit close button inside the open panel.
  $("side-close").addEventListener("click", () => {
    const b = document.querySelector(".menu-btn");
    if (b && b.getAttribute("aria-expanded") === "true") b.click();
  });

  async function liveCount() {
    try {
      const r = await fetch("/api/agents", { headers: { accept: "application/json" } });
      if (!r.ok) return;
      const { agents } = await r.json();
      const n = agents.filter((a) => ["running", "waking", "publishing"].includes(a.state)).length;
      $("side-live").hidden = n === 0;
      $("side-live").textContent = String(n);
    } catch {
      /* the count is decoration */
    }
  }
  fetch("/api/config")
    .then((r) => r.json())
    .then((c) => {
      if (c.platformToken && c.platformToken.symbol) {
        const a = $("side-token");
        a.hidden = false;
        a.href = "https://pump.fun/coin/" + encodeURIComponent(c.platformToken.mint);
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        $("side-token-t").textContent = "$" + c.platformToken.symbol;
      }
    })
    .catch(() => {});
  liveCount();
  window.setInterval(liveCount, 30000);

  // ---- motion helpers (transform and opacity only, base curve, reduced motion respected) ----

  /** Counts a number up from its current value. Keeps any text the formatter adds. */
  function countUp(el, to, fmt) {
    const f = fmt || ((n) => String(Math.round(n)));
    const from = Number(el.dataset.v || 0);
    el.dataset.v = String(to);
    if (reduce || from === to) return void (el.textContent = f(to));
    const start = performance.now();
    const dur = 500;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / dur);
      const e = 1 - Math.pow(1 - t, 3);
      el.textContent = f(from + (to - from) * e);
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /** Green or red flash on a value that just moved, like a trading terminal. */
  function flash(el, up) {
    if (reduce || !el) return;
    el.classList.remove("flash-up", "flash-down");
    void el.offsetWidth; // restart the animation
    el.classList.add(up ? "flash-up" : "flash-down");
  }

  /** Cards rise in one after another (first render only). */
  function stagger(nodes) {
    if (reduce) return;
    nodes.forEach((n, i) => {
      n.classList.add("rise");
      n.style.transitionDelay = Math.min(i * 60, 400) + "ms";
      requestAnimationFrame(() => requestAnimationFrame(() => n.classList.add("in")));
      setTimeout(() => {
        n.classList.remove("rise", "in");
        n.style.transitionDelay = "";
      }, 1200);
    });
  }

  /** Sparklines draw themselves. */
  function drawSparks(root) {
    if (reduce) return;
    for (const p of root.querySelectorAll("svg.spark .ln")) {
      p.setAttribute("pathLength", "1");
      p.classList.add("draw");
    }
  }

  // The primary button bursts when pressed, then follows its link.
  const COLORS = ["#ffffff", "#4ade80", "#60a5fa", "#fbbf24", "#9b9b9b"];
  document.addEventListener("click", (e) => {
    const b = e.target.closest(".btn.press");
    if (!b || reduce) return;
    const r = b.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    for (let i = 0; i < 16; i++) {
      const d = document.createElement("i");
      d.className = "burst-dot";
      d.style.left = cx + "px";
      d.style.top = cy + "px";
      d.style.background = COLORS[i % COLORS.length];
      document.body.append(d);
      const a = (Math.PI * 2 * i) / 16 + Math.random() * 0.4;
      const dist = 40 + Math.random() * 48;
      requestAnimationFrame(() => {
        d.style.transform = `translate(${Math.cos(a) * dist}px, ${Math.sin(a) * dist}px) rotate(${a * 90}deg) scale(0.6)`;
        d.style.opacity = "0";
      });
      setTimeout(() => d.remove(), 450);
    }
    const href = b.getAttribute("href");
    if (href && !e.metaKey && !e.ctrlKey && !e.shiftKey && b.target !== "_blank") {
      e.preventDefault();
      setTimeout(() => (location.href = href), 150);
    }
  });

  window.DA = Object.assign(window.DA || {}, { countUp, flash, stagger, drawSparks });
})();
