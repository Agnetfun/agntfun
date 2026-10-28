import { beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "@devagent/core";
import { appendEvent, migrate, openDb, type Db } from "../src";

let db: Db;
const clock = new FakeClock(1_700_000_000_000);

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db, clock);
});

const tables = () =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name as string);

const addAgent = (id = "a1") =>
  db.prepare("INSERT INTO agents (id, name, created_at) VALUES (?, 'bot', 1)").run(id);

const addLedger = (amount: number, unit = "lamports") =>
  db
    .prepare(
      "INSERT INTO ledger (id, ts, txn_id, account, amount, unit, direction) VALUES ('l1', 1, 't1', 'treasury:sol', ?, ?, 'debit')",
    )
    .run(amount, unit);

describe("schema v0", () => {
  it("creates the four core tables", () => {
    expect(tables()).toEqual(expect.arrayContaining(["agents", "sessions", "events", "ledger"]));
  });

  it("migrate is idempotent", () => {
    expect(migrate(db, clock)).toEqual([]);
  });

  it("enforces foreign keys", () => {
    expect(() =>
      db.prepare("INSERT INTO sessions (id, agent_id, started_at) VALUES ('s1','nope',1)").run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it("rejects unknown agent states", () => {
    expect(() => db.prepare("UPDATE agents SET state='flying'").run()).not.toThrow(); // no rows yet
    addAgent();
    expect(() => db.prepare("UPDATE agents SET state='flying'").run()).toThrow(/CHECK/);
  });
});

describe("append-only tables", () => {
  it("events cannot be updated or deleted", () => {
    appendEvent(db, clock, { type: "t" });
    expect(() => db.exec("UPDATE events SET type='x'")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM events")).toThrow(/append-only/);
  });

  it("ledger cannot be updated or deleted", () => {
    addLedger(5);
    expect(() => db.exec("UPDATE ledger SET amount=9")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM ledger")).toThrow(/append-only/);
  });

  it("ledger rejects non positive amounts and unknown units", () => {
    expect(() => addLedger(0)).toThrow(/CHECK/);
    expect(() => addLedger(-3)).toThrow(/CHECK/);
    expect(() => addLedger(1, "dollars")).toThrow(/CHECK/);
  });
});

describe("appendEvent", () => {
  it("stores json payload and the clock time", () => {
    const id = appendEvent(db, clock, { type: "boot", payload: { a: 1 } });
    const row = db.prepare("SELECT * FROM events WHERE id = ?").get(id)!;
    expect(row.ts).toBe(1_700_000_000_000);
    expect(JSON.parse(row.payload_json as string)).toEqual({ a: 1 });
  });
});
