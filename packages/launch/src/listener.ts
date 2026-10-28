import type { Db } from "@devagent/db";
import type { Treasury } from "@devagent/treasury";
import type { LaunchPad } from "./launchpad";

/**
 * Watches distributions for a coin and books the agent treasury's share as creator-fee income.
 * Idempotent: replays and overlapping polls never double count (the signature plus shareholder is the ledger reference).
 */
export class TreasuryListener {
  constructor(
    private db: Db,
    private treasury: Treasury,
    private pad: LaunchPad,
  ) {}

  cursor(mint: string): number {
    const r = this.db.prepare("SELECT value FROM listener_cursor WHERE mint=?").get(mint) as
      { value: number } | undefined;
    return r?.value ?? 0;
  }

  async poll(
    agentId: string,
    mint: string,
    treasuryAddress: string,
  ): Promise<{ booked: number; lamports: bigint }> {
    let booked = 0;
    let lamports = 0n;
    const since = this.cursor(mint);
    let max = since;
    for (const d of await this.pad.distributionsSince(mint, since)) {
      max = Math.max(max, d.seq);
      if (d.shareholder !== treasuryAddress) continue;
      if (d.lamports > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("amount too large");
      if (
        this.treasury.recordCreatorFee(
          agentId,
          Number(d.lamports),
          `${d.signature}:${d.shareholder}`,
        )
      ) {
        booked++;
        lamports += d.lamports;
      }
    }
    this.db
      .prepare(
        "INSERT INTO listener_cursor (mint, value) VALUES (?,?) ON CONFLICT(mint) DO UPDATE SET value=excluded.value",
      )
      .run(mint, max);
    return { booked, lamports };
  }
}
