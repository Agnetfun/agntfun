"use strict";
// Live agent screen: plays the real frames of a session (files written, tests, commits) as an editor and terminal.
// Live sessions stream in as they happen; finished ones can be replayed. All text goes in through textContent.
(function () {
  const { h, ago, $ } = window.DA;
  const { setTimeout, clearTimeout, URLSearchParams } = window;
  const id = decodeURIComponent(location.pathname.split("/").pop() || "");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const KW =
    /^(const|let|var|function|return|if|else|for|while|import|from|export|default|class|new|async|await|require|module|exports|true|false|null|undefined|try|catch|throw|def|self|None|True|False)$/;

  let sessionId = null;
  let lastSeq = 0;
  let isLive = false;
  let queue = [];
  let playing = false;
  let instant = false;
  let files = new Map();
  let typing = null;
  let pollTimer = null;

  /** Tiny highlighter: comments, strings, numbers and keywords, as text nodes in spans. */
  function lineEl(text) {
    const el = h("span", { class: "l" });
    const re = /(\/\/.*$|#.*$|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d+(?:\.\d+)?\b|[A-Za-z_$][\w$]*)/g;
    let last = 0;
    for (const m of text.matchAll(re)) {
      if (m.index > last) el.append(text.slice(last, m.index));
      const t = m[0];
      const cls = /^(\/\/|#)/.test(t) ? "cm" : /^["'`]/.test(t) ? "st" : /^\d/.test(t) ? "nu" : KW.test(t) ? "kw" : null;
      el.append(cls ? h("span", { class: cls }, t) : t);
      last = m.index + t.length;
    }
    if (last < text.length) el.append(text.slice(last));
    return el;
  }

  function showCode(path, content, cursor) {
    $("scr-file").textContent = path;
    const lines = content.split("\n");
    const els = lines.map(lineEl);
    if (cursor && els.length) els[els.length - 1].classList.add("cur");
    $("scr-code").replaceChildren(...els);
    const box = $("scr-code");
    box.scrollTop = box.scrollHeight;
  }

  function term(...parts) {
    const t = $("scr-term");
    t.append(h("span", {}, ...parts), "\n");
    while (t.childNodes.length > 240) t.firstChild.remove();
    t.scrollTop = t.scrollHeight;
  }
  const p = (s) => h("span", { class: "p" }, s);

  function tree(path, active, written) {
    if (!files.has(path)) files.set(path, h("li", { title: path }, path));
    if (written) files.get(path).classList.add("new");
    for (const [k, el] of files) el.classList.toggle("on", k === active);
    $("scr-tree").replaceChildren(...files.values());
  }

  // Each reset starts a new generation: the pending wait resolves at once and the old playback stops drawing, so
  // pump() never hangs on a cleared timer and two playbacks never interleave.
  let gen = 0;
  let wake = null;
  class Stale extends Error {}
  const wait = (ms) => {
    const mine = gen;
    return new Promise((r) => {
      wake = r;
      typing = setTimeout(r, instant || reduce ? 0 : ms);
    }).then(() => {
      if (mine !== gen) throw new Stale();
    });
  };

  async function typeFile(path, content) {
    if (instant || reduce) return showCode(path, content, false);
    const total = Math.min(2600, 300 + content.length * 3);
    const steps = Math.max(1, Math.ceil(total / 40));
    for (let i = 1; i <= steps; i++) {
      showCode(path, content.slice(0, Math.ceil((content.length * i) / steps)), true);
      await wait(40);
    }
    showCode(path, content, false);
  }

  async function play(f) {
    switch (f.kind) {
      case "recall":
        term(p("› "), "recall " + f.sessions + " past session" + (f.sessions === 1 ? "" : "s") + " from memory");
        break;
      case "start":
        $("scr-task").textContent = "Task: " + f.task;
        term(p("$ "), "wake");
        term(h("span", { class: "dim" }, "task: " + f.task));
        break;
      case "read":
        tree(f.path, f.path);
        term(p("› "), "read " + f.path);
        break;
      case "list":
        term(p("› "), "ls " + f.path);
        term(h("span", { class: "dim" }, f.entries));
        break;
      case "write":
        tree(f.path, f.path, true);
        term(p("› "), "write " + f.path + "  (" + f.chars + " chars)");
        await typeFile(f.path, f.content);
        break;
      case "tests": {
        term(p("› "), "run tests");
        for (const line of f.output.split("\n").slice(-14)) {
          term(h("span", { class: /fail|error|not ok/i.test(line) ? "bad" : /pass|ok\b/i.test(line) ? "ok" : "dim" }, line));
          await wait(60);
        }
        term(h("span", { class: f.ok ? "ok" : "bad" }, f.ok ? "✓ tests passed" : "✗ tests failed"));
        break;
      }
      case "commit":
        term(p("› "), "git commit -m " + JSON.stringify(f.message));
        if (f.sha) term(h("span", { class: "ok" }, "[" + f.sha + "] " + f.message));
        break;
      case "end":
        term(p("$ "), "sleep");
        term(h("span", { class: f.endReason === "finished" ? "ok" : "bad" }, "session ended: " + f.endReason + " · tests " + f.tests + " · " + f.commits + " commit(s)"));
        break;
    }
    await wait(f.kind === "write" ? 500 : 700);
  }

  async function pump() {
    if (playing) return;
    playing = true;
    let stale = false;
    try {
      while (queue.length) {
        instant = instant || queue.length > 25; // far behind: catch up without animation
        await play(queue.shift());
      }
    } catch (e) {
      if (!(e instanceof Stale)) throw e;
      stale = true; // a reset happened: it already chose the new session's mode, keep it
    } finally {
      if (!stale) instant = false;
      playing = false;
    }
    if (queue.length) pump(); // frames that arrived after a reset
  }

  function reset() {
    gen++;
    clearTimeout(typing);
    if (wake) wake();
    wake = null;
    queue = [];
    files = new Map();
    lastSeq = 0;
    $("scr-tree").replaceChildren();
    $("scr-term").replaceChildren();
    $("scr-file").textContent = "no file open";
    $("scr-code").replaceChildren(
      h("span", { class: "scr-empty" }, h("strong", {}, isLive ? "Agent is starting" : "Waiting for the agent"), isLive ? "The first file it writes opens here." : "When it wakes up you see it code here live."),
    );
  }

  function badge(data) {
    const on = $("onair");
    on.classList.toggle("live", data.live);
    $("onair-t").textContent = data.live
      ? "LIVE"
      : data.session
        ? "Replay · " + ago(data.session.endedAt || data.session.startedAt)
        : data.state === "starved" ? "Sleeping, needs funds" : "Offline";
    $("scr-replay").hidden = data.live || !data.session;
    const pick = $("scr-pick");
    const want = data.sessions.map((s) => s.id).join();
    if (pick.dataset.ids !== want) {
      pick.dataset.ids = want;
      pick.replaceChildren(
        ...data.sessions.map((s, i) =>
          h("option", { value: s.id }, (i === 0 ? "Latest · " : "") + ago(s.startedAt) + (s.task ? " · " + s.task.slice(0, 40) : "")),
        ),
      );
    }
    if (data.session) pick.value = data.session.id;
    pick.closest("label").hidden = data.sessions.length === 0;
  }

  // `pinned` is a session the viewer picked; null means follow the newest session (a new one takes over).
  let pinned = null;
  let animateNext = false;

  async function load() {
    clearTimeout(pollTimer);
    try {
      const q = new URLSearchParams({ after: String(lastSeq) });
      if (pinned) q.set("session", pinned);
      const r = await fetch("/api/agents/" + encodeURIComponent(id) + "/live?" + q, { headers: { accept: "application/json" } });
      if (r.ok) {
        const data = await r.json();
        const sid = data.session ? data.session.id : null;
        if (sid !== sessionId) {
          isLive = data.live;
          reset();
          sessionId = sid;
          // A finished session opens at its final state; a live one (or a replay) plays with timing.
          instant = !data.live && !animateNext;
          animateNext = false;
          if (lastSeq === 0 && data.frames.length && data.frames[0].seq !== 1) return load();
        }
        isLive = data.live;
        badge(data);
        for (const f of data.frames)
          if (f.seq > lastSeq) {
            queue.push(f);
            lastSeq = f.seq;
          }
        pump();
      }
    } catch {
      /* keep the screen; try again */
    }
    pollTimer = setTimeout(load, isLive ? 1500 : pinned ? 60000 : 10000);
  }

  function restart(session, animate) {
    pinned = session;
    sessionId = undefined; // forces a reset on the next response
    lastSeq = 0;
    animateNext = animate;
    load();
  }
  $("scr-replay").addEventListener("click", () => restart(sessionId, true));
  $("scr-pick").addEventListener("change", (e) => {
    const first = e.target.options[0] && e.target.options[0].value;
    restart(e.target.value === first ? null : e.target.value, false);
  });
  load();
})();
