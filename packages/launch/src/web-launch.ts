import type { Clock } from "@devagent/core";
import { appendEvent, type Db } from "@devagent/db";
import { ComputeBudgetProgram, Message, Transaction, type Connection } from "@solana/web3.js";
import { DEFAULT_SPLIT_BPS, validateSplit, type CurrentRole, type Share } from "./split";
import { buildCreateTx, buildSplitTx, type Rpc } from "./pumpfun";
import { getLaunch, recordLaunch } from "./record";
import { agentWalletAddress } from "./wallets";

/**
 * Launch from the website. The server builds the unsigned pump.fun transaction, the creator's own wallet signs it
 * in the browser, and the server only relays it after checking the signed message is byte for byte the one it built.
 * No key ever touches the server; a changed transaction is refused.
 */
export interface WebLaunchConfig {
  cluster: string;
  /** Public base URL of this site, used for the coin's metadata URI. */
  publicUrl: string;
  /** Owner's wallet that pays the server, X API and GitHub (10%). */
  infraWallet?: string;
  /** Platform buyback wallet (20%): sealed, signed only by the gateway. */
  buybackWallet?: string;
}
export type LaunchRpc = Rpc &
  Pick<Connection, "sendRawTransaction" | "getSignatureStatuses">;
export type Step = "create" | "split";
export class LaunchFlowError extends Error {}

const fail = (m: string): never => {
  throw new LaunchFlowError(m);
};

interface AgentInfo {
  name: string;
  ticker: string | null;
  deployer: string | null;
  removed_at: number | null;
}

function owned(db: Db, agentId: string, wallet: string): AgentInfo {
  const a = db
    .prepare("SELECT name, ticker, deployer, removed_at FROM agents WHERE id=?")
    .get(agentId) as AgentInfo | undefined;
  if (!a || a.removed_at) fail("Agent not found.");
  if (!a!.deployer || a!.deployer !== wallet) fail("Only the wallet that created this agent can launch its coin.");
  return a!;
}

/**
 * 40% agent wallet, 30% creator, 10% infra, 20% buyback. On test networks a missing infra or buyback wallet
 * passes its share to the agent; on mainnet both must exist, because the split can never be changed later.
 */
export function splitFor(db: Db, agentId: string, deployer: string, c: WebLaunchConfig): Share[] {
  const agentWallet = agentWalletAddress(db, agentId) ?? fail("This agent has no wallet yet. Try again in a minute.");
  if (c.cluster === "mainnet-beta" && (!c.infraWallet || !c.buybackWallet))
    fail("Mainnet launches need INFRA_WALLET and the buyback wallet set up first.");
  const want: Record<CurrentRole, string | undefined> = {
    agent_treasury: agentWallet,
    deployer,
    infra: c.infraWallet,
    buyback: c.buybackWallet,
  };
  const seen = new Set<string>();
  const out: Share[] = [];
  for (const role of Object.keys(DEFAULT_SPLIT_BPS) as CurrentRole[]) {
    const address = want[role];
    if (!address || seen.has(address)) continue;
    seen.add(address);
    out.push({ role, address, shareBps: DEFAULT_SPLIT_BPS[role] });
  }
  const rest = 10_000 - out.reduce((s, x) => s + x.shareBps, 0);
  out[0]!.shareBps += rest; // index 0 is always the agent treasury
  validateSplit(out);
  return out;
}

const messageOf = (b64: string) => Transaction.from(Buffer.from(b64, "base64")).serializeMessage().toString("base64");

const COMPUTE_BUDGET = ComputeBudgetProgram.programId.toBase58();
/** What a transaction actually does: its fee payer and every non compute budget instruction, in order. */
function intentOf(tx: Transaction): string {
  return JSON.stringify({
    payer: tx.feePayer?.toBase58() ?? null,
    ixs: tx.instructions
      .filter((i) => i.programId.toBase58() !== COMPUTE_BUDGET)
      .map((i) => ({
        program: i.programId.toBase58(),
        keys: i.keys.map((k) => `${k.pubkey.toBase58()}:${k.isSigner ? 1 : 0}:${k.isWritable ? 1 : 0}`),
        data: i.data.toString("base64"),
      })),
  });
}

/**
 * True when the signed transaction does exactly what the site prepared. Wallets such as Phantom add their own
 * priority fee (Compute Budget program) instructions before signing; those are the only difference allowed. Any other
 * added, removed or changed instruction, account, data or fee payer is refused.
 */
export function matchesPrepared(preparedMessageB64: string, signed: Transaction): boolean {
  const prepared = Transaction.populate(Message.from(Buffer.from(preparedMessageB64, "base64")));
  return intentOf(prepared) === intentOf(signed);
}

function savePending(db: Db, clock: Clock, agentId: string, step: Step, mint: string, tx: string, split: Share[]) {
  db.prepare(
    "INSERT OR REPLACE INTO pending_launches (agent_id, step, mint, message_b64, split_json, created_at) VALUES (?,?,?,?,?,?)",
  ).run(agentId, step, mint, messageOf(tx), JSON.stringify(split), clock.now());
}

export async function prepareLaunch(
  db: Db, clock: Clock, rpc: LaunchRpc, c: WebLaunchConfig, agentId: string, wallet: string,
): Promise<{ step: Step; mint: string; tx: string; split: Share[] }> {
  const a = owned(db, agentId, wallet);
  const launched = getLaunch(db, agentId);
  if (launched) {
    if (launched.cluster === "mock" || splitIsSet(db, agentId)) fail("This coin is already launched and its fee split is set.");
    const split = launched.split;
    const { tx } = await buildSplitTx(rpc, c.cluster, { name: a.name, symbol: a.ticker ?? "AGENT", uri: "x", creator: wallet, split }, launched.mint);
    savePending(db, clock, agentId, "split", launched.mint, tx, split);
    return { step: "split", mint: launched.mint, tx, split };
  }
  // The metadata URI is written into the coin forever. On mainnet it must be a public https address.
  if (c.cluster === "mainnet-beta" && !/^https:\/\/(?!127\.|localhost)/.test(c.publicUrl))
    fail("Mainnet launches need PUBLIC_URL set to this site's public https address.");
  const split = splitFor(db, agentId, wallet, c);
  const { mint, tx } = await buildCreateTx(rpc, c.cluster, {
    name: a.name.slice(0, 32),
    symbol: (a.ticker ?? "AGENT").slice(0, 10),
    uri: `${c.publicUrl.replace(/\/+$/, "")}/meta/${agentId}.json`,
    creator: wallet,
    split,
  });
  savePending(db, clock, agentId, "create", mint, tx, split);
  return { step: "create", mint, tx, split };
}

/** Waits until the network confirms a signature; fails on a rejected transaction or after the timeout. */
export async function confirmSignature(rpc: Pick<LaunchRpc, "getSignatureStatuses">, signature: string, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = (await rpc.getSignatureStatuses([signature])).value[0];
    if (s?.err) fail("The network rejected the transaction.");
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  fail("The transaction was sent but not confirmed in time. Check the explorer, then refresh.");
}

export async function submitLaunch(
  db: Db, clock: Clock, rpc: LaunchRpc, c: WebLaunchConfig, agentId: string, step: Step, signedB64: string,
): Promise<{ signature: string; mint: string; next?: Step }> {
  const p = db
    .prepare("SELECT mint, message_b64, split_json FROM pending_launches WHERE agent_id=? AND step=?")
    .get(agentId, step) as { mint: string; message_b64: string; split_json: string } | undefined;
  if (!p) fail("Nothing is waiting to be signed. Start the launch again.");
  let tx: Transaction;
  try {
    tx = Transaction.from(Buffer.from(signedB64, "base64"));
  } catch {
    return fail("That is not a valid signed transaction.");
  }
  if (!matchesPrepared(p!.message_b64, tx))
    fail("The signed transaction is not the one this site prepared.");
  if (!tx.verifySignatures()) fail("The transaction is missing a signature.");
  const signature = await rpc.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await confirmSignature(rpc, signature);
  db.prepare("DELETE FROM pending_launches WHERE agent_id=? AND step=?").run(agentId, step);
  if (step === "create") {
    recordLaunch(db, clock, {
      agentId,
      mint: p!.mint,
      cluster: c.cluster,
      signature,
      split: JSON.parse(p!.split_json) as Share[],
    });
    return { signature, mint: p!.mint, next: "split" };
  }
  appendEvent(db, clock, { type: "launch.split_set", agentId, payload: { signature, mint: p!.mint } });
  return { signature, mint: p!.mint };
}

export function splitIsSet(db: Db, agentId: string): boolean {
  return !!db
    .prepare("SELECT 1 x FROM events WHERE agent_id=? AND type='launch.split_set' LIMIT 1")
    .get(agentId);
}
