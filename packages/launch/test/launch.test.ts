import { Keypair, Transaction } from "@solana/web3.js";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "@devagent/core";
import { createAgent, migrate, openDb, type Db } from "@devagent/db";
import { Treasury, unbalancedTxns } from "@devagent/treasury";
import {
  ClusterError,
  DEFAULT_SPLIT_BPS,
  MockLaunchPad,
  SplitError,
  TreasuryListener,
  buildCreateTx,
  buildSplitTx,
  defaultSplit,
  splitLamports,
  validateSplit,
  type Share,
} from "../src";

const addr = () => Keypair.generate().publicKey.toBase58();
const roles = () => ({
  agent_treasury: addr(),
  infra: addr(),
  deployer: addr(),
  buyback: addr(),
});
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"; // from the official pump-public-docs

describe("fee split rules (mirror the on chain rules)", () => {
  it("default split is valid and totals 10000", () => {
    expect(Object.values(DEFAULT_SPLIT_BPS).reduce((a, b) => a + b, 0)).toBe(10_000);
    expect(defaultSplit(roles())).toHaveLength(4);
  });
  const s = (n: number): Share => ({ role: "buyback", address: addr(), shareBps: n });
  it("rejects bad splits", () => {
    expect(() => validateSplit([])).toThrow(SplitError);
    expect(() => validateSplit([s(5000), s(4000)])).toThrow(/10000/);
    expect(() => validateSplit([s(10_000), s(0)])).toThrow(SplitError);
    expect(() => validateSplit([s(-5), s(10_005)])).toThrow(SplitError);
    expect(() => validateSplit(Array.from({ length: 11 }, () => s(1)))).toThrow(/at most 10/);
    const a = s(5000);
    expect(() => validateSplit([a, { ...a }])).toThrow(/duplicate/);
  });
  it("lamport split is exact and never loses a lamport", () => {
    const sh = defaultSplit(roles());
    for (const total of [0n, 1n, 7n, 999_999_999n, 12_345_678_901n]) {
      const parts = splitLamports(total, sh);
      expect(parts.reduce((a, b) => a + b, 0n)).toBe(total);
    }
    expect(splitLamports(10_000n, sh)).toEqual([4000n, 3000n, 1000n, 2000n]);
  });
});

describe("mock launchpad and treasury listener", () => {
  let db: Db,
    clock: FakeClock,
    treasury: Treasury,
    agent: string,
    pad: MockLaunchPad,
    listener: TreasuryListener;
  beforeEach(() => {
    clock = new FakeClock(1_000_000);
    db = openDb(":memory:");
    migrate(db, clock);
    treasury = new Treasury(db, clock, ["op"]);
    agent = createAgent(db, clock, { name: "a", model: "opus", lockedPrompt: "" }).id;
    pad = new MockLaunchPad();
    listener = new TreasuryListener(db, treasury, pad);
  });
  const launch = async () => {
    const a = roles();
    const r = await pad.launch({
      name: "Agent One",
      symbol: "AGT1",
      uri: "https://example.com/m.json",
      creator: a.deployer,
      split: defaultSplit(a),
    });
    return { a, mint: r.mint };
  };

  it("enforces name, symbol and uri limits", async () => {
    const a = roles();
    const base = { name: "n", symbol: "S", uri: "u", creator: a.deployer, split: defaultSplit(a) };
    await expect(pad.launch({ ...base, name: "x".repeat(33) })).rejects.toThrow();
    await expect(pad.launch({ ...base, symbol: "x".repeat(14) })).rejects.toThrow();
    await expect(pad.launch({ ...base, uri: "x".repeat(201) })).rejects.toThrow();
  });

  it("the split cannot be changed after launch", async () => {
    const { a, mint } = await launch();
    await expect(pad.setSplitAgain(mint, defaultSplit(a))).rejects.toThrow(/cannot be changed/);
  });

  it("books only the treasury share, exactly once, even when polled repeatedly", async () => {
    const { a, mint } = await launch();
    pad.accrueFees(mint, 1_000_000_000n);
    pad.distribute(mint);
    expect(await listener.poll(agent, mint, a.agent_treasury)).toEqual({
      booked: 1,
      lamports: 400_000_000n,
    });
    expect(await listener.poll(agent, mint, a.agent_treasury)).toEqual({ booked: 0, lamports: 0n });
    pad.accrueFees(mint, 500n);
    pad.distribute(mint);
    expect((await listener.poll(agent, mint, a.agent_treasury)).booked).toBe(1);
    const total = db
      .prepare("SELECT SUM(amount) s FROM ledger WHERE account='income:creator_fees'")
      .get() as { s: number };
    expect(total.s).toBe(400_000_000 + 200);
    expect(unbalancedTxns(db)).toEqual([]);
  });

  it("a lost cursor cannot double count either, because the ledger reference is unique", async () => {
    const { a, mint } = await launch();
    pad.accrueFees(mint, 1000n);
    pad.distribute(mint);
    await listener.poll(agent, mint, a.agent_treasury);
    db.prepare("DELETE FROM listener_cursor").run();
    expect((await listener.poll(agent, mint, a.agent_treasury)).booked).toBe(0);
  });
});

describe("real pump.fun transaction builder (offline, official SDK)", () => {
  const rpc = {
    getLatestBlockhash: async () => ({
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 1,
    }),
  };
  const a = roles();
  const req = {
    name: "Agent One",
    symbol: "AGT1",
    uri: "https://example.com/m.json",
    creator: a.deployer,
    split: defaultSplit(a),
  };

  it("builds an unsigned create_v2 transaction paid by the operator wallet and signed only by the new mint", async () => {
    const { mint, tx } = await buildCreateTx(rpc, "devnet", req);
    const t = Transaction.from(Buffer.from(tx, "base64"));
    expect(t.feePayer!.toBase58()).toBe(a.deployer);
    expect(t.instructions.some((i) => i.programId.toBase58() === PUMP)).toBe(true);
    const signed = t.signatures.filter((s) => s.signature);
    expect(signed).toHaveLength(1);
    expect(signed[0]!.publicKey.toBase58()).toBe(mint);
  });

  it("builds the split transaction with the pump fees program and no signatures at all", async () => {
    const { mint } = await buildCreateTx(rpc, "devnet", req);
    const { tx } = await buildSplitTx(rpc, "devnet", req, mint);
    const t = Transaction.from(Buffer.from(tx, "base64"));
    expect(t.instructions).toHaveLength(2);
    expect(t.signatures.filter((s) => s.signature)).toHaveLength(0);
  });

  it("refuses unknown clusters and bad splits (mainnet is gated in config, not here)", async () => {
    await expect(buildCreateTx(rpc, "testnet", req)).rejects.toThrow(ClusterError);
    await expect(buildSplitTx(rpc, "mainnet", req, addr())).rejects.toThrow(ClusterError);
    await expect(buildCreateTx(rpc, "mainnet-beta", req)).resolves.toHaveProperty("mint");
    await expect(buildCreateTx(rpc, "devnet", { ...req, split: [] })).rejects.toThrow(SplitError);
  });
});

describe("ChainBalances", () => {
  it("sums token accounts for the coin and treats bad input as zero", async () => {
    const { ChainBalances } = await import("../src");
    const rpc = {
      getParsedTokenAccountsByOwner: async () => ({
        value: [
          { account: { data: { parsed: { info: { tokenAmount: { uiAmount: 1500.5 } } } } } },
          { account: { data: { parsed: { info: { tokenAmount: { uiAmount: 500 } } } } } },
          { account: { data: {} } },
          { account: { data: { parsed: { info: { tokenAmount: { uiAmount: null } } } } } },
        ],
      }),
    };
    const b = new ChainBalances(rpc, "mint", (s) => {
      if (s === "bad") throw new Error("bad key");
      return s;
    });
    expect(await b.balanceOf("w")).toBe(2000.5);
    expect(await b.balanceOf("bad")).toBe(0);
  });
});
