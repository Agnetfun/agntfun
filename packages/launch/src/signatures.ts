import type { ConfirmedSignatureInfo, Connection, PublicKey } from "@solana/web3.js";

/**
 * Every signature on `address` newer than `until`, newest first. getSignaturesForAddress returns at most `limit`
 * per call, newest first; reading only that page and moving a cursor to its newest entry would skip everything
 * older on a busy address. So this pages backwards with `before` until it reaches `until`, up to `maxPages`.
 * With no cursor yet (first read) it takes one page only, so a busy pool's whole history is not pulled in at once.
 */
export async function signaturesSince(
  rpc: Pick<Connection, "getSignaturesForAddress">,
  address: PublicKey,
  until: string | undefined,
  limit: number,
  maxPages = 20,
): Promise<ConfirmedSignatureInfo[]> {
  const out: ConfirmedSignatureInfo[] = [];
  let before: string | undefined;
  const pages = until ? maxPages : 1;
  for (let p = 0; p < pages; p++) {
    const page = await rpc.getSignaturesForAddress(address, { until, before, limit }, "confirmed");
    out.push(...page);
    if (page.length < limit) break; // reached `until` (or the start of the address)
    before = page[page.length - 1]!.signature;
  }
  return out;
}
