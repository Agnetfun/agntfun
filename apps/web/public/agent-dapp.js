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
          : "Send SOL to the address above";
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
  }

  async function step(kind, wallet) {
    const prep = await window.Wallet.postJson("/api/launch/prepare", { agentId: id, wallet });
    $("launch-split").replaceChildren(
      ...kv(prep.split.map((s) => [ROLES[s.role] || s.role, (s.shareBps / 100).toFixed(1) + "% " + short(s.address)])),
    );
    say("launch-msg", prep.step === "create" ? "Step 1 of 2: approve the coin in your wallet." : "Step 2 of 2: approve the fee split in your wallet. It can never be changed.");
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
  loadWallet();
  setInterval(loadWallet, 20_000);
})();
