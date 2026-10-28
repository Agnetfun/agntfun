"use strict";
// Agent accounts: the creator connects the agent's own GitHub and X accounts (OAuth); everyone sees what is linked.
(function () {
  const { h, $ } = window.DA;
  const { URLSearchParams, history } = window;
  const id = decodeURIComponent(location.pathname.split("/").pop() || "");
  const NAMES = { github: "GitHub", x: "X" };
  const ICON = { github: "github-logo", x: "x" };
  let agent = null;
  let status = null;

  const say = (text, kind) => {
    $("acct-msg").className = "note mt-3 " + (kind === "ok" ? "ok-msg" : kind === "err" ? "err" : "muted");
    $("acct-msg").textContent = text;
  };
  const icon = (k) => {
    const src = $("icon-tpl").content.querySelector('[data-k="' + ICON[k] + '"]');
    return src ? src.cloneNode(true) : h("i", {});
  };
  const nonce = () => {
    const b = new Uint8Array(12);
    crypto.getRandomValues(b);
    return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  };
  const mine = () => agent && window.Wallet.address() && agent.deployerAddress === window.Wallet.address();

  function render() {
    if (!status) return;
    $("accts").replaceChildren(
      ...["github", "x"].map((k) => {
        const s = status[k];
        const linked = s.account;
        const link =
          linked && linked !== "connected"
            ? h(
                "a",
                {
                  href: k === "x" ? "https://x.com/" + encodeURIComponent(linked) : "https://github.com/" + encodeURIComponent(linked),
                  rel: "noopener noreferrer",
                  target: "_blank",
                },
                "@" + linked,
              )
            : h("span", { class: linked ? "" : "muted" }, linked ? "Connected" : "Not connected");
        let action = null;
        if (mine())
          action =
            linked && s.needsReconnect && s.available
              ? h("button", { class: "btn small primary", type: "button", "data-act": "start", "data-k": k }, "Reconnect")
              : linked
                ? h("button", { class: "btn small", type: "button", "data-act": "remove", "data-k": k }, "Disconnect")
                : s.available
                  ? h("button", { class: "btn small primary", type: "button", "data-act": "start", "data-k": k }, "Connect " + NAMES[k])
                  : h("span", { class: "note muted" }, "Not set up on this site");
        // Health: a revoked or expired login shows plainly, so nobody wonders why the agent went quiet.
        const health = !linked
          ? null
          : s.needsReconnect
            ? h("span", { class: "acct-bad" }, "Needs reconnect: its login stopped working")
            : s.lastOkAt
              ? h("span", { class: "muted" }, "Working, last used " + window.DA.ago(s.lastOkAt))
              : h("span", { class: "muted" }, "Connected, not used yet");
        return h(
          "li",
          {},
          icon(k),
          h("div", { class: "min0" }, h("strong", {}, NAMES[k]), h("div", { class: "note" }, link), health ? h("div", { class: "note" }, health) : null),
          action,
        );
      }),
    );
    if (mine() && !status.github.account && !status.x.account && !$("acct-msg").textContent)
      say("Create a GitHub and an X account for this agent, then connect them here. Connect GitHub before its first session so all its work lands there.");
  }

  async function load() {
    try {
      const r = await fetch("/api/agents/" + encodeURIComponent(id) + "/connections");
      if (r.ok) {
        status = await r.json();
        window.dispatchEvent(new window.CustomEvent("accounts-loaded", { detail: status }));
      }
    } catch {
      /* keep the last view */
    }
    render();
  }

  $("accts").addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (b) run(b.dataset.k, b.dataset.act, b);
  });
  // The setup checklist starts the very same flow.
  window.DA.connectAccount = (kind) => run(kind, "start");
  window.DA.accountStatus = () => status;

  async function run(kind, act, b) {
    if (b) b.disabled = true;
    try {
      const wallet = await window.Wallet.ensure();
      const n = nonce();
      const ts = Date.now();
      const verb = act === "start" ? "devagent-connect" : "devagent-disconnect";
      const signature = await window.Wallet.sign([verb, "v1", id, kind, n, ts].join(":"));
      const out = await window.Wallet.postJson(act === "start" ? "/api/connect/start" : "/api/connect/remove", {
        agentId: id,
        kind,
        wallet,
        signature,
        nonce: n,
        ts,
      });
      if (act === "start") {
        say("Opening " + NAMES[kind] + ". Log in as the agent's account and approve.");
        location.href = out.url;
        return;
      }
      say(NAMES[kind] + " disconnected. The agent stops using it right away.", "ok");
      load();
    } catch (er) {
      say(er.message, "err");
    } finally {
      if (b) b.disabled = false;
    }
  }

  // Result of the OAuth round trip, then clean the address bar.
  const q = new URLSearchParams(location.search);
  if (q.get("connected")) {
    const [k, name] = q.get("connected").split(":");
    say((NAMES[k] || k) + " connected as @" + name + ". The agent uses it from its next session.", "ok");
  } else if (q.get("connect_error")) say(q.get("connect_error"), "err");
  if (q.has("connected") || q.has("connect_error")) history.replaceState(null, "", location.pathname);

  window.addEventListener("agent-loaded", (e) => {
    agent = e.detail;
    render();
  });
  window.Wallet.onChange(render);
  load();
})();
