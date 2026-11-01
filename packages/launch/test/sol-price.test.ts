import { describe, expect, it } from "vitest";
import { SOL_PRICE_SOURCES, SolUsd } from "../src/sol-price";

// Every dollar figure hangs on this price: a broken answer must never replace a good one.
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
function fetchFrom(answers: Record<string, () => Response>) {
  const calls: string[] = [];
  const f = (async (url: string) => {
    const s = SOL_PRICE_SOURCES.find((x) => url === x.url)!;
    calls.push(s.name);
    const a = answers[s.name];
    if (!a) throw new Error("network down");
    return a();
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("live SOL price", () => {
  it("uses the first source that answers sanely", async () => {
    const { f, calls } = fetchFrom({ coingecko: () => reply(200, { solana: { usd: 95.47 } }) });
    const p = new SolUsd(150, f);
    expect(await p.refresh()).toBe(95.47);
    expect(p.source).toBe("coingecko");
    expect(calls).toEqual(["coingecko"]);
    expect(p.cents()).toBe(9547);
  });

  it("falls through to Coinbase, then Jupiter, when a source fails or talks nonsense", async () => {
    const one = fetchFrom({ coingecko: () => reply(429, {}), coinbase: () => reply(200, { data: { amount: "95.33" } }) });
    const a = new SolUsd(150, one.f);
    expect(await a.refresh()).toBe(95.33);
    expect(a.source).toBe("coinbase");
    const two = fetchFrom({
      coingecko: () => reply(200, { solana: { usd: 0 } }), // nonsense
      coinbase: () => reply(200, { data: { amount: "abc" } }), // nonsense
      jupiter: () => reply(200, { So11111111111111111111111111111111111111112: { usdPrice: 95.4 } }),
    });
    const b = new SolUsd(150, two.f);
    expect(await b.refresh()).toBe(95.4);
    expect(two.calls).toEqual(["coingecko", "coinbase", "jupiter"]);
  });

  it("keeps the last good price when every source fails, and uses the env fallback before the first one", async () => {
    let up = true;
    const f = (async (url: string) => {
      if (!up) throw new Error("down");
      return url.includes("coingecko") ? reply(200, { solana: { usd: 101 } }) : reply(500, {});
    }) as unknown as typeof fetch;
    const p = new SolUsd(150, f, 0);
    expect(p.value()).toBe(150); // nothing fetched yet
    await p.refresh();
    up = false;
    expect(await p.refresh()).toBe(101); // all down: last good price stays
    expect(p.source).toBe("coingecko");
  });
});
