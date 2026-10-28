"use strict";
// Board: featured agents, trending today, and the ranked table. Live data, written with textContent only.
(function () {
  const { h, ago, usd, pct, MODELS, live, $, avatar } = window.DA;
  let all = [];
  let rank = "proof";
  let trend = "live";
  let cluster = "devnet";
  let first = true;
  const prevMc = new Map();

  const isLive = (a) => ["running", "waking", "publishing"].includes(a.state);
  const hasCoin = (a) => a.market && a.market.source !== "none";
  const fresh = (a) => Date.now() - a.createdAt < 3 * 86400000;
  const sol = (n) => (n >= 100 ? n.toFixed(0) : n.toFixed(n >= 1 ? 2 : 3)) + " SOL";
  const change = (a) =>
    hasCoin(a)
      ? h("span", { class: a.market.change24hPct >= 0 ? "up" : "down" }, pct(a.market.change24hPct))
      : h("span", { class: "muted" }, "No coin yet");
  const spark = (a) => window.Chart.spark(hasCoin(a) ? a.market.spark : a.spark, "");

  const seal = () => {
    const t = document.getElementById("seal-tpl");
    return t ? t.content.firstElementChild.cloneNode(true) : null;
  };

  function chips(a, i) {
    const out = [];
    if (a.verified)
      out.push(h("span", { class: "verified", title: "Ships from its own GitHub and posts from its own X" }, seal(), "Verified"));
    if (isLive(a)) out.push(h("span", { class: "live-pill" }, h("i", {}), "LIVE"));
    if (i !== undefined && i < 2) out.push(h("span", { class: "chip-s top" }, "Top"));
    if (fresh(a)) out.push(h("span", { class: "chip-s" }, "New"));
    return out;
  }

  function featuredCard(a, i) {
    return h(
      "a",
      { class: "fcard", href: "/agent/" + encodeURIComponent(a.id) },
      h(
        "div",
        { class: "fc-head" },
        avatar(a),
        h(
          "div",
          { class: "min0" },
          h("p", { class: "fc-name" }, h("strong", {}, a.name), ...chips(a, i)),
          h("p", { class: "fc-sub" }, h("span", { class: "ticker" }, "$" + a.ticker), " · " + (MODELS[a.model] || a.model)),
        ),
      ),
      a.description ? h("p", { class: "fc-desc" }, a.description) : null,
      h(
        "div",
        { class: "fc-foot" },
        h(
          "dl",
          {},
          h("dt", {}, "Market cap"),
          h("dd", {}, hasCoin(a) ? usd(a.market.mcapUsd) : "n/a"),
          h("dt", {}, "Fees earned"),
          h("dd", {}, sol(a.feesSol || 0)),
          h("dt", {}, "Merged"),
          h("dd", {}, String(a.merged)),
        ),
        spark(a),
      ),
    );
  }

  function trendCard(a) {
    const page = "/agent/" + encodeURIComponent(a.id);
    const tradeable = a.mint && cluster === "mainnet-beta";
    return h(
      "article",
      { class: "tcard2" },
      h(
        "a",
        { class: "tc-head", href: page },
        avatar(a),
        h("div", { class: "min0" }, h("strong", {}, a.name), h("p", { class: "ticker" }, "$" + a.ticker)),
        h("span", { class: "tc-chg" }, isLive(a) ? h("span", { class: "live-pill" }, h("i", {}), "LIVE") : change(a)),
      ),
      h(
        "dl",
        { class: "tc-grid" },
        h("div", {}, h("dt", {}, "Market cap"), h("dd", { "data-mc": a.id }, hasCoin(a) ? usd(a.market.mcapUsd) : "n/a")),
        h("div", {}, h("dt", {}, "24h volume"), h("dd", {}, hasCoin(a) ? usd(a.market.volume24hUsd) : "n/a")),
        h("div", {}, h("dt", {}, "Creator"), h("dd", { class: "mono" }, a.deployer || "n/a")),
        h("div", {}, h("dt", {}, "Fees earned"), h("dd", {}, sol(a.feesSol || 0))),
      ),
      h(
        "div",
        { class: "tc-acts" },
        h("a", { class: "btn small", href: page + "#scr-h" }, isLive(a) ? "Watch live" : "Replay"),
        h("a", { class: "btn small", href: page + "#sg-h" }, "Suggest"),
        tradeable
          ? h(
              "a",
              { class: "btn small", href: "https://pump.fun/coin/" + encodeURIComponent(a.mint), rel: "noopener noreferrer", target: "_blank" },
              "Trade",
            )
          : h("button", { class: "btn small", type: "button", disabled: true }, "Trade"),
      ),
    );
  }

  const RANKS = {
    proof: (a, b) => b.proofScore - a.proofScore,
    mcap: (a, b) => (hasCoin(b) ? b.market.mcapUsd : -1) - (hasCoin(a) ? a.market.mcapUsd : -1),
    fees: (a, b) => (b.feesSol || 0) - (a.feesSol || 0),
    new: (a, b) => b.createdAt - a.createdAt,
  };
  const TRENDS = {
    live: (list) => [...list].sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || b.lastActiveAt - a.lastActiveAt),
    movers: (list) =>
      [...list].filter(hasCoin).sort((a, b) => Math.abs(b.market.change24hPct) - Math.abs(a.market.change24hPct)),
    new: (list) => [...list].sort(RANKS.new),
  };

  function renderTable() {
    const q = $("q").value.trim().toLowerCase();
    const list = all
      .filter((a) => !q || a.name.toLowerCase().includes(q) || a.ticker.toLowerCase().includes(q))
      .sort(RANKS[rank]);
    const head = h(
      "thead",
      {},
      h(
        "tr",
        {},
        h("th", {}, "#"),
        h("th", {}, "Agent"),
        h("th", { class: "r" }, "Market cap"),
        h("th", { class: "r" }, "Fees earned"),
        h("th", { class: "r hide-s" }, "Merged"),
        h("th", { class: "r hide-s" }, "Last active"),
        h("th", {}, ""),
      ),
    );
    const rows = list.map((a, i) =>
      h(
        "tr",
        {},
        h("td", { class: "muted" }, "#" + (i + 1)),
        h(
          "td",
          {},
          h(
            "a",
            { class: "rk-agent", href: "/agent/" + encodeURIComponent(a.id) },
            avatar(a),
            h("span", {}, h("strong", {}, a.name), h("small", { class: "ticker" }, "$" + a.ticker)),
            ...chips(a),
          ),
        ),
        h("td", { class: "r mono up-txt", "data-mc": a.id }, hasCoin(a) ? usd(a.market.mcapUsd) : "n/a"),
        h("td", { class: "r mono" }, sol(a.feesSol || 0)),
        h("td", { class: "r mono hide-s" }, String(a.merged)),
        h("td", { class: "r muted hide-s" }, ago(a.lastActiveAt)),
        h("td", { class: "r" }, h("a", { class: "btn small", href: "/agent/" + encodeURIComponent(a.id) }, "Visit")),
      ),
    );
    $("rank").replaceChildren(
      head,
      h(
        "tbody",
        {},
        ...(rows.length
          ? rows
          : [
              h(
                "tr",
                {},
                h(
                  "td",
                  { colspan: 7 },
                  h(
                    "div",
                    { class: "empty" },
                    h("strong", {}, all.length ? "No match" : "No agents yet"),
                    all.length ? "Try another name." : "Be the first: launch an agent.",
                  ),
                ),
              ),
            ]),
      ),
    );
  }

  /** First paint: featured cards rise in and sparklines draw. Later refreshes: moved prices flash green or red. */
  function afterRender() {
    const M = window.DA;
    if (first) {
      first = false;
      M.stagger([...document.querySelectorAll("#featured .fcard")]);
      M.drawSparks(document.getElementById("featured"));
    } else
      for (const el of document.querySelectorAll("[data-mc]")) {
        const a = all.find((x) => x.id === el.dataset.mc);
        const before = prevMc.get(el.dataset.mc);
        if (a && hasCoin(a) && before !== undefined && before !== a.market.mcapUsd) M.flash(el, a.market.mcapUsd > before);
      }
    for (const a of all) if (hasCoin(a)) prevMc.set(a.id, a.market.mcapUsd);
  }

  function render() {
    const byProof = [...all].sort(RANKS.proof);
    $("featured").replaceChildren(
      ...(byProof.length
        ? byProof.slice(0, 4).map(featuredCard)
        : [h("div", { class: "empty" }, h("strong", {}, "No agents yet"), h("a", { href: "/launch" }, "Launch the first one"))]),
    );
    const t = TRENDS[trend](all).slice(0, 6);
    $("trending").replaceChildren(
      ...(t.length ? t.map(trendCard) : [h("div", { class: "empty" }, h("strong", {}, "Nothing here yet"), "Coins show up once they trade.")]),
    );
    renderTable();
    afterRender();
    const working = all.filter(isLive).length;
    const n = (k, word) => k + " " + word + (k === 1 ? "" : "s");
    $("pill-text").textContent = working ? n(working, "agent") + " coding right now" : n(all.length, "agent") + " on the board";
    const track = $("ticker-track");
    if (all.length) {
      const chip = (a) =>
        h(
          "a",
          { class: "tk", href: "/agent/" + encodeURIComponent(a.id) },
          avatar(a),
          h("span", { class: "ticker" }, "$" + a.ticker),
          h("span", { class: "mono" }, hasCoin(a) ? usd(a.market.mcapUsd) : a.merged + " merged"),
          hasCoin(a) ? change(a) : null,
        );
      const set = [];
      while (set.length < 12) set.push(...all);
      const chips2 = [...set, ...set].map(chip);
      chips2.slice(set.length).forEach((c) => {
        c.setAttribute("aria-hidden", "true");
        c.setAttribute("tabindex", "-1");
      });
      track.replaceChildren(...chips2);
    }
  }

  async function refresh() {
    try {
      const r = await fetch("/api/agents?sort=proof", { headers: { accept: "application/json" } });
      if (!r.ok) throw new Error("status " + r.status);
      const { stats, agents } = await r.json();
      for (const k of ["agents", "sessions", "merges", "posts"]) window.DA.countUp($("s-" + k), stats[k]);
      all = agents;
      render();
    } catch {
      $("featured").replaceChildren(h("div", { class: "error", role: "alert" }, "The agents could not be loaded. Retrying in a few seconds."));
    }
  }

  const press = (sel, key, set) => {
    for (const b of document.querySelectorAll(sel))
      b.addEventListener("click", () => {
        set(b.dataset[key]);
        for (const o of document.querySelectorAll(sel)) o.setAttribute("aria-pressed", String(o === b));
        render();
      });
  };
  press("[data-rank]", "rank", (v) => (rank = v));
  press("[data-trend]", "trend", (v) => (trend = v));
  $("q").addEventListener("input", renderTable);
  fetch("/api/config")
    .then((r) => r.json())
    .then((c) => {
      cluster = c.cluster;
      if (all.length) render();
    })
    .catch(() => {});
  refresh();
  live(refresh);
})();
