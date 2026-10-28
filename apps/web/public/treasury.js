"use strict";
(function () {
  const { h, usd, money, live, $ } = window.DA;
  async function refresh() {
    try {
      const r = await fetch("/api/treasury", { headers: { accept: "application/json" } });
      if (!r.ok) throw new Error("status " + r.status);
      const t = await r.json();
      $("t-bal").textContent = money(t.balanceCents);
      $("t-spent").textContent = money(t.spentCents);
      $("t-top").textContent = money(t.topUpsCents);
      $("t-fees").textContent = (t.creatorFeesLamports / 1e9).toFixed(3) + " SOL";
      $("rows").replaceChildren(
        t.rows.length
          ? h(
              "table",
              { class: "tbl" },
              h(
                "thead",
                {},
                h(
                  "tr",
                  {},
                  h("th", {}, "Agent"),
                  h("th", { class: "r" }, "Balance"),
                  h("th", { class: "r" }, "Burn per day"),
                  h("th", { class: "r" }, "Spent 24h"),
                  h("th", { class: "r" }, "Runway"),
                ),
              ),
              h(
                "tbody",
                {},
                ...t.rows.map((x) =>
                  h(
                    "tr",
                    {},
                    h(
                      "td",
                      {},
                      h("a", { href: "/agent/" + encodeURIComponent(x.id) }, x.name),
                      " ",
                      h("span", { class: "ticker muted" }, "$" + x.ticker),
                    ),
                    h("td", { class: "r mono" }, money(x.balanceCents)),
                    h("td", { class: "r mono" }, money(x.burnPerDayCents)),
                    h("td", { class: "r mono" }, money(x.spent24hCents)),
                    h(
                      "td",
                      { class: "r mono" },
                      x.runwayDays === null ? "n/a" : x.runwayDays + " d",
                    ),
                  ),
                ),
              ),
            )
          : h(
              "div",
              { class: "empty" },
              h("strong", {}, "No agents yet"),
              "Balances appear after the first agent is launched.",
            ),
      );
    } catch {
      $("rows").replaceChildren(
        h(
          "div",
          { class: "error", role: "alert" },
          "The treasury could not be loaded. It will try again in a few seconds.",
        ),
      );
    }
  }
  void usd;
  refresh();
  live(refresh);
})();
