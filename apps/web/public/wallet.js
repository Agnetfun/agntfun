"use strict";
// Wallet access for Phantom and Solflare (injected Solana wallets). Nothing here ever holds a key.
(function () {
  const PROVIDERS = {
    phantom: () =>
      (window.phantom && window.phantom.solana) ||
      (window.solana && window.solana.isPhantom ? window.solana : null),
    solflare: () => (window.solflare && window.solflare.isSolflare ? window.solflare : null),
  };
  let current = null;
  let address = "";
  const listeners = [];
  const emit = () => listeners.slice().forEach((f) => f(address));
  const keep = (v) => {
    try {
      if (v) sessionStorage.setItem("da-wallet", v);
      else sessionStorage.removeItem("da-wallet");
    } catch {
      /* storage can be blocked */
    }
  };
  const saved = () => {
    try {
      return sessionStorage.getItem("da-wallet");
    } catch {
      return null;
    }
  };
  const keyOf = (p, r) => (r && r.publicKey ? r.publicKey : p.publicKey).toString();

  async function connect(which) {
    const p = PROVIDERS[which] && PROVIDERS[which]();
    if (!p) throw new Error("That wallet is not installed in this browser. Install it and reload.");
    const r = await p.connect();
    current = p;
    address = keyOf(p, r);
    keep(which);
    emit();
    return address;
  }
  async function restore() {
    const w = saved();
    const p = w && PROVIDERS[w] && PROVIDERS[w]();
    if (!p) return;
    try {
      const r = await p.connect({ onlyIfTrusted: true });
      current = p;
      address = keyOf(p, r);
      emit();
    } catch {
      keep(null);
    }
  }
  async function disconnect() {
    try {
      if (current && current.disconnect) await current.disconnect();
    } catch {
      /* already disconnected */
    }
    current = null;
    address = "";
    keep(null);
    emit();
  }
  async function sign(message) {
    if (!current) throw new Error("Connect your wallet first.");
    const out = await current.signMessage(new TextEncoder().encode(message), "utf8");
    const bytes = out.signature || out;
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }
  /** Signs a server-built transaction (base64) with the connected wallet. Needs /vendor/web3.js on the page. */
  async function signTransaction(b64) {
    if (!current) throw new Error("Connect your wallet first.");
    if (!window.solanaWeb3) throw new Error("The signing library did not load. Reload the page.");
    const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const signed = await current.signTransaction(window.solanaWeb3.Transaction.from(raw));
    const bytes = signed.serialize({ requireAllSignatures: true, verifySignatures: true });
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }
  /** Resolves with the address once connected, opening the connect dialog if needed. */
  function ensure() {
    return new Promise((resolve, reject) => {
      if (address) return resolve(address);
      const gone = () => {
        listeners.splice(listeners.indexOf(f), 1);
        reject(new Error("Wallet connection was cancelled."));
      };
      const f = (a) => {
        if (!a) return;
        listeners.splice(listeners.indexOf(f), 1);
        window.removeEventListener("wallet-dismissed", gone);
        resolve(a);
      };
      listeners.push(f);
      window.addEventListener("wallet-dismissed", gone, { once: true });
      window.dispatchEvent(new Event("open-wallet"));
    });
  }
  async function sha256Hex(text) {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  async function postJson(path, body) {
    const r = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    let data = {};
    try {
      data = await r.json();
    } catch {
      /* empty body */
    }
    if (!r.ok) throw new Error(data.error || "The request failed. Try again.");
    return data;
  }
  window.Wallet = {
    connect,
    disconnect,
    sign,
    signTransaction,
    ensure,
    sha256Hex,
    postJson,
    address: () => address,
    available: (w) => !!(PROVIDERS[w] && PROVIDERS[w]()),
    onChange: (f) => listeners.push(f),
  };
  window.addEventListener("load", restore);
})();
