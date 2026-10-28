import { createHash } from "node:crypto";
import { base58Encode } from "@devagent/community";
import {
  validateLaunch,
  type Distribution,
  type LaunchPad,
  type LaunchRequest,
  type LaunchResult,
} from "./launchpad";
import { splitLamports, validateSplit, type Share } from "./split";

interface Coin {
  shares: Share[];
  vault: bigint;
}

/** In memory pump.fun: same rules as the real program for the parts we depend on. */
export class MockLaunchPad implements LaunchPad {
  private coins = new Map<string, Coin>();
  private log: Distribution[] = [];
  private n = 0;

  async launch(req: LaunchRequest): Promise<LaunchResult> {
    validateLaunch(req);
    validateSplit(req.split);
    const id = ++this.n;
    const mint = base58Encode(createHash("sha256").update(`mint:${id}:${req.symbol}`).digest());
    this.coins.set(mint, { shares: req.split, vault: 0n });
    return { mint, signature: `mock-launch-${id}`, sharingConfigSet: true };
  }

  /** The program lets the split be set once. A second attempt must fail. */
  async setSplitAgain(mint: string, shares: Share[]): Promise<never> {
    validateSplit(shares);
    throw new Error(`fee split for ${mint} is already set and cannot be changed`);
  }

  /** Test hook: trading on the curve accrues creator fees in the vault. */
  accrueFees(mint: string, lamports: bigint): void {
    this.coin(mint).vault += lamports;
  }

  /** Permissionless on chain; anyone may trigger it. Pays every shareholder by bps. */
  distribute(mint: string): Distribution[] {
    const c = this.coin(mint);
    if (c.vault === 0n) return [];
    const parts = splitLamports(c.vault, c.shares);
    c.vault = 0n;
    const sig = `mock-dist-${this.log.length + 1}`;
    const rows = c.shares.map((s, i) => ({
      signature: sig,
      mint,
      shareholder: s.address,
      lamports: parts[i]!,
      seq: this.log.length + i + 1,
    }));
    this.log.push(...rows);
    return rows;
  }

  async distributionsSince(mint: string, cursor: number): Promise<Distribution[]> {
    return this.log.filter((d) => d.mint === mint && d.seq > cursor);
  }

  private coin(mint: string): Coin {
    const c = this.coins.get(mint);
    if (!c) throw new Error("unknown mint");
    return c;
  }
}
export type { LaunchRequest };
