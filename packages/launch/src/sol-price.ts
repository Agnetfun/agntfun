/**
 * Live SOL/USD for every dollar figure: market cap, price and volume in USD, and treasury bookings when SOL arrives.
 * Three keyless public sources, tried in order until one gives a sane number (each verified by calling it):
 *   CoinGecko  GET api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd  -> { solana: { usd } }
 *   Coinbase   GET api.coinbase.com/v2/prices/SOL-USD/spot                             -> { data: { amount } }
 *   Jupiter    GET lite-api.jup.ag/price/v3?ids=<wrapped SOL mint>                     -> { <mint>: { usdPrice } }
 * Refreshed at most once a minute. When every source fails the last good price stays; before the first one,
 * SOL_USD from the environment is the fallback.
 */
const WSOL = "So11111111111111111111111111111111111111112";
export const SOL_PRICE_SOURCES: { name: string; url: string; pick: (j: unknown) => unknown }[] = [
  {
    name: "coingecko",
    url: "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
    pick: (j) => (j as { solana?: { usd?: unknown } }).solana?.usd,
  },
  {
    name: "coinbase",
    url: "https://api.coinbase.com/v2/prices/SOL-USD/spot",
    pick: (j) => (j as { data?: { amount?: unknown } }).data?.amount,
  },
  {
    name: "jupiter",
    url: `https://lite-api.jup.ag/price/v3?ids=${WSOL}`,
    pick: (j) => (j as Record<string, { usdPrice?: unknown }>)[WSOL]?.usdPrice,
  },
];

/** A SOL price outside this range is a broken answer, not a market move. */
const SANE = { min: 1, max: 100_000 };

export class SolUsd {
  private usd: number;
  private at = 0;
  private inflight: Promise<number> | null = null;
  /** Which source gave the current price ("fallback" before any source answered). */
  source = "fallback";

  constructor(
    private fallback: number,
    private fetchFn: typeof fetch = fetch,
    private maxAgeMs = 60_000,
  ) {
    this.usd = fallback > 0 ? fallback : 150;
  }

  /** The current price, at once; starts a refresh in the background when it is older than a minute. */
  value(): number {
    if (Date.now() - this.at > this.maxAgeMs) void this.refresh();
    return this.usd;
  }

  cents(): number {
    return Math.round(this.value() * 100);
  }

  /** Fetches a fresh price (one at a time); resolves with the price in use afterwards. */
  refresh(): Promise<number> {
    this.inflight ??= (async () => {
      try {
        for (const s of SOL_PRICE_SOURCES) {
          try {
            const r = await this.fetchFn(s.url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
            if (!r.ok) continue;
            const v = Number(s.pick(await r.json()));
            if (Number.isFinite(v) && v >= SANE.min && v <= SANE.max) {
              this.usd = v;
              this.at = Date.now();
              this.source = s.name;
              return v;
            }
          } catch {
            /* try the next source */
          }
        }
        this.at = Date.now() - this.maxAgeMs + 15_000; // all failed: try again in 15 seconds, keep the last price
        return this.usd;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }
}
