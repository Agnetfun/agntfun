"use strict";
// Burns: buyback and burn of the platform token, plus infra top ups, straight from the event log.
(function () {
  const { h, ago, short, $ } = window.DA;
  const KIND = { burned: "Bought and burned", to_infra: "Infra top up", skipped: "Skipped" };
  const fmt = (raw) => {
    const n = Number(raw) / 1e6; // pump.fun coins use 6 decimals
    return n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : n.toFixed(0);
  };
  async function load() {
    try {
      const r = await fetch("/api/burns", { headers: { accept: "application/json" } });
      if (!r.ok) throw new Error();
      const d = await r.json();
      $("b-tokens").textContent = fmt(d.totals.tokensBurned);
      $("b-sol").textContent = d.totals.buybackSol.toFixed(3);
      $("b-infra").textContent = d.totals.infraSol.toFixed(3);
      if (!d.token)
        $("burn-sub").textContent =
          "The platform token is not launched yet. Until then the buyback share keeps infra funded and the rest is saved.";
      const tx = (sig) =>
        sig
          ? h(
              "a",
              {
                href: "https://explorer.solana.com/tx/" + encodeURIComponent(sig) + (d.cluster === "mainnet-beta" ? "" : "?cluster=" + d.cluster),
                rel: "noopener noreferrer",
                target: "_blank",
                class: "mono",
              },
              short(sig),
            )
          : "n/a";
      $("burns").replaceChildren(
        h("thead", {}, h("tr", {}, h("th", {}, "When"), h("th", {}, "What"), h("th", { class: "r" }, "SOL"), h("th", { class: "r" }, "Tokens"), h("th", { class: "r" }, "Transaction"))),
        h(
          "tbody",
          {},
          ...(d.items.length
            ? d.items.map((i) =>
                h(
                  "tr",
                  {},
                  h("td", { class: "muted" }, ago(i.ts)),
                  h("td", {}, KIND[i.kind] || i.kind, i.note ? h("small", { class: "muted" }, " · " + i.note) : null),
                  h("td", { class: "r mono" }, i.sol ? i.sol.toFixed(3) : "n/a"),
                  h("td", { class: "r mono" }, i.tokens ? fmt(i.tokens) : "n/a"),
                  h("td", { class: "r" }, tx(i.signature)),
                ),
              )
            : [h("tr", {}, h("td", { colspan: 5 }, h("div", { class: "empty" }, h("strong", {}, "Nothing burned yet"), "The first buyback runs once coins have paid out fees.")))]),
        ),
      );
    } catch {
      $("burns").replaceChildren(h("tbody", {}, h("tr", {}, h("td", {}, "Could not load the activity. Try again in a moment."))));
    }
  }
  load();
})();
