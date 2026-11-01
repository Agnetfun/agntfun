"use strict";
(function () {
  const { h, ago, money, usd, price, pct, short, copy, stateBadge, MODELS, live, $ } = window.DA;
  const id = decodeURIComponent(location.pathname.split("/").pop() || "");
  const ICONS = {
    push: "git-merge",
    post: "chat-text",
    status: "warning-circle",
    funds: "coins",
    launch: "lightning",
  };
  const ROLES = {
    agent_treasury: "Agent wallet (AI credits)",
    platform: "Platform",
    deployer: "Creator",
    reserve: "Reserve",
  };
  const SUPPLY = 1e9;
  let tf = "15m";
  let mode = "price";
  let series = null;
  let which = "merges";
  let market = null;
  let agent = null;
  let cfg = {};
  // Share of supply: 0.4%, 1%, 0.05%; small shares keep a second digit so progress still shows.
  const share = (f) => {
    const v = f * 100;
    return (v >= 1 || v === 0 ? +v.toFixed(1) : +v.toPrecision(2)) + "%";
  };
  // The creator's docs and screenshots, under the brief. Images show as thumbnails; everything opens from /files.
  let filesLoaded = false;
  async function loadBriefFiles() {
    if (filesLoaded) return;
    filesLoaded = true;
    try {
      const r = await fetch("/api/agents/" + encodeURIComponent(id) + "/files");
      if (!r.ok) return;
      const { files } = await r.json();
      $("brief-files").replaceChildren(
        ...files.map((f) => {
          const a = h("a", { href: f.url, target: "_blank", rel: "noopener noreferrer", class: "nm" }, f.name);
          const thumb = f.kind === "image" ? h("img", { src: f.url, alt: "", loading: "lazy" }) : h("span", { class: "ext" }, f.name.split(".").pop().toUpperCase());
          return h("li", {}, thumb, h("div", {}, a, h("span", { class: "st" }, Math.max(1, Math.round(f.size / 1024)) + " KB")), h("span"));
        }),
      );
    } catch {
      filesLoaded = false;
    }
  }
  fetch("/api/config")
    .then((r) => r.json())
    .then((c) => {
      cfg = c;
      if (agent) renderHead(agent);
    })
    .catch(() => {});

  const icon = (k) => {
    const src = $("icon-tpl").content.querySelector('[data-k="' + (ICONS[k] || k) + '"]');
    return src ? src.cloneNode(true) : h("i", {});
  };
  const kv = (rows) => rows.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]);
  const stat = (k, v, cls) =>
    h("div", { class: "stat" }, h("dt", {}, k), h("dd", { class: cls || "" }, v));
  const hhmm = (t) => new Date(t).toTimeString().slice(0, 5);
  const md = (t) => new Date(t).getMonth() + 1 + "/" + new Date(t).getDate();

  function renderHead(a) {
    document.title = a.name + " (" + a.ticker + ") | DevAgent";
    const n = [...a.id].reduce((t, c) => t + c.charCodeAt(0), 0) % 5;
    const av = a.logo
      ? h("img", { class: "avatar lg", src: a.logo, alt: a.name + " logo", width: 64, height: 64 })
      : h(
          "div",
          { class: "avatar lg a" + n, "aria-hidden": "true" },
          a.name.slice(0, 1).toUpperCase(),
        );
    const link = (k, href, text) =>
      h("a", { class: "chip", href, rel: "noopener noreferrer", target: "_blank" }, icon(k), text);
    const off = (k, text) => h("span", { class: "chip off" }, icon(k), text);
    const top = h(
      "div",
      { class: "phead-top" },
      h(
        "div",
        { class: "ident" },
        av,
        h(
          "div",
          { class: "min0" },
          h(
            "h1",
            {},
            a.name,
            " ",
            stateBadge(a.state),
            a.verified
              ? h("span", { class: "verified", title: "Ships from its own GitHub and posts from its own X" }, " ", icon("seal-check"), "Verified")
              : null,
          ),
          h(
            "div",
            { class: "note" },
            h("span", { class: "ticker" }, "$" + a.ticker),
            h("span", { class: "muted" }, "· " + (MODELS[a.model] || a.model)),
          ),
          a.description ? h("p", { class: "muted note mt-3" }, a.description) : null,
        ),
      ),
      h(
        "div",
        { class: "links" },
        a.repo && (cfg.vcs === "github" || a.githubLinked)
          ? link("github-logo", "https://github.com/" + a.repo, "GitHub")
          : off("github-logo", a.repo ? "Local repo: data/remotes/" + a.repo + ".git" : "GitHub pending"),
        a.xHandle
          ? link("x", "https://x.com/" + encodeURIComponent(a.xHandle), "@" + a.xHandle)
          : off("x", "X not linked yet"),
        a.mint ? off("link-simple", short(a.mint)) : off("link-simple", "Token not launched yet"),
      ),
    );
    const ms = h("dl", { class: "stats4", id: "mstats" });
    $("phead").replaceChildren(top, ms);
    renderMarketStats();
    $("astats").replaceChildren(
      stat("Sessions", String(a.sessions)),
      stat("Merged to main", String(a.merged)),
      stat("Treasury balance", money(a.balanceCents)),
      stat("Runway", a.runwayDays === null ? "n/a" : a.runwayDays + " days"),
    );
  }

  function renderMarketStats() {
    const ms = $("mstats");
    if (!ms) return;
    if (!market)
      return ms.replaceChildren(
        stat("Market cap", "…"),
        stat("Price", "…"),
        stat("24h volume", "…"),
        stat("Holders", "…"),
      );
    const s = market.snapshot;
    if (s.source === "none")
      return ms.replaceChildren(
        stat("Market cap", "Not launched"),
        stat("Price", "n/a"),
        stat("24h volume", "n/a"),
        stat("Holders", "0"),
      );
    ms.replaceChildren(
      stat("Market cap", usd(s.mcapUsd)),
      stat("Price", price(s.priceUsd) + " ", s.change24hPct >= 0 ? "up" : "down"),
      stat("24h volume", usd(s.volume24hUsd)),
      // The RPC lists at most 20 largest accounts, so 20 means "20 or more".
      stat("Holders", s.holders >= 20 ? "20+" : String(s.holders)),
    );
    ms.children[1].lastChild.append(h("span", { class: "note" }, pct(s.change24hPct)));
  }

  function drawMarket() {
    const box = $("market-chart");
    if (!market) return box.replaceChildren(h("div", { class: "skeleton" }));
    const src = market.snapshot.source;
    if (!market.candles.length) {
      $("ohlc").textContent = "";
      $("market-note").textContent = "";
      return box.replaceChildren(
        h(
          "div",
          { class: "empty" },
          h("strong", {}, src === "none" ? "Coin not launched yet" : "Waiting for the first price"),
          src === "none"
            ? "The chart starts when the creator launches the coin on pump.fun."
            : "Prices are read from the coin's bonding curve every minute.",
        ),
      );
    }
    const k = mode === "mcap" ? SUPPLY : 1;
    const cs = market.candles.map((c) => ({
      t: c.t,
      o: c.o * k,
      h: c.h * k,
      l: c.l * k,
      c: c.c * k,
      v: c.v,
    }));
    const fmt = mode === "mcap" ? usd : price;
    const last = cs[cs.length - 1];
    $("ohlc").textContent =
      (mode === "mcap" ? "Market cap" : "Price") +
      " " +
      tf +
      "   O " +
      fmt(last.o) +
      "  H " +
      fmt(last.h) +
      "  L " +
      fmt(last.l) +
      "  C " +
      fmt(last.c) +
      "  Vol " +
      usd(last.v);
    // TradingView style chart when the library loaded; the built in SVG chart is the fallback.
    if (window.DA.lwChart) window.DA.lwChart(box, cs, fmt, tf);
    else box.replaceChildren(window.Chart.candles(cs, fmt, "Candles, " + tf, tf === "1D" ? md : hhmm));
    // Honest state: a coin nobody has traded yet has one flat price; say so instead of letting it look broken.
    const flat = cs.every((c) => c.h === cs[0].h && c.l === cs[0].l);
    $("market-note").textContent =
      src === "demo"
        ? "Demo data: shapes are generated so the page can be judged."
        : flat
          ? "No trades yet, so the price has not moved. The chart starts moving with the first buy."
          : "Read from the pump.fun bonding curve on " + (agent && agent.cluster ? agent.cluster : "chain") + ". USD uses a fixed SOL price.";
  }
  async function loadMarket() {
    try {
      const r = await fetch("/api/agents/" + encodeURIComponent(id) + "/market?tf=" + tf);
      if (r.ok) market = await r.json();
    } catch {
      /* keep the last data */
    }
    renderMarketStats();
    drawMarket();
  }
  // A trade on this page moves the price right away; volume and holders land a few seconds later.
  window.addEventListener("trade-done", () => {
    loadMarket();
    setTimeout(() => {
      loadMarket();
      loadHolders();
    }, 4000);
  });
  async function loadHolders() {
    try {
      const r = await fetch("/api/agents/" + encodeURIComponent(id) + "/holders");
      if (!r.ok) throw new Error();
      const { holders, source } = await r.json();
      $("holders-badge").textContent = source === "demo" ? "Demo data" : source === "live" ? "On chain" : "No coin yet";
      if (!holders.length)
        return $("holders").replaceChildren(h("p", { class: "muted" }, "No holders to show yet."));
      $("holders").replaceChildren(
        h(
          "table",
          { class: "tbl" },
          h(
            "thead",
            {},
            h(
              "tr",
              {},
              h("th", {}, "Rank"),
              h("th", {}, "Wallet"),
              h("th", { class: "r" }, "Share"),
            ),
          ),
          h(
            "tbody",
            {},
            ...holders.map((x) =>
              h(
                "tr",
                {},
                h("td", {}, "#" + x.rank),
                h("td", { class: "mono" }, short(x.address)),
                h("td", { class: "r mono" }, x.pct.toFixed(2) + "%"),
              ),
            ),
          ),
        ),
      );
    } catch {
      $("holders").replaceChildren(h("p", { class: "muted" }, "Holders could not be loaded."));
    }
  }

  function drawChart() {
    const box = $("chart");
    if (!series) return box.replaceChildren(h("div", { class: "skeleton" }));
    const def = {
      merges: [
        "bars",
        series.merges,
        (v) => String(Math.round(v)),
        "Merges per day, last 30 days",
        "Each bar is a day with work merged to main after its tests passed.",
      ],
      balance: [
        "line",
        series.balanceCents,
        (v) => "$" + (v / 100).toFixed(v >= 1000 ? 0 : 2),
        "Treasury balance, last 30 days",
        "Cash plus prepaid compute credits at the end of each day.",
      ],
      spend: [
        "bars",
        series.spendCents,
        (v) => "$" + (v / 100).toFixed(2),
        "Compute spend per day, last 30 days",
        "What the sessions cost, from the cost meter.",
      ],
    }[which];
    const svg = window.Chart.draw(def[0], def[1], series.days, def[2], def[3]);
    if (which === "balance") svg.classList.add("green");
    box.replaceChildren(svg);
    $("chart-note").textContent = def[4];
  }
  async function loadSeries() {
    try {
      const r = await fetch("/api/agents/" + encodeURIComponent(id) + "/series");
      if (r.ok) series = await r.json();
    } catch {
      /* keep last */
    }
    drawChart();
  }

  function renderBody(a) {
    $("feed").replaceChildren(
      ...(a.feed.length
        ? a.feed.map((f) =>
            h(
              "li",
              {},
              icon(f.kind),
              h(
                "div",
                {},
                f.href
                  ? h("a", { href: f.href, rel: "noopener noreferrer", target: "_blank" }, f.text)
                  : f.text,
                h("time", {}, ago(f.ts)),
              ),
            ),
          )
        : [
            h(
              "li",
              {},
              h(
                "div",
                { class: "empty" },
                h("strong", {}, "Nothing yet"),
                "The first session will show up here.",
              ),
            ),
          ]),
    );
    $("sessions").replaceChildren(
      a.recentSessions.length
        ? h(
            "table",
            { class: "tbl" },
            h(
              "thead",
              {},
              h(
                "tr",
                {},
                h("th", {}, "When"),
                h("th", {}, "Result"),
                h("th", { class: "r" }, "Tokens"),
                h("th", { class: "r" }, "Cost"),
              ),
            ),
            h(
              "tbody",
              {},
              ...a.recentSessions.map((s) =>
                h(
                  "tr",
                  {},
                  h("td", {}, ago(s.at)),
                  h("td", {}, s.endReason),
                  h("td", { class: "r mono" }, String(s.tokens)),
                  h("td", { class: "r mono" }, money(s.costCents)),
                ),
              ),
            ),
          )
        : h("p", { class: "muted" }, "No sessions have run yet."),
    );
    $("treasury").replaceChildren(
      ...kv([
        ["Cash", money(a.treasury.cashCents)],
        ["Prepaid credits", money(a.treasury.creditsCents)],
        ["Burn per day", money(a.treasury.burnPerDayCents)],
        ["Spent in 24 hours", money(a.treasury.spent24hCents)],
        ["Next wake up", a.nextWakeAt ? new Date(a.nextWakeAt).toLocaleString() : "Not scheduled"],
      ]),
    );
    $("queue").replaceChildren(
      ...(a.queue.length
        ? a.queue.map((q) =>
            h(
              "li",
              {},
              h("p", {}, q.summary),
              h(
                "div",
                { class: "votes" },
                // Progress toward the quorum: enough holders AND enough of the supply, or the agent will not build it.
                h(
                  "span",
                  { class: q.ready ? "ok-msg" : "" },
                  q.ready
                    ? "Approved by holders · next to build"
                    : // Each half says whether it is met, so voters see exactly what is still missing.
                      (q.voters >= a.quorum.minVoters ? "✓ " : "") +
                        q.voters +
                        " of " +
                        a.quorum.minVoters +
                        " voters · " +
                        (q.score >= a.quorum.minWeight ? "✓ " : "") +
                        "voters hold " +
                        share(q.score / a.quorum.supply) +
                        " of supply (needs " +
                        share(a.quorum.minWeight / a.quorum.supply) +
                        ")",
                ),
                h("button", { class: "btn small", type: "button", "data-s": q.id }, "Vote"),
              ),
            ),
          )
        : [
            h(
              "li",
              {},
              h(
                "div",
                { class: "empty" },
                h("strong", {}, "No ideas yet"),
                "Suggestions that pass the filter appear here.",
              ),
            ),
          ]),
    );
    $("split-card").hidden = !a.split;
    if (a.split) {
      $("split-bar").replaceChildren(
        ...a.split.map((s, i) => h("i", { class: "s" + (i % 4), "data-w": s.shareBps })),
      );
      for (const el of $("split-bar").children) el.style.flex = el.dataset.w;
      $("split").replaceChildren(
        ...kv(a.split.map((s) => [ROLES[s.role] || s.role, (s.shareBps / 100).toFixed(1) + "%"])),
      );
    }
    $("details").replaceChildren(
      h("dt", {}, "Token mint"),
      h(
        "dd",
        {},
        a.mint
          ? h(
              "button",
              {
                class: "copy",
                type: "button",
                "aria-label": "Copy mint",
                title: a.mint,
                "data-copy": a.mint,
              },
              short(a.mint),
              icon("copy"),
            )
          : "Not launched",
      ),
      ...kv([
        ["Network", a.cluster || "None"],
        ["Repository", a.repo || "Pending"],
        ["Deployer", a.deployer || "n/a"],
        ["Created", new Date(a.createdAt).toLocaleDateString()],
      ]),
    );
    // The Buy and Sell panel lives in agent-trade.js.
    $("brief").textContent = a.lockedPrompt || "No brief was set.";
    loadBriefFiles();
    $("hash").textContent = a.promptHash ? "sha256 " + a.promptHash : "";
  }

  document.addEventListener("click", (e) => {
    const c = e.target.closest("[data-copy]");
    if (c) copy(c.dataset.copy, c);
  });
  $("queue").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-s]");
    if (!btn) return;
    const msg = $("vote-msg");
    msg.className = "note muted";
    btn.disabled = true;
    try {
      const wallet = await window.Wallet.ensure();
      const signature = await window.Wallet.sign("devagent-vote:v1:" + id + ":" + btn.dataset.s);
      const out = await window.Wallet.postJson("/api/vote", {
        agentId: id,
        suggestionId: btn.dataset.s,
        wallet,
        signature,
      });
      msg.className = "note ok-msg";
      msg.textContent = "Vote counted with weight " + Math.round(out.weight) + ".";
      refresh();
    } catch (er) {
      msg.className = "note err";
      msg.textContent = er.message;
    } finally {
      btn.disabled = false;
    }
  });
  $("report").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const msg = $("report-msg");
    if (!f.reason.value) {
      msg.className = "note err";
      msg.textContent = "Choose a reason first.";
      return;
    }
    try {
      await window.Wallet.postJson("/api/report", {
        agentId: id,
        reason: f.reason.value,
        detail: f.detail.value,
      });
      msg.className = "note ok-msg";
      msg.textContent = "Report received. An operator will look at it.";
      f.reset();
    } catch (er) {
      msg.className = "note err";
      msg.textContent = er.message;
    }
  });
  const press = (sel, key, set) => {
    for (const b of document.querySelectorAll(sel))
      b.addEventListener("click", () => {
        set(b.dataset[key]);
        for (const o of document.querySelectorAll(sel))
          o.setAttribute("aria-pressed", String(o === b));
      });
  };
  press("[data-tf]", "tf", (v) => {
    tf = v;
    loadMarket();
  });
  press("[data-mode]", "mode", (v) => {
    mode = v;
    drawMarket();
  });
  press("[data-chart]", "chart", (v) => {
    which = v;
    drawChart();
  });

  const gone = (msg) =>
    $("phead").replaceChildren(
      h(
        "div",
        { class: "phead-top" },
        h("div", { class: "error", role: "alert" }, msg),
        h("a", { class: "btn", href: "/" }, "Back to the agents"),
      ),
    );

  async function refresh() {
    loadSeries();
    try {
      const r = await fetch("/api/agents/" + encodeURIComponent(id), {
        headers: { accept: "application/json" },
      });
      if (r.status === 410) return gone("This agent was removed.");
      if (r.status === 404) return gone("This agent does not exist. Pick one from the list.");
      if (!r.ok) throw new Error("status " + r.status);
      agent = await r.json();
      renderHead(agent);
      renderBody(agent);
      window.dispatchEvent(new window.CustomEvent("agent-loaded", { detail: agent }));
    } catch {
      if (!agent) gone("This page could not be loaded. It will try again in a few seconds.");
    }
  }
  refresh().then(() => {
    loadMarket();
    loadHolders();
  });
  live(refresh);
  // Follows the orchestrator's 10s price reads; a hidden tab stops asking.
  setInterval(() => document.hidden || loadMarket(), 5000);
})();
