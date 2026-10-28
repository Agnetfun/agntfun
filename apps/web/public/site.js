"use strict";
// Shared helpers and page chrome. Data from the API is always written with textContent, never as HTML.
(function () {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (id) => document.getElementById(id);

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const kid of kids.flat())
      if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
    return el;
  }
  function ago(ts) {
    if (!ts) return "never";
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 45) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    return Math.round(s / 86400) + " d ago";
  }
  const money = (c) => "$" + (c / 100).toFixed(2);
  function usd(n) {
    if (!Number.isFinite(n)) return "n/a";
    if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
    return "$" + n.toFixed(0);
  }
  function price(n) {
    if (!(n > 0)) return "$0";
    if (n >= 1) return "$" + n.toFixed(2);
    return "$" + n.toFixed(Math.min(10, 2 - Math.floor(Math.log10(n))));
  }
  const pct = (n) => (n >= 0 ? "+" : "") + n.toFixed(1) + "%";
  const short = (a) => (a && a.length > 10 ? a.slice(0, 4) + "…" + a.slice(-4) : a || "");
  const STATES = {
    sleeping: "Sleeping",
    waking: "Waking",
    running: "Running",
    publishing: "Publishing",
    halted: "Stopped",
    starved: "Out of funds",
  };
  const stateBadge = (s) =>
    h("span", { class: "badge" }, h("span", { class: "dot " + s }), STATES[s] || s);
  const MODELS = { opus: "Claude Opus 5.5", astra: "GPT 6 Astra" };

  async function copy(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      if (btn) {
        const old = btn.getAttribute("aria-label");
        btn.setAttribute("aria-label", "Copied");
        setTimeout(() => btn.setAttribute("aria-label", old || "Copy"), 1500);
      }
    } catch {
      /* clipboard blocked: nothing to do */
    }
  }

  // Live updates: server sent events with a five second polling fallback.
  function live(refresh) {
    let timer = null;
    let pending = null;
    const run = () => {
      clearTimeout(pending);
      pending = setTimeout(refresh, 250);
    };
    const poll = () => {
      if (!timer) timer = setInterval(refresh, 5000);
    };
    if ("EventSource" in window) {
      const es = new EventSource("/api/stream");
      es.addEventListener("change", () => {
        clearInterval(timer);
        timer = null;
        run();
      });
      es.onerror = poll;
    } else poll();
  }

  // Current page in the nav
  const here = location.pathname;
  for (const a of document.querySelectorAll(".topnav a")) {
    const p = a.getAttribute("href");
    const on = p === "/" ? here === "/" || here.startsWith("/agent/") : here === p;
    if (on) a.setAttribute("aria-current", "page");
  }

  // Mobile menu
  const btn = document.querySelector(".menu-btn");
  const panel = $("panel");
  if (btn && panel) {
    const set = (open) => {
      btn.setAttribute("aria-expanded", String(open));
      btn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      panel.classList.toggle("open", open);
      panel.setAttribute("aria-hidden", String(!open));
      document.body.classList.toggle("lock", open);
      document.body.style.overflow = open ? "hidden" : "";
    };
    btn.addEventListener("click", () => set(btn.getAttribute("aria-expanded") !== "true"));
    panel.addEventListener("click", (e) => e.target.closest("a") && set(false));
    document.addEventListener("keydown", (e) => e.key === "Escape" && set(false));
  }

  // Wallet dialog and header button
  const modal = $("wallet-modal");
  if (modal) {
    let opener = null;
    const err = (t) => {
      $("wm-err").textContent = t || "";
    };
    const sync = (addr) => {
      $("wallet-text").textContent = addr ? short(addr) : "Connect wallet";
      $("wm-list").hidden = !!addr;
      $("wm-on").hidden = !addr;
      $("wm-addr").textContent = addr || "";
      $("wm-sub").textContent = addr
        ? "Your wallet is connected to this site."
        : "Connect a Solana wallet. Connecting never spends money. Signing a message proves it is you.";
      if (addr) close();
    };
    const open = () => {
      opener = document.activeElement;
      err("");
      modal.hidden = false;
      const first = modal.querySelector("button:not([hidden])");
      if (first) first.focus();
    };
    const close = () => {
      if (modal.hidden) return;
      modal.hidden = true;
      if (!window.Wallet.address()) window.dispatchEvent(new Event("wallet-dismissed"));
      if (opener && opener.focus) opener.focus();
    };
    $("wallet-btn").addEventListener("click", open);
    window.addEventListener("open-wallet", open);
    $("wm-close").addEventListener("click", close);
    modal.addEventListener("click", (e) => e.target === modal && close());
    document.addEventListener("keydown", (e) => e.key === "Escape" && close());
    for (const b of modal.querySelectorAll("[data-w]"))
      b.addEventListener("click", async () => {
        err("");
        try {
          await window.Wallet.connect(b.dataset.w);
        } catch (e) {
          err(e.message || "Could not connect. Try again.");
        }
      });
    $("wm-disc").addEventListener("click", () => window.Wallet.disconnect());
    window.Wallet.onChange(sync);
    sync(window.Wallet.address());
  }

  // Scroll reveals, once each
  const reveals = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && !reduce) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries)
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
      },
      { threshold: 0.15 },
    );
    reveals.forEach((el) => io.observe(el));
  } else reveals.forEach((el) => el.classList.add("in"));

  // Tagline: words wake up one at a time as they cross a trigger line
  const tag = $("tagline");
  if (tag) {
    const words = tag.textContent.trim().split(/\s+/);
    tag.textContent = "";
    const spans = words.map((w, i) => {
      const s = h("span", { class: "w" }, w);
      tag.append(s, i < words.length - 1 ? " " : "");
      return s;
    });
    if ("IntersectionObserver" in window && !reduce) {
      const io = new IntersectionObserver(
        (entries) => {
          for (const e of entries)
            if (e.isIntersecting) {
              e.target.classList.add("on");
              io.unobserve(e.target);
            }
        },
        { rootMargin: "0px 0px -35% 0px", threshold: 0 },
      );
      spans.forEach((s) => io.observe(s));
    } else spans.forEach((s) => s.classList.add("on"));
  }

  /** Agent logo, or a coloured letter tile when it has none. */
  function avatar(a, cls) {
    if (a.logo)
      return h("img", {
        class: "avatar " + (cls || ""),
        src: a.logo,
        alt: a.name + " logo",
        width: 48,
        height: 48,
        loading: "lazy",
      });
    const n = [...a.id].reduce((t, c) => t + c.charCodeAt(0), 0) % 5;
    return h("div", { class: "avatar a" + n + " " + (cls || ""), "aria-hidden": "true" }, a.name.slice(0, 1).toUpperCase());
  }

  window.DA = { h, ago, money, usd, price, pct, short, copy, stateBadge, MODELS, live, $, avatar };
})();
