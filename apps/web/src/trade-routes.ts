import type { Clock } from "@devagent/core";
import { appendEvent, type Db } from "@devagent/db";
import {
  PriceSampler,
  TradeError,
  buildTrade,
  confirmSignature,
  getLaunch,
  matchesPrepared,
  tokenBalanceRaw,
  type Side,
} from "@devagent/launch";
import { PublicKey, Transaction, type Connection } from "@solana/web3.js";

/**
 * Buy and sell from the agent page. The server builds the unsigned pump.fun transaction, the user's wallet signs,
 * and the server relays it only if it does exactly what was prepared (wallet priority fees aside). Nothing here holds
 * funds or keys. After a trade the coin's price is sampled at once so the chart moves with it.
 */
export interface TradeDeps {
  db: Db;
  clock: Clock;
  rpc: Connection;
}
type Reply = { status: number; body: unknown };
const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");
const TTL = 2 * 60_000;

export function createTradeRoutes(d: TradeDeps) {
  const pending = new Map<string, { message: string; side: Side; at: number }>();
  const sampler = new PriceSampler(d.db, d.clock, d.rpc);
  const coin = (agentId: string) => {
    const l = getLaunch(d.db, agentId);
    return l && l.cluster !== "mock" ? l : undefined;
  };

  return {
    postPaths: {
      "/api/trade/prepare": [60, 600_000],
      "/api/trade/submit": [30, 600_000],
    } as Record<string, [number, number]>,

    async post(path: string, b: Record<string, unknown>): Promise<Reply> {
      const agentId = str(b.agentId, 40);
      const wallet = str(b.wallet, 64);
      const l = coin(agentId);
      if (!l) return { status: 400, body: { error: "This agent has no coin yet." } };
      const key = `${wallet}:${agentId}`;
      try {
        if (path === "/api/trade/prepare") {
          const side: Side = b.side === "sell" ? "sell" : "buy";
          const out = await buildTrade(d.rpc, l.mint, wallet, side, str(b.amount, 24), Number(b.slippage) || 5);
          const message = Transaction.from(Buffer.from(out.tx, "base64")).serializeMessage().toString("base64");
          pending.set(key, { message, side, at: Date.now() });
          for (const [k, v] of pending) if (Date.now() - v.at > TTL) pending.delete(k);
          return { status: 200, body: out };
        }
        const p = pending.get(key);
        if (!p || Date.now() - p.at > TTL) return { status: 400, body: { error: "This quote expired. Try again." } };
        let tx: Transaction;
        try {
          tx = Transaction.from(Buffer.from(str(b.tx, 4000), "base64"));
        } catch {
          return { status: 400, body: { error: "That is not a valid signed transaction." } };
        }
        if (!matchesPrepared(p.message, tx)) return { status: 400, body: { error: "The signed trade is not the one this site prepared." } };
        if (!tx.verifySignatures()) return { status: 400, body: { error: "The trade is missing your signature." } };
        pending.delete(key);
        const signature = await d.rpc.sendRawTransaction(tx.serialize());
        await confirmSignature(d.rpc, signature);
        appendEvent(d.db, d.clock, { type: "trade", agentId, payload: { side: p.side, signature } });
        await sampler.sample(l.mint).catch(() => false);
        return { status: 200, body: { signature } };
      } catch (e) {
        if (e instanceof TradeError) return { status: 400, body: { error: e.message } };
        const m = e instanceof Error ? e.message : "";
        if (/insufficient|0x1\b|lamports/i.test(m)) return { status: 400, body: { error: "Not enough SOL in your wallet for this trade and its fees." } };
        if (/slippage|6002|6003|TooMuchSol|TooLittleSol/i.test(m))
          return { status: 400, body: { error: "The price moved more than your slippage allows. Try again or raise slippage." } };
        if (/blockhash|expired/i.test(m)) return { status: 400, body: { error: "The trade expired before it was sent. Try again." } };
        return { status: 502, body: { error: "The network call failed. Try again in a moment." } };
      }
    },

    /** Your SOL and your holding of this agent's coin. */
    async position(agentId: string, wallet: string): Promise<Reply> {
      const l = coin(agentId);
      try {
        const owner = new PublicKey(wallet);
        const [lamports, tokensRaw] = await Promise.all([
          d.rpc.getBalance(owner, "confirmed"),
          l ? tokenBalanceRaw(d.rpc, l.mint, wallet) : Promise.resolve("0"),
        ]);
        return { status: 200, body: { lamports, tokensRaw, mint: l?.mint ?? null } };
      } catch {
        return { status: 400, body: { error: "Could not read this wallet." } };
      }
    },
  };
}
export type TradeRoutes = ReturnType<typeof createTradeRoutes>;
