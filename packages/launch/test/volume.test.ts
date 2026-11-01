import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { FakeClock } from "@devagent/core";
import { migrate, openDb } from "@devagent/db";
import { collectVolume, type VolumeRpc } from "../src/volume";

// 24h volume comes from the chain: each trade on the coin's venue is counted once, failed ones never.
const curve = Keypair.generate().publicKey;
const tx = (lamportsBefore: number, lamportsAfter: number, err: unknown = null) => ({
  blockTime: 1_793_000_000,
  meta: { err, preBalances: [5, lamportsBefore], postBalances: [5, lamportsAfter], preTokenBalances: [], postTokenBalances: [] },
  transaction: { message: { accountKeys: [{ pubkey: Keypair.generate().publicKey }, { pubkey: curve }] } },
});

function fakeRpc(pages: { signature: string; err: unknown }[][], txs: Record<string, unknown>) {
  let call = 0;
  return {
    getSignaturesForAddress: async (_a: unknown, opts: { until?: string }) => {
      const page = pages[call++] ?? [];
      return page.filter((s) => s.signature !== opts.until).map((s) => ({ ...s, blockTime: 1_793_000_000, slot: 1, memo: null }));
    },
    getParsedTransaction: async (sig: string) => txs[sig] ?? null,
  } as unknown as VolumeRpc;
}

describe("on-chain volume", () => {
  it("records each trade once with the SOL it moved, skips failed ones, and resumes from the cursor", async () => {
    const db = openDb(":memory:");
    migrate(db, new FakeClock(1));
    const txs = { a: tx(10e9, 10.5e9), b: tx(10.5e9, 10.2e9), bad: tx(10e9, 11e9, { InstructionError: [0, "x"] }), c: tx(10.2e9, 11.2e9) };
    // Newest first, as the RPC returns them; the second round only sees what is new.
    const rpc = fakeRpc([[{ signature: "bad", err: null }, { signature: "b", err: null }, { signature: "a", err: null }], [{ signature: "c", err: null }]], txs);
    expect(await collectVolume(db, rpc, "M", { kind: "curve", address: curve })).toBe(2);
    expect(await collectVolume(db, rpc, "M", { kind: "curve", address: curve })).toBe(1);
    const r = db.prepare("SELECT COUNT(*) n, ROUND(SUM(sol), 6) s FROM trade_volume WHERE mint='M'").get() as { n: number; s: number };
    expect(r).toEqual({ n: 3, s: 1.8 }); // 0.5 + 0.3 + 1.0; the failed 1.0 is not counted
    expect(await collectVolume(db, fakeRpc([[{ signature: "a", err: null }]], txs), "M", { kind: "curve", address: curve })).toBe(0); // seen before
  });

  it("does nothing when the RPC cannot list signatures", async () => {
    const db = openDb(":memory:");
    migrate(db, new FakeClock(1));
    expect(await collectVolume(db, {}, "M", { kind: "curve", address: curve })).toBe(0);
  });
});
