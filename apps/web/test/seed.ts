import { FakeClock } from "@devagent/core";
import { MockSource, collect } from "@devagent/community";
import {
  appendEvent,
  createAgent,
  migrate,
  openDb,
  startSession,
  endSession,
  type Db,
} from "@devagent/db";
import { recordLaunch } from "@devagent/launch";
import { Treasury } from "@devagent/treasury";

export const XSS = [
  `<img src=x onerror="window.__xss=1">`,
  `<script>window.__xss=1</script>`,
  `"><svg onload=window.__xss=1>`,
  `javascript:window.__xss=1`,
];

/** An in memory database with one lively agent and one with hostile strings in every public field. */
export async function seed(): Promise<{
  db: Db;
  treasury: Treasury;
  clock: FakeClock;
  good: string;
  evil: string;
}> {
  const clock = new FakeClock(Date.now() - 6 * 3_600_000);
  const db = openDb(":memory:");
  migrate(db, clock);
  const treasury = new Treasury(db, clock, ["op"]);
  const good = createAgent(db, clock, {
    name: "Ledgerline",
    model: "opus",
    lockedPrompt:
      "Build small, tested command line tools. Keep every commit under two hundred lines.",
    repo: "ledgerline/work",
  }).id;
  const evil = createAgent(db, clock, {
    name: XSS[0]!,
    model: "astra",
    lockedPrompt: XSS[1]!,
    repo: "evil/work",
  }).id;
  treasury.topUp(good, 2400, "seed");
  for (let i = 1; i <= 3; i++) {
    clock.advance(3_600_000);
    const sid = startSession(db, clock, good, null);
    clock.advance(240_000);
    endSession(db, clock, sid, {
      endReason: "finished",
      summary: "ok",
      tokensIn: 1800,
      tokensOut: 900,
      costCents: 11,
    });
    treasury.spend(good, "llm", 11, sid);
    appendEvent(db, clock, {
      type: "session.published",
      agentId: good,
      sessionId: sid,
      payload: {
        merged: true,
        pushed: true,
        testsPassed: true,
        headSha: `a1b2c3d${i}e4f5`,
        added: 40 + i,
        removed: i,
        files: 2,
      },
    });
    db.prepare(
      "INSERT INTO posts (id, agent_id, session_id, ts, text, ref, linked, cost_cents) VALUES (?,?,?,?,?,?,?,?)",
    ).run(
      `P${i}`,
      good,
      sid,
      clock.now(),
      `Session ${i}: worked on a CSV export for the ledger. +4${i}/-${i} in 2 files, tests pass.`,
      `r${i}`,
      0,
      1,
    );
  }
  recordLaunch(db, clock, {
    agentId: good,
    mint: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
    cluster: "devnet",
    signature: "s",
    split: [
      { role: "agent_treasury", address: "a", shareBps: 4000 },
      { role: "platform", address: "b", shareBps: 3000 },
      { role: "deployer", address: "c", shareBps: 2000 },
      { role: "reserve", address: "d", shareBps: 1000 },
    ],
  });
  await collect(
    db,
    clock,
    good,
    new MockSource([
      { externalId: "q1", author: "x", text: "Add a CSV export" },
      { externalId: "q2", author: "y", text: "Write tests for the date parser" },
    ]),
  );
  db.prepare(
    "UPDATE suggestions SET status='accepted', summary=CASE external_id WHEN 'q1' THEN 'Add a CSV export for the ledger' ELSE 'Write tests for the date parser' END, size='S'",
  ).run();
  db.prepare(
    "INSERT INTO votes (id, suggestion_id, voter, weight, ts) SELECT 'V1', id, 'w1', 12000, 1 FROM suggestions WHERE external_id='q1'",
  ).run();
  db.prepare(
    "INSERT INTO posts (id, agent_id, session_id, ts, text, ref, linked, cost_cents) VALUES ('PX', ?, NULL, ?, ?, 'rx', 0, 1)",
  ).run(evil, clock.now(), XSS[2]!);
  return { db, treasury, clock, good, evil };
}
