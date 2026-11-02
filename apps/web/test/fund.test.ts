import { generateKeyPairSync } from "node:crypto";
import { Keypair, PublicKey, SystemProgram, Transaction, type Connection } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { FakeClock } from "@devagent/core";
import { createAgent, migrate, openDb } from "@devagent/db";
import { agentWalletAddress, createAgentWallet } from "@devagent/launch";
import { createTradeRoutes } from "../src/trade-routes";

// Funding moves the user's SOL, so the server must only ever relay the exact transfer it built.
function setup(status: () => unknown = () => ({ confirmationStatus: "confirmed", err: null })) {
  const clock = new FakeClock(Date.UTC(2026, 9, 29));
  const db = openDb(":memory:");
  migrate(db, clock);
  const agentId = createAgent(db, clock, { name: "fund me", model: "opus", lockedPrompt: "x".repeat(30) }).id;
  const pub = generateKeyPairSync("x25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
  createAgentWallet(db, clock, pub, agentId);
  const sent: Buffer[] = [];
  const rpc = {
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }),
    sendRawTransaction: async (raw: Buffer) => (sent.push(raw), "sig1"),
    getSignatureStatuses: async () => ({ value: [status()] }),
  } as unknown as Connection;
  return { routes: createTradeRoutes({ db, clock, rpc }), agentId, to: agentWalletAddress(db, agentId)!, sent };
}

describe("fund an agent", () => {
  it("prepares exactly one transfer of the asked amount to the agent's own wallet", async () => {
    const { routes, agentId, to } = setup();
    const user = Keypair.generate();
    const r = await routes.post("/api/fund/prepare", { agentId, wallet: user.publicKey.toBase58(), sol: 0.25 });
    expect(r.status).toBe(200);
    const tx = Transaction.from(Buffer.from((r.body as { tx: string }).tx, "base64"));
    expect(tx.instructions).toHaveLength(1);
    expect(tx.instructions[0]!.programId.equals(SystemProgram.programId)).toBe(true);
    const keys = tx.instructions[0]!.keys.map((k) => k.pubkey.toBase58());
    expect(keys).toEqual([user.publicKey.toBase58(), to]);
    expect(tx.instructions[0]!.data.readBigUInt64LE(4)).toBe(250_000_000n);
  });

  it("relays the signed transfer, and refuses a transfer that was changed after preparing", async () => {
    const { routes, agentId, sent } = setup();
    const user = Keypair.generate();
    const wallet = user.publicKey.toBase58();
    const prep = (await routes.post("/api/fund/prepare", { agentId, wallet, sol: 0.1 })).body as { tx: string };
    // A tampered copy: same signer and amount, but the SOL goes to someone else.
    const real = Transaction.from(Buffer.from(prep.tx, "base64"));
    const evil = new Transaction({ feePayer: user.publicKey, recentBlockhash: real.recentBlockhash! }).add(
      SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: new PublicKey(Keypair.generate().publicKey), lamports: 100_000_000 }),
    );
    evil.sign(user);
    const bad = await routes.post("/api/fund/submit", { agentId, wallet, tx: evil.serialize().toString("base64") });
    expect(bad).toMatchObject({ status: 400 });
    expect(sent).toHaveLength(0);
    real.sign(user);
    const ok = await routes.post("/api/fund/submit", { agentId, wallet, tx: real.serialize().toString("base64") });
    expect(ok).toMatchObject({ status: 200, body: { signature: "sig1" } });
    expect(sent).toHaveLength(1);
  });

  it("refuses amounts outside 0.001 to 100 SOL", async () => {
    const { routes, agentId } = setup();
    const wallet = Keypair.generate().publicKey.toBase58();
    for (const sol of [0, 0.0001, 101, -1, "abc"])
      expect((await routes.post("/api/fund/prepare", { agentId, wallet, sol })).status).toBe(400);
  });

  it("relays a prepared transfer once only, even if submitted twice", async () => {
    const { routes, agentId, sent } = setup();
    const user = Keypair.generate();
    const wallet = user.publicKey.toBase58();
    const prep = (await routes.post("/api/fund/prepare", { agentId, wallet, sol: 0.1 })).body as { tx: string };
    const tx = Transaction.from(Buffer.from(prep.tx, "base64"));
    tx.sign(user);
    const raw = tx.serialize().toString("base64");
    expect((await routes.post("/api/fund/submit", { agentId, wallet, tx: raw })).status).toBe(200);
    expect((await routes.post("/api/fund/submit", { agentId, wallet, tx: raw })).status).toBe(400);
    expect(sent).toHaveLength(1);
  });

  it("after broadcasting, a failed confirmation check returns the signature as pending, never 'try again'", async () => {
    const { routes, agentId, sent } = setup(() => {
      throw new Error("fetch failed");
    });
    const user = Keypair.generate();
    const wallet = user.publicKey.toBase58();
    const prep = (await routes.post("/api/fund/prepare", { agentId, wallet, sol: 0.1 })).body as { tx: string };
    const tx = Transaction.from(Buffer.from(prep.tx, "base64"));
    tx.sign(user);
    const r = await routes.post("/api/fund/submit", { agentId, wallet, tx: tx.serialize().toString("base64") });
    expect(r).toMatchObject({ status: 202, body: { signature: "sig1", pending: true } });
    expect(sent).toHaveLength(1);
  });

  it("an on-chain rejection is reported as safe to retry", async () => {
    const { routes, agentId } = setup(() => ({ confirmationStatus: "confirmed", err: { InstructionError: [0, "x"] } }));
    const user = Keypair.generate();
    const wallet = user.publicKey.toBase58();
    const prep = (await routes.post("/api/fund/prepare", { agentId, wallet, sol: 0.1 })).body as { tx: string };
    const tx = Transaction.from(Buffer.from(prep.tx, "base64"));
    tx.sign(user);
    const r = await routes.post("/api/fund/submit", { agentId, wallet, tx: tx.serialize().toString("base64") });
    expect(r).toMatchObject({ status: 400, body: { signature: "sig1" } });
  });

  it("keeps a quote and a later prepare both valid, so signing either one works", async () => {
    const { routes, agentId, sent } = setup();
    const user = Keypair.generate();
    const wallet = user.publicKey.toBase58();
    const first = (await routes.post("/api/fund/prepare", { agentId, wallet, sol: 0.1 })).body as { tx: string };
    await routes.post("/api/fund/prepare", { agentId, wallet, sol: 0.2 });
    const tx = Transaction.from(Buffer.from(first.tx, "base64"));
    tx.sign(user);
    expect((await routes.post("/api/fund/submit", { agentId, wallet, tx: tx.serialize().toString("base64") })).status).toBe(200);
    expect(sent).toHaveLength(1);
  });
});
