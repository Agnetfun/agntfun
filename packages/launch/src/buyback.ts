import { createRequire } from "node:module";
import type { Clock } from "@devagent/core";
import { appendEvent, type Db } from "@devagent/db";
import type { OnlinePumpSdk as OnlineSdk, PumpSdk } from "@pump-fun/pump-sdk";
import { createBurnInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  type Connection,
  type Keypair,
  type TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";

// Same CommonJS loading as pumpfun.ts.
const sdk = createRequire(import.meta.url)("@pump-fun/pump-sdk") as {
  PUMP_SDK: PumpSdk;
  OnlinePumpSdk: new (c: Connection) => OnlineSdk;
  getBuyTokenAmountFromSolAmount: typeof import("@pump-fun/pump-sdk").getBuyTokenAmountFromSolAmount;
};

/**
 * The 20% buyback share (DECISIONS D24). Infra comes first: while the owner's infra wallet holds less than its
 * target (server, X API, GitHub), buyback money tops it up. After that, buyback money buys the platform token on
 * its pump.fun bonding curve and burns every token bought. Without a platform token yet, money is saved up.
 * Built only from the official SDK (fetchBuyState, getBuyTokenAmountFromSolAmount, buyInstructions) and SPL burn.
 */
export interface BuybackPlanInput {
  buybackLamports: number;
  infraLamports: number;
  infraTargetLamports: number;
  /** Left in the buyback wallet for network fees and rent. */
  keepLamports: number;
  minLamports: number;
  tokenMint?: string;
}
export type BuybackPlan = { action: "none" | "to_infra" | "buy"; lamports: number };

export function planBuyback(i: BuybackPlanInput): BuybackPlan {
  const spendable = Math.max(0, i.buybackLamports - i.keepLamports);
  if (spendable < i.minLamports) return { action: "none", lamports: 0 };
  const shortfall = Math.max(0, i.infraTargetLamports - i.infraLamports);
  if (shortfall > 0) return { action: "to_infra", lamports: Math.round(Math.min(spendable, shortfall)) };
  if (!i.tokenMint) return { action: "none", lamports: 0 };
  return { action: "buy", lamports: Math.round(spendable) };
}

export interface BuybackOptions {
  tokenMint?: string;
  infraWallet: string;
  infraTargetLamports: number;
  keepLamports: number;
  minLamports: number;
  /** Percent slippage allowed on the buy. TODO(verify): unit of the SDK's `slippage` parameter. */
  slippage: number;
}

export class BuybackEngine {
  private online: OnlineSdk;
  constructor(
    private db: Db,
    private clock: Clock,
    private rpc: Connection,
    private signer: () => Keypair,
    private o: BuybackOptions,
  ) {
    this.online = new sdk.OnlinePumpSdk(rpc);
  }

  private async send(kp: Keypair, ixs: TransactionInstruction[]): Promise<string> {
    const { blockhash, lastValidBlockHeight } = await this.rpc.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: kp.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
    tx.sign(kp);
    const signature = await this.rpc.sendRawTransaction(tx.serialize());
    await this.rpc.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    return signature;
  }

  async run(): Promise<BuybackPlan & { signature?: string }> {
    const kp = this.signer();
    try {
      const infra = new PublicKey(this.o.infraWallet);
      const plan = planBuyback({
        buybackLamports: await this.rpc.getBalance(kp.publicKey, "confirmed"),
        infraLamports: await this.rpc.getBalance(infra, "confirmed"),
        infraTargetLamports: this.o.infraTargetLamports,
        keepLamports: this.o.keepLamports,
        minLamports: this.o.minLamports,
        tokenMint: this.o.tokenMint,
      });
      if (plan.action === "to_infra") {
        const signature = await this.send(kp, [
          SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: infra, lamports: plan.lamports }),
        ]);
        appendEvent(this.db, this.clock, { type: "buyback.to_infra", payload: { lamports: plan.lamports, signature } });
        return { ...plan, signature };
      }
      if (plan.action === "buy") return { ...plan, signature: await this.buyAndBurn(kp, plan.lamports) };
      return plan;
    } finally {
      kp.secretKey.fill(0);
    }
  }

  private async buyAndBurn(kp: Keypair, lamports: number): Promise<string | undefined> {
    const mint = new PublicKey(this.o.tokenMint!);
    const mintInfo = await this.rpc.getAccountInfo(mint, "confirmed");
    if (!mintInfo) throw new Error("platform token mint not found");
    const tokenProgram = mintInfo.owner; // SPL Token or Token-2022, whichever owns the mint
    const state = await this.online.fetchBuyState(mint, kp.publicKey, tokenProgram);
    if (state.bondingCurve.complete) {
      // Graduated coins trade on PumpSwap, which needs its own SDK; not built yet.
      appendEvent(this.db, this.clock, { type: "buyback.skipped", payload: { reason: "token graduated (AMM buy not built)" } });
      return undefined;
    }
    const global = await this.online.fetchGlobal();
    const feeConfig = await this.online.fetchFeeConfig();
    const solAmount = new BN(lamports);
    const amount = sdk.getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: null,
      bondingCurve: state.bondingCurve,
      amount: solAmount,
      quoteMint: state.quoteMint,
    });
    const buy = await sdk.PUMP_SDK.buyInstructions({
      global,
      bondingCurveAccountInfo: state.bondingCurveAccountInfo,
      bondingCurve: state.bondingCurve,
      associatedUserAccountInfo: state.associatedUserAccountInfo,
      mint,
      user: kp.publicKey,
      amount,
      solAmount,
      slippage: this.o.slippage,
      tokenProgram,
    });
    const bought = await this.send(kp, buy);
    // Burn everything the buyback wallet holds of the platform token.
    const ata = getAssociatedTokenAddressSync(mint, kp.publicKey, false, tokenProgram);
    const bal = await this.rpc.getTokenAccountBalance(ata, "confirmed");
    const raw = BigInt(bal.value.amount);
    let burned: string | undefined;
    if (raw > 0n) burned = await this.send(kp, [createBurnInstruction(ata, mint, kp.publicKey, raw, [], tokenProgram)]);
    appendEvent(this.db, this.clock, {
      type: "buyback.burned",
      payload: { lamports, tokens: raw.toString(), buy: bought, burn: burned ?? null },
    });
    return burned ?? bought;
  }
}
