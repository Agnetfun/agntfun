import { createRequire } from "node:module";
import type { Clock } from "@devagent/core";
import type { Db } from "@devagent/db";
import type { PumpSdk } from "@pump-fun/pump-sdk";
import { PublicKey, type Connection } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { collectVolume, type VolumeRpc } from "./volume";

// Same CommonJS loading as pumpfun.ts (the SDK's ESM entry does not load under Node).
const sdk = createRequire(import.meta.url)("@pump-fun/pump-sdk") as {
  PUMP_SDK: PumpSdk;
  bondingCurvePda(mint: PublicKey): PublicKey;
  canonicalPumpPoolPda(mint: PublicKey): PublicKey;
  getPumpAmmProgram: typeof import("@pump-fun/pump-sdk").getPumpAmmProgram;
};

export type PriceRpc = Pick<Connection, "getAccountInfo" | "getTokenLargestAccounts"> &
  Partial<Pick<Connection, "getTokenAccountBalance">> &
  Partial<VolumeRpc>;

const TOKEN_DECIMALS = 6;

/**
 * A graduated coin trades in its PumpSwap pool: price = (SOL in the pool + the pool's virtualQuoteReserves) / tokens
 * in the pool, read with the official pump-amm account layout. The virtual part is confirmed by the program itself:
 * simulated buys and sells on a graduated devnet coin (official SDK simulateMultiHopSwap) match this price after
 * fees, and miss it by about 20% without the virtual reserves.
 */
interface PoolInfo {
  price: number;
  pool: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
}
async function poolInfo(rpc: PriceRpc, mint: PublicKey): Promise<PoolInfo | null> {
  if (!rpc.getTokenAccountBalance) return null;
  try {
    const pool = sdk.canonicalPumpPoolPda(mint);
    const p = await sdk.getPumpAmmProgram(rpc as unknown as Connection).account.pool.fetch(pool);
    const [base, quote] = await Promise.all([
      rpc.getTokenAccountBalance(p.poolBaseTokenAccount, "confirmed"),
      rpc.getTokenAccountBalance(p.poolQuoteTokenAccount, "confirmed"),
    ]);
    const tokens = Number(base.value.amount) / 10 ** TOKEN_DECIMALS;
    const sol = (Number(quote.value.amount) + Number(p.virtualQuoteReserves?.toString() ?? 0)) / 1e9;
    if (!(tokens > 0)) return null;
    return { price: sol / tokens, pool, baseVault: p.poolBaseTokenAccount, quoteVault: p.poolQuoteTokenAccount };
  } catch {
    return null; // no pool yet (just graduated) or the RPC refused
  }
}

/** The curve's own token account, under either token program (pump.fun coins use Token-2022 since create_v2). */
const curveAccounts = (mint: PublicKey) =>
  [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((p) =>
    getAssociatedTokenAddressSync(mint, sdk.bondingCurvePda(mint), true, p).toBase58(),
  );

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

  /**
   * Reads the coin's price and stores a sample. `priceOnly` (used right after a trade on this site) skips the slow
   * parts, volume and holders, so the chart moves at once; the regular round fills those in.
   */
  async sample(mint: string, opts: { priceOnly?: boolean } = {}): Promise<boolean> {
    const m = new PublicKey(mint);
    const info = await this.rpc.getAccountInfo(sdk.bondingCurvePda(m), "confirmed");
    if (!info) return false;
    const bc = sdk.PUMP_SDK.decodeBondingCurve(info);
    const vTok = Number(bc.virtualTokenReserves.toString()) / 10 ** TOKEN_DECIMALS;
    const vSol = Number(bc.virtualQuoteReserves.toString()) / 1e9;
    const supply = Number(bc.tokenTotalSupply.toString()) / 10 ** TOKEN_DECIMALS;
    // On the curve the price comes from its virtual reserves; once graduated, from the PumpSwap pool.
    const pool = bc.complete ? await poolInfo(this.rpc, m) : null;
    const price = bc.complete ? (pool?.price ?? null) : vTok > 0 ? vSol / vTok : null;
    if (price === null || !(price > 0)) return false;
    if (opts.priceOnly) {
      // Keep the last known holder count instead of writing 0 for a sample that did not look.
      const last = this.db.prepare("SELECT holders FROM price_samples WHERE mint=? ORDER BY ts DESC LIMIT 1").get(mint) as
        | { holders: number }
        | undefined;
      this.db
        .prepare("INSERT OR REPLACE INTO price_samples (mint, ts, price_sol, mcap_sol, holders, complete) VALUES (?,?,?,?,?,?)")
        .run(mint, this.clock.now(), price, price * supply, last?.holders ?? 0, bc.complete ? 1 : 0);
      return true;
    }
    // Volume from the chain (every trade, wherever it was made); a failed read never blocks the price.
    await collectVolume(
      this.db,
      this.rpc,
      mint,
      pool ? { kind: "pool", address: pool.pool, quoteVault: pool.quoteVault } : { kind: "curve", address: sdk.bondingCurvePda(m) },
    ).catch(() => 0);
    // The curve's and the pool's own token accounts hold supply, not people: they are not holders.
    const notHolders = new Set([...curveAccounts(m), ...(pool ? [pool.baseVault.toBase58()] : [])]);
    let holders = 0;
    try {
      const largest = (await this.rpc.getTokenLargestAccounts(m, "confirmed")).value.filter(
        (a) => Number(a.amount) > 0 && !notHolders.has(a.address.toBase58()),
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
