import { createRequire } from "node:module";
import type { OnlinePumpSdk as OnlineSdk, PumpSdk } from "@pump-fun/pump-sdk";
import { NATIVE_MINT } from "@solana/spl-token";
import { ComputeBudgetProgram, PublicKey, Transaction, type Connection } from "@solana/web3.js";
import BN from "bn.js";

// Same CommonJS loading as pumpfun.ts.
const sdk = createRequire(import.meta.url)("@pump-fun/pump-sdk") as {
  PUMP_SDK: PumpSdk;
  OnlinePumpSdk: new (c: Connection) => OnlineSdk;
  getBuyTokenAmountFromSolAmount: typeof import("@pump-fun/pump-sdk").getBuyTokenAmountFromSolAmount;
  getSellSolAmountFromTokenAmount: typeof import("@pump-fun/pump-sdk").getSellSolAmountFromTokenAmount;
};

/**
 * Buy and sell an agent's coin on its pump.fun bonding curve, from the user's own wallet.
 * The server builds an UNSIGNED transaction (official SDK: fetchBuyState/fetchSellState, buyInstructions,
 * sellInstructions); the user's wallet signs it; the server only relays it after checking it is the one it built.
 * No key ever touches the server and the agent never trades. Slippage is in percent (the SDK multiplies by 1 + s/100).
 * Graduated coins trade on PumpSwap; for those the page links to pump.fun instead.
 */
export type Side = "buy" | "sell";
export class TradeError extends Error {}
export const TOKEN_DECIMALS = 6;
const MAX_SLIPPAGE_PCT = 25;

// A coin's token program never changes, and pump.fun's global and fee settings change rarely: caching them leaves
// one parallel round of reads (curve state + blockhash) per quote instead of four in a row.
const SETTINGS_TTL_MS = 60_000;
const tokenPrograms = new Map<string, PublicKey>();
let settings: { at: number; rpc: Connection; value: Promise<[unknown, unknown]> } | null = null;

async function tokenProgramOf(rpc: Connection, mint: PublicKey): Promise<PublicKey> {
  const hit = tokenPrograms.get(mint.toBase58());
  if (hit) return hit;
  const info = await rpc.getAccountInfo(mint, "confirmed");
  if (!info) throw new TradeError("This coin was not found on chain.");
  tokenPrograms.set(mint.toBase58(), info.owner);
  return info.owner;
}

function pumpSettings(rpc: Connection, online: OnlineSdk) {
  if (!settings || settings.rpc !== rpc || Date.now() - settings.at > SETTINGS_TTL_MS) {
    const value = Promise.all([online.fetchGlobal(), online.fetchFeeConfig()]) as Promise<[unknown, unknown]>;
    settings = { at: Date.now(), rpc, value };
    value.catch(() => (settings = null)); // a failed read is retried on the next quote
  }
  return settings.value as Promise<[Awaited<ReturnType<OnlineSdk["fetchGlobal"]>>, Awaited<ReturnType<OnlineSdk["fetchFeeConfig"]>>]>;
}

export interface TradeQuote {
  side: Side;
  /** Lamports for a buy, raw token units for a sell. */
  inRaw: string;
  /** Raw token units for a buy, lamports for a sell. */
  outRaw: string;
}

export async function buildTrade(
  rpc: Connection,
  mintAddr: string,
  userAddr: string,
  side: Side,
  amountRaw: string,
  slippagePct: number,
): Promise<{ tx: string; quote: TradeQuote }> {
  if (!/^\d{1,20}$/.test(amountRaw) || amountRaw === "0") throw new TradeError("Enter an amount above zero.");
  if (!(slippagePct > 0 && slippagePct <= MAX_SLIPPAGE_PCT)) throw new TradeError("Slippage must be between 0.1% and 25%.");
  let mint: PublicKey;
  let user: PublicKey;
  try {
    mint = new PublicKey(mintAddr);
    user = new PublicKey(userAddr);
  } catch {
    throw new TradeError("Invalid wallet or coin address.");
  }
  const tokenProgram = await tokenProgramOf(rpc, mint);
  const online = new sdk.OnlinePumpSdk(rpc);
  const blockhash = rpc.getLatestBlockhash("confirmed");
  const [global, feeConfig] = await pumpSettings(rpc, online);
  const amount = new BN(amountRaw);
  let ixs;
  let quote: TradeQuote;
  if (side === "buy") {
    const s = await online.fetchBuyState(mint, user, tokenProgram);
    if (s.bondingCurve.complete) return poolTrade(online, user, mint, side, amount, slippagePct, blockhash);
    const tokens = sdk.getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: s.bondingCurve.tokenTotalSupply,
      bondingCurve: s.bondingCurve,
      amount,
      quoteMint: s.quoteMint,
    });
    ixs = await sdk.PUMP_SDK.buyInstructions({
      global,
      bondingCurveAccountInfo: s.bondingCurveAccountInfo,
      bondingCurve: s.bondingCurve,
      associatedUserAccountInfo: s.associatedUserAccountInfo,
      mint,
      user,
      amount: tokens,
      solAmount: amount,
      slippage: slippagePct,
      tokenProgram,
    });
    quote = { side, inRaw: amountRaw, outRaw: tokens.toString() };
  } else {
    const s = await online.fetchSellState(mint, user, tokenProgram);
    if (s.bondingCurve.complete) return poolTrade(online, user, mint, side, amount, slippagePct, blockhash);
    const sol = sdk.getSellSolAmountFromTokenAmount({
      global,
      feeConfig,
      mintSupply: s.bondingCurve.tokenTotalSupply,
      bondingCurve: s.bondingCurve,
      amount,
    });
    ixs = await sdk.PUMP_SDK.sellInstructions({
      global,
      bondingCurveAccountInfo: s.bondingCurveAccountInfo,
      bondingCurve: s.bondingCurve,
      mint,
      user,
      amount,
      solAmount: sol,
      slippage: slippagePct,
      tokenProgram,
      mayhemMode: s.bondingCurve.isMayhemMode,
    });
    quote = { side, inRaw: amountRaw, outRaw: sol.toString() };
  }
  const tx = new Transaction({ feePayer: user, recentBlockhash: (await blockhash).blockhash }).add(...ixs);
  return {
    tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
    quote,
  };
}

/**
 * A graduated coin trades in its PumpSwap pool. Official SDK route: resolveMultiHopRoute (one hop, SOL <-> coin),
 * an exact quote by simulateMultiHopSwap, then multiHopSwapInstructions with the minimum out lowered by slippage.
 * The docs ask to budget compute generously (~200k CU per hop, plus account creation), so the limit is raised.
 */
async function poolTrade(
  online: OnlineSdk,
  user: PublicKey,
  mint: PublicKey,
  side: Side,
  amount: BN,
  slippagePct: number,
  blockhash: ReturnType<Connection["getLatestBlockhash"]>,
): Promise<{ tx: string; quote: TradeQuote }> {
  const path = side === "buy" ? [NATIVE_MINT, mint] : [mint, NATIVE_MINT];
  let hops;
  let out: bigint;
  try {
    hops = await online.resolveMultiHopRoute(path, side);
    out = BigInt((await online.simulateMultiHopSwap({ user, hops, side, amountIn: amount })).toString());
  } catch {
    throw new TradeError(side === "buy" ? "Not enough SOL for this buy, or the pool is not ready yet." : "Not enough of this coin to sell, or the pool is not ready yet.");
  }
  if (out === 0n) throw new TradeError("That amount is too small to trade.");
  const minAmountOut = new BN(((out * BigInt(10_000 - Math.round(slippagePct * 100))) / 10_000n).toString());
  const ixs = await sdk.PUMP_SDK.multiHopSwapInstructions({ user, hops, side, amountIn: amount, minAmountOut });
  const tx = new Transaction({ feePayer: user, recentBlockhash: (await blockhash).blockhash }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ...ixs,
  );
  return {
    tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
    quote: { side, inRaw: amount.toString(), outRaw: out.toString() },
  };
}

/** The user's balance of a coin, in raw units (0 when they have no token account yet). */
export async function tokenBalanceRaw(rpc: Connection, mintAddr: string, ownerAddr: string): Promise<string> {
  const res = await rpc.getParsedTokenAccountsByOwner(new PublicKey(ownerAddr), { mint: new PublicKey(mintAddr) });
  let total = 0n;
  for (const a of res.value) {
    const amt = (a.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed?.info?.tokenAmount
      ?.amount;
    if (amt) total += BigInt(amt);
  }
  return total.toString();
}
