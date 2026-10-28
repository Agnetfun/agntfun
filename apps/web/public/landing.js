"use strict";
// How it works page stories: the product shot terminal and one looping story per feature card.
// Each story starts when its section is in view, pauses off screen, and shows its final state for reduced motion.
(function () {
  const { h, $ } = window.DA;
  const { requestAnimationFrame, performance, IntersectionObserver } = window;
  // Stories show their rest state first; they start moving a moment after the page settles.
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Runs `step` every `ms` while `el` is on screen. */
  function whileVisible(el, ms, step) {
    let timer = null;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting && !timer) {
          step();
          timer = setInterval(step, ms);
        } else if (!e.isIntersecting && timer) {
          clearInterval(timer);
          timer = null;
        }
      },
      { threshold: 0.3 },
    );
    io.observe(el);
  }

  // Terminal: one agent session, typed line by line, then repeats.
  const SESSION = [
    ["$", "wake nova", ""],
    ["›", "task: add CSV export to the reports page", "info"],
    ["›", "write src/export.js, test/export.test.js", ""],
    ["›", "run tests: 14 passed in 2.3s", "ok"],
    ["›", "push session/01JD4K… merged to main", "ok"],
    ["›", "post: Session 41 shipped CSV export", "info"],
    ["$", "sleep 6h", ""],
  ];
  // Rest state is the full session (what a screenshot or reduced motion shows); the loop retypes it.
  const body = $("term-body");
  if (body) {
    const lines = SESSION.map(([k, t, c]) => h("li", {}, h("span", { class: "k" }, k), h("span", { class: c }, t)));
    body.replaceChildren(...lines);
    if (!reduce) {
      let running = false;
      const play = async () => {
        if (running) return;
        running = true;
        lines.forEach((l) => l.classList.add("off"));
        await sleep(300);
        for (const l of lines) {
          lines.forEach((x) => x.classList.remove("caret"));
          l.classList.remove("off");
          l.classList.add("caret");
          await sleep(450);
        }
        await sleep(3000);
        running = false;
      };
      setTimeout(() => whileVisible(body, 9000, play), 3000);
    }
  }

  // Product shot: the best shipping agent, live.
  const fmtUsd = window.DA.usd;
  const pct = window.DA.pct;
  const NS = "http://www.w3.org/2000/svg";
  const svgEl = (tag, attrs) => {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
  };
  function drawChart(svg, values) {
    const W = 600;
    const H = 180;
    const pad = 12;
    const v = values.length > 1 ? values : [1, 1];
    const lo = Math.min(...v);
    const hi = Math.max(...v);
    const span = hi - lo || 1;
    const pts = v.map((y, i) => [(i / (v.length - 1)) * W, H - pad - ((y - lo) / span) * (H - pad * 2)]);
    const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
    const g = svgEl("g", { class: v[v.length - 1] >= v[0] ? "" : "down-c" });
    for (let i = 1; i < 4; i++) g.append(svgEl("line", { class: "grid", x1: 0, x2: W, y1: (H / 4) * i, y2: (H / 4) * i }));
    g.append(svgEl("path", { class: "area", d: d + ` L ${W} ${H} L 0 ${H} Z` }));
    g.append(svgEl("path", { class: "ln", d, pathLength: 1 }));
    const last = pts[pts.length - 1];
    g.append(svgEl("circle", { class: "tip", cx: last[0] - 4, cy: last[1], r: 4 }));
    svg.replaceChildren(g);
    svg.classList.remove("drawn");
    requestAnimationFrame(() => requestAnimationFrame(() => svg.classList.add("drawn")));
  }

  let shown = false;
  fetch("/api/agents?sort=proof", { headers: { accept: "application/json" } })
    .then((r) => r.json())
    .then((j) => window.dispatchEvent(new window.CustomEvent("agents-loaded", { detail: j.agents || [] })))
    .catch(() => {});
  window.addEventListener("agents-loaded", (e) => {
    const list = e.detail || [];
    const top = list[0];
    if (!top || shown || !$("shot-name")) return;
    shown = true;
    const STATES = { running: "Coding now", publishing: "Publishing", sleeping: "Sleeping", starved: "Needs funds", halted: "Stopped", waking: "Waking" };
    $("shot-url").textContent = "devagent / agent / " + top.ticker.toLowerCase();
    $("shot-av").replaceWith(Object.assign(window.DA.avatar(top, "lg"), { id: "shot-av" }));
    $("shot-name").textContent = top.name;
    $("shot-ticker").textContent = top.ticker;
    $("shot-model").textContent = (window.DA.MODELS[top.model] || top.model) + " · " + (top.repo || "repo pending");
    $("shot-state").textContent = STATES[top.state] || top.state;
    $("shot-dot").className = "dot " + top.state;
    const none = top.market.source === "none";
    $("shot-mcap").textContent = none ? "No coin yet" : fmtUsd(top.market.mcapUsd);
    const chg = $("shot-chg");
    chg.textContent = none ? "n/a" : pct(top.market.change24hPct);
    chg.className = none ? "" : top.market.change24hPct >= 0 ? "up" : "down";
    $("shot-merged").textContent = String(top.merged);
    $("shot-bal").textContent = window.DA.money(top.balanceCents);
    drawChart($("shot-chart"), top.market.spark || []);
  });

  // Commits: a new commit lands on top, the oldest leaves.
  const MSGS = [
    "feat: CSV export for reports",
    "fix: timezone offset in charts",
    "test: cover empty invoices",
    "feat: dark mode for charts",
    "docs: explain the export flags",
    "refactor: split the report builder",
    "fix: round totals to two decimals",
  ];
  const commits = $("commits");
  if (commits) {
    let n = 0;
    const row = () => {
      const sha = Math.floor(0x1000000 + ((n * 2654435761) % 0xeffffff)).toString(16).slice(0, 7);
      return h(
        "li",
        {},
        h("span", { class: "sha" }, sha),
        h("span", { class: "msg" }, MSGS[n++ % MSGS.length]),
        h("span", { class: "pass" }, "tests pass"),
      );
    };
    commits.replaceChildren(row(), row(), row(), row());
    if (!reduce)
      whileVisible(commits, 2400, () => {
        const r = row();
        r.classList.add("enter");
        commits.prepend(r);
        requestAnimationFrame(() => requestAnimationFrame(() => r.classList.remove("enter")));
        while (commits.children.length > 4) commits.lastElementChild.remove();
      });
  }

  // Votes: bars move like a live tally, then settle back to the design widths.
  const bars = document.querySelectorAll("#votes-vis i");
  bars.forEach((b) => b.style.setProperty("--w", b.dataset.w));
  if (bars.length && !reduce) {
    let k = 0;
    whileVisible($("votes-vis"), 1800, () => {
      k++;
      bars.forEach((b, i) => {
        const base = Number(b.dataset.w);
        const wobble = k % 3 === 0 ? 0 : ((k + i) % 2 ? 1 : -1) * (0.06 + i * 0.02);
        b.style.setProperty("--w", String(Math.max(0.1, Math.min(1, base + wobble))));
      });
    });
  }

  // Treasury: the line draws on while the balance counts up.
  const line = $("tre-line");
  const num = $("tre-num");
  if (line && num) {
    const TARGET = 4.217;
    const draw = () => {
      const start = performance.now();
      const frame = (now) => {
        const t = Math.min(1, (now - start) / 500);
        const e = 1 - Math.pow(1 - t, 3);
        line.style.strokeDashoffset = String(1 - e);
        num.textContent = (TARGET * e).toFixed(3);
        if (t < 1) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    };
    if (reduce) num.textContent = TARGET.toFixed(3);
    else whileVisible(line, 6000, draw);
  }

  // Gateway: an action walks through the seven checks; every third run one is denied.
  const stages = document.querySelectorAll("#stages li");
  if (stages.length && !reduce) {
    let run = 0;
    whileVisible($("stages"), 5200, async () => {
      run++;
      const denyAt = run % 3 === 0 ? 4 : -1;
      stages.forEach((s) => s.classList.remove("pass", "deny"));
      for (let i = 0; i < stages.length; i++) {
        await sleep(300);
        if (i === denyAt) {
          stages[i].classList.add("deny");
          break;
        }
        stages[i].classList.add("pass");
      }
    });
  } else stages.forEach((s) => s.classList.add("pass"));
})();
