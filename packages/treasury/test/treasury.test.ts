import { beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "@devagent/core";
import { createAgent, migrate, openDb, setAgentState, type Db } from "@devagent/db";
import { LedgerError, OperatorError, Treasury, postTxn, unbalancedTxns } from "../src";

const DAY = 86_400_000;
let db: Db, clock: FakeClock, t: Treasury, a: string;
beforeEach(() => {
  clock = new FakeClock(10 * DAY);
  db = openDb(":memory:");
  migrate(db, clock);
  t = new Treasury(db, clock, ["op1"], {
    dailyCapCents: 100,
    minRunwayDays: 1,
    sessionReserveCents: 10,
  });
  a = createAgent(db, clock, { name: "a", model: "opus", lockedPrompt: "" }).id;
});

describe("ledger", () => {
  it("rejects unbalanced and malformed transactions", () => {
    const bad = (entries: never[]) => () =>
      postTxn(db, clock, { agentId: a, unit: "usd_cents", entries });
    expect(
      bad([
        { account: "x", direction: "debit", amount: 5 },
        { account: "y", direction: "credit", amount: 4 },
      ] as never),
    ).toThrow(LedgerError);
    expect(bad([{ account: "x", direction: "debit", amount: 5 }] as never)).toThrow(LedgerError);
    expect(
      bad([
        { account: "x", direction: "debit", amount: 0.5 },
        { account: "y", direction: "credit", amount: 0.5 },
      ] as never),
    ).toThrow(LedgerError);
    expect(db.prepare("SELECT COUNT(*) c FROM ledger").get()).toEqual({ c: 0 });
  });
  it("is append only", () => {
    t.topUp(a, 100, "x");
    expect(() => db.prepare("UPDATE ledger SET amount=1").run()).toThrow(/append-only/);
  });
});

describe("treasury", () => {
  it("books fees, conversion, top ups and spend, always balanced", () => {
    t.recordCreatorFee(a, 5_000_000_000, "fee1");
    t.convertSolToUsd(a, 5_000_000_000, 60, "fx1");
    t.topUp(a, 40, "card");
    t.spend(a, "llm", 7, "s1");
    t.spend(a, "x_posts", 3, "s1");
    expect(t.balanceCents(a)).toBe(90);
    expect(unbalancedTxns(db)).toEqual([]);
  });
  it("gates sessions on funds, daily cap and runway", () => {
    expect(t.canRun(a)).toEqual({ ok: false, reason: "no_funds" });
    t.topUp(a, 1000, "x");
    expect(t.canRun(a).ok).toBe(true);
    for (let i = 0; i < 10; i++) t.spend(a, "llm", 10, `s${i}`);
    expect(t.canRun(a)).toEqual({ ok: false, reason: "daily_cap" });
    clock.advance(DAY + 1);
    expect(t.canRun(a).ok).toBe(true);
  });
  it("low runway puts it to sleep", () => {
    t.topUp(a, 30, "x");
    t.spend(a, "llm", 20, "s1");
    clock.advance(1000);
    expect(t.runwayDays(a)).toBeLessThan(1);
    expect(t.canRun(a)).toEqual({ ok: false, reason: "low_runway" });
  });
  it("LLM spend uses prepaid credits first", () => {
    t.topUp(a, 100, "x");
    t.buyCredits(a, 50, "op1", "anthropic");
    expect(t.balanceCents(a)).toBe(100);
    t.spend(a, "llm", 30, "s");
    expect(t.creditsCents(a)).toBe(20);
    expect(t.cashCents(a)).toBe(50);
    expect(unbalancedTxns(db)).toEqual([]);
  });
  it("only a listed operator can move money out", () => {
    t.topUp(a, 100, "x");
    expect(() => t.withdraw(a, 10, "intruder", "addr")).toThrow(OperatorError);
    expect(() => t.withdraw(a, 10, "", "addr")).toThrow(OperatorError);
    expect(() => t.buyCredits(a, 10, "agent-self", "p")).toThrow(OperatorError);
    expect(() => t.withdraw(a, 1000, "op1", "addr")).toThrow(OperatorError);
    t.withdraw(a, 10, "op1", "addr");
    expect(t.balanceCents(a)).toBe(90);
    expect(
      db.prepare("SELECT operator_id o FROM ledger WHERE ref_type='withdraw' LIMIT 1").get(),
    ).toEqual({ o: "op1" });
  });
  it("a top up wakes a starved agent", () => {
    setAgentState(db, a, "starved");
    t.topUp(a, 500, "x");
    expect((db.prepare("SELECT state s FROM agents WHERE id=?").get(a) as { s: string }).s).toBe(
      "sleeping",
    );
  });
});
