// Demo server with believable fake data (30 days of work, logos, tickers). In memory, nothing is saved.
// Run: pnpm demo   then open http://127.0.0.1:3001
import { readFileSync, existsSync } from "node:fs";
import { FakeClock } from "@devagent/core";
import { appendEvent, createAgent, endSession, migrate, openDb, startSession } from "@devagent/db";
import { Treasury } from "@devagent/treasury";
import { saveLogo } from "@devagent/platform";
import { KillSwitch } from "@devagent/safety";
import { createWebServer } from "../src/server";
import { createDappRoutes, type DappDeps } from "../src/dapp-routes";
import { createConnectRoutes } from "../src/connect-routes";

const DAY = 86_400_000;
const clock = new FakeClock(Date.now() - 30 * DAY);
const db = openDb(":memory:");
migrate(db, clock);
const treasury = new Treasury(db, clock, ["op"]);
const logos = ["a", "b"]
  .map((n) => new URL(`./demo-logos/logo_${n}.png`, import.meta.url).pathname)
  .filter(existsSync);

const cast = [
  [
    "Ledgerline",
    "LEDGR",
    "opus",
    "Builds small tested command line tools for plain text and CSV files.",
    0.9,
    3000,
  ],
  [
    "Pixel Smith",
    "PIXEL",
    "astra",
    "Ships tiny image utilities in Rust, one tested crate at a time.",
    0.6,
    1800,
  ],
  [
    "Quiet Compiler",
    "QCOMP",
    "opus",
    "Writes a lexer and parser for a toy language, with a test for every rule.",
    0.75,
    2200,
  ],
  [
    "Nightowl Docs",
    "OWLDOC",
    "astra",
    "Turns messy READMEs into clear docs with working examples.",
    0.35,
    900,
  ],
  [
    "Cron Whisperer",
    "CRONW",
    "opus",
    "Maintains a cron expression library and its explainer web page.",
    0.5,
    1400,
  ],
  ["Tidewater", "TIDE", "opus", "A small static site generator for field notes.", 0.2, 600],
] as const;

let n = 0;
for (const [name, ticker, model, desc, rate, fund] of cast) {
  clock.set(Date.now() - (28 - n * 3) * DAY);
  const a = createAgent(db, clock, {
    name,
    model,
    lockedPrompt: desc + " Keep every commit small and tested.",
    repo: `devagent-agents/${name.toLowerCase().replace(/\s+/g, "-")}`,
    xHandle: n % 2 === 0 ? name.toLowerCase().replace(/\s+/g, "") : undefined,
  });
  const lg = logos[n % 2] && n < 4 ? saveLogo(db, clock, readFileSync(logos[n % 2]!)) : undefined;
  db.prepare("UPDATE agents SET ticker=?, description=?, logo_id=? WHERE id=?").run(
    ticker,
    desc,
    lg && lg.ok ? lg.id : null,
    a.id,
  );
  treasury.topUp(a.id, fund, "demo");
  let seed = n * 7 + 3;
  const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  const days = 28 - n * 3;
  for (let d = 0; d < days; d++) {
    clock.set(Date.now() - (days - d) * DAY + 3 * 3_600_000);
    if (rnd() > rate) continue;
    const k = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < k; i++) {
      clock.advance(2 * 3_600_000);
      const sid = startSession(db, clock, a.id, null);
      clock.advance(300_000);
      const cost = 8 + Math.floor(rnd() * 10);
      endSession(db, clock, sid, {
        endReason: "finished",
        summary: "ok",
        tokensIn: 1800,
        tokensOut: 900,
        costCents: cost,
      });
      treasury.spend(a.id, "llm", cost, sid);
      appendEvent(db, clock, {
        type: "session.published",
        agentId: a.id,
        sessionId: sid,
        payload: {
          merged: rnd() > 0.15,
          pushed: true,
          testsPassed: true,
          headSha: `c0ffee${d}${i}abcd`,
          added: 30 + Math.floor(rnd() * 90),
          removed: Math.floor(rnd() * 20),
          files: 2 + i,
        },
      });
    }
    if (d % 6 === 5) treasury.topUp(a.id, 400, "demo");
  }
  n++;
}
clock.set(Date.now());

// Live screen demo: the first agent codes a short session every 40 seconds, frame by frame.
const liveAgent = (db.prepare("SELECT id FROM agents ORDER BY created_at LIMIT 1").get() as { id: string }).id;

// Two demo agents show as Verified (own GitHub and X connected). Placeholder rows, no real tokens.
for (const a of db.prepare("SELECT id, name FROM agents ORDER BY created_at LIMIT 2").all() as { id: string; name: string }[])
  for (const kind of ["github", "x"])
    db.prepare(
      "INSERT INTO agent_credentials (agent_id, kind, sealed, updated_at, account) VALUES (?,?,?,?,?)",
    ).run(a.id, kind, "demo-placeholder", Date.now(), a.name.toLowerCase().replace(/\s+/g, ""));
const SCRIPT: [string, Record<string, unknown>][] = [
  ["start", { task: "Add CSV export to the reports command" }],
  ["list", { path: ".", entries: "package.json\nsrc\ntest" }],
  ["read", { path: "src/report.js" }],
  [
    "write",
    {
      path: "src/export.js",
      chars: 412,
      content:
        '// Turns report rows into CSV text.\nconst quote = (v) => {\n  const s = String(v ?? "");\n  return /[",\\n]/.test(s) ? `"${s.replace(/"/g, \'""\')}"` : s;\n};\n\nfunction toCsv(rows) {\n  if (!rows.length) return "";\n  const head = Object.keys(rows[0]);\n  const lines = rows.map((r) => head.map((k) => quote(r[k])).join(","));\n  return [head.join(","), ...lines].join("\\n");\n}\n\nmodule.exports = { toCsv };\n',
    },
  ],
  [
    "write",
    {
      path: "test/export.test.js",
      chars: 380,
      content:
        'const test = require("node:test");\nconst assert = require("node:assert");\nconst { toCsv } = require("../src/export.js");\n\ntest("writes a header and rows", () => {\n  assert.strictEqual(toCsv([{ a: 1, b: 2 }]), "a,b\\n1,2");\n});\n\ntest("quotes commas and quotes", () => {\n  assert.strictEqual(toCsv([{ a: \'x,"y"\' }]), \'a\\n"x,""y"""\');\n});\n',
    },
  ],
  ["tests", { ok: true, output: "▶ writes a header and rows\n✔ writes a header and rows (0.6ms)\n▶ quotes commas and quotes\n✔ quotes commas and quotes (0.2ms)\nℹ tests 2\nℹ pass 2\nℹ fail 0" }],
  ["commit", { message: "feat: CSV export for reports", sha: "4e1c9a2" }],
  ["end", { endReason: "finished", tests: "passing", commits: 1 }],
];
function demoSession() {
  clock.set(Date.now());
  const sid = startSession(db, clock, liveAgent, null);
  db.prepare("UPDATE agents SET state='running' WHERE id=?").run(liveAgent);
  let i = 0;
  const t = setInterval(() => {
    const [kind, payload] = SCRIPT[i]!;
    db.prepare(
      "INSERT INTO live_frames (session_id, seq, agent_id, ts, kind, payload_json) VALUES (?,?,?,?,?,?)",
    ).run(sid, i + 1, liveAgent, Date.now(), kind, JSON.stringify(payload));
    if (++i === SCRIPT.length) {
      clearInterval(t);
      clock.set(Date.now());
      endSession(db, clock, sid, { endReason: "finished", summary: "ok", tokensIn: 0, tokensOut: 0, costCents: 0 });
      db.prepare("UPDATE agents SET state='sleeping' WHERE id=?").run(liveAgent);
    }
  }, 2500);
}
demoSession();
setInterval(demoSession, 40_000);

const dapp = createDappRoutes({
  db,
  clock,
  rpc: { getBalance: async () => 1_250_000_000 } as unknown as DappDeps["rpc"],
  launch: { cluster: "devnet", publicUrl: "http://127.0.0.1:3001" },
  vcsMode: "local",
  socialMode: "local",
  connect: createConnectRoutes({ db, clock, apps: {} }),
});
const web = createWebServer({
  db,
  treasury,
  kill: new KillSwitch(db, clock),
  pollMs: 2000,
  clock,
  deployPerHour: 100,
  dapp,
});
const port = Number(process.env.DEMO_PORT) || 3001;
web.server.listen(port, "127.0.0.1", () => console.log(`demo on http://127.0.0.1:${port}`));
