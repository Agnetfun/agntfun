"use strict";
(function () {
  const { $ } = window.DA;
  const MODELS = { opus: "Claude Opus 5.5", astra: "GPT 6 Astra" };
  const form = $("deploy");
  const err = (id, t) => {
    $(id).textContent = t || "";
  };
  const nonce = () => {
    const b = new Uint8Array(12);
    crypto.getRandomValues(b);
    return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  };
  let logoFile = null;

  function summary() {
    $("sum-model").textContent = MODELS[form.model.value];
    $("sum-name").textContent = form.name.value.trim() || "Not set";
    const t = form.ticker.value.trim().toUpperCase();
    $("sum-ticker").textContent = t ? "$" + t : "Not set";
    const words = form.brief.value.trim() ? form.brief.value.trim().split(/\s+/).length : 0;
    $("brief-count").textContent = words.toLocaleString() + " of 10,000 words";
  }
  function button() {
    $("submit").textContent = window.Wallet.address() ? "Sign and create agent" : "Connect wallet";
  }
  form.addEventListener("input", summary);
  window.Wallet.onChange(button);
  button();
  summary();

  $("logo").addEventListener("change", () => {
    err("logo-err", "");
    const f = $("logo").files[0];
    logoFile = null;
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) return err("logo-err", "The image is over 5 MB.");
    if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type))
      return err("logo-err", "Use a PNG, JPG, WebP or GIF image.");
    logoFile = f;
    const rd = new FileReader();
    rd.onload = () => {
      const img = document.createElement("img");
      img.className = "avatar";
      img.alt = "Logo preview";
      img.src = String(rd.result);
      img.id = "logo-prev";
      $("logo-prev").replaceWith(img);
    };
    rd.readAsDataURL(f);
  });

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!window.Wallet.address()) {
      try {
        await window.Wallet.ensure();
      } catch {
        /* dialog closed */
      }
      return;
    }
    for (const id of ["name-err", "brief-err", "wallet-err", "ticker-err", "x-err"]) err(id, "");
    $("result").textContent = "";
    $("result").className = "note mt-3";
    const name = form.name.value.trim();
    const brief = form.brief.value;
    const model = form.model.value;
    const ticker = form.ticker.value.trim().toUpperCase();
    const xHandle = form.xHandle.value.trim().replace(/^@/, "");
    let bad = false;
    if (!/^[A-Za-z0-9][A-Za-z0-9 ]{1,30}[A-Za-z0-9]$/.test(name)) {
      err("name-err", "Use 3 to 32 letters, numbers or spaces.");
      bad = true;
    }
    if (ticker && !/^[A-Z0-9]{2,10}$/.test(ticker)) {
      err("ticker-err", "Use 2 to 10 letters or numbers.");
      bad = true;
    }
    if (brief.trim().length < 20) {
      err("brief-err", "Write at least 20 characters about what the agent should build.");
      bad = true;
    } else if (brief.trim().split(/\s+/).length > 10000) {
      err("brief-err", "The brief is over 10,000 words.");
      bad = true;
    }
    let attachmentIds = [];
    try {
      attachmentIds = window.DA.launchFiles ? window.DA.launchFiles() : [];
    } catch (e) {
      $("files-err").textContent = e.message;
      bad = true;
    }
    if (xHandle && !/^[A-Za-z0-9_]{1,15}$/.test(xHandle)) {
      err("x-err", "Use the handle only, up to 15 letters, numbers or underscores.");
      bad = true;
    }
    if (bad) return;
    const btn = $("submit");
    btn.disabled = true;
    try {
      const wallet = await window.Wallet.ensure();
      const n = nonce();
      const ts = Date.now();
      const message = [
        "devagent-deploy",
        "v1",
        name,
        model,
        await window.Wallet.sha256Hex(brief),
        n,
        ts,
        // The signature also covers the exact attached files, so they cannot be swapped after signing.
        ...(attachmentIds.length ? ["files", await window.Wallet.sha256Hex(attachmentIds.join(","))] : []),
      ].join(":");
      const signature = await window.Wallet.sign(message);
      let logoId;
      if (logoFile) {
        const up = await fetch("/api/logo", {
          method: "POST",
          headers: { "content-type": logoFile.type },
          body: logoFile,
        });
        const u = await up.json().catch(() => ({}));
        if (!up.ok) throw new Error(u.error || "The logo upload failed. Try another image.");
        logoId = u.id;
      }
      const out = await window.Wallet.postJson("/api/deploy", {
        name,
        model,
        brief,
        wallet,
        signature,
        nonce: n,
        ts,
        ticker,
        description: form.description.value.trim(),
        xHandle,
        logoId,
        attachmentIds,
      });
      $("result").className = "note mt-3 ok-msg";
      $("result").textContent = "Agent created. Opening its page.";
      // Step 2 and 3 of the wizard continue on the agent page, in its setup checklist.
      location.href = "/agent/" + encodeURIComponent(out.agentId) + "?setup=1";
    } catch (e) {
      $("result").className = "note mt-3 err";
      $("result").textContent = e.message;
      btn.disabled = false;
    }
  });
})();
