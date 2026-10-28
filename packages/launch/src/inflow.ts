import type { Db } from "@devagent/db";
import type { Treasury } from "@devagent/treasury";
import { PublicKey, type Connection } from "@solana/web3.js";
import { listAgentWallets } from "./wallets";

export type InflowRpc = Pick<Connection, "getSignaturesForAddress" | "getTransaction">;

export interface InflowOptions {
  /** USD cents per SOL used to turn received SOL into runnable budget. TODO(verify): a live price source. */
  solUsdCents: number;
  /** Signatures read per wallet per poll. */
  pageSize: number;
}
export const DEFAULT_INFLOW: InflowOptions = { solUsdCents: 15_000, pageSize: 25 };

/**
 * Watches every agent wallet on chain. Any SOL that lands in it (pump.fun creator fee share, a supporter sending
 * SOL, a devnet airdrop) is booked once as creator-fee income and converted to budget at the configured rate.
 * Idempotent: the transaction signature is the ledger reference, and a cursor stops rereads.
 */
export class InflowWatcher {
  constructor(
    private db: Db,
    private treasury: Treasury,
    private rpc: InflowRpc,
    private opts: InflowOptions = DEFAULT_INFLOW,
  ) {}

  async pollAll(): Promise<{ booked: number; lamports: number }> {
    let booked = 0;
    let lamports = 0;
    for (const w of listAgentWallets(this.db)) {
      const r = await this.poll(w.agentId, w.address);
      booked += r.booked;
      lamports += r.lamports;
    }
    return { booked, lamports };
  }

  async poll(agentId: string, address: string): Promise<{ booked: number; lamports: number }> {
    const cur = this.db.prepare("SELECT last_signature s FROM wallet_cursor WHERE address=?").get(address) as
      { s: string } | undefined;
    const sigs = await this.rpc.getSignaturesForAddress(
      new PublicKey(address),
      { until: cur?.s, limit: this.opts.pageSize },
      "confirmed",
    );
    let booked = 0;
    let lamports = 0;
    // Newest first from the RPC; book oldest first so the ledger reads in order.
    for (const s of [...sigs].reverse()) {
      if (s.err) continue;
      const tx = await this.rpc.getTransaction(s.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (!tx?.meta) continue;
      const keys = tx.transaction.message.getAccountKeys().staticAccountKeys.map((k) => k.toBase58());
      const i = keys.indexOf(address);
      if (i < 0) continue;
      const delta = (tx.meta.postBalances[i] ?? 0) - (tx.meta.preBalances[i] ?? 0);
      if (delta <= 0) continue;
      if (this.treasury.recordCreatorFee(agentId, delta, s.signature)) {
        const cents = Math.floor((delta / 1e9) * this.opts.solUsdCents);
        if (cents > 0) this.treasury.convertSolToUsd(agentId, delta, cents, `inflow:${s.signature}`);
        booked++;
        lamports += delta;
      }
    }
    if (sigs[0])
      this.db
        .prepare(
          "INSERT INTO wallet_cursor (address, last_signature) VALUES (?,?) ON CONFLICT(address) DO UPDATE SET last_signature=excluded.last_signature",
        )
        .run(address, sigs[0].signature);
    return { booked, lamports };
  }
}
