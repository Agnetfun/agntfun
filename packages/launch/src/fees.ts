import { createRequire } from "node:module";
import type { Clock } from "@devagent/core";
import { appendEvent, type Db } from "@devagent/db";
import type { OnlinePumpSdk as OnlineSdk } from "@pump-fun/pump-sdk";
import { PublicKey, Transaction, type Connection, type Keypair } from "@solana/web3.js";
import { splitIsSet } from "./web-launch";

// Same CommonJS loading as pumpfun.ts.
const { OnlinePumpSdk } = createRequire(import.meta.url)("@pump-fun/pump-sdk") as {
  OnlinePumpSdk: new (c: Connection) => OnlineSdk;
};

/**
 * Pays out each coin's accrued pump.fun creator fees to its fee split (the "claim fees" step).
 * pump.fun keeps creator fees in a vault until someone sends the permissionless distribute instruction;
 * without this the agent's share never reaches its wallet. The agent's own wallet pays the network fee,
 * and the transaction holds only the SDK's sweep and distribute instructions, built here, never by a model.
 * Per official SDK docs: OnlinePumpSdk.getMinimumDistributableFee and buildDistributeCreatorFeesInstructions.
 */
export interface FeeOptions {
  /** Distribute only when at least this many lamports are waiting (network fee is ~5000 lamports). */
  minLamports: number;
  /** Seconds between attempts per coin. */
  everySeconds: number;
  /** Lamports the agent wallet must hold to pay the network fee. */
  feeReserveLamports: number;
}
export const DEFAULT_FEES: FeeOptions = { minLamports: 5_000_000, everySeconds: 1800, feeReserveLamports: 100_000 };

export interface FeeStatus {
  mint: string;
  checkedAt: number;
  waitingLamports: number;
  canDistribute: boolean;
  lastPayoutAt: number | null;
  lastSignature: string | null;
}

export function feeStatus(db: Db, agentId: string): FeeStatus | undefined {
  const r = db
    .prepare(
      "SELECT f.* FROM fee_status f JOIN launches l ON l.mint=f.mint WHERE l.agent_id=?",
    )
    .get(agentId) as
    | { mint: string; checked_at: number; waiting: number; can: number; paid_at: number | null; signature: string | null }
    | undefined;
  return (
    r && {
      mint: r.mint,
      checkedAt: r.checked_at,
      waitingLamports: r.waiting,
      canDistribute: !!r.can,
      lastPayoutAt: r.paid_at,
      lastSignature: r.signature,
    }
  );
}

export class FeeDistributor {
  private sdk: OnlineSdk;
  constructor(
    private db: Db,
    private clock: Clock,
    private rpc: Connection,
    private signerFor: (agentId: string) => Keypair,
    private opts: FeeOptions = DEFAULT_FEES,
  ) {
    this.sdk = new OnlinePumpSdk(rpc);
  }

  private save(mint: string, waiting: number, can: boolean, paid?: string) {
    this.db
      .prepare(
        `INSERT INTO fee_status (mint, checked_at, waiting, can, paid_at, signature) VALUES (?,?,?,?,?,?)
         ON CONFLICT(mint) DO UPDATE SET checked_at=excluded.checked_at, waiting=excluded.waiting, can=excluded.can,
           paid_at=COALESCE(excluded.paid_at, fee_status.paid_at), signature=COALESCE(excluded.signature, fee_status.signature)`,
      )
      .run(mint, this.clock.now(), waiting, can ? 1 : 0, paid ? this.clock.now() : null, paid ?? null);
  }

  async runAll(cluster: string): Promise<{ checked: number; paid: number }> {
    const due = this.db
      .prepare(
        `SELECT l.agent_id, l.mint FROM launches l LEFT JOIN fee_status f ON f.mint=l.mint
         WHERE l.cluster=? AND (f.checked_at IS NULL OR f.checked_at < ?)`,
      )
      .all(cluster, this.clock.now() - this.opts.everySeconds * 1000) as { agent_id: string; mint: string }[];
    let paid = 0;
    for (const d of due) {
      try {
        if (await this.run(d.agent_id, d.mint)) paid++;
      } catch {
        this.save(d.mint, 0, false); // retried next round
      }
    }
    return { checked: due.length, paid };
  }

  /** One coin: read what is waiting, distribute when it is worth the network fee. */
  async run(agentId: string, mint: string): Promise<boolean> {
    if (!splitIsSet(this.db, agentId)) return false; // without a sharing config the creator collects directly
    const signer = this.signerFor(agentId);
    try {
      const m = new PublicKey(mint);
      const info = await this.sdk.getMinimumDistributableFee(m, signer.publicKey);
      const waiting = Number(info.distributableFees.toString());
      if (!info.canDistribute || waiting < this.opts.minLamports) {
        this.save(mint, waiting, info.canDistribute);
        return false;
      }
      const balance = await this.rpc.getBalance(signer.publicKey, "confirmed");
      if (balance < this.opts.feeReserveLamports) {
        this.save(mint, waiting, true);
        return false;
      }
      const { instructions } = await this.sdk.buildDistributeCreatorFeesInstructions(m, { payer: signer.publicKey });
      const { blockhash, lastValidBlockHeight } = await this.rpc.getLatestBlockhash("confirmed");
      const tx = new Transaction({ feePayer: signer.publicKey, blockhash, lastValidBlockHeight }).add(...instructions);
      tx.sign(signer);
      const signature = await this.rpc.sendRawTransaction(tx.serialize());
      await this.rpc.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
      this.save(mint, 0, false, signature);
      appendEvent(this.db, this.clock, { type: "fees.distributed", agentId, payload: { mint, lamports: waiting, signature } });
      return true;
    } finally {
      signer.secretKey.fill(0);
    }
  }
}
