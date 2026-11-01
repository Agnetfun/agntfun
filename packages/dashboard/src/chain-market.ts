import type { Db } from "@devagent/db";
import { TIMEFRAMES, type Candle, type Holder, type MarketProvider, type MarketSnapshot, type Timeframe } from "./market";

const DAY = 86_400_000;
const NONE: MarketSnapshot = { source: "none", priceUsd: 0, mcapUsd: 0, volume24hUsd: 0, change24hPct: 0, holders: 0 };

interface Sample {
  ts: number;
  price_sol: number;
  mcap_sol: number;
  holders: number;
}

/**
 * Real numbers only: price samples the orchestrator reads from each coin's bonding curve on chain.
 * No coin, no numbers. Volume comes from on-chain trades the sampler records (trade_volume), every venue included.
 * USD values use the live SOL/USD price (SolUsd: CoinGecko, Coinbase, Jupiter; SOL_USD only as a fallback).
 */
export class ChainMarket implements MarketProvider {
  constructor(
    private db: Db,
    private solUsdOf: number | (() => number),
  ) {}

  private get solUsd(): number {
    return typeof this.solUsdOf === "function" ? this.solUsdOf() : this.solUsdOf;
  }

  private mint(agentId: string): string | undefined {
    const r = this.db
      .prepare("SELECT mint FROM launches WHERE agent_id=? AND cluster <> 'mock'")
      .get(agentId) as { mint: string } | undefined;
    return r?.mint;
  }

  snapshot(agentId: string, now: number): MarketSnapshot {
    const mint = this.mint(agentId);
    if (!mint) return NONE;
    const last = this.db
      .prepare("SELECT * FROM price_samples WHERE mint=? ORDER BY ts DESC LIMIT 1")
      .get(mint) as Sample | undefined;
    if (!last) return { ...NONE, source: "live" };
    const prev = (this.db
      .prepare("SELECT * FROM price_samples WHERE mint=? AND ts <= ? ORDER BY ts DESC LIMIT 1")
      .get(mint, now - DAY) ??
      this.db.prepare("SELECT * FROM price_samples WHERE mint=? ORDER BY ts LIMIT 1").get(mint)) as unknown as Sample;
    return {
      source: "live",
      priceUsd: last.price_sol * this.solUsd,
      mcapUsd: last.mcap_sol * this.solUsd,
      volume24hUsd:
        ((this.db.prepare("SELECT COALESCE(SUM(sol),0) s FROM trade_volume WHERE mint=? AND ts > ?").get(mint, now - DAY) as { s: number }).s) *
        this.solUsd,
      change24hPct: prev.price_sol > 0 ? (last.price_sol / prev.price_sol - 1) * 100 : 0,
      holders: last.holders,
    };
  }

  candles(agentId: string, tf: Timeframe, now: number, count = 96): Candle[] {
    const mint = this.mint(agentId);
    if (!mint) return [];
    const step = TIMEFRAMES[tf];
    const from = Math.floor(now / step) * step - (count - 1) * step;
    const rows = this.db
      .prepare("SELECT ts, price_sol FROM price_samples WHERE mint=? AND ts >= ? ORDER BY ts")
      .all(mint, from) as { ts: number; price_sol: number }[];
    const out: Candle[] = [];
    // Volume per bucket, in USD, from the recorded on-chain trades.
    const vol = new Map<number, number>();
    for (const v of this.db.prepare("SELECT ts, sol FROM trade_volume WHERE mint=? AND ts >= ?").all(mint, from) as { ts: number; sol: number }[]) {
      const t = Math.floor(v.ts / step) * step;
      vol.set(t, (vol.get(t) ?? 0) + v.sol * this.solUsd);
    }
    for (const r of rows) {
      const t = Math.floor(r.ts / step) * step;
      const p = r.price_sol * this.solUsd;
      const c = out[out.length - 1];
      if (c && c.t === t) {
        c.h = Math.max(c.h, p);
        c.l = Math.min(c.l, p);
        c.c = p;
      } else out.push({ t, o: c ? c.c : p, h: p, l: p, c: p, v: vol.get(t) ?? 0 });
    }
    return out;
  }

  holders(agentId: string): Holder[] {
    const mint = this.mint(agentId);
    if (!mint) return [];
    const r = this.db.prepare("SELECT holders_json FROM holder_snapshots WHERE mint=?").get(mint) as
      { holders_json: string } | undefined;
    return r ? (JSON.parse(r.holders_json) as Holder[]) : [];
  }
}
