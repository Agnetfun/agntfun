import type { Db } from "@devagent/db";
import type { Connection, PublicKey } from "@solana/web3.js";
import { signaturesSince } from "./signatures";

/**
 * On-chain trading volume for a coin, so 24h volume and the chart's volume bars count every trade, including ones
 * made on pump.fun itself. Each round reads the new transactions on the coin's venue (its bonding curve while it
 * trades there, its PumpSwap pool after graduation) and stores each one once, by signature, with the SOL it moved:
 * the change in the curve's lamports, or in the pool's SOL (WSOL) vault. Failed transactions are skipped.
 */
export type VolumeRpc = Pick<Connection, "getSignaturesForAddress" | "getParsedTransaction">;
export type Venue =
  | { kind: "curve"; address: PublicKey }
  | { kind: "pool"; address: PublicKey; quoteVault: PublicKey };

const PER_ROUND = 40;

export async function collectVolume(db: Db, rpc: Partial<VolumeRpc>, mint: string, venue: Venue): Promise<number> {
  if (!rpc.getSignaturesForAddress || !rpc.getParsedTransaction) return 0;
  const cursor = db.prepare("SELECT last_signature s FROM trade_cursor WHERE mint=? AND venue=?").get(mint, venue.kind) as
    | { s: string }
    | undefined;
  // Every new trade since the cursor (paged), not just the newest page: a busy coin's older trades are not skipped.
  const sigs = await signaturesSince(rpc as Pick<Connection, "getSignaturesForAddress">, venue.address, cursor?.s, PER_ROUND);
  if (!sigs.length) return 0;
  let added = 0;
  // Oldest first, so a partial round still moves the cursor forward in order.
  for (const s of [...sigs].reverse()) {
    if (s.err) continue;
    const tx = await rpc.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (!tx?.meta || tx.meta.err) continue;
    let sol = 0;
    if (venue.kind === "curve") {
      const i = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey.equals(venue.address));
      if (i >= 0) sol = Math.abs(tx.meta.postBalances[i]! - tx.meta.preBalances[i]!) / 1e9;
    } else {
      const i = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey.equals(venue.quoteVault));
      const amount = (list: typeof tx.meta.preTokenBalances) =>
        Number(list?.find((b) => b.accountIndex === i)?.uiTokenAmount.amount ?? 0);
      if (i >= 0) sol = Math.abs(amount(tx.meta.postTokenBalances) - amount(tx.meta.preTokenBalances)) / 1e9;
    }
    if (sol > 0) {
      const ts = (s.blockTime ?? tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000;
      added += db
        .prepare("INSERT OR IGNORE INTO trade_volume (mint, signature, ts, sol) VALUES (?,?,?,?)")
        .run(mint, s.signature, ts, sol).changes as number;
    }
  }
  db.prepare("INSERT OR REPLACE INTO trade_cursor (mint, venue, last_signature) VALUES (?,?,?)").run(mint, venue.kind, sigs[0]!.signature);
  return added;
}
