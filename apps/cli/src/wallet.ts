import { boot, rpcUrl } from "@devagent/app";
import { systemClock } from "@devagent/core";
import { getAgent, listAgents } from "@devagent/db";
import {
  agentWalletAddress,
  allowRecipient,
  assertCluster,
  assertTestCluster,
  backfillAgentWallets,
  checkOutflow,
  listAgentWallets,
  listRecipients,
  openAgentSigner,
  policyFromEnv,
  recordOutflow,
  removeRecipient,
} from "@devagent/launch";
import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { base58Encode } from "@devagent/community";

// Operator commands for agent wallets.
//   wallet list                       every agent wallet with its balance
//   wallet create                     give every agent without a wallet one
//   wallet airdrop <agent> [sol]      devnet/localnet only
//   wallet allow <agent> <address>    operator: add a recipient (usable after the cooldown, default 24 h)
//   wallet disallow <agent> <address> | wallet allowlist <agent>
//   wallet send <agent> <to> <sol>    operator only; allowlisted recipient, per send and daily caps, kill switch pauses
const [cmd, first, ...rest] = process.argv.slice(2);
const app = boot();
const rpc = new Connection(rpcUrl(app), "confirmed");
const agentId = (x?: string) => {
  const a = x && (getAgent(app.db, x) ?? listAgents(app.db).find((y) => y.name === x));
  if (!a) throw new Error(`unknown agent ${x}`);
  return a.id;
};
const policy = policyFromEnv();
const operator = () => {
  const op = process.env.OPERATOR_ID ?? "";
  const ops = (process.env.OPERATOR_IDS ?? "").split(",").map((x) => x.trim());
  if (!op || !ops.includes(op)) throw new Error("OPERATOR_ID must be listed in OPERATOR_IDS");
  return op;
};
const addressOf = (id: string) => {
  const a = agentWalletAddress(app.db, id);
  if (!a) throw new Error("agent has no wallet yet: run pnpm wallet create");
  return new PublicKey(a);
};
try {
  if (cmd === "list") {
    for (const w of listAgentWallets(app.db)) {
      const lamports = await rpc.getBalance(new PublicKey(w.address)).catch(() => NaN);
      console.log(`${getAgent(app.db, w.agentId)?.name ?? w.agentId}  ${w.address}  ${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    }
  } else if (cmd === "create") {
    const key = process.env.SEAL_PUBLIC_KEY;
    if (!key) throw new Error("SEAL_PUBLIC_KEY is not set (run pnpm predev)");
    console.log(`created ${backfillAgentWallets(app.db, systemClock, key)} wallet(s)`);
  } else if (cmd === "airdrop") {
    assertTestCluster(app.config.solanaCluster);
    const sol = Number(rest[0] ?? 1);
    const sig = await rpc.requestAirdrop(addressOf(agentId(first)), Math.round(sol * LAMPORTS_PER_SOL));
    console.log(`airdrop requested: ${sig} (public devnet faucet is rate limited; https://faucet.solana.com also works)`);
  } else if (cmd === "allow" || cmd === "disallow" || cmd === "allowlist") {
    const id = agentId(first);
    if (cmd === "allow") {
      const at = allowRecipient(app.db, systemClock, id, rest[0] ?? "", operator(), policy);
      console.log(`allowed; usable from ${new Date(at).toLocaleString()} (cooldown)`);
    } else if (cmd === "disallow") {
      operator();
      removeRecipient(app.db, id, rest[0] ?? "");
      console.log("removed");
    } else
      for (const r of listRecipients(app.db, id))
        console.log(`${r.address}  ${r.usable_at > Date.now() ? "cooldown until " + new Date(r.usable_at).toLocaleString() : "usable"}`);
  } else if (cmd === "send") {
    assertCluster(app.config.solanaCluster);
    const op = operator();
    const priv = process.env.SEAL_PRIVATE_KEY;
    if (!priv) throw new Error("SEAL_PRIVATE_KEY is not set");
    const [to, solStr] = rest;
    const id = agentId(first);
    const lamports = Math.round(Number(solStr) * LAMPORTS_PER_SOL);
    const check = checkOutflow(app.db, systemClock, id, to ?? "", lamports, policy, () => app.kill.isHalted(id));
    if (!check.ok) throw new Error(`refused: ${check.reason}`);
    const signer = openAgentSigner(app.db, priv, id);
    try {
      const tx = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: new PublicKey(to ?? ""), lamports }),
      );
      // Record the outflow before broadcasting, so a crash or timeout after the send can never leave money moved
      // but uncounted against the daily cap. A send that then fails keeps counting: the cap errs on the safe side.
      const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = signer.publicKey;
      tx.sign(signer);
      const sig = base58Encode(tx.signature!);
      recordOutflow(app.db, systemClock, id, to ?? "", lamports, op, sig);
      await rpc.sendRawTransaction(tx.serialize());
      console.log(`sent: ${sig} (confirming…)`);
      await rpc.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      console.log(`confirmed: ${sig}`);
    } finally {
      signer.secretKey.fill(0);
    }
  } else
    console.log(
      "usage: wallet list | create | airdrop <agent> [sol] | allow|disallow <agent> <address> | allowlist <agent> | send <agent> <to> <sol>",
    );
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  app.close();
}
