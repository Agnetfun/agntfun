import { systemClock, ulid } from "@devagent/core";
import { collect, promoteTop, quorumFromEnv, rankQueue, triageAll } from "@devagent/community";
import { listAgents, pickTask, upsertTask } from "@devagent/db";
import type { Adapters } from "@devagent/gateway";
import {
  BuybackEngine,
  DEFAULT_FEES,
  FeeDistributor,
  ensurePlatformWallet,
  openPlatformSigner,
  InflowWatcher,
  PriceSampler,
  backfillAgentWallets,
  openAgentSigner,
} from "@devagent/launch";
import { createProvider, triageScript, MockProvider } from "@devagent/llm";
import { Connection } from "@solana/web3.js";
import type { Booted } from "./boot";

export function rpcUrl(app: Booted, env: Record<string, string | undefined> = process.env): string {
  const defaults = {
    devnet: "https://api.devnet.solana.com",
    // The public mainnet RPC is heavily rate limited and refuses some calls; set SOLANA_RPC_URL to a paid one.
    "mainnet-beta": "https://api.mainnet-beta.solana.com",
    localnet: "http://127.0.0.1:8899",
  };
  return env.SOLANA_RPC_URL || defaults[app.config.solanaCluster];
}

/**
 * Community round for every live agent: pull X mentions (x mode), triage new ideas, promote voted ones to tasks.
 * With PROMOTE_UNVOTED_WHEN_IDLE=1 an agent with an empty task list takes its best accepted idea even without votes
 * (lets a coin-less local test run end to end; off by default for production).
 */
export async function communityTick(app: Booted, adapters: Adapters, env = process.env) {
  const llm =
    app.config.llm.mode === "mock"
      ? new MockProvider("mock-triage", triageScript)
      : createProvider("opus", app.config.llm);
  const out = { collected: 0, accepted: 0, promoted: 0 };
  for (const a of listAgents(app.db)) {
    if (app.kill.isHalted(a.id)) continue;
    for (const src of adapters.sourcesFor(a.id)) {
      // Reading X costs money: an agent with nothing in its treasury does not read (and is not charged) until funded.
      if (src.name === "x" && app.treasury.balanceCents(a.id) <= 0) continue;
      try {
        out.collected += await collect(app.db, systemClock, a.id, src);
        // The agent pays for its own X reads from its treasury (the platform's X credits are only a float).
        const bill = src.takeBillableCents();
        if (bill > 0) app.treasury.spend(a.id, "x_posts", bill, `xread:${ulid()}`);
      } catch (e) {
        app.log.warn({ agent: a.id, err: (e as Error).message }, "community source failed");
      }
    }
    out.accepted += (await triageAll({ db: app.db, clock: systemClock, llm }, a.id)).accepted;
    out.promoted += promoteTop(app.db, systemClock, a.id, 3, quorumFromEnv(env));
    if (env.PROMOTE_UNVOTED_WHEN_IDLE === "1" && !pickTask(app.db, a.id)) {
      const top = rankQueue(app.db, a.id).find(
        (r) => (app.db.prepare("SELECT status FROM suggestions WHERE id=?").get(r.id) as { status: string }).status === "accepted",
      );
      if (top) {
        upsertTask(app.db, systemClock, { agentId: a.id, source: "proposal", summary: top.summary, size: top.size ?? undefined, priority: 1 });
        app.db.prepare("UPDATE suggestions SET status='queued' WHERE id=?").run(top.id);
        out.promoted++;
      }
    }
  }
  return out;
}

/** Chain round: give every agent a wallet, book SOL that reached agent wallets, pay out fees, run the buyback. */
export function makeChainTick(app: Booted, env = process.env) {
  const rpc = new Connection(rpcUrl(app, env), "confirmed");
  const inflow = new InflowWatcher(app.db, app.treasury, rpc, {
    solUsdCents: Math.round((Number(env.SOL_USD) || 150) * 100),
    pageSize: 25,
  });
  // Pays out pump.fun creator fees so the agent's share reaches its wallet (needs the private seal key: gateway side).
  const priv = env.SEAL_PRIVATE_KEY;
  const fees = priv
    ? new FeeDistributor(app.db, systemClock, rpc, (id) => openAgentSigner(app.db, priv, id), {
        ...DEFAULT_FEES,
        minLamports: Math.round((Number(env.FEE_PAYOUT_MIN_SOL) || 0.005) * 1e9),
      })
    : undefined;
  // 20% buyback share: infra first, then buy the platform token and burn it (DECISIONS D24).
  const buyback =
    priv && env.SEAL_PUBLIC_KEY && env.INFRA_WALLET
      ? new BuybackEngine(
          app.db,
          systemClock,
          rpc,
          () => {
            ensurePlatformWallet(app.db, systemClock, env.SEAL_PUBLIC_KEY!, "buyback");
            return openPlatformSigner(app.db, priv, "buyback");
          },
          {
            tokenMint: env.PLATFORM_TOKEN_MINT || undefined,
            infraWallet: env.INFRA_WALLET,
            infraTargetLamports: Math.round((Number(env.INFRA_TARGET_SOL) || 1) * 1e9),
            keepLamports: 10_000_000,
            minLamports: Math.round((Number(env.BUYBACK_MIN_SOL) || 0.05) * 1e9),
            slippage: 2,
          },
        )
      : undefined;
  const buybackEveryMs = (Number(env.BUYBACK_EVERY_HOURS) || 24) * 3_600_000;
  let lastBuyback = 0;
  return async () => {
    const out = { wallets: 0, booked: 0, feePayouts: 0, buyback: "" };
    if (buyback && Date.now() - lastBuyback >= buybackEveryMs) {
      lastBuyback = Date.now();
      try {
        const r = await buyback.run();
        if (r.action !== "none") out.buyback = `${r.action} ${(r.lamports / 1e9).toFixed(4)} SOL`;
      } catch (e) {
        app.log.warn({ err: (e as Error).message }, "buyback failed");
      }
    }
    if (fees)
      try {
        out.feePayouts = (await fees.runAll(app.config.solanaCluster)).paid;
      } catch (e) {
        app.log.warn({ err: (e as Error).message }, "fee payout failed");
      }
    if (env.SEAL_PUBLIC_KEY) out.wallets = backfillAgentWallets(app.db, systemClock, env.SEAL_PUBLIC_KEY);
    try {
      out.booked = (await inflow.pollAll()).booked;
    } catch (e) {
      app.log.warn({ err: (e as Error).message }, "wallet watch failed");
    }
    return out;
  };
}

/** Price round, on its own fast timer: one account read per launched coin, so charts follow trades made anywhere. */
export function makePriceTick(app: Booted, env = process.env) {
  const prices = new PriceSampler(app.db, systemClock, new Connection(rpcUrl(app, env), "confirmed"));
  return () => prices.sampleAll();
}
