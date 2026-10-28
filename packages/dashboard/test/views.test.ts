import { beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "@devagent/core";
import { appendEvent, createAgent, migrate, openDb, setAgentState, type Db } from "@devagent/db";
import { MockSource, collect } from "@devagent/community";
import { recordLaunch } from "@devagent/launch";
import { Treasury } from "@devagent/treasury";
import { agentCards, agentDetail, feed, platformStats, version } from "../src";

let db: Db, clock: FakeClock, t: Treasury, a: string;
beforeEach(() => {
  clock = new FakeClock(1_000_000);
  db = openDb(":memory:");
  migrate(db, clock);
  t = new Treasury(db, clock, ["op"]);
  a = createAgent(db, clock, {
    name: "<img src=x onerror=alert(1)>",
    model: "astra",
    lockedPrompt: "Build tools",
    repo: "o/r",
  }).id;
});

describe("public views", () => {
  it("never exposes raw community text, authors, or operator ids", async () => {
    await collect(
      db,
      clock,
      a,
      new MockSource([{ externalId: "1", author: "secret_handle", text: "SECRETRAW idea text" }]),
    );
    db.prepare("UPDATE suggestions SET status='accepted', summary='Add CSV export' ").run();
    t.topUp(a, 500, "x");
    t.withdraw(a, 10, "op", "addr");
    const json = JSON.stringify({
      cards: agentCards(db, t),
      detail: agentDetail(db, t, a),
      stats: platformStats(db),
    });
    expect(json).not.toContain("SECRETRAW");
    expect(json).not.toContain("secret_handle");
    expect(json).not.toMatch(/"op"|operator/);
    expect(json).toContain("Add CSV export");
  });

  it("hostile names come back as plain data, never altered or evaluated", () => {
    expect(agentCards(db, t)[0]!.name).toBe("<img src=x onerror=alert(1)>");
  });

  it("builds a feed from pushes, posts, funds, status and launch, newest first", () => {
    t.topUp(a, 700, "x");
    clock.advance(1000);
    appendEvent(db, clock, {
      type: "session.published",
      agentId: a,
      payload: {
        merged: true,
        pushed: true,
        testsPassed: true,
        headSha: "abcdef1234567",
        added: 5,
        removed: 1,
        files: 2,
      },
    });
    clock.advance(1000);
    setAgentState(db, a, "starved");
    appendEvent(db, clock, { type: "agent.starved", agentId: a, payload: {} });
    clock.advance(1000);
    recordLaunch(db, clock, { agentId: a, mint: "M", cluster: "mock", signature: "s", split: [] });
    const f = feed(db, a, "o/r");
    expect(f.map((x) => x.kind)).toEqual(["launch", "status", "push", "funds"]);
    expect(f[2]).toMatchObject({ href: "https://github.com/o/r/commit/abcdef1234567" });
    expect(f[2]!.text).toContain("Merged: +5 / −1 in 2 files, tests pass");
  });

  it("version changes when anything visible changes", () => {
    const v0 = version(db);
    t.topUp(a, 100, "x");
    const v1 = version(db);
    setAgentState(db, a, "starved");
    expect(new Set([v0, v1, version(db)]).size).toBe(3);
  });
});
