import { Keypair, type Connection } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { signaturesSince } from "../src/signatures";

// A busy address can get more new transactions between two reads than one page holds; none may be skipped.
const all = Array.from({ length: 100 }, (_, i) => `s${99 - i}`); // newest first: s99 ... s0
const rpc = {
  getSignaturesForAddress: async (_a: unknown, o: { until?: string; before?: string; limit: number }) => {
    let start = o.before ? all.indexOf(o.before) + 1 : 0;
    const out = [];
    for (; start < all.length && out.length < o.limit; start++) {
      if (all[start] === o.until) break;
      out.push({ signature: all[start]!, err: null, slot: 1, blockTime: 1, memo: null });
    }
    return out;
  },
} as unknown as Pick<Connection, "getSignaturesForAddress">;
const addr = Keypair.generate().publicKey;

describe("signatures since a cursor", () => {
  it("pages back to the cursor instead of stopping at the newest page", async () => {
    const got = await signaturesSince(rpc, addr, "s9", 40); // 90 newer than s9, pages of 40
    expect(got).toHaveLength(90);
    expect(got[0]!.signature).toBe("s99");
    expect(got.at(-1)!.signature).toBe("s10");
  });

  it("reads one page only when there is no cursor yet", async () => {
    expect(await signaturesSince(rpc, addr, undefined, 40)).toHaveLength(40);
  });

  it("stops at the page cap", async () => {
    expect(await signaturesSince(rpc, addr, "s0", 10, 3)).toHaveLength(30);
  });
});
