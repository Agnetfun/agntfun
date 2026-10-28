import { describe, expect, it } from "vitest";
import { FakeClock } from "@devagent/core";
import { createAgent, migrate, openDb } from "@devagent/db";
import {
  allowRecipient,
  checkOutflow,
  recordOutflow,
  removeRecipient,
  type WalletPolicy,
} from "../src/wallet-policy";

const SOL = 1_000_000_000;
const POLICY: WalletPolicy = { perTxLamports: 2 * SOL, dailyLamports: 3 * SOL, cooldownMs: 24 * 3_600_000 };
const TO = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

function setup() {
  const clock = new FakeClock(1_000_000);
  const db = openDb(":memory:");
  migrate(db, clock);
  const a = createAgent(db, clock, { name: "Policy Bot", model: "opus", lockedPrompt: "x".repeat(30) });
  return { db, clock, id: a.id };
}

describe("agent wallet outflow policy", () => {
  it("refuses a recipient that is not on the allowlist", () => {
    const { db, clock, id } = setup();
    expect(checkOutflow(db, clock, id, TO, SOL, POLICY, () => false)).toEqual({
      ok: false,
      reason: "recipient not on the allowlist",
    });
  });

  it("refuses a new recipient until its cooldown has passed", () => {
    const { db, clock, id } = setup();
    allowRecipient(db, clock, id, TO, "op", POLICY);
    expect(checkOutflow(db, clock, id, TO, SOL, POLICY, () => false).ok).toBe(false);
    clock.advance(POLICY.cooldownMs - 1);
    expect(checkOutflow(db, clock, id, TO, SOL, POLICY, () => false).ok).toBe(false);
    clock.advance(1);
    expect(checkOutflow(db, clock, id, TO, SOL, POLICY, () => false)).toEqual({ ok: true });
  });

  it("caps a single send and the rolling 24 hour total", () => {
    const { db, clock, id } = setup();
    allowRecipient(db, clock, id, TO, "op", POLICY);
    clock.advance(POLICY.cooldownMs);
    expect(checkOutflow(db, clock, id, TO, 2 * SOL + 1, POLICY, () => false).ok).toBe(false);
    recordOutflow(db, clock, id, TO, 2 * SOL, "op", "sig1");
    expect(checkOutflow(db, clock, id, TO, SOL, POLICY, () => false).ok).toBe(true);
    expect(checkOutflow(db, clock, id, TO, SOL + 1, POLICY, () => false)).toEqual({
      ok: false,
      reason: "daily limit reached",
    });
    clock.advance(24 * 3_600_000 + 1);
    expect(checkOutflow(db, clock, id, TO, 2 * SOL, POLICY, () => false).ok).toBe(true);
  });

  it("refuses everything while paused, and bad amounts", () => {
    const { db, clock, id } = setup();
    allowRecipient(db, clock, id, TO, "op", POLICY);
    clock.advance(POLICY.cooldownMs);
    expect(checkOutflow(db, clock, id, TO, SOL, POLICY, () => true)).toEqual({ ok: false, reason: "paused" });
    expect(checkOutflow(db, clock, id, TO, 0, POLICY, () => false).ok).toBe(false);
    expect(checkOutflow(db, clock, id, TO, 1.5, POLICY, () => false).ok).toBe(false);
  });

  it("re-adding a removed recipient restarts its cooldown, and bad addresses are refused", () => {
    const { db, clock, id } = setup();
    allowRecipient(db, clock, id, TO, "op", POLICY);
    clock.advance(POLICY.cooldownMs);
    removeRecipient(db, id, TO);
    allowRecipient(db, clock, id, TO, "op", POLICY);
    expect(checkOutflow(db, clock, id, TO, SOL, POLICY, () => false).ok).toBe(false);
    expect(() => allowRecipient(db, clock, id, "not-an-address", "op", POLICY)).toThrow();
  });

  it("keeps the outflow log append only", () => {
    const { db, clock, id } = setup();
    recordOutflow(db, clock, id, TO, SOL, "op", "sig");
    expect(() => db.prepare("DELETE FROM wallet_outflows").run()).toThrow();
  });
});
