import { createRequire } from "node:module";
import type { Clock } from "@devagent/core";
import type { Db } from "@devagent/db";
import type { PumpSdk } from "@pump-fun/pump-sdk";
import { PublicKey, type Connection } from "@solana/web3.js";

// Same CommonJS loading as pumpfun.ts (the SDK's ESM entry does not load under Node).
const sdk = createRequire(import.meta.url)("@pump-fun/pump-sdk") as {
  PUMP_SDK: PumpSdk;
  bondingCurvePda(mint: PublicKey): PublicKey;
};

export type PriceRpc = Pick<Connection, "getAccountInfo" | "getTokenLargestAccounts">;

const TOKEN_DECIMALS = 6;

/**
 * Reads each launched coin's bonding curve straight from chain and stores a price sample.
 * Price per token in SOL = virtual quote reserves / virtual token reserves (pump.fun constant product curve).
 * Holders is the count of non empty accounts among the largest token accounts (the RPC returns at most 20).
 */
export class PriceSampler {
  constructor(
    private db: Db,
    private clock: Clock,
    private rpc: PriceRpc,
  ) {}

  async sampleAll(): Promise<number> {
    const mints = this.db
      .prepare("SELECT mint FROM launches WHERE cluster IN ('devnet','localnet','mainnet-beta')")
      .all() as { mint: string }[];
    let n = 0;
    for (const { mint } of mints) {
      try {
        if (await this.sample(mint)) n++;
      } catch {
        /* one bad coin must not stop the others; the next round retries */
      }
    }
    return n;
  }

  async sample(mint: string): Promise<boolean> {
    const m = new PublicKey(mint);
    const info = await this.rpc.getAccountInfo(sdk.bondingCurvePda(m), "confirmed");
    if (!info) return false;
    const bc = sdk.PUMP_SDK.decodeBondingCurve(info);
    const vTok = Number(bc.virtualTokenReserves.toString()) / 10 ** TOKEN_DECIMALS;
    const vSol = Number(bc.virtualQuoteReserves.toString()) / 1e9;
    const supply = Number(bc.tokenTotalSupply.toString()) / 10 ** TOKEN_DECIMALS;
    if (!(vTok > 0)) return false;
    const price = vSol / vTok;
    let holders = 0;
    try {
      const largest = (await this.rpc.getTokenLargestAccounts(m, "confirmed")).value.filter(
        (a) => Number(a.amount) > 0,
      );
      holders = largest.length;
      // Token accounts, not owner wallets (the bonding curve's own account is usually rank 1).
      const top = largest.slice(0, 10).map((a, i) => ({
        rank: i + 1,
        address: a.address.toBase58(),
        pct: supply > 0 ? (Number(a.amount) / 10 ** TOKEN_DECIMALS / supply) * 100 : 0,
      }));
      this.db
        .prepare("INSERT OR REPLACE INTO holder_snapshots (mint, ts, holders_json) VALUES (?,?,?)")
        .run(mint, this.clock.now(), JSON.stringify(top));
    } catch {
      /* some RPCs refuse this call; keep the price */
    }
    this.db
      .prepare(
        "INSERT OR REPLACE INTO price_samples (mint, ts, price_sol, mcap_sol, holders, complete) VALUES (?,?,?,?,?,?)",
      )
      .run(mint, this.clock.now(), price, price * supply, holders, bc.complete ? 1 : 0);
    return true;
  }
}
