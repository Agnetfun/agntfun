"use strict";
// Launch: creator docs and screenshots. Browse, drag and drop, or paste a screenshot; each file uploads at once,
// so the deploy only signs over the finished upload ids. All text goes in through textContent.
(function () {
  const { $ } = window.DA;
  const { URL, File } = window;
  const MAX = 10;
  const IMAGE = /^image\/(png|jpeg|webp)$/;
  const TEXT = /\.(md|txt|json|csv)$/i;
  const items = []; // { el, state: "up" | "ok" | "err", id }

  const say = (t) => ($("files-err").textContent = t || "");
  const h = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  function precheck(f) {
    const isText = TEXT.test(f.name);
    if (!IMAGE.test(f.type) && f.type !== "application/pdf" && !isText)
      return "Only PNG, JPG, WebP, PDF, Markdown, text, JSON or CSV.";
    if (isText && f.size > 200_000) return "Text files can be up to 200 KB.";
    if (!isText && f.size > 3_000_000) return "Images and PDFs can be up to 3 MB.";
    return "";
  }

  function row(f) {
    const li = h("li");
    let thumb;
    if (IMAGE.test(f.type)) {
      thumb = h("img");
      thumb.alt = "";
      const url = URL.createObjectURL(f);
      thumb.src = url;
      thumb.onload = () => URL.revokeObjectURL(url);
    } else thumb = h("span", "ext", (f.name.split(".").pop() || "file").slice(0, 4).toUpperCase());
    const mid = h("div");
    const nm = h("span", "nm", f.name);
    const st = h("span", "st", "Uploading…");
    mid.append(nm, st);
    const rm = h("button", "btn small", "Remove");
    rm.type = "button";
    li.append(thumb, mid, rm);
    return { li, st, nm, rm };
  }

  async function add(f) {
    say("");
    if (items.filter((i) => i.state !== "err").length >= MAX) return say("Up to " + MAX + " files.");
    const problem = precheck(f);
    const r = row(f);
    const item = { el: r.li, state: "up", id: null };
    items.push(item);
    r.rm.addEventListener("click", () => {
      items.splice(items.indexOf(item), 1);
      r.li.remove();
    });
    $("file-list").append(r.li);
    if (problem) {
      item.state = "err";
      r.st.className = "st err";
      return void (r.st.textContent = problem);
    }
    try {
      const res = await fetch("/api/attachment", {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(f.name) },
        body: f,
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || "The upload failed.");
      item.state = "ok";
      item.id = out.id;
      r.nm.textContent = out.name;
      r.st.textContent = (out.size / 1024).toFixed(0) + " KB" + (out.kind === "text" ? " · goes into the repo" : " · shown on the agent page");
    } catch (e) {
      item.state = "err";
      r.st.className = "st err";
      r.st.textContent = e.message;
    }
  }

  const addAll = (list) => [...list].forEach(add);
  $("files").addEventListener("change", (e) => {
    addAll(e.target.files);
    e.target.value = "";
  });
  const drop = $("drop");
  ["dragenter", "dragover"].forEach((t) =>
    drop.addEventListener(t, (e) => {
      e.preventDefault();
      drop.classList.add("over");
    }),
  );
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, () => drop.classList.remove("over")));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    addAll(e.dataTransfer.files);
  });
  // Paste a screenshot anywhere on the page (text pastes into fields stay untouched).
  document.addEventListener("paste", (e) => {
    const shots = [...(e.clipboardData?.files || [])].filter((f) => IMAGE.test(f.type));
    if (!shots.length) return;
    e.preventDefault();
    shots.forEach((f, i) => add(new File([f], "screenshot-" + Date.now() + (i ? "-" + i : "") + ".png", { type: f.type })));
  });

  /** For launch.js: finished upload ids, or an error while uploads are still running or failed. */
  window.DA.launchFiles = () => {
    if (items.some((i) => i.state === "up")) throw new Error("Wait for the files to finish uploading.");
    if (items.some((i) => i.state === "err")) throw new Error("Remove the files that failed to upload.");
    return items.map((i) => i.id);
  };
})();
