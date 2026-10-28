import { describe, expect, it } from "vitest";
import { FakeClock } from "@devagent/core";
import { createAgent, migrate, openDb } from "@devagent/db";
import { KillSwitch } from "@devagent/safety";
import { Treasury, unbalancedTxns } from "@devagent/treasury";
import { Scheduler } from "../src";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function setup() {
  const clock = new FakeClock(100 * DAY);
  const db = openDb(":memory:");
  migrate(db, clock);
  const kill = new KillSwitch(db, clock);
  const treasury = new Treasury(db, clock, ["op"], {
    dailyCapCents: 60,
    minRunwayDays: 0.25,
    sessionReserveCents: 15,
  });
  const funded = createAgent(db, clock, { name: "funded", model: "opus", lockedPrompt: "" }).id;
  const broke = createAgent(db, clock, { name: "broke", model: "astra", lockedPrompt: "" }).id;
  const runs: Array<{ id: string; at: number }> = [];
  const sched = new Scheduler(db, clock, treasury, kill, async (id) => {
    runs.push({ id, at: clock.now() });
    return { sessionId: `s${runs.length}`, llmCents: 12, postCents: 1 };
  });
  sched.schedule(funded, 6 * HOUR);
  sched.schedule(broke, 6 * HOUR);
  return { clock, db, kill, treasury, funded, broke, runs, sched };
}
const state = (db: ReturnType<typeof setup>["db"], id: string) =>
  (db.prepare("SELECT state s FROM agents WHERE id=?").get(id) as { s: string }).s;

describe("14 day fake time simulation", () => {
  it("respects money, daily cap, kill switch and keeps the books balanced", async () => {
    const s = setup();
    s.treasury.topUp(s.funded, 80, "seed");
    const spendAtHour: number[] = [];
    for (let h = 0; h < 14 * 24; h++) {
      if (h === 3 * 24) s.treasury.topUp(s.funded, 400, "topup"); // starved by now, wakes on top up
      if (h === 9 * 24) s.kill.trip(s.funded, "op", "drill");
      if (h === 10 * 24) s.kill.clear(s.funded);
      await s.sched.tick();
      spendAtHour.push(s.treasury.spentLastDay(s.funded));
      if (h === 2 * 24 + 12) expect(state(s.db, s.funded)).toBe("starved");
      if (h === 9 * 24 + 6) expect(state(s.db, s.funded)).toBe("halted");
      s.clock.advance(HOUR);
    }
    // the unfunded agent never ran, the funded one did, and only when allowed
    expect(s.runs.some((r) => r.id === s.broke)).toBe(false);
    expect(state(s.db, s.broke)).toBe("starved");
    const mine = s.runs.filter((r) => r.id === s.funded);
    expect(mine.length).toBeGreaterThan(20);
    // nothing ran during the kill window
    const kStart = 100 * DAY + 9 * DAY;
    expect(mine.some((r) => r.at >= kStart && r.at < kStart + DAY)).toBe(false);
    // rolling 24h spend never exceeded the cap by more than the one session that crossed it
    expect(Math.max(...spendAtHour)).toBeLessThanOrEqual(60 + 13);
    // money never went negative and every transaction balances
    expect(s.treasury.balanceCents(s.funded)).toBeGreaterThanOrEqual(0);
    expect(unbalancedTxns(s.db)).toEqual([]);
    // it was starved at least once and resumed after the top up
    const ev = s.db.prepare("SELECT COUNT(*) c FROM events WHERE type='agent.starved'").get() as {
      c: number;
    };
    expect(ev.c).toBeGreaterThanOrEqual(2);
    expect(mine.some((r) => r.at > 100 * DAY + 3 * DAY)).toBe(true);
  });

  it("a failing run is logged, not fatal, and the agent still sleeps until next time", async () => {
    const s = setup();
    s.treasury.topUp(s.funded, 200, "seed");
    const bad = new Scheduler(s.db, s.clock, s.treasury, s.kill, async () => {
      throw new Error("boom");
    });
    const r = await bad.tick();
    expect(r.skipped).toContainEqual({ agentId: s.funded, why: "run failed" });
    expect(state(s.db, s.funded)).toBe("sleeping");
    expect(await bad.tick()).toEqual({ ran: [], skipped: [] });
  });
});
