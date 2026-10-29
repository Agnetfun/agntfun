import { describe, expect, it } from "vitest";
import { ComputeBudgetProgram, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { matchesPrepared } from "../src/web-launch";

const payer = Keypair.generate();
const other = Keypair.generate().publicKey;
const BLOCKHASH = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi";

function prepared(): Transaction {
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: BLOCKHASH });
  tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: other, lamports: 1000 }));
  return tx;
}
const msg = (tx: Transaction) => tx.serializeMessage().toString("base64");

describe("signed launch transaction must be the one the site prepared", () => {
  it("accepts the exact transaction", () => {
    expect(matchesPrepared(msg(prepared()), prepared())).toBe(true);
  });

  it("accepts a wallet adding only priority fee (compute budget) instructions", () => {
    const signed = new Transaction({ feePayer: payer.publicKey, recentBlockhash: BLOCKHASH }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      ...prepared().instructions,
    );
    expect(matchesPrepared(msg(prepared()), signed)).toBe(true);
  });

  it("refuses changed instruction data", () => {
    const signed = new Transaction({ feePayer: payer.publicKey, recentBlockhash: BLOCKHASH }).add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: other, lamports: 999_999 }),
    );
    expect(matchesPrepared(msg(prepared()), signed)).toBe(false);
  });

  it("refuses a different recipient account", () => {
    const signed = new Transaction({ feePayer: payer.publicKey, recentBlockhash: BLOCKHASH }).add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1000 }),
    );
    expect(matchesPrepared(msg(prepared()), signed)).toBe(false);
  });

  it("refuses any extra instruction that is not a compute budget one", () => {
    const signed = prepared().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: other, lamports: 1 }));
    expect(matchesPrepared(msg(prepared()), signed)).toBe(false);
  });

  it("refuses a different fee payer", () => {
    const signed = new Transaction({ feePayer: Keypair.generate().publicKey, recentBlockhash: BLOCKHASH }).add(
      ...prepared().instructions,
    );
    expect(matchesPrepared(msg(prepared()), signed)).toBe(false);
  });

  it("refuses dropped instructions", () => {
    const signed = new Transaction({ feePayer: payer.publicKey, recentBlockhash: BLOCKHASH });
    signed.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }));
    expect(matchesPrepared(msg(prepared()), signed)).toBe(false);
  });
});
