"use strict";
// Buy and sell the agent's coin from your own wallet. The server builds the pump.fun transaction, your wallet signs,
// the server relays it only if it is the one it built. Live quote while typing (debounced).
(function () {
  const { h, $ } = window.DA;
  const { setTimeout, clearTimeout } = window;
  const id = decodeURIComponent(location.pathname.split("/").pop() || "");
  const LAMPORTS = 1e9;
  const TOKEN = 1e6; // pump.fun coins use 6 decimals
  let side = "buy";
  let slippage = 5;
  let agent = null;
  let pos = null; // { lamports, tokensRaw }
  let busy = false;
  let quoteTimer = null;
  let quoteSeq = 0;

  const fmtTok = (n) =>
    n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : n.toFixed(2);
  const say = (t, kind) => {
    $("tp-msg").className = "note " + (kind === "ok" ? "ok-msg" : kind === "err" ? "err" : "muted");
    $("tp-msg").replaceChildren(...(Array.isArray(t) ? t : [t]));
  };
  const amountRaw = () => {
    const v = Number(($("tp-amount").value || "").replace(",", "."));
    if (!(v > 0)) return null;
    return String(Math.floor(v * (side === "buy" ? LAMPORTS : TOKEN)));
  };
  const explorer = (sig) =>
    "https://explorer.solana.com/tx/" + encodeURIComponent(sig) + (agent && agent.cluster === "mainnet-beta" ? "" : "?cluster=" + (agent ? agent.cluster : "devnet"));

  function quick() {
    const opts =
      side === "buy"
        ? [["0.1", "0.1 SOL"], ["0.5", "0.5 SOL"], ["1", "1 SOL"]]
        : [["25", "25%"], ["50", "50%"], ["100", "Max"]];
    $("tp-quick").replaceChildren(...opts.map(([v, label]) => h("button", { type: "button", "data-q": v }, label)));
  }

  function renderBalance() {
    if (!pos) return void ($("tp-bal").textContent = "");
    const tokens = Number(pos.tokensRaw) / TOKEN;
    $("tp-bal").textContent =
      "You hold " + fmtTok(tokens) + " $" + (agent ? agent.ticker : "") + " · " + (pos.lamports / LAMPORTS).toFixed(3) + " SOL";
  }

  function renderButton() {
    const go = $("tp-go");
    const wallet = window.Wallet.address();
    const ready = agent && agent.mint && agent.splitSet;
    // Disabled (and looking it) until the coin is tradeable; connecting the wallet is always allowed.
    go.disabled = busy || !ready || (!!wallet && !amountRaw());
    go.textContent = !ready
      ? "Opens after the launch"
      : !wallet
        ? "Connect wallet"
        : busy
          ? "Confirm in your wallet"
          : (side === "buy" ? "Buy $" : "Sell $") + agent.ticker;
    $("tp-unit").textContent = side === "buy" ? "SOL" : "$" + (agent ? agent.ticker : "");
  }

  async function loadPosition() {
    const w = window.Wallet.address();
    if (!w || !agent || !agent.mint) return void ((pos = null), renderBalance());
    try {
      const r = await fetch("/api/agents/" + encodeURIComponent(id) + "/position?wallet=" + encodeURIComponent(w));
      if (r.ok) pos = await r.json();
    } catch {
      /* keep the last balance */
    }
    renderBalance();
  }

  // The quote already built the transaction; Buy reuses it while it is fresh, so the wallet opens at once.
  let last = null;
  const FRESH_MS = 20000;
  const prepKey = () => [window.Wallet.address(), side, amountRaw(), slippage].join("|");
  async function prepare() {
    const key = prepKey();
    const prep = await window.Wallet.postJson("/api/trade/prepare", {
      agentId: id,
      wallet: window.Wallet.address(),
      side,
      amount: amountRaw(),
      slippage,
    });
    last = { key, at: Date.now(), prep };
    return prep;
  }
  const freshPrep = () => (last && last.key === prepKey() && Date.now() - last.at < FRESH_MS ? last.prep : null);

  // Live estimate: a fresh prepare after typing stops, so the number shown is what the chain would do now.
  function requote() {
    clearTimeout(quoteTimer);
    renderButton();
    $("tp-out").textContent = "";
    if (!amountRaw() || !window.Wallet.address() || !agent || !agent.mint) return;
    const seq = ++quoteSeq;
    last = null;
    quoteTimer = setTimeout(async () => {
      $("tp-out").textContent = "Getting a price…";
      try {
        const q = (await prepare()).quote;
        if (seq !== quoteSeq) return;
        $("tp-out").textContent =
          side === "buy"
            ? "You get about " + fmtTok(Number(q.outRaw) / TOKEN) + " $" + agent.ticker
            : "You get about " + (Number(q.outRaw) / LAMPORTS).toFixed(4) + " SOL";
      } catch (e) {
        if (seq === quoteSeq) $("tp-out").textContent = e.message;
      }
    }, 250);
  }

  async function trade() {
    if (!window.Wallet.address()) {
      try {
        await window.Wallet.ensure();
      } catch {
        /* closed */
      }
      return;
    }
    if (busy || !amountRaw()) return;
    busy = true;
    renderButton();
    try {
      let prep = freshPrep();
      if (!prep) {
        say("Preparing the trade…");
        prep = await prepare();
      }
      last = null; // one signature per prepared transaction
      say("Approve the trade in your wallet.");
      const signed = await window.Wallet.signTransaction(prep.tx);
      say("Sent. Waiting for the network…");
      const out = await window.Wallet.postJson("/api/trade/submit", { agentId: id, wallet: window.Wallet.address(), tx: signed });
      say(
        [
          (side === "buy" ? "Bought. " : "Sold. "),
          h("a", { href: explorer(out.signature), rel: "noopener noreferrer", target: "_blank" }, "View transaction"),
        ],
        "ok",
      );
      $("tp-amount").value = "";
      $("tp-out").textContent = "";
      window.dispatchEvent(new window.CustomEvent("trade-done"));
      loadPosition();
    } catch (e) {
      say(e.message || "The trade did not go through.", "err");
    } finally {
      busy = false;
      renderButton();
    }
  }

  for (const b of document.querySelectorAll(".tp-side [data-side]"))
    b.addEventListener("click", () => {
      side = b.dataset.side;
      for (const o of document.querySelectorAll(".tp-side [data-side]")) o.setAttribute("aria-selected", String(o === b));
      $("tp-amount").value = "";
      quick();
      requote();
    });
  for (const b of document.querySelectorAll("[data-slip]"))
    b.addEventListener("click", () => {
      slippage = Number(b.dataset.slip);
      for (const o of document.querySelectorAll("[data-slip]")) o.setAttribute("aria-pressed", String(o === b));
      requote();
    });
  $("tp-quick").addEventListener("click", (e) => {
    const b = e.target.closest("[data-q]");
    if (!b) return;
    if (side === "buy") $("tp-amount").value = b.dataset.q;
    else if (pos) {
      const raw = (BigInt(pos.tokensRaw) * BigInt(b.dataset.q)) / 100n;
      $("tp-amount").value = String(Number(raw) / TOKEN);
    }
    requote();
  });
  $("tp-amount").addEventListener("input", requote);
  $("tp-go").addEventListener("click", trade);

  window.addEventListener("agent-loaded", (e) => {
    const first = !agent;
    agent = e.detail;
    $("tp-sym").textContent = "$" + agent.ticker;
    renderButton();
    if (first) loadPosition();
  });
  window.Wallet.onChange(() => {
    renderButton();
    loadPosition();
    requote();
  });
  quick();
  renderButton();
})();
