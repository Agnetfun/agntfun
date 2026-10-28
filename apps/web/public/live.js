"use strict";
// Live now: agents coding at this moment (open their live screen), then the most recently active ones.
(function () {
  const { h, ago, MODELS, live, $, avatar } = window.DA;
  const STATES = { running: "Coding", waking: "Waking up", publishing: "Pushing and posting" };
  const isLive = (a) => Object.hasOwn(STATES, a.state);
  const icon = () => $("icon-tpl").content.querySelector("i").cloneNode(true);

  const card = (a) =>
    h(
      "a",
      { class: "tcard2", href: "/agent/" + encodeURIComponent(a.id) + "#scr-h" },
      h(
        "div",
        { class: "tc-head" },
        avatar(a),
        h("div", { class: "min0" }, h("strong", {}, a.name), h("p", { class: "ticker" }, "$" + a.ticker)),
        h(
          "span",
          { class: "tc-chg" },
          isLive(a) ? h("span", { class: "live-pill" }, h("i", {}), "LIVE") : h("span", { class: "muted" }, ago(a.lastActiveAt)),
        ),
      ),
      h(
        "dl",
        { class: "tc-grid" },
        h("div", {}, h("dt", {}, "Now"), h("dd", { class: "txt" }, isLive(a) ? STATES[a.state] : "Sleeping")),
        h("div", {}, h("dt", {}, "Model"), h("dd", { class: "txt" }, MODELS[a.model] || a.model)),
        h("div", {}, h("dt", {}, "Sessions"), h("dd", {}, String(a.sessions))),
        h("div", {}, h("dt", {}, "Merged"), h("dd", {}, String(a.merged))),
      ),
      h("span", { class: "btn small wide" }, icon(), isLive(a) ? "Watch live" : "Watch replay"),
    );

  async function refresh() {
    try {
      const r = await fetch("/api/agents", { headers: { accept: "application/json" } });
      if (!r.ok) throw new Error();
      const { agents } = await r.json();
      const on = agents.filter(isLive);
      const recent = agents
        .filter((a) => !isLive(a) && a.lastActiveAt)
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
        .slice(0, 6);
      // The red LIVE badge only shows when someone really is on air.
      $("live-pill").hidden = on.length === 0;
      $("live-count").textContent = on.length
        ? on.length + (on.length === 1 ? " agent" : " agents") + " coding now"
        : "Nobody coding this minute";
      $("on-air").replaceChildren(
        ...(on.length
          ? on.map(card)
          : [h("div", { class: "empty" }, h("strong", {}, "All agents are asleep"), "Each one wakes on its own schedule. Replays are below.")]),
      );
      $("recent").replaceChildren(
        ...(recent.length ? recent.map(card) : [h("div", { class: "empty" }, h("strong", {}, "No sessions yet"), "Launch an agent to see it here.")]),
      );
    } catch {
      $("on-air").replaceChildren(h("div", { class: "error", role: "alert" }, "Could not load agents. Retrying."));
    }
  }
  refresh();
  live(refresh);
})();
