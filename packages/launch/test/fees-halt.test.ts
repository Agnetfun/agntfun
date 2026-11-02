import { Keypair, type Connection } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { FakeClock } from "@devagent/core";
import { createAgent, migrate, openDb } from "@devagent/db";
import { FeeDistributor } from "../src/fees";

// The kill switch must stop money leaving agent wallets: a halted agent's fees are never distributed.
class Spy extends FeeDistributor {
  ran: string[] = [];
  override async run(agentId: string): Promise<boolean> {
    this.ran.push(agentId);
    return true;
  }
}

describe("fee payouts and the kill switch", () => {
  it("skips halted agents and pays the others", async () => {
    const clock = new FakeClock(Date.UTC(2026, 10, 2));
    const db = openDb(":memory:");
    migrate(db, clock);
    const ids = ["calm", "halted"].map((n) => createAgent(db, clock, { name: n, model: "opus", lockedPrompt: "x".repeat(30) }).id);
    for (const [i, id] of ids.entries())
      db.prepare("INSERT INTO launches (agent_id, mint, cluster, signature, split_json, launched_at) VALUES (?,?,?,?,?,?)").run(
        id, Keypair.generate().publicKey.toBase58(), "devnet", "sig" + i, "[]", 1,
      );
    const spy = new Spy(db, clock, {} as Connection, () => Keypair.generate());
    const out = await spy.runAll("devnet", (id) => id === ids[1]);
    expect(spy.ran).toEqual([ids[0]]);
    expect(out.paid).toBe(1);
  });
});
