import { createRequire } from "node:module";
import type { OnlinePumpSdk as OnlineSdk, PumpSdk } from "@pump-fun/pump-sdk";
import { NATIVE_MINT } from "@solana/spl-token";
import { Keypair, PublicKey, Transaction, type Connection } from "@solana/web3.js";
import BN from "bn.js";
// The SDK's ESM entry cannot be loaded by Node (its anchor dependency is CommonJS), so load the CommonJS build.
const { PUMP_SDK, OnlinePumpSdk, getBuyTokenAmountFromSolAmount, bondingCurvePda, canonicalPumpPoolPda, getPumpAmmProgram } = createRequire(
  import.meta.url,
)("@pump-fun/pump-sdk") as {
  PUMP_SDK: PumpSdk;
  OnlinePumpSdk: new (c: Connection) => OnlineSdk;
  getBuyTokenAmountFromSolAmount: typeof import("@pump-fun/pump-sdk").getBuyTokenAmountFromSolAmount;
  bondingCurvePda: typeof import("@pump-fun/pump-sdk").bondingCurvePda;
  canonicalPumpPoolPda: typeof import("@pump-fun/pump-sdk").canonicalPumpPoolPda;
  getPumpAmmProgram: typeof import("@pump-fun/pump-sdk").getPumpAmmProgram;
};
import { validateLaunch, type LaunchRequest } from "./launchpad";
import { validateSplit } from "./split";

/**
 * Builds UNSIGNED pump.fun transactions with the official SDK (@pump-fun/pump-sdk, exact pinned).
 * Nothing here holds a wallet key. The operator signs with their own wallet and submits the result,
 * so no server side signing exists (architecture rule for Phase 6).
 * The mint keypair is created per launch and only signs the create transaction; it controls nothing afterwards.
 */
export interface Rpc {
  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
}
export interface RpcSubmit extends Rpc {
  sendRawTransaction(raw: Buffer): Promise<string>;
}

export type Cluster = "devnet" | "localnet" | "mainnet-beta";
export class ClusterError extends Error {}

/** Any known cluster. Mainnet is gated earlier, in config (SOLANA_CLUSTER=mainnet-beta needs REAL_MONEY=1). */
export function assertCluster(cluster: string): asserts cluster is Cluster {
  if (cluster !== "devnet" && cluster !== "localnet" && cluster !== "mainnet-beta")
    throw new ClusterError(`refusing to build for cluster ${cluster}`);
}

/** Test networks only (airdrops and other test-only helpers). */
export function assertTestCluster(cluster: string): asserts cluster is "devnet" | "localnet" {
  if (cluster !== "devnet" && cluster !== "localnet")
    throw new ClusterError(`refusing to build for cluster ${cluster}`);
}

const b64 = (tx: Transaction) =>
  tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");

async function frame(
  rpc: Rpc,
  payer: PublicKey,
  ...ix: Transaction["instructions"]
): Promise<Transaction> {
  const { blockhash } = await rpc.getLatestBlockhash();
  const tx = new Transaction({ feePayer: payer, recentBlockhash: blockhash });
  tx.add(...ix);
  return tx;
}

/** A dev buy above this is almost surely a typo (100 instead of 1.00); the creator can buy more on the curve later. */
export const DEV_BUY_MAX_LAMPORTS = 50 * 1e9;

/**
 * Step 1: create the coin. With a dev buy, create and buy in ONE transaction (create_v2 + buy, official SDK
 * createV2AndBuyInstructions), so the creator's first tokens land before anyone else can buy. The only trade before
 * the split is set is this buy; its own creator fee goes to the creator, everything after follows the split.
 */
export async function buildCreateTx(rpc: Rpc, cluster: string, req: LaunchRequest) {
  assertCluster(cluster);
  validateLaunch(req);
  validateSplit(req.split);
  const devBuy = req.devBuyLamports ?? 0;
  if (!Number.isInteger(devBuy) || devBuy < 0 || devBuy > DEV_BUY_MAX_LAMPORTS)
    throw new Error("dev buy must be between 0 and 50 SOL");
  const creator = new PublicKey(req.creator);
  const mint = Keypair.generate();
  const meta = { mint: mint.publicKey, name: req.name, symbol: req.symbol, uri: req.uri, creator, user: creator, mayhemMode: false };
  let ixs: Transaction["instructions"];
  if (devBuy > 0) {
    // The quote needs pump.fun's live global and fee settings, so the rpc must be a full Connection here.
    const online = new OnlinePumpSdk(rpc as unknown as Connection);
    const [global, feeConfig] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig()]);
    const solAmount = new BN(devBuy);
    const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: solAmount, quoteMint: NATIVE_MINT });
    ixs = await PUMP_SDK.createV2AndBuyInstructions({ ...meta, global, amount, solAmount });
  } else ixs = [await PUMP_SDK.createV2Instruction(meta)];
  const tx = await frame(rpc, creator, ...ixs);
  tx.partialSign(mint);
  return { mint: mint.publicKey.toBase58(), tx: b64(tx) };
}

/** Step 2: create the sharing config and set the final split. The split can be set once and never changed. */
export async function buildSplitTx(rpc: Rpc, cluster: string, req: LaunchRequest, mint: string) {
  assertCluster(cluster);
  validateSplit(req.split);
  const creator = new PublicKey(req.creator);
  const m = new PublicKey(mint);
  // Before the split, pump.fun wants leftover creator fees swept (6095 / 6081 CreatorFeesNotSwept otherwise):
  //  - the curve's bucket, to the curve's own creator (harmless when empty, so always included);
  //  - on a graduated coin, also the pool's bucket, to the pool's own coin_creator; and the split then needs the
  //    pool itself (pump fees 6019 AmmAccountsRequiredForGraduatedCoin otherwise).
  let pool: PublicKey | null = null;
  const before: Transaction["instructions"] = [];
  const read = (rpc as Partial<Pick<Connection, "getAccountInfo">>).getAccountInfo?.bind(rpc);
  if (read) {
    const info = await read(bondingCurvePda(m), "confirmed");
    const curve = info ? PUMP_SDK.decodeBondingCurve(info) : null;
    if (curve)
      before.push(await PUMP_SDK.sweepCreatorFeeInstruction({ payer: creator, mint: m, creator: curve.creator, quoteMint: curve.quoteMint }));
    if (curve?.complete) {
      pool = canonicalPumpPoolPda(m);
      if (!(await read(pool, "confirmed")))
        throw new Error("The coin just graduated and its pool is being created. Try again in a minute.");
      const p = await getPumpAmmProgram(rpc as unknown as Connection).account.pool.fetch(pool);
      before.push(await PUMP_SDK.sweepPoolCreatorFeeInstruction({ payer: creator, mint: m, coinCreator: p.coinCreator, quoteMint: p.quoteMint }));
    }
  }
  const create = await PUMP_SDK.createFeeSharingConfig({ creator, mint: m, pool });
  const update = await PUMP_SDK.updateFeeShares({
    authority: creator,
    mint: m,
    currentShareholders: [creator],
    newShareholders: req.split.map((s) => ({
      address: new PublicKey(s.address),
      shareBps: s.shareBps,
    })),
    bondingCurveComplete: pool !== null,
  });
  return { tx: b64(await frame(rpc, creator, ...before, create, update)) };
}

export async function submitSigned(rpc: RpcSubmit, signedBase64: string): Promise<string> {
  return rpc.sendRawTransaction(Buffer.from(signedBase64, "base64"));
}
