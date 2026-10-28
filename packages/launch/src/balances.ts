import type { BalanceProvider } from "@devagent/community";

/** The slice of @solana/web3.js Connection that this needs. Read only, no keys. */
export interface TokenRpc {
  getParsedTokenAccountsByOwner(
    owner: unknown,
    filter: { mint: unknown },
  ): Promise<{
    value: Array<{
      account: { data: { parsed?: { info?: { tokenAmount?: { uiAmount?: number | null } } } } };
    }>;
  }>;
}

/**
 * Token balance of a wallet for one coin, read from the chain. Voting weight comes from here.
 * Uses the standard getTokenAccountsByOwner RPC call through web3.js (TODO(verify) against a live devnet).
 */
export class ChainBalances implements BalanceProvider {
  constructor(
    private rpc: TokenRpc,
    private mint: unknown,
    private toKey: (s: string) => unknown,
  ) {}

  async balanceOf(wallet: string): Promise<number> {
    let owner: unknown;
    try {
      owner = this.toKey(wallet);
    } catch {
      return 0;
    }
    const r = await this.rpc.getParsedTokenAccountsByOwner(owner, { mint: this.mint });
    let total = 0;
    for (const a of r.value) {
      const v = a.account.data.parsed?.info?.tokenAmount?.uiAmount;
      if (typeof v === "number" && Number.isFinite(v) && v > 0) total += v;
    }
    return total;
  }
}
