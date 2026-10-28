// Older coins keep the roles they launched with ("platform", "reserve"); new coins use the current four.
export type Role = "agent_treasury" | "infra" | "deployer" | "buyback" | "platform" | "reserve";
export interface Share {
  role: Role;
  address: string;
  shareBps: number;
}

// OWNER DECISION (DECISIONS D24): 40% agent wallet (its AI credits), 30% creator (paid straight to their wallet),
// 10% infra (server, X API, GitHub), 20% buyback wallet (tops up infra first, then buys the platform token and burns it).
// pump.fun lets the split be set exactly once per coin and never changed (official fee sharing doc).
export const DEFAULT_SPLIT_BPS = {
  agent_treasury: 4000,
  deployer: 3000,
  infra: 1000,
  buyback: 2000,
} as const satisfies Partial<Record<Role, number>>;
export type CurrentRole = keyof typeof DEFAULT_SPLIT_BPS;

export class SplitError extends Error {}

/** Mirrors the on-chain rules: 1 to 10 holders, every share above zero, no duplicates, total exactly 10000. */
export function validateSplit(shares: Share[]): void {
  if (shares.length < 1) throw new SplitError("at least one shareholder");
  if (shares.length > 10) throw new SplitError("at most 10 shareholders");
  const seen = new Set<string>();
  let total = 0;
  for (const s of shares) {
    if (!Number.isInteger(s.shareBps) || s.shareBps <= 0)
      throw new SplitError("every share must be a positive integer of bps");
    if (seen.has(s.address)) throw new SplitError("duplicate shareholder address");
    seen.add(s.address);
    total += s.shareBps;
  }
  if (total !== 10_000) throw new SplitError(`shares must total 10000 bps, got ${total}`);
}

export function defaultSplit(addresses: Record<CurrentRole, string>): Share[] {
  const out = (Object.keys(DEFAULT_SPLIT_BPS) as CurrentRole[]).map((role) => ({
    role,
    address: addresses[role],
    shareBps: DEFAULT_SPLIT_BPS[role],
  }));
  validateSplit(out);
  return out;
}

/** Integer split of a payout. The remainder goes to the first shareholder. Rounding on chain is TODO(verify). */
export function splitLamports(total: bigint, shares: Share[]): bigint[] {
  const parts = shares.map((s) => (total * BigInt(s.shareBps)) / 10_000n);
  const rest = total - parts.reduce((a, b) => a + b, 0n);
  parts[0] = parts[0]! + rest;
  return parts;
}
