"use strict";
// Fund an agent in one click, like a buy: the server builds a plain SOL transfer to the agent's wallet, your wallet
// signs it, the server sends it only if it is that transfer. Anyone can fund an agent. All text goes in as text.
(function () {
  const { h, $, toast, celebrate } = window.DA;
  const id = decodeURIComponent(location.pathname.split("/").pop() || "");
  let cluster = "devnet";
  let busy = false;
  fetch("/api/config")
    .then((r) => r.json())
    .then((c) => (cluster = c.cluster || cluster))
    .catch(() => {});

  const say = (parts, kind) => {
    const el = $("fund-msg");
    el.className = "note mt-2 " + (kind === "ok" ? "ok-msg" : kind === "err" ? "err" : "muted");
    el.replaceChildren(...[].concat(parts));
  };
  const explorer = (sig) =>
    "https://explorer.solana.com/tx/" + encodeURIComponent(sig) + (cluster === "mainnet-beta" ? "" : "?cluster=" + cluster);
  const amount = () => {
    const v = Number($("fund-amt").value.trim().replace(",", "."));
    return Number.isFinite(v) ? v : 0;
  };
  const button = () => {
    $("fund-btn").textContent = busy ? "Confirm in your wallet" : window.Wallet.address() ? "Fund agent" : "Connect wallet to fund";
    $("fund-btn").disabled = busy;
  };

  $("fund-quick").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sol]");
    if (!b) return;
    $("fund-amt").value = b.dataset.sol;
    $("fund-amt").focus();
  });

  $("fund-btn").addEventListener("click", async () => {
    if (busy) return;
    if (!window.Wallet.address()) {
      try {
        await window.Wallet.ensure();
      } catch {
        /* closed */
      }
      return button();
    }
    const sol = amount();
    if (!(sol >= 0.001 && sol <= 100)) return say("Enter between 0.001 and 100 SOL.", "err");
    busy = true;
    button();
    try {
      say("Approve the transfer in your wallet.");
      const wallet = window.Wallet.address();
      const prep = await window.Wallet.postJson("/api/fund/prepare", { agentId: id, wallet, sol });
      const tx = await window.Wallet.signTransaction(prep.tx);
      say("Sent. Waiting for the network…");
      const out = await window.Wallet.postJson("/api/fund/submit", { agentId: id, wallet, tx });
      if (!out.pending) {
        celebrate();
        toast("Funded with " + sol + " SOL");
      }
      say(
        [
          out.pending
            ? "Sent, still confirming. Check the transaction before sending again. "
            : "Funded with " + sol + " SOL. The treasury counts it within a minute. ",
          h("a", { href: explorer(out.signature), target: "_blank", rel: "noopener noreferrer" }, "View transaction"),
        ],
        "ok",
      );
      $("fund-amt").value = "";
      window.dispatchEvent(new window.CustomEvent("agent-funded"));
    } catch (e) {
      say(e.message || "The transfer did not go through.", "err");
    } finally {
      busy = false;
      button();
    }
  });

  window.addEventListener("agent-loaded", () => {
    $("fund").hidden = false;
    button();
  });
  window.Wallet.onChange(button);
})();
