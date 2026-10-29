"use strict";
// Agent page: data tabs, and the creator's setup checklist (step 2 and 3 of the launch wizard).
(function () {
  const { h, $ } = window.DA;
  const { localStorage, URLSearchParams } = window;
  const id = decodeURIComponent(location.pathname.split("/").pop() || "");

  // ---- tabs: arrow keys move between them, the panel follows ----
  for (const box of document.querySelectorAll("[data-tabs]")) {
    const tabs = [...box.querySelectorAll('[role="tab"]')];
    const show = (t, focus) => {
      for (const x of tabs) {
        const on = x === t;
        x.setAttribute("aria-selected", String(on));
        x.tabIndex = on ? 0 : -1;
        box.querySelector('[data-panel="' + x.dataset.tab + '"]').hidden = !on;
      }
      if (focus) t.focus();
    };
    tabs.forEach((t, i) => {
      t.addEventListener("click", () => show(t));
      t.addEventListener("keydown", (e) => {
        const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (d) show(tabs[(i + d + tabs.length) % tabs.length], true);
      });
    });
    show(tabs[0]);
  }

  // ---- setup checklist, creator only ----
  let agent = null;
  let accounts = null;
  let walletSol = null;
  const hideKey = "da-setup-hidden-" + id;
  const hidden = () => {
    try {
      return localStorage.getItem(hideKey) === "1";
    } catch {
      return false;
    }
  };
  const icon = (k) => {
    const src = $("icon-tpl").content.querySelector('[data-k="' + k + '"]');
    return src ? src.cloneNode(true) : h("i", {});
  };
  const goTo = (el) => {
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  function render() {
    const box = $("setup");
    const mine = agent && window.Wallet.address() && agent.deployerAddress === window.Wallet.address();
    if (!mine || hidden()) return void (box.hidden = true);
    // A connection that stopped working counts as not done: the checklist asks to reconnect it.
    const gh = accounts && !accounts.github.needsReconnect && accounts.github.account;
    const x = accounts && !accounts.x.needsReconnect && accounts.x.account;
    const coin = !!agent.mint && agent.splitSet;
    const funded = agent.balanceCents > 0 || (walletSol !== null && walletSol > 0);
    const steps = [
      { done: true, title: "Create the agent", text: "Its brief is locked and its wallet is ready." },
      {
        done: !!gh,
        title: gh ? "GitHub connected as @" + gh : "Connect its GitHub",
        text: "Every session pushes to its own repository. Connect it before the first session.",
        act: () => window.DA.connectAccount && window.DA.connectAccount("github"),
        label: "Connect GitHub",
        available: accounts ? accounts.github.available : true,
      },
      {
        done: !!x,
        title: x ? "X connected as @" + x : "Connect its X",
        text: "It posts a short update after each session, and mentions become ideas.",
        act: () => window.DA.connectAccount && window.DA.connectAccount("x"),
        label: "Connect X",
        available: accounts ? accounts.x.available : true,
      },
      {
        done: coin,
        title: coin ? "Coin launched" : agent.mint ? "Set the fee split" : "Launch its coin",
        text: "Two signatures on pump.fun: the coin, then its fee split, which never changes.",
        act: () => {
          goTo($("launch-card"));
          $("launch-btn").click();
        },
        label: agent.mint ? "Set the split" : "Launch coin",
        available: true,
      },
      {
        done: funded,
        title: funded ? "Wallet funded" : "Fund its wallet",
        text: "Any SOL in its wallet pays for its AI. Fees take over once the coin trades.",
        act: () => goTo($("wallet")),
        label: "Show wallet",
        available: true,
      },
    ];
    const doneCount = steps.filter((s) => s.done).length;
    if (doneCount === steps.length) return void (box.hidden = true);
    box.hidden = false;
    $("setup-bar").style.transform = "scaleX(" + doneCount / steps.length + ")";
    $("setup-sub").textContent = doneCount + " of " + steps.length + " done. Only you see this.";
    // Highlight the first step the creator can actually do now (accounts may not be set up on this site yet).
    const next = steps.find((s) => !s.done && s.available !== false) || steps.find((s) => !s.done);
    $("setup-list").replaceChildren(
      ...steps.map((s) =>
        h(
          "li",
          { class: s.done ? "done" : s === next ? "next" : "" },
          h("span", { class: "setup-mark", "aria-hidden": "true" }, s.done ? icon("check") : ""),
          h("div", { class: "min0" }, h("strong", {}, s.title), h("p", { class: "muted" }, s.text)),
          !s.done && s.act
            ? s.available
              ? h(
                  "button",
                  { class: "btn small" + (s === next ? " primary" : ""), type: "button", "data-step": steps.indexOf(s) },
                  s.label,
                )
              : h("span", { class: "note muted" }, "Not set up on this site yet")
            : null,
        ),
      ),
    );
    $("setup-list").onclick = (e) => {
      const b = e.target.closest("[data-step]");
      if (b) steps[Number(b.dataset.step)].act();
    };
  }

  $("setup-hide").addEventListener("click", () => {
    try {
      localStorage.setItem(hideKey, "1");
    } catch {
      /* not remembered */
    }
    $("setup").hidden = true;
  });
  window.addEventListener("agent-loaded", (e) => {
    agent = e.detail;
    render();
  });
  window.addEventListener("accounts-loaded", (e) => {
    accounts = e.detail;
    render();
  });
  window.Wallet.onChange(render);
  fetch("/api/agents/" + encodeURIComponent(id) + "/wallet")
    .then((r) => r.json())
    .then((w) => {
      walletSol = typeof w.sol === "number" ? w.sol : null;
      render();
    })
    .catch(() => {});

  // Arriving from the launch wizard: bring the checklist into view.
  if (new URLSearchParams(location.search).get("setup") === "1") {
    try {
      localStorage.removeItem(hideKey);
    } catch {
      /* ignore */
    }
    window.addEventListener("agent-loaded", () => setTimeout(() => goTo($("setup")), 300), { once: true });
  }
})();
