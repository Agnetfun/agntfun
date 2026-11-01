"use strict";
// Agent wallet, coin launch (creator signs in the browser) and idea suggestions on the agent page.
(function () {
  const { h, short, $ } = window.DA;
  const id = decodeURIComponent(location.pathname.split("/").pop() || "");
  const ROLES = { agent_treasury: "Agent wallet", platform: "Platform", deployer: "You (creator)", reserve: "Reserve", infra: "Infra (server, X API, GitHub)", buyback: "Token buyback and burn" };
  let agent = null;
  let busy = false;
  const say = (el, text, kind) => {
    $(el).className = "note mt-3 " + (kind === "ok" ? "ok-msg" : kind === "err" ? "err" : "muted");
    $(el).textContent = text;
  };
  const kv = (rows) => rows.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]);
  const copyBtn = (v) =>
    h("button", { class: "copy", type: "button", title: v, "data-copy": v, "aria-label": "Copy address" }, short(v));

  async function loadWallet() {
    try {
      const r = await fetch("/api/agents/" + encodeURIComponent(id) + "/wallet");
      if (!r.ok) return;
      const w = await r.json();
      if (!w.address)
        return $("wallet").replaceChildren(...kv([["Address", "Being created, check back in a minute"]]));
      const faucet =
        w.cluster === "devnet"
          ? h("a", { href: "https://faucet.solana.com", rel: "noopener noreferrer", target: "_blank" }, "Devnet faucet")
          : "Use Fund agent below, or send SOL to the address";
      const f = w.fees || {};
      $("wallet").replaceChildren(
        ...kv([
          ["Address", copyBtn(w.address)],
          ["Balance", w.lamports === null ? "Network unavailable" : w.sol.toFixed(4) + " SOL"],
          ["Received so far", (f.receivedSol || 0).toFixed(4) + " SOL"],
          [
            "Coin fees waiting",
            f.waitingSol === null || f.waitingSol === undefined
              ? "No coin yet"
              : f.waitingSol.toFixed(4) + " SOL, paid out automatically",
          ],
          ["Last fee payout", f.lastPayoutAt ? new Date(f.lastPayoutAt).toLocaleString() : "None yet"],
          ["Network", w.cluster],
          ["Fund it", faucet],
        ]),
      );
    } catch {
      /* keep the last view */
    }
  }

  function renderLaunch() {
    const me = window.Wallet.address();
    const mine = agent && me && agent.deployerAddress === me;
    const todo = agent && (!agent.mint || (agent.mint && !agent.splitSet));
    $("launch-card").hidden = !(mine && todo);
    if ($("launch-card").hidden || busy) return;
    $("launch-btn").textContent = agent.mint ? "Set the fee split (step 2 of 2)" : "Launch on pump.fun";
    $("devbuy-row").hidden = !!agent.mint; // the dev buy only exists in the create transaction
  }

  // Live dev buy quote: tokens and share of supply, and a plain warning when the amount fills the whole curve
  // (pump.fun then charges only the cost of the curve, and the coin graduates in the same transaction).
  const DEVBUY_HINT = "Bought in the same transaction as the coin, so you get the first tokens before anyone else. Public on chain.";
  let quoteTimer = null;
  $("devbuy").addEventListener("input", () => {
    clearTimeout(quoteTimer);
    const note = $("devbuy-note");
    const sol = Number($("devbuy").value.trim().replace(",", "."));
    note.className = "note muted mt-2";
    if (!(sol > 0)) return void (note.textContent = DEVBUY_HINT);
    note.textContent = "Getting a quote…";
    quoteTimer = setTimeout(async () => {
      try {
        const r = await fetch("/api/launch/quote?sol=" + encodeURIComponent(sol));
        const q = await r.json();
        if (!r.ok) throw new Error(q.error);
        const tok = q.tokens >= 1e6 ? (q.tokens / 1e6).toFixed(1) + "M" : Math.round(q.tokens).toLocaleString();
        if (q.fillsCurve) {
          note.className = "note mt-2 err";
          note.textContent =
            "This buys the whole curve (" + tok + " tokens, " + q.supplyPct.toFixed(1) + "% of supply). Only about " +
            q.fillSol.toFixed(3) + " SOL is spent and the coin graduates at once. Enter less than " + q.fillSol.toFixed(2) + " SOL to stay on the curve.";
        } else {
          note.textContent =
            "You get about " + tok + " tokens (" + q.supplyPct.toFixed(1) + "% of supply). The curve fills at about " + q.fillSol.toFixed(3) + " SOL.";
        }
      } catch (e) {
        note.textContent = e.message || DEVBUY_HINT;
      }
    }, 350);
  });

  /** Dev buy in SOL from the launch card: empty means none; refuses nonsense before the wallet opens. */
  function devBuySol() {
    const raw = $("devbuy").value.trim().replace(",", ".");
    if (!raw) return 0;
    const v = Number(raw);
    if (!(v >= 0 && v <= 50)) throw new Error("The dev buy must be between 0 and 50 SOL.");
    return v;
  }

  async function step(kind, wallet) {
    const prep = await window.Wallet.postJson("/api/launch/prepare", { agentId: id, wallet, devBuySol: kind === "first" ? devBuySol() : 0 });
    $("launch-split").replaceChildren(
      ...kv(prep.split.map((s) => [ROLES[s.role] || s.role, (s.shareBps / 100).toFixed(1) + "% " + short(s.address)])),
    );
    const buy = kind === "first" ? devBuySol() : 0;
    say(
      "launch-msg",
      prep.step === "create"
        ? "Step 1 of 2: approve the coin" + (buy ? " and your " + buy + " SOL dev buy" : "") + " in your wallet."
        : "Step 2 of 2: approve the fee split in your wallet. It can never be changed.",
    );
    const tx = await window.Wallet.signTransaction(prep.tx);
    say("launch-msg", "Sent. Waiting for the network to confirm…");
    return window.Wallet.postJson("/api/launch/submit", { agentId: id, step: prep.step, tx });
  }

  $("launch-btn").addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    $("launch-btn").disabled = true;
    try {
      const wallet = await window.Wallet.ensure();
      let out = await step("first", wallet);
      if (out.next === "split") out = await step("split", wallet);
      say("launch-msg", "Launched. Mint " + short(out.mint) + ". Prices appear within a minute.", "ok");
      setTimeout(() => location.reload(), 2500);
    } catch (e) {
      say("launch-msg", e.message || "The launch did not finish.", "err");
    } finally {
      busy = false;
      $("launch-btn").disabled = false;
      renderLaunch();
    }
  });

  $("suggest").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const text = f.text.value.trim();
    if (text.length < 8) return say("suggest-msg", "Write at least 8 characters.", "err");
    try {
      const out = await window.Wallet.postJson("/api/suggest", { agentId: id, text, wallet: window.Wallet.address() });
      say("suggest-msg", out.note, "ok");
      f.reset();
    } catch (er) {
      say("suggest-msg", er.message, "err");
    }
  });

  window.addEventListener("agent-loaded", (e) => {
    agent = e.detail;
    renderLaunch();
  });
  window.Wallet.onChange(renderLaunch);
  window.addEventListener("agent-funded", () => setTimeout(loadWallet, 1500)); // the new balance shows at once
  loadWallet();
  setInterval(loadWallet, 20_000);
})();
