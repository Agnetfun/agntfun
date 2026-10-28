/**
 * Market numbers for the token page. Until a coin really trades there is nothing true to show, so the default
 * provider makes up a stable, believable series from the agent id and says so ("demo"). A live provider
 * (pump.fun or a DEX data API) plugs in through the same interface. TODO(verify): pick and verify that source.
 */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}
export interface MarketSnapshot {
  source: "demo" | "live" | "none";
  priceUsd: number;
  mcapUsd: number;
  volume24hUsd: number;
  change24hPct: number;
  holders: number;
}
export interface Holder {
  rank: number;
  address: string;
  pct: number;
}
export interface MarketProvider {
  snapshot(agentId: string, now: number): MarketSnapshot;
  candles(agentId: string, tf: Timeframe, now: number, count?: number): Candle[];
  holders(agentId: string): Holder[];
}

export const TIMEFRAMES = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1D": 86_400_000,
} as const;
export type Timeframe = keyof typeof TIMEFRAMES;
const SUPPLY = 1_000_000_000;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
/** Stable noise in [0,1) for a seed and an index, no state. */
function noise(seed: number, i: number): number {
  let x = (seed ^ Math.imul(i, 0x9e3779b1)) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export class DemoMarket implements MarketProvider {
  private price(agentId: string, t: number): number {
    const s = hash(agentId);
    const base = 0.00002 + noise(s, 1) * 0.0004;
    const a = 0.5 + noise(s, 2) * 0.7;
    const b = 0.2 + noise(s, 3) * 0.4;
    const d = t / 86_400_000;
    const trend = 0.6 * Math.sin(d / 9 + noise(s, 4) * 6);
    const wave = a * Math.sin(d / 1.7 + noise(s, 5) * 6) + b * Math.sin(d * 3.1 + noise(s, 6) * 6);
    const jitter = (noise(s, Math.floor(t / 60_000)) - 0.5) * 0.04;
    return Math.max(1e-9, base * Math.exp(0.4 * wave + trend + jitter));
  }
  snapshot(agentId: string, now: number): MarketSnapshot {
    const p = this.price(agentId, now);
    const prev = this.price(agentId, now - 86_400_000);
    const s = hash(agentId);
    const mcap = p * SUPPLY;
    return {
      source: "demo",
      priceUsd: p,
      mcapUsd: mcap,
      volume24hUsd: mcap * (0.01 + noise(s, 7) * 0.06),
      change24hPct: (p / prev - 1) * 100,
      holders: 60 + Math.floor(noise(s, 8) * 900),
    };
  }
  candles(agentId: string, tf: Timeframe, now: number, count = 96): Candle[] {
    const step = TIMEFRAMES[tf];
    const s = hash(agentId);
    const end = Math.floor(now / step) * step;
    const out: Candle[] = [];
    for (let i = count - 1; i >= 0; i--) {
      const t = end - i * step;
      const o = this.price(agentId, t);
      const c = this.price(agentId, t + step - 1);
      const k = hash(agentId + tf) ^ Math.floor(t / step);
      const wick = Math.abs(c - o) * (0.3 + noise(k, 1)) + o * 0.003 * noise(k, 2);
      out.push({
        t,
        o,
        c,
        h: Math.max(o, c) + wick * noise(k, 3),
        l: Math.max(1e-9, Math.min(o, c) - wick * noise(k, 4)),
        v: o * SUPPLY * (0.0002 + noise(s ^ k, 9) * 0.004),
      });
    }
    return out;
  }
  holders(agentId: string): Holder[] {
    const s = hash(agentId);
    const raw = Array.from({ length: 10 }, (_, i) => (1 / (i + 1.4)) * (0.6 + noise(s, 20 + i)));
    const total = raw.reduce((a, b) => a + b, 0);
    return raw
      .map((r, i) => {
        let a = "";
        for (let j = 0; j < 44; j++) a += B58[Math.floor(noise(s, 100 + i * 50 + j) * B58.length)];
        return { rank: i + 1, address: a, pct: (r / total) * 38 };
      })
      .sort((x, y) => y.pct - x.pct)
      .map((h, i) => ({ ...h, rank: i + 1 }));
  }
}
